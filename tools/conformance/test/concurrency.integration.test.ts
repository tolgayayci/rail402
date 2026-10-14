/**
 * The concurrency harness against two replicas of the service, run as real processes on one
 * Postgres schema and the private Stellar network: the same code path `concurrency.ts` runs on the
 * public testnet, at a smaller size, with `exact` and `upto` payments mixed in every batch.
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { sql } from "kysely";
import { createDatabase } from "@rail402.dev/store-postgres";
import {
  LocalNetwork,
  ServiceProcess,
  deployUpto,
  stopServiceProcesses,
  type IssuedAsset,
  type LocalUptoContract,
} from "@rail402.dev/testkit";
import { concurrencyEvidence, runConcurrency } from "../src/concurrency-run.ts";
import { checkEvidence } from "../src/evidence.ts";

const MAIN = fileURLToPath(new URL("../../../apps/rail402/src/main.ts", import.meta.url));
const DATABASE_URL =
  process.env["RAIL402_TEST_DATABASE_URL"] ?? "postgres://rail402:rail402@localhost:5432/rail402";
const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("concurrency harness against two local replicas", () => {
  let usdc: IssuedAsset;
  let contract: LocalUptoContract;
  let seller: Keypair;
  const schema = `conc_${randomBytes(6).toString("hex")}`;
  const replicas: ServiceProcess[] = [];

  beforeAll(async () => {
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    const sponsor = Keypair.random();
    await net.fund(sponsor);
    const admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    await admin.destroy();
    const env = {
      STORE: "postgres",
      DATABASE_URL: `${DATABASE_URL}?options=-c%20search_path%3D${schema}`,
      TESTNET_RPC_URL: net.rpcUrl,
      TESTNET_SPONSOR_SECRET: sponsor.secret(),
      TESTNET_CHANNEL_COUNT: "4",
      TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
      TESTNET_MAX_TX_FEE_STROOPS: "2000000",
      TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
      TESTNET_UPTO_ENABLED: "true",
      TESTNET_UPTO_CONTRACT: contract.address,
      TESTNET_UPTO_WASM_HASH: contract.wasmHash,
      TESTNET_UPTO_TTL_KEEPER: "false",
      SETTLE_CHANNEL_WAIT_MS: "30000",
      BAZAAR_ENABLED: "false",
      RATE_LIMIT_PER_MINUTE: "0",
    };
    // The first replica migrates and provisions the channels; the second starts on what it left.
    for (let index = 0; index < 2; index++) {
      const replica = await ServiceProcess.start({ entry: MAIN, env });
      await replica.listening();
      const deadline = Date.now() + 60_000;
      while ((await fetch(`${replica.url}/ready`)).status !== 200) {
        if (Date.now() > deadline) throw new Error("replica did not become ready");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      replicas.push(replica);
    }
  });

  afterAll(async () => {
    await stopServiceProcesses();
    const admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin);
    await admin.destroy();
  }, 180_000);

  it("passes every batch and writes evidence the writer accepts", async () => {
    const supported = (await (await fetch(`${replicas[0]?.url ?? ""}/supported`)).json()) as {
      kinds: { scheme: string; extra?: { facilitatorAddress?: string } }[];
    };
    const authority = supported.kinds.find((kind) => kind.scheme === "upto")?.extra?.facilitatorAddress;
    if (authority === undefined) throw new Error("the replicas do not serve upto");
    const run = await runConcurrency({
      scheme: "mixed",
      // The service estimates ledger time from Horizon (5–6 s); 6 s keeps the window inside either.
      upto: { authority, contract: contract.address, ledgerSeconds: 6 },
      facilitators: replicas.map((replica) => replica.url),
      net,
      asset: { contract: usdc.sac, symbol: "USDC", decimals: 7 },
      payTo: seller.publicKey(),
      amount: 10_000n,
      batches: 2,
      size: 8,
      duplicates: 2,
      payers: (count) => net.holders(usdc, count, "0.01"),
      startingBalance: 100_000n,
      explorer: (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`,
    });

    expect(run.cases.map((entry) => [entry.id, entry.status, entry.observations?.["problems"]])).toEqual([
      ["batch-1", "passed", undefined],
      ["batch-2", "passed", undefined],
      ["distinct-sequences", "passed", undefined],
    ]);
    for (const batch of run.cases.slice(0, 2)) {
      expect(batch.transactions).toHaveLength(8);
      expect(batch.observations).toMatchObject({
        replicas: 2,
        settlementsCounted: 8,
        repeatsCounted: 2,
        sequenceConflicts: 0,
        leaseTimeouts: 0,
      });
      // 8 payments on 4 channels: the pool was in use during the batch.
      expect(batch.observations?.["maxChannelsInUse"]).toBeGreaterThan(0);
    }
    expect(run.cases[2]?.observations).toEqual({ transactions: 16, collisions: [] });

    const evidence = concurrencyEvidence(run, {
      provenance: { commit: "a".repeat(40), dirty: false },
      network: "stellar:testnet",
      facilitators: replicas.map((replica) => replica.url),
      healthVersion: "test",
      supported: { kinds: [] },
      packages: { "@x402/stellar": "2.27.0" },
      command: "node tools/conformance/src/concurrency.ts",
      config: { scheme: "mixed", batches: 2, size: 8, duplicates: 2 },
      accounts: { payTo: seller.publicKey() },
    });
    expect(checkEvidence(evidence).problems).toEqual([]);
    expect(evidence).toMatchObject({
      kind: "concurrency",
      target: { mode: "local" },
      summary: { total: 3, passed: 3, failed: 0, skipped: 0 },
    });
  }, 600_000);
});
