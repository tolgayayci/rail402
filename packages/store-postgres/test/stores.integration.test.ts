/**
 * Runs the facilitator's store conformance suites against Postgres (docker compose up -d postgres).
 * Each suite gets its own schema, so runs never share state.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import { channelPoolSuite, settlementLedgerSuite } from "@rail402.dev/facilitator/testing";
import { catalogSuite } from "@rail402.dev/bazaar/testing";
import {
  PostgresCatalogStore,
  PostgresChannelPool,
  PostgresRateLimiter,
  PostgresUsageMeter,
  PostgresSettlementLedger,
  PostgresTaskLock,
  MIGRATIONS_DIRECTORY,
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

describe("postgres: settlements recorded before request fingerprints", () => {
  it("compare the signed transaction alone, so they keep answering repeats", async () => {
    const db = await freshDatabase();
    const ledger = new PostgresSettlementLedger(db);
    const key = { network: "stellar:testnet", payer: "GLEGACY", nonce: "1" };
    const id = "00000000-0000-4000-8000-000000000001";
    // A row as the previous release wrote it: no request_hash, fee or settled_by.
    await sql`INSERT INTO settlements (id, network, payer, nonce, payload_hash, state, owner, claim_expires_at,
                channel, transaction_hash, envelope_xdr, valid_until, response)
              VALUES (${id}, ${key.network}, ${key.payer}, ${key.nonce}, 'payload', 'succeeded', 'old',
                now(), 'GCHANNEL', ${"f".repeat(64)}, 'AAAA', 1700000000, '{"success":true}')`.execute(db);

    const found = await ledger.find(key);
    expect(found).toMatchObject({ id, state: "succeeded", payloadHash: "payload" });
    expect(found?.requestHash).toBeUndefined();
    expect(found?.settledBy).toBeUndefined();
    expect(
      await ledger.claim(key, { payloadHash: "payload", requestHash: "terms" }, "new", 60_000),
    ).toMatchObject({ kind: "existing", record: { id } });
    expect(
      (await ledger.claim(key, { payloadHash: "other", requestHash: "terms" }, "new", 60_000)).kind,
    ).toBe("conflict");
  });
});

describe("postgres: migrations", () => {
  it("apply once when several replicas start on an empty schema at the same moment", async () => {
    const schema = `test_${randomBytes(6).toString("hex")}`;
    const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    await admin.destroy();
    const replicas = Array.from({ length: 4 }, () =>
      createDatabase({ connectionString: URL, schema, maxConnections: 2 }),
    );
    opened.push(...replicas);
    const applied = await Promise.all(replicas.map((db) => migrate(db)));
    const total = applied.flat();
    expect(total.length).toBeGreaterThan(0);
    // Every migration was applied by exactly one replica.
    expect(new Set(total).size).toBe(total.length);
    const recorded = await sql<{ n: string }>`SELECT count(*)::text AS n FROM schema_migrations`.execute(
      replicas[0] as Kysely<Database>,
    );
    expect(Number(recorded.rows[0]?.n)).toBe(total.length);
  });
});

describe("postgres: MCP tools published before origin checks covered them", () => {
  it("are queued for an origin check, so a tool's own server confirms or withdraws them", async () => {
    const schema = `test_${randomBytes(6).toString("hex")}`;
    const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    await admin.destroy();
    const db = createDatabase({ connectionString: URL, schema, maxConnections: 2 });
    opened.push(db);
    // The schema as the previous release left it.
    const previous = await mkdtemp(join(tmpdir(), "rail402-migrations-"));
    try {
      for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
        if (name.endsWith(".sql") && name < "0013") {
          await copyFile(join(MIGRATIONS_DIRECTORY, name), join(previous, name));
        }
      }
      await migrate(db, `${previous}/`);
    } finally {
      await rm(previous, { recursive: true, force: true });
    }
    const legacy = async (kind: string, resource: string, confirmed: boolean) => {
      const id = randomUUID();
      await sql`INSERT INTO listings (id, network, kind, resource, method, tool_name, scope, owner, trust,
                  state, version, content, content_hash, first_cataloged_at, last_updated, last_settled_at,
                  settlements, listed_at)
                VALUES (${id}, 'stellar:testnet', ${kind}, ${resource}, '', 'forecast', 'GOWNER', 'GOWNER',
                  ${confirmed ? "origin_verified" : "settled"}, 'published', 1, '{}', 'hash', now(), now(),
                  now(), 1, now())`.execute(db);
      await sql`INSERT INTO listing_versions (listing_id, version, created_at, cause, owner, trust, state, content)
                VALUES (${id}, 1, now(), ${confirmed ? "origin_verification" : "settlement"}, 'GOWNER',
                  'settled', 'published', '{}')`.execute(db);
      return id;
    };
    const unchecked = await legacy("mcp", "https://tools.example.com/mcp", false);
    await legacy("mcp", "mcp://tool/forecast", false);
    await legacy("mcp", "https://checked.example.com/mcp", true);

    await migrate(db);
    const checks = await sql<{ listing_id: string; url: string }>`
      SELECT listing_id, url FROM origin_checks`.execute(db);
    expect(checks.rows).toEqual([{ listing_id: unchecked, url: "https://tools.example.com/mcp" }]);
  });
});

describe("postgres: task lock", () => {
  it("runs a named task on one replica at a time and frees the lock after it, even when it fails", async () => {
    const [first, second] = [await freshDatabase(), await freshDatabase()];
    const [a, b] = [new PostgresTaskLock(first), new PostgresTaskLock(second)];
    // Advisory locks are database-wide, so the name is unique to this run.
    const name = `test-lock:${randomBytes(6).toString("hex")}`;
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = a.run(
      name,
      () =>
        new Promise<string>((resolve) => {
          started();
          release = () => {
            resolve("first");
          };
        }),
    );
    await running;
    expect(await b.run(name, () => Promise.resolve("second"))).toBeUndefined();
    expect(await b.run(`${name}:other`, () => Promise.resolve("other"))).toBe("other");
    release();
    expect(await held).toBe("first");
    await expect(b.run(name, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await a.run(name, () => Promise.resolve("again"))).toBe("again");
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
