/**
 * Metering against Postgres (docker compose up -d postgres): settlements record their caller and the
 * service fee priced at the claim; the operator export reads them back per caller, network and day.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import {
  PostgresSettlementLedger,
  PostgresUsageMeter,
  createDatabase,
  migrate,
  type Database,
} from "@rail402.dev/store-postgres";
import { exportUsage, usageCsv } from "@rail402.dev/service";
import { settled } from "./metering-ledger.ts";
import { DATABASE_URL, createServiceSchema, dropServiceSchema } from "./service-harness.ts";

const USAGE = fileURLToPath(new URL("../src/usage.ts", import.meta.url));
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

describe("metering in Postgres", () => {
  let schema: string;
  let url: string;
  let db: Kysely<Database>;

  beforeAll(async () => {
    schema = await createServiceSchema();
    url = `${DATABASE_URL}?options=-c%20search_path%3D${schema}`;
    db = createDatabase({ connectionString: url, maxConnections: 4 });
    await migrate(db);
    const ledger = new PostgresSettlementLedger(db);
    await settled(ledger, { caller: "key:alice-1", serviceFeeUsd: "0.01", fee: 1_000n });
    await settled(ledger, { caller: "key:alice-1", serviceFeeUsd: "0.0125", fee: 2_000n });
    await settled(ledger, { caller: "key:alice-1", serviceFeeUsd: "0.01", fee: 5_000n, state: "failed" });
    await settled(ledger, {
      caller: "key:bob-1",
      serviceFeeUsd: "0.01",
      fee: 9_000n,
      settledBy: "third_party",
    });
    const meter = new PostgresUsageMeter(db);
    for (const amount of ["100", "250"]) {
      await meter.record({
        subject: "key:alice-1",
        network: "stellar:testnet",
        operation: "settle",
        outcome: "success",
        asset: ASSET,
        settledAmount: amount,
      });
    }
  });

  afterAll(async () => {
    await db.destroy();
    await dropServiceSchema(schema);
  });

  it("keeps the price recorded at settlement after the price changes", async () => {
    const [alice] = await new PostgresSettlementLedger(db).usageSince(
      "key:alice-1",
      new Date(Date.now() - 86_400_000),
    );
    expect(alice).toMatchObject({
      caller: "key:alice-1",
      network: "stellar:testnet",
      succeeded: 2,
      sponsoredFeeStroops: 8_000n,
      serviceFeeUsd: "0.0225000",
    });
  });

  it("exports usage per caller, network and day, never billing what Rail402 did not land", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const rows = await exportUsage(db, { from: day, to: day });
    expect(rows).toEqual([
      {
        day,
        caller: "key:alice-1",
        network: "stellar:testnet",
        settlements: 2,
        amounts: [{ asset: ASSET, amount: "350" }],
        sponsoredFeeStroops: "8000",
        serviceFeeUsd: "0.0225000",
      },
      {
        day,
        caller: "key:bob-1",
        network: "stellar:testnet",
        settlements: 0,
        amounts: [],
        sponsoredFeeStroops: "9000",
        serviceFeeUsd: "0.0000000",
      },
    ]);
    expect(usageCsv(rows).split("\n")[1]).toBe(
      `${day},key:alice-1,stellar:testnet,2,${ASSET}=350,8000,0.0225000`,
    );
    const only = await exportUsage(db, { from: day, to: day, caller: "key:bob-1" });
    expect(only.map((row) => row.caller)).toEqual(["key:bob-1"]);
  });

  it("serves the export from the command line", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [
          "--conditions=@rail402/source",
          USAGE,
          "export",
          "--from",
          day,
          "--to",
          day,
          "--key",
          "alice-1",
          "--format",
          "json",
        ],
        { env: { PATH: process.env["PATH"] ?? "", DATABASE_URL: url } },
        (error, stdout, stderr) => {
          resolve({
            code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
            stdout,
            stderr,
          });
        },
      );
    });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({ caller: "key:alice-1", settlements: 2 }),
    ]);
  });
});
