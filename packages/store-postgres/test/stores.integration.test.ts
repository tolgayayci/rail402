/**
 * Runs the facilitator's store conformance suites against Postgres (docker compose up -d postgres).
 * Each suite gets its own schema, so runs never share state.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { channelPoolSuite, settlementLedgerSuite } from "@rail402.dev/facilitator/testing";
import { catalogSuite } from "@rail402.dev/bazaar/testing";
import {
  PostgresCatalogStore,
  PostgresChannelPool,
  PostgresRateLimiter,
  PostgresUsageMeter,
  PostgresSettlementLedger,
  createDatabase,
  migrate,
  type Database,
} from "@rail402.dev/store-postgres";

const URL = process.env["RAIL402_TEST_DATABASE_URL"] ?? "postgres://rail402:rail402@localhost:5432/rail402";
const opened: Kysely<Database>[] = [];

async function freshDatabase(): Promise<Kysely<Database>> {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
  await admin.destroy();
  const db = createDatabase({ connectionString: URL, schema, maxConnections: 20 });
  await migrate(db);
  opened.push(db);
  return db;
}

// Every test opens its own schema and pool: close the previous test's pools so the suite stays well
// under the server's connection limit.
beforeEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.destroy()));
});

afterAll(async () => {
  const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
  const schemas = await sql<{ nspname: string }>`
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'test\\_%'`.execute(admin);
  await Promise.all(opened.map((db) => db.destroy()));
  for (const { nspname } of schemas.rows) await sql`DROP SCHEMA ${sql.id(nspname)} CASCADE`.execute(admin);
  await admin.destroy();
});

settlementLedgerSuite("postgres", async () => {
  const db = await freshDatabase();
  return {
    ledger: new PostgresSettlementLedger(db),
    expireClaims: async () => {
      await sql`UPDATE settlements SET claim_expires_at = now() - interval '1 hour'`.execute(db);
    },
  };
});

channelPoolSuite("postgres", async (addresses) =>
  PostgresChannelPool.open(await freshDatabase(), {
    network: "stellar:testnet",
    addresses,
    retryIntervalMs: 20,
  }),
);

catalogSuite("postgres", async () => ({ store: new PostgresCatalogStore(await freshDatabase()) }));

describe("postgres: access control", () => {
  it("limits each client key per minute, shared by every limiter instance", async () => {
    const db = await freshDatabase();
    const [a, b] = [new PostgresRateLimiter(db, 3), new PostgresRateLimiter(db, 3)];
    const results = await Promise.all([a.take("ip-1"), b.take("ip-1"), a.take("ip-1"), b.take("ip-1")]);
    expect(results.filter((retry) => retry === 0)).toHaveLength(3);
    expect(results.find((retry) => retry > 0)).toBeGreaterThan(0);
    expect(await a.take("ip-2")).toBe(0);
    await a.sweep();
    expect(await new PostgresRateLimiter(db, 0).take("ip-1")).toBe(0);
  });

  it("meters usage per subject and day", async () => {
    const db = await freshDatabase();
    const meter = new PostgresUsageMeter(db);
    const event = { subject: "key:abc", network: "stellar:testnet", asset: "CUSDC", settledAmount: "0" };
    await meter.record({ ...event, operation: "verify", outcome: "valid" });
    await meter.record({ ...event, operation: "settle", outcome: "success", settledAmount: "150000" });
    await meter.record({ ...event, operation: "settle", outcome: "success", settledAmount: "50000" });
    await meter.record({
      ...event,
      subject: "public",
      operation: "settle",
      outcome: "success",
      settledAmount: "1",
    });
    const rows = await meter.usage("key:abc", 31);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.operation === "settle")).toMatchObject({
      outcome: "success",
      requests: 2,
      settledAmount: "200000",
    });
    expect(rows[0]?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("connection pool", () => {
  it("survives the server closing its idle connections, as in a restart or failover", async () => {
    const schema = `test_${randomBytes(6).toString("hex")}`;
    const idleErrors: Error[] = [];
    const db = createDatabase({
      connectionString: URL,
      schema,
      maxConnections: 2,
      onIdleError: (error) => idleErrors.push(error),
    });
    opened.push(db);
    const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db);
    const backend = pid.rows[0]?.pid;

    const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
    await sql`SELECT pg_terminate_backend(${backend})`.execute(admin);
    await admin.destroy();

    await vi.waitFor(() => {
      expect(idleErrors).toHaveLength(1);
    });
    const after = await sql<{ one: number }>`SELECT 1 AS one`.execute(db);
    expect(after.rows).toEqual([{ one: 1 }]);
  });
});
