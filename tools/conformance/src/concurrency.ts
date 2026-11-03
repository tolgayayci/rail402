/**
 * Concurrency run on the public Stellar testnet: batches of concurrent `exact` or `upto` settlements,
 * or both mixed in every batch, in Circle USDC against one Rail402, or two replicas of one deployment,
 * with duplicates injected into every batch. Every settlement is proved on chain, and each replica's `/metrics` is scraped before and
 * after each batch (and polled during it for the peak channel use). See concurrency-run.ts for what a
 * batch must satisfy.
 *
 *   node tools/conformance/src/concurrency.ts --facilitator http://…[,http://…] \
 *     [--scheme exact|upto|mixed] [--batches 3] [--size 20] [--duplicates 2] [--write [--allow-branch <branch>]]
 *
 * With two URLs, every duplicate goes to the replica its original did not. Fresh accounts are
 * created for each run, so the script needs no secrets. With --write the evidence is recorded in
 * tools/conformance/evidence/concurrency-stellar-testnet.json (`exact`), or
 * concurrency-upto-stellar-testnet.json and concurrency-mixed-stellar-testnet.json.
 */
import { parseArgs } from "node:util";
import { concurrencyEvidence, runConcurrency, type ConcurrencyScheme } from "./concurrency-run.ts";
import { harnessProvenance, recheckProvenance, runFileName, writeEvidence } from "./evidence.ts";
import {
  NETWORK_OPTION,
  ProfileNetwork,
  feeCeilingStroops,
  parseNetworkId,
  profileEvidence,
  resolveProfile,
  startRun,
  sweepObservation,
  withRun,
} from "./network.ts";
import { log, versions } from "./testnet.ts";

const { values: args } = parseArgs({
  options: {
    facilitator: { type: "string", default: "http://localhost:8080" },
    scheme: { type: "string", default: "exact" },
    batches: { type: "string", default: "3" },
    size: { type: "string", default: "20" },
    duplicates: { type: "string", default: "2" },
    rpc: { type: "string" },
    friendbot: { type: "string" },
    write: { type: "boolean", default: false },
    "allow-branch": { type: "string" },
    ...NETWORK_OPTION,
  },
});

