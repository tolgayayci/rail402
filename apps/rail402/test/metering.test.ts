import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { MemorySettlementLedger, silentLogger, type StellarFacilitator } from "@rail402.dev/facilitator";
import { Metrics, createApp, loadConfig, newAccessKey } from "@rail402.dev/service";
import { settled } from "./metering-ledger.ts";
import { secretFile } from "./secret-fixtures.ts";

const NETWORK = "stellar:testnet";
const alice = newAccessKey("alice-1");
const bob = newAccessKey("bob-1");

function app(ledger: MemorySettlementLedger, price: string) {
  const keys = [alice, bob].map((key, index) => ({
    id: index === 0 ? "alice-1" : "bob-1",
    sha256: key.sha256,
    networks: [NETWORK],
    requestsPerMinute: 30,
    sponsorBudgetXlmPerHour: "1",
    createdAt: "2026-01-01T00:00:00Z",
  }));
  return createApp({
    config: loadConfig({
      STORE: "memory",
      TESTNET_RPC_URL: "http://localhost:8000/rpc",
      TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
      API_KEYS_FILE: secretFile(JSON.stringify({ schemaVersion: 1, keys })),
      SERVICE_FEE_PER_SETTLEMENT_USD: price,
    }),
    facilitator: {
      core: { getSupported: () => ({ kinds: [], extensions: [], signers: {} }) },
      networks: new Map(),
    } as unknown as StellarFacilitator,
    metrics: new Metrics(),
    log: silentLogger,
    readiness: () => Promise.resolve({ ready: true, checks: {} }),
    version: "test",
    settlementUsage: (subject, since) => ledger.usageSince(subject, since),
    callerCommitted: (network, subject) =>
      ledger.committedFeesSince(network, new Date(Date.now() - 3_600_000), subject),
  });
}

interface Usage {
  subject: string;
  keyId: string;
  serviceFee: { perSettlementUsd: string; accruedUsd: string; basis: string };
  networks: Record<
    string,
    {
      settlements: { succeeded: number; sponsoredFeeStroops: string; serviceFeeUsd: string };
      limits: Record<string, unknown>;
    }
  >;
}

const usage = async (service: ReturnType<typeof app>, key: string) =>
  (await (await service.request("/usage", { headers: { "x-api-key": key } })).json()) as Usage;

describe("metering from the settlement ledger", () => {
  it("keeps the price recorded at settlement after the price changes", async () => {
    const ledger = new MemorySettlementLedger();
    await settled(ledger, { caller: "key:alice-1", serviceFeeUsd: "0.01", fee: 1_000n });
    await settled(ledger, { caller: "key:alice-1", serviceFeeUsd: "0.01", fee: 2_000n });
    // The price rises; settlements already recorded keep theirs.
    const after = await usage(app(ledger, "0.05"), alice.key);
    expect(after.serviceFee).toEqual({
      perSettlementUsd: "0.05",
      accruedUsd: "0.0200000",
      basis: "per_settlement_recorded_price",
    });
    await settled(ledger, { caller: "key:alice-1", serviceFeeUsd: "0.05", fee: 3_000n });
    expect((await usage(app(ledger, "0.05"), alice.key)).serviceFee.accruedUsd).toBe("0.0700000");
  });

  it("shows a key only its own usage", async () => {
    const ledger = new MemorySettlementLedger();
    await settled(ledger, { caller: "key:alice-1", serviceFeeUsd: "0.01", fee: 1_000n });
    await settled(ledger, { caller: "key:bob-1", serviceFeeUsd: "0.01", fee: 9_000n });
    await settled(ledger, { caller: "public", serviceFeeUsd: "0", fee: 7_000n });
    const service = app(ledger, "0.01");
    const mine = await usage(service, bob.key);
    expect(mine).toMatchObject({ subject: "key:bob-1", keyId: "bob-1" });
    expect(mine.networks[NETWORK]?.settlements).toEqual(
      expect.objectContaining({ succeeded: 1, sponsoredFeeStroops: "9000", serviceFeeUsd: "0.0100000" }),
    );
    expect(mine.networks[NETWORK]?.limits).toMatchObject({
      requestsPerMinute: 30,
      sponsorBudgetStroopsPerHour: "10000000",
      // A finished settlement counts the fee it was charged, not its ceiling.
      sponsorCommitted1hStroops: "9000",
    });
  });

  it("never bills a failure or a payment another party landed, but counts the fees sponsored", async () => {
    const ledger = new MemorySettlementLedger();
    await settled(ledger, { caller: "key:alice-1", serviceFeeUsd: "0.01", fee: 1_000n });
    await settled(ledger, { caller: "key:alice-1", serviceFeeUsd: "0.01", fee: 2_000n, state: "failed" });
    await settled(ledger, {
      caller: "key:alice-1",
      serviceFeeUsd: "0.01",
      fee: 4_000n,
      settledBy: "third_party",
    });
    const report = await usage(app(ledger, "0.01"), alice.key);
    expect(report.networks[NETWORK]?.settlements).toEqual(
      expect.objectContaining({ succeeded: 1, sponsoredFeeStroops: "7000", serviceFeeUsd: "0.0100000" }),
    );
    expect(report.serviceFee.accruedUsd).toBe("0.0100000");
  });
});
