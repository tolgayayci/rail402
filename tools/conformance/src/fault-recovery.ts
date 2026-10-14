/**
 * Crash recovery on the public Stellar testnet: a Rail402 process from this checkout, over Postgres,
 * reaching the testnet RPC through the fault proxy, killed with SIGKILL at K0 and K1 (for `exact` and
 * `upto`) and K3 (`exact`), then restarted. See fault-recovery-run.ts for what each case must prove.
 * The hosted service is never killed: this run always starts its own process.
 *
 *   node tools/conformance/src/fault-recovery.ts [--database postgres://…] [--cases k0-exact,k1-exact,k3-exact,k0-upto,k1-upto] \
 *     [--write [--allow-branch <branch>]]
 *
 * The sponsor, the payers and the seller are fresh Friendbot-funded accounts; the upto payments use the
 * canonical testnet settlement contract. The run needs no secrets. With --write the evidence is
 * recorded in tools/conformance/evidence/fault-recovery-stellar-testnet.json.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LocalNetwork } from "@rail402.dev/testkit";
import { buildEvidence } from "./harness.ts";
import { harnessProvenance, recheckProvenance, writeEvidence } from "./evidence.ts";
import {
  DEFAULT_FAULT_CASES,
  runFaultRecovery,
  type FaultCase,
  type FaultScheme,
  type KillPoint,
} from "./fault-recovery-run.ts";
import {
  NETWORK,
  TESTNET_FRIENDBOT_URL,
  TESTNET_RPC_URL,
  Treasury,
  USDC_TESTNET_ADDRESS,
  gitCommit,
  log,
  versions,
} from "./testnet.ts";

const { values: args } = parseArgs({
  options: {
    database: { type: "string", default: "postgres://rail402:rail402@localhost:5432/rail402" },
    cases: { type: "string" },
    rpc: { type: "string", default: TESTNET_RPC_URL },
    friendbot: { type: "string", default: TESTNET_FRIENDBOT_URL },
    write: { type: "boolean", default: false },
    "allow-branch": { type: "string" },
  },
});

const CASES: readonly FaultCase[] =
  args.cases === undefined
    ? DEFAULT_FAULT_CASES
    : args.cases.split(",").map((id) => {
        const match = /^(k0|k1|k3)-(exact|upto)$/.exec(id.trim());
        if (match === null) throw new Error(`--cases ${id}: expected k0|k1|k3 - exact|upto`);
        return { point: match[1] as KillPoint, scheme: match[2] as FaultScheme };
      });

// Evidence is recorded only from a clean commit on main, checked before any testnet funds are spent.
const provenance = args.write ? harnessProvenance({ allowBranch: args["allow-branch"] }) : undefined;

const ENTRY = fileURLToPath(new URL("../../../apps/rail402/src/main.ts", import.meta.url));
/**
 * The version the started process reports on `/health`: `RAIL402_VERSION` when set (as `pnpm evidence`
 * sets it), otherwise `<package version>+<commit>` of this checkout, like every other local replica.
 */
const SERVICE_VERSION = process.env["RAIL402_VERSION"] ?? checkoutVersion();

function checkoutVersion(): string {
  const manifest = new URL("../../../apps/rail402/package.json", import.meta.url);
  const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
  const commit = gitCommit().replace(/-dirty$/, "");
  return `${version}+${commit.slice(0, 12)}`;
}

/** 0.01 USDC per payment; each payer holds 0.05 USDC. */
const AMOUNT = 100_000n;

async function main() {
  const net = new LocalNetwork(args.rpc, args.friendbot);
  log("opening a treasury: Friendbot XLM, then USDC from the testnet XLM/USDC pool");
  const treasury = await new Treasury(net).open("1");
  const [seller] = await treasury.accounts(1, "0");
  if (seller === undefined) throw new Error("no seller account");

  const config = {
    TESTNET_ASSETS: `${USDC_TESTNET_ADDRESS}:USDC:7`,
    TESTNET_MAX_TX_FEE_STROOPS: "1000000",
    TESTNET_UPTO_MAX_TX_FEE_STROOPS: "1000000",
    SEARCH_EMBEDDINGS: "false",
  };
  const run = await runFaultRecovery({
    net,
    entry: ENTRY,
    databaseUrl: args.database,
    asset: { contract: USDC_TESTNET_ADDRESS, symbol: "USDC", decimals: 7 },
    env: { ...config, RAIL402_VERSION: SERVICE_VERSION },
    payer: async () => {
      const [payer] = await treasury.accounts(1, "0.05");
      if (payer === undefined) throw new Error("no payer account");
      return payer;
    },
    payTo: seller.publicKey(),
    amount: AMOUNT,
    cases: CASES,
    log,
  });

  const evidence = buildEvidence(
    {
      kind: "fault-recovery",
      // Without --write the document is printed only; its commit may then describe a dirty tree.
      provenance: provenance ?? { commit: gitCommit().replace(/-dirty$/, ""), dirty: false },
      network: NETWORK,
      // The process this run started (and killed): a local Rail402 from this checkout.
      target: run.target ?? {
        mode: "local",
        facilitatorUrl: "http://127.0.0.1",
        healthVersion: "unknown",
        supported: null,
      },
      packages: versions(["@x402/core", "@x402/stellar", "@stellar/stellar-sdk", "@rail402.dev/upto"]),
      command: `node tools/conformance/src/fault-recovery.ts --cases ${CASES.map((entry) => `${entry.point}-${entry.scheme}`).join(",")}`,
      config: {
        store: "postgres",
        rpc: args.rpc,
        rpcPath: "through the fault proxy",
        channels: 2,
        reconcileIntervalMs: 1_000,
        amount: AMOUNT.toString(),
        ...config,
      },
      accounts: {
        sponsor: run.sponsor,
        payTo: seller.publicKey(),
        treasury: treasury.keypair.publicKey(),
      },
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    run.cases,
  );
  if (provenance === undefined) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } else {
    recheckProvenance(provenance, { allowBranch: args["allow-branch"] });
    log(`evidence written to ${writeEvidence(evidence, { allowBranch: args["allow-branch"] })}`);
  }
  if (evidence.summary.failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
