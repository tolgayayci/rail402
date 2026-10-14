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
import { LocalNetwork } from "@rail402.dev/testkit";
import { concurrencyEvidence, runConcurrency, type ConcurrencyScheme } from "./concurrency-run.ts";
import { harnessProvenance, recheckProvenance, runFileName, writeEvidence } from "./evidence.ts";
import {
  NETWORK,
  TESTNET_FRIENDBOT_URL,
  TESTNET_RPC_URL,
  Treasury,
  USDC_TESTNET_ADDRESS,
  log,
  versions,
} from "./testnet.ts";

const { values: args } = parseArgs({
  options: {
    facilitator: { type: "string", default: "http://localhost:8080" },
    scheme: { type: "string", default: "exact" },
    batches: { type: "string", default: "3" },
    size: { type: "string", default: "20" },
    duplicates: { type: "string", default: "2" },
    rpc: { type: "string", default: TESTNET_RPC_URL },
    friendbot: { type: "string", default: TESTNET_FRIENDBOT_URL },
    write: { type: "boolean", default: false },
    "allow-branch": { type: "string" },
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
  const net = new LocalNetwork(args.rpc, args.friendbot);
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
  const treasury = await new Treasury(net).open(String(Math.ceil((payers * 0.01 + 1) * 100) / 100));
  const [seller] = await treasury.accounts(1, "0");
  if (seller === undefined) throw new Error("no seller account");

  const run = await runConcurrency({
    scheme: SCHEME,
    ...(typeof authority === "string" ? { upto: { authority } } : {}),
    facilitators: FACILITATORS,
    net,
    asset: { contract: USDC_TESTNET_ADDRESS, symbol: "USDC", decimals: 7 },
    payTo: seller.publicKey(),
    amount: AMOUNT,
    batches: BATCHES,
    size: SIZE,
    duplicates: DUPLICATES,
    payers: (count) => treasury.accounts(count, STARTING.text),
    startingBalance: STARTING.baseUnits,
    explorer: (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`,
    log,
  });

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
      command: `node tools/conformance/src/concurrency.ts --facilitator ${FACILITATORS.join(",")} --scheme ${SCHEME} --batches ${String(BATCHES)} --size ${String(SIZE)} --duplicates ${String(DUPLICATES)}`,
      config: {
        scheme: SCHEME,
        batches: BATCHES,
        size: SIZE,
        duplicates: DUPLICATES,
        amount: AMOUNT.toString(),
      },
      accounts: { payTo: seller.publicKey(), treasury: treasury.keypair.publicKey() },
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
