/**
 * Reads the public data lake and the public testnet RPC, read-only. Runs only with
 * RAIL402_LIVE_LEDGERS=1, since it needs the internet.
 */
import { describe, expect, it } from "vitest";
import { DataLakeSource, RpcLedgerSource, verifyHashChain, verifyLedger } from "../src/index.ts";

const live = process.env["RAIL402_LIVE_LEDGERS"] === "1";
const TESTNET_RPC = "https://soroban-testnet.stellar.org";

describe.skipIf(!live)("live ledger sources", () => {
  it("reads the same verified ledgers from the data lake and the RPC", async () => {
    const lake = new DataLakeSource({
      folder: "testnet/2025-12-18",
      passphrase: "Test SDF Network ; September 2015",
    });
    const rpc = new RpcLedgerSource({ url: TESTNET_RPC });
    const start = (await rpc.latestLedger()) - 40;
    const fromRpc = await rpc.getLedgers(start, 3);
    const fromLake = await Promise.all(
      [start, start + 1, start + 2].map((sequence) => lake.getLedger(sequence)),
    );
    const lakeVerified = fromLake.map((ledger) => {
      if (ledger === undefined) throw new Error("the data lake lags more than 40 ledgers");
      return verifyLedger(ledger.meta);
    });
    verifyHashChain(lakeVerified);
    expect(fromRpc.map((ledger) => verifyLedger(ledger.meta).hash)).toEqual(
      lakeVerified.map((ledger) => ledger.hash),
    );
    expect(await lake.latestLedger(start)).toBeGreaterThanOrEqual(start + 2);
  });

  it("holds the pubnet partition the backfill starts from", async () => {
    const lake = new DataLakeSource({
      folder: "pubnet",
      passphrase: "Public Global Stellar Network ; September 2015",
    });
    const ledger = await lake.getLedger(61_440_001);
    expect(ledger === undefined ? undefined : verifyLedger(ledger.meta).ledger).toBe(61_440_001);
  });
});