const integer = (name: string, value: string, min: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer between ${String(min)} and ${String(max)}`);
  }
  return parsed;
};

// Anything but exact, upto or the two mixed is refused before any funds are spent.
if (!["exact", "upto", "mixed"].includes(args.scheme)) {
  throw new Error(`--scheme ${args.scheme}: expected exact, upto or mixed`);
}
const SCHEME = args.scheme as ConcurrencyScheme;
const PROFILE = resolveProfile(parseNetworkId(args.network), { needsUpto: SCHEME !== "exact" });
const NETWORK = PROFILE.caip2;
if (PROFILE.id !== "testnet" && (args.rpc !== undefined || args.friendbot !== undefined)) {
  throw new Error("--rpc and --friendbot apply to testnet runs; pubnet uses RAIL402_PUBNET_RPC_URLS");
}
const BATCHES = integer("batches", args.batches, 1, 20);
const SIZE = integer("size", args.size, 1, 100);
const DUPLICATES = integer("duplicates", args.duplicates, 0, SIZE);
const FACILITATORS = args.facilitator.split(",").map((url) => url.trim().replace(/\/+$/, ""));
if (FACILITATORS.length > 2) throw new Error("--facilitator takes one URL or two replicas' URLs");

// Evidence is recorded only from a clean commit on main, checked before any testnet funds are spent.
const provenance = args.write ? harnessProvenance({ allowBranch: args["allow-branch"] }) : undefined;

/** 0.001 USDC per payment; each payer holds exactly 0.01 USDC. */
const AMOUNT = 10_000n;
const STARTING = { text: "0.01", baseUnits: 100_000n };

async function main() {
  const net = new ProfileNetwork({
    ...PROFILE,
    ...(args.rpc === undefined ? {} : { rpcUrls: [args.rpc] }),
    ...(args.friendbot === undefined || PROFILE.funding.kind !== "friendbot"
      ? {}
      : { funding: { ...PROFILE.funding, friendbotUrl: args.friendbot } }),
  });
  const [primary = ""] = FACILITATORS;
  const health = (await (await fetch(`${primary}/health`)).json()) as { version?: string };
  const supported: unknown = await (await fetch(`${primary}/supported`)).json();
  log(`facilitators ${FACILITATORS.join(", ")} (version ${health.version ?? "unknown"})`);
  const authority = (
    supported as { kinds?: { scheme?: string; network?: string; extra?: { facilitatorAddress?: unknown } }[] }
  ).kinds?.find((kind) => kind.scheme === "upto" && kind.network === NETWORK)?.extra?.facilitatorAddress;
  if (SCHEME !== "exact" && typeof authority !== "string") {
    throw new Error(`--scheme ${SCHEME}: the facilitator does not advertise upto on ${NETWORK}`);
  }

  const payers = BATCHES * SIZE;
  log(`opening a treasury for ${String(payers)} payers`);
  const treasury = await startRun("concurrency", PROFILE, net, {
    usdc: String(Math.ceil((payers * 0.01 + 1) * 100) / 100),
    facilitators: FACILITATORS,
  });
  // Every /settle is debited when it is sent, duplicates included; the run's known needs (one settlement
  // per payment and per duplicate, the payers' USDC) are checked against the caps before anything is sent.
  const ceiling = feeCeilingStroops(PROFILE, SCHEME === "exact" ? "exact" : "upto");
  const requests = BATCHES * (SIZE + DUPLICATES);
  treasury.meter.ensure(
    {
      settlements: requests,
      xlmStroops: ceiling * BigInt(requests),
      usdcBaseUnits: STARTING.baseUnits * BigInt(payers),
      newAccounts: payers + 1,
    },
    `${String(requests)} settlement requests`,
  );

  let run: Awaited<ReturnType<typeof runConcurrency>> | undefined;
  let seller: string | undefined;
  const sweep = await withRun(treasury, async () => {
    const [account] = await treasury.accounts(1, "0", true, { role: "seller" });
    if (account === undefined) throw new Error("no seller account");
    seller = account.publicKey();
    run = await runConcurrency({
      network: NETWORK,
      scheme: SCHEME,
      ...(typeof authority === "string"
        ? {
            upto: {
              authority,
              ...(PROFILE.id === "testnet" || PROFILE.upto === undefined
                ? {}
                : { contract: PROFILE.upto.contract }),
            },
          }
        : {}),
      facilitators: FACILITATORS,
      net,
      asset: { contract: PROFILE.usdc.contract, symbol: "USDC", decimals: 7 },
      payTo: seller,
      amount: AMOUNT,
      batches: BATCHES,
      size: SIZE,
      duplicates: DUPLICATES,
      payers: (count) => treasury.accounts(count, STARTING.text),
      startingBalance: STARTING.baseUnits,
      explorer: PROFILE.explorer.tx,
      log,
    });
  });
  if (run === undefined || seller === undefined) throw new Error("the run did not finish");
  if (PROFILE.id !== "testnet") {
    run.cases.push({
      id: "sweep-back",
      title: "the run's USDC is back in the operator treasury and its accounts are merged",
      checks: ["pubnet-config"],
      status: sweep.status === "partial" ? "failed" : "passed",
      elapsedMs: 0,
      observations: { sweep: sweepObservation(sweep) },
    });
  }

  const failed = run.cases.filter((entry) => entry.status === "failed").length;
  if (provenance === undefined) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  } else {
    const evidence = concurrencyEvidence(run, {
      provenance,
      network: NETWORK,
      facilitators: FACILITATORS,
      healthVersion: health.version ?? "unknown",
      supported,
      packages: versions(["@x402/core", "@x402/stellar", "@stellar/stellar-sdk"]),
      command: `node tools/conformance/src/concurrency.ts --facilitator ${FACILITATORS.join(",")} --scheme ${SCHEME} --batches ${String(BATCHES)} --size ${String(SIZE)} --duplicates ${String(DUPLICATES)}${PROFILE.id === "testnet" ? "" : ` --network ${PROFILE.id}`}`,
      config: {
        scheme: SCHEME,
        batches: BATCHES,
        size: SIZE,
        duplicates: DUPLICATES,
        amount: AMOUNT.toString(),
      },
      accounts: { payTo: seller, treasury: treasury.keypair.publicKey() },
      ...(PROFILE.id === "testnet" ? {} : { profile: profileEvidence(PROFILE, treasury, sweep) }),
    });
    recheckProvenance(provenance, { allowBranch: args["allow-branch"] });
    // One file per scheme: `exact` keeps the plain name, `upto` and `mixed` runs are variants.
    const file = runFileName(evidence, SCHEME === "exact" ? undefined : SCHEME);
    log(`evidence written to ${writeEvidence(evidence, { allowBranch: args["allow-branch"], file })}`);
  }
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
