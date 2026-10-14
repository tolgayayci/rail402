/**
 * The crash-recovery harness against the service run as a real process on the private Stellar network
 * and the shared Postgres: the code path `fault-recovery.ts` runs on the public testnet, with one case
 * of each kill point, and the evidence it builds accepted by the writer's checks.
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Keypair } from "@stellar/stellar-sdk";
import {
  LocalNetwork,
  deployUpto,
  stopServiceProcesses,
  type IssuedAsset,
  type LocalUptoContract,
} from "@rail402.dev/testkit";
import { checkEvidence } from "../src/evidence.ts";
import { runFaultRecovery } from "../src/fault-recovery-run.ts";
import { buildEvidence } from "../src/harness.ts";

const MAIN = fileURLToPath(new URL("../../../apps/rail402/src/main.ts", import.meta.url));
const DATABASE_URL =
  process.env["RAIL402_TEST_DATABASE_URL"] ?? "postgres://rail402:rail402@localhost:5432/rail402";
const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("crash-recovery harness against the service process", () => {
  let usdc: IssuedAsset;
  let contract: LocalUptoContract;
  let seller: Keypair;

  beforeAll(async () => {
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
  }, 120_000);

  afterAll(async () => {
    await stopServiceProcesses();
  });

  it("recovers K0 (upto), K1 (exact) and K3 (exact) and writes evidence the writer accepts", async () => {
    const run = await runFaultRecovery({
      net,
      entry: MAIN,
      databaseUrl: DATABASE_URL,
      asset: { contract: usdc.sac, symbol: "USDC", decimals: 7 },
      env: {
        TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
        TESTNET_MAX_TX_FEE_STROOPS: "2000000",
        TESTNET_UPTO_ENABLED: "true",
        TESTNET_UPTO_CONTRACT: contract.address,
        TESTNET_UPTO_WASM_HASH: contract.wasmHash,
        TESTNET_UPTO_TTL_KEEPER: "false",
        SEARCH_EMBEDDINGS: "false",
      },
      payer: async () => {
        const [payer] = (await net.holders(usdc, 1, "1")) as [Keypair];
        return payer;
      },
      payTo: seller.publicKey(),
      amount: 1_000_000n,
      cases: [
        { point: "k0", scheme: "upto" },
        { point: "k1", scheme: "exact" },
        { point: "k3", scheme: "exact" },
      ],
      // The service estimates ledger time from Horizon (5–6 s); 6 s keeps the window inside either.
      upto: { contract: contract.address, ledgerSeconds: 6 },
    });

    expect(run.cases.map((entry) => [entry.id, entry.status, entry.observations?.["error"]])).toEqual([
      ["k0-upto", "passed", undefined],
      ["k1-exact", "passed", undefined],
      ["k3-exact", "passed", undefined],
    ]);
    expect(run.cases[0]?.transactions?.[0]?.transfers).toEqual([
      { from: expect.any(String) as unknown, to: seller.publicKey(), amount: "1000000" },
    ]);
    expect(run.cases[1]?.observations).toMatchObject({ state: "succeeded", reconciled: 1 });
    expect(run.cases[2]?.observations).toMatchObject({ state: "expired", onChain: "NOT_FOUND" });
    expect(run.target?.mode).toBe("local");

    const evidence = buildEvidence(
      {
        kind: "fault-recovery",
        provenance: { commit: "a".repeat(40), dirty: false },
        network: "stellar:testnet",
        target: run.target ?? {
          mode: "local",
          facilitatorUrl: "http://127.0.0.1",
          healthVersion: "",
          supported: null,
        },
        packages: { "@x402/stellar": "2.27.0" },
        command: "node tools/conformance/src/fault-recovery.ts",
        config: { store: "postgres" },
        accounts: { sponsor: run.sponsor, payTo: seller.publicKey() },
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
      run.cases,
    );
    expect(checkEvidence(evidence).problems).toEqual([]);
    expect(evidence.summary).toEqual({ total: 3, passed: 3, failed: 0, skipped: 0 });
  }, 600_000);
});
