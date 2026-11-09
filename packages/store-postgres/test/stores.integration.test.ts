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
  Catalog,
  SchemaSandbox,
  paymentRequiredFor,
  randomAddress,
  randomContract,
  settledPayment,
  type OriginResponse,
} from "@rail402.dev/bazaar";
import {
  PostgresCatalogStore,
  PostgresChannelPool,
  PostgresRateLimiter,
  PostgresUsageMeter,
  PostgresSettlementLedger,
  PostgresTaskLock,
  PostgresIssuedKeys,
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

/** The rate-limit window counts written for `key`. */
async function written(db: Kysely<Database>, key: string): Promise<number[]> {
  const { rows } = await sql<{ count: number }>`
    SELECT count FROM rate_limit_windows WHERE key = ${key} ORDER BY window_start`.execute(db);
  return rows.map((row) => row.count);
}

/** Waits, when needed, until at least `seconds` are left of the database's current minute. */
async function minuteLeft(db: Kysely<Database>, seconds: number): Promise<void> {
  const { rows } = await sql<{ left_ms: number }>`
    SELECT (extract(epoch FROM date_trunc('minute', now()) + interval '1 minute' - now()) * 1000)::float8
      AS left_ms`.execute(db);
  const left = rows[0]?.left_ms ?? 60_000;
  if (left < seconds * 1_000) await new Promise((resolve) => setTimeout(resolve, left + 500));
}

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

  it("refuses a key over its limit from memory, without another write, until its window ends", async () => {
    const db = await freshDatabase();
    // Clear of a minute boundary, so every write below lands in one window.
    await minuteLeft(db, 5);
    let now = 1_000_000;
    const limiter = new PostgresRateLimiter(db, 2, () => now);
    expect([await limiter.take("ip-9"), await limiter.take("ip-9")]).toEqual([0, 0]);
    const retry = await limiter.take("ip-9");
    expect(retry).toBeGreaterThan(0);
    // Past the limit: refused at once, with what is left of the window, and nothing more written.
    for (let i = 0; i < 5; i++) expect(await limiter.take("ip-9")).toBe(retry);
    expect(await written(db, "ip-9")).toEqual([3]);
    // Another limit on the same key is decided by the database.
    expect(await limiter.takeLimit("ip-9", 10)).toBe(0);
    expect(await written(db, "ip-9")).toEqual([4]);
    // Once the window's time is up on this clock, the database decides again.
    now += retry * 1_000;
    expect(await limiter.take("ip-9")).toBeGreaterThan(0);
    expect(await written(db, "ip-9")).toEqual([5]);
  });

  it("never refuses from memory past the window's end, however long the refused write waited", async () => {
    const db = await freshDatabase();
    await minuteLeft(db, 15);
    let skip = 0;
    const limiter = new PostgresRateLimiter(db, 1, () => performance.now() + skip);
    expect(await limiter.take("ip-7")).toBe(0);
    // Another transaction holds the key's row: the next write starts now and waits 3 seconds for it.
    const holding = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const lock = db.transaction().execute(async (trx) => {
      await sql`UPDATE rate_limit_windows SET count = count WHERE key = 'ip-7'`.execute(trx);
      holding.resolve(undefined);
      await release.promise;
    });
    await holding.promise;
    const refused = limiter.take("ip-7");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    release.resolve(undefined);
    await lock;
    expect(await refused).toBeGreaterThan(0);
    expect(await written(db, "ip-7")).toEqual([2]);
    // This process's clock moves to just past the window's end as the database counts it: the memory
    // has run out, and the database decides (still in its own window, it counts and refuses).
    const { rows } = await sql<{ left_ms: number }>`
      SELECT (extract(epoch FROM date_trunc('minute', now()) + interval '1 minute' - now()) * 1000)::float8
        AS left_ms`.execute(db);
    skip = (rows[0]?.left_ms ?? 0) + 100;
    expect(await limiter.take("ip-7")).toBeGreaterThan(0);
    expect(await written(db, "ip-7")).toEqual([3]);
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

describe("postgres: keys issued through sign-in", () => {
  const request = (account: string, digest = randomBytes(32).toString("hex")) => ({
    id: `gh-${account}`,
    githubUserId: account,
    githubLogin: `user${account}`,
    sha256: digest,
    networks: ["stellar:pubnet"],
    requestsPerMinute: 60,
    sponsorBudgetStroopsPerHour: 5_000_000n,
    lifetimeDays: 90,
  });
  const open = { perHour: 100, reissueSeconds: 0 };

  it("keeps one key per account, replacing its digest and counting the keys issued", async () => {
    const keys = new PostgresIssuedKeys(await freshDatabase());
    const first = await keys.issue(request("1", "a".repeat(64)), open);
    expect(first).toMatchObject({ kind: "issued", row: { id: "gh-1", issuedCount: 1, revoked: false } });
    const second = await keys.issue(request("1", "b".repeat(64)), open);
    expect(second).toMatchObject({ kind: "issued", row: { sha256: "b".repeat(64), issuedCount: 2 } });
    const rows = await keys.list();
    expect(rows.map((row) => [row.id, row.sha256])).toEqual([["gh-1", "b".repeat(64)]]);
    expect(rows[0]?.sponsorBudgetStroopsPerHour).toBe(5_000_000n);
    const lifetime = (rows[0]?.expiresAt.getTime() ?? 0) - (rows[0]?.createdAt.getTime() ?? 0);
    expect(lifetime).toBe(90 * 86_400_000);
  });

  it("waits the interval between two keys of one account and stops at the hourly cap", async () => {
    const keys = new PostgresIssuedKeys(await freshDatabase());
    await keys.issue(request("1"), open);
    const soon = await keys.issue(request("1"), { perHour: 100, reissueSeconds: 3_600 });
    expect(soon.kind).toBe("too_soon");
    expect(soon.kind === "too_soon" && soon.retryAfterSeconds).toBeGreaterThan(3_590);
    await keys.issue(request("2"), open);
    expect(await keys.issue(request("3"), { perHour: 2, reissueSeconds: 0 })).toEqual({
      kind: "cap_reached",
    });
  });

  it("holds the cap across concurrent sign-ins", async () => {
    const keys = new PostgresIssuedKeys(await freshDatabase());
    const outcomes = await Promise.all(
      ["1", "2", "3", "4", "5", "6"].map((account) =>
        keys.issue(request(account), { perHour: 3, reissueSeconds: 0 }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.kind === "issued")).toHaveLength(3);
    expect(outcomes.filter((outcome) => outcome.kind === "cap_reached")).toHaveLength(3);
  });

  it("blocks a revoked account until it is restored, by id or by login", async () => {
    const keys = new PostgresIssuedKeys(await freshDatabase());
    await keys.issue(request("1"), open);
    expect(await keys.setRevoked("USER1", true)).toBe(true);
    expect((await keys.list())[0]?.revoked).toBe(true);
    expect(await keys.issue(request("1"), open)).toEqual({ kind: "revoked" });
    expect(await keys.setRevoked("gh-1", false)).toBe(true);
    expect((await keys.issue(request("1"), open)).kind).toBe("issued");
    expect(await keys.setRevoked("nobody", true)).toBe(false);
  });

  it("lists unexpired keys only, and lists every key for the operator", async () => {
    const db = await freshDatabase();
    const keys = new PostgresIssuedKeys(db);
    await keys.issue(request("1"), open);
    await keys.issue(request("2"), open);
    await db
      .updateTable("issued_access_keys")
      .set({ expires_at: new Date(Date.now() - 1_000), created_at: new Date(Date.now() - 2_000) })
      .where("id", "=", "gh-1")
      .execute();
    expect((await keys.list()).map((row) => row.id)).toEqual(["gh-2"]);
    expect((await keys.all()).map((row) => row.id).sort()).toEqual(["gh-1", "gh-2"]);
  });

  it("refuses a digest used by another account", async () => {
    const keys = new PostgresIssuedKeys(await freshDatabase());
    await keys.issue(request("1", "c".repeat(64)), open);
    await expect(keys.issue(request("2", "c".repeat(64)), open)).rejects.toThrow();
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
    // The settle attempt id: absent on rows written before it, kept from the claim that started one.
    expect(found?.attempt).toBeUndefined();
    const started = { network: "stellar:testnet", payer: "GATTEMPT", nonce: "2" };
    const fingerprint = { payloadHash: "payload", requestHash: "terms" };
    const claimed = await ledger.claim(started, fingerprint, "first", 60_000, {
      attempt: "first-attempt-id-0001",
    });
    expect(claimed).toMatchObject({ kind: "claimed", record: { attempt: "first-attempt-id-0001" } });
    expect(
      await ledger.claim(started, fingerprint, "second", 60_000, { attempt: "later-attempt-id-0002" }),
    ).toMatchObject({ kind: "existing", record: { attempt: "first-attempt-id-0001" } });
    expect(await ledger.find(started)).toMatchObject({ attempt: "first-attempt-id-0001" });
  });
});

describe("postgres: channel leases", () => {
  it("never lease a channel whose recorded settlement is still open, released or expired", async () => {
    const db = await freshDatabase();
    const ledger = new PostgresSettlementLedger(db);
    const pool = await PostgresChannelPool.open(db, {
      network: "stellar:testnet",
      addresses: ["GCHANNEL"],
      leaseTtlMs: 50,
      retryIntervalMs: 10,
    });
    const leased = await pool.acquire(0);
    expect(leased).toBe("GCHANNEL");
    const { record } = await ledger.claim(
      { network: "stellar:testnet", payer: "GOPEN", nonce: "1" },
      { payloadHash: "p", requestHash: "r" },
      "o",
      60_000,
    );
    await ledger.recordEnvelope(record.id, "o", {
      channel: "GCHANNEL",
      transactionHash: "a".repeat(64),
      innerTransactionHash: "b".repeat(64),
      envelopeXdr: "AAAA",
      validUntil: 1_700_000_000,
      maxFeeStroops: "1000",
    });
    // Released while its settlement is open (a double lease left it so), then past the lease TTL.
    await pool.release("GCHANNEL");
    expect(await pool.acquire(0)).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await pool.acquire(0)).toBeUndefined();
    await ledger.finish(record.id, "failed", { success: false, transaction: "", network: "stellar:testnet" });
    expect(await pool.acquire(0)).toBe("GCHANNEL");
  });

  it("lease a channel again once its open settlement gave it back", async () => {
    const db = await freshDatabase();
    const ledger = new PostgresSettlementLedger(db);
    const pool = await PostgresChannelPool.open(db, {
      network: "stellar:testnet",
      addresses: ["GCHANNEL"],
      retryIntervalMs: 10,
    });
    expect(await pool.acquire(0)).toBe("GCHANNEL");
    const { record } = await ledger.claim(
      { network: "stellar:testnet", payer: "GWAITING", nonce: "1" },
      { payloadHash: "p", requestHash: "r" },
      "o",
      60_000,
    );
    await ledger.recordEnvelope(record.id, "o", {
      channel: "GCHANNEL",
      transactionHash: "c".repeat(64),
      innerTransactionHash: "d".repeat(64),
      envelopeXdr: "AAAA",
      validUntil: 1_700_000_000,
      maxFeeStroops: "1000",
    });
    await pool.release("GCHANNEL");
    expect(await pool.acquire(0)).toBeUndefined();
    // Its bytes can never apply: the settlement gives the channel back while its outcome waits.
    expect(await ledger.releaseChannel(record.id)).toBe(true);
    expect(await pool.acquire(0)).toBe("GCHANNEL");
    expect((await ledger.get(record.id))?.state).toBe("submitted");
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

describe("postgres: restores of the settlement ledger", () => {
  it("hold each network from the first ledger it reports after the latest one, and none before any", async () => {
    const db = await freshDatabase();
    const ledger = new PostgresSettlementLedger(db);
    expect(await ledger.rewindLedger("stellar:pubnet", 100)).toBeUndefined();
    await sql`INSERT INTO settlement_rewinds (reason) VALUES ('restore')`.execute(db);
    expect(await ledger.rewindLedger("stellar:pubnet", 200)).toBe(200);
    expect(await ledger.rewindLedger("stellar:pubnet", 300)).toBe(200);
    expect(await ledger.rewindLedger("stellar:testnet", 300)).toBe(300);
    // A newer restore starts again, and replicas that see it at the same moment agree on one ledger.
    await sql`INSERT INTO settlement_rewinds (reason) VALUES ('point-in-time recovery')`.execute(db);
    const replica = new PostgresSettlementLedger(db);
    const seen = await Promise.all([
      ledger.rewindLedger("stellar:pubnet", 400),
      replica.rewindLedger("stellar:pubnet", 401),
    ]);
    expect(seen[0]).toBe(seen[1]);
    expect([400, 401]).toContain(seen[0]);
    expect(await ledger.rewindLedger("stellar:testnet", 402)).toBe(402);
  });

  it("read where the hold counts from without recording anything", async () => {
    const db = await freshDatabase();
    const ledger = new PostgresSettlementLedger(db);
    expect(await ledger.rewindAnchor("stellar:pubnet")).toBeUndefined();
    await sql`INSERT INTO settlement_rewinds (reason) VALUES ('restore')`.execute(db);
    expect(await ledger.rewindAnchor("stellar:pubnet")).toBeNull();
    expect(await ledger.rewindAnchor("stellar:pubnet")).toBeNull();
    await ledger.rewindLedger("stellar:pubnet", 1_000);
    expect(await ledger.rewindAnchor("stellar:pubnet")).toBe(1_000);
    expect(await ledger.rewindAnchor("stellar:testnet")).toBeNull();
  });

  it("start the hold again from a network whose ledgers count from the start again", async () => {
    const db = await freshDatabase();
    const ledger = new PostgresSettlementLedger(db);
    await sql`INSERT INTO settlement_rewinds (reason) VALUES ('restore')`.execute(db);
    expect(await ledger.rewindLedger("stellar:testnet", 2_000_000, 307)).toBe(2_000_000);
    // A ledger more than a hold below the recorded one means the network was reset.
    expect(await ledger.rewindLedger("stellar:testnet", 500, 307)).toBe(500);
    expect(await ledger.rewindLedger("stellar:testnet", 600, 307)).toBe(500);
    // A reading a few ledgers behind the recorded one (another replica's fresher one) keeps it.
    expect(await ledger.rewindLedger("stellar:testnet", 490, 307)).toBe(500);
  });

  it("count a database that held settlements before restores were recorded as just restored", async () => {
    // It may be a restore of a dump taken before the record existed, which could not record itself.
    const schema = `test_${randomBytes(6).toString("hex")}`;
    const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    await admin.destroy();
    const db = createDatabase({ connectionString: URL, schema, maxConnections: 2 });
    opened.push(db);
    const previous = await mkdtemp(join(tmpdir(), "rail402-migrations-"));
    try {
      for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
        if (name.endsWith(".sql") && name < "0032") {
          await copyFile(join(MIGRATIONS_DIRECTORY, name), join(previous, name));
        }
      }
      await migrate(db, `${previous}/`);
    } finally {
      await rm(previous, { recursive: true, force: true });
    }
    const ledger = new PostgresSettlementLedger(db);
    await ledger.claim(
      { network: "stellar:pubnet", payer: "GPAYER", nonce: "1" },
      { payloadHash: "p", requestHash: "r" },
      "o",
      60_000,
      { scheme: "upto", amount: "0" },
    );
    await migrate(db);
    const rewinds = await sql<{ reason: string }>`SELECT reason FROM settlement_rewinds`.execute(db);
    expect(rewinds.rows).toEqual([{ reason: "migration" }]);
    expect(await ledger.rewindLedger("stellar:pubnet", 500)).toBe(500);
  });

  it("count a database migrated before restores were recorded as just restored, even with no settlements", async () => {
    const schema = `test_${randomBytes(6).toString("hex")}`;
    const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    await admin.destroy();
    const db = createDatabase({ connectionString: URL, schema, maxConnections: 2 });
    opened.push(db);
    const previous = await mkdtemp(join(tmpdir(), "rail402-migrations-"));
    try {
      for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
        if (name.endsWith(".sql") && name < "0032") {
          await copyFile(join(MIGRATIONS_DIRECTORY, name), join(previous, name));
        }
      }
      await migrate(db, `${previous}/`);
    } finally {
      await rm(previous, { recursive: true, force: true });
    }
    // Created a day ago, as a dump restored from then would show; a new database migrates at once.
    await sql`UPDATE schema_migrations SET applied_at = applied_at - interval '1 day'`.execute(db);
    await migrate(db);
    const rewinds = await sql<{ reason: string }>`SELECT reason FROM settlement_rewinds`.execute(db);
    expect(rewinds.rows).toEqual([{ reason: "migration" }]);
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

describe("postgres: origin checks requested before they kept candidates", () => {
  const sandbox = new SchemaSandbox();
  afterAll(async () => {
    await sandbox.close();
  });

  it("try the path of the owner's settlement that joined a claim's check", async () => {
    const db = await freshDatabase();
    const store = new PostgresCatalogStore(db);
    const answers = new Map<string, OriginResponse>();
    const catalog = new Catalog({
      store,
      sandbox,
      fetchOrigin: (url) => Promise.resolve(answers.get(url) ?? { kind: "unreachable", reason: "offline" }),
    });
    const seller = randomAddress();
    const item = {
      url: "https://items.example.com/items/42",
      payTo: seller,
      routeTemplate: "/items/:id",
      pathParams: { id: "42" },
    };
    const id = (await catalog.record(settledPayment(item)))?.listingId ?? "";
    await catalog.record(settledPayment({ ...item, payTo: randomAddress() }));
    // The check as the previous release left it: a claim's check its owner's settlement joined, with
    // that settlement's path and payment, and no candidates.
    await sql`ALTER TABLE origin_checks DROP COLUMN candidates, DROP COLUMN retry_at`.execute(db);
    await sql`DELETE FROM schema_migrations WHERE name = '0033_origin_check_candidates.sql'`.execute(db);
    await migrate(db);
    const [check] = await store.dueOriginChecks(10);
    expect(check?.reason).toBe("owner_conflict");
    expect(check?.candidates?.map(({ url, settled }) => [url, settled?.payTo])).toEqual([[item.url, seller]]);

    answers.set(item.url, { kind: "payment_required", paymentRequired: paymentRequiredFor(item) });
    await catalog.checkOrigins();
    expect(await store.get(id)).toMatchObject({ owner: seller, state: "published" });
  });
});

describe("postgres: checks over a small host budget", () => {
  const sandbox = new SchemaSandbox();
  afterAll(async () => {
    await sandbox.close();
  });

  it("go on from the paths earlier runs found refused, never asking one twice", async () => {
    const db = await freshDatabase();
    const store = new PostgresCatalogStore(db);
    let now = Date.now();
    const asked: string[] = [];
    const answers = new Map<string, OriginResponse>();
    const catalog = new Catalog({
      store,
      sandbox,
      now: () => new Date(now),
      originChecksPerHostPerMinute: 2,
      fetchOrigin: (url) => {
        asked.push(url);
        return Promise.resolve(answers.get(url) ?? { kind: "not_payment_required", status: 404 });
      },
    });
    const seller = randomAddress();
    const item = (id: string, fixture: Parameters<typeof settledPayment>[0] = {}) => ({
      url: `https://items.example.com/items/${id}`,
      payTo: seller,
      routeTemplate: "/items/:id",
      pathParams: { id },
      ...fixture,
    });
    // Large payments of a token worth nothing, at paths the seller does not sell, before a buyer's.
    const junk = randomContract();
    let id = "";
    for (const path of ["x1", "x2", "x3"]) {
      const outcome = await catalog.record(settledPayment(item(path, { asset: junk, amount: "1000000000" })));
      id ||= outcome?.listingId ?? "";
    }
    answers.set(item("42").url, {
      kind: "payment_required",
      paymentRequired: paymentRequiredFor(item("42")),
    });
    await catalog.record(settledPayment(item("42")));
    await catalog.checkOrigins();
    expect(await store.get(id)).toMatchObject({ state: "pending" });
    expect(await store.dueOriginChecks(10)).toEqual([]);
    // A minute later.
    now += 61_000;
    await sql`UPDATE origin_checks SET due_at = now()`.execute(db);
    await catalog.checkOrigins();
    expect(await store.get(id)).toMatchObject({
      state: "published",
      content: { bazaar: { info: { input: { pathParams: { id: "42" } } } } },
    });
    expect(asked).toEqual(["x1", "x2", "x3", "42"].map((path) => item(path).url));
  });
});

describe("postgres: a pending listing's retry schedule", () => {
  const sandbox = new SchemaSandbox();
  afterAll(async () => {
    await sandbox.close();
  });

  it("holds however often its owner is paid while its origin fails", async () => {
    const db = await freshDatabase();
    const store = new PostgresCatalogStore(db);
    const answers = new Map<string, OriginResponse>();
    const catalog = new Catalog({
      store,
      sandbox,
      fetchOrigin: (url) => Promise.resolve(answers.get(url) ?? { kind: "unreachable", reason: "offline" }),
    });
    /** Moves the check's schedule `seconds` into the past, as if that much time went by. */
    const later = (seconds: number) =>
      sql`UPDATE origin_checks SET due_at = due_at - make_interval(secs => ${seconds}),
        retry_at = retry_at - make_interval(secs => ${seconds}),
        claimed_until = claimed_until - make_interval(secs => ${seconds})`.execute(db);
    const item = {
      url: "https://items.example.com/items/42",
      payTo: randomAddress(),
      routeTemplate: "/items/:id",
      pathParams: { id: "42" },
    };
    answers.set(item.url, { kind: "not_payment_required", status: 503 });
    const id = (await catalog.record(settledPayment(item)))?.listingId ?? "";
    // A payer pays the seller one unit six times, 20 seconds apart, while the path fails for now.
    for (let payment = 0; payment < 6; payment++) {
      await catalog.record(settledPayment({ ...item, amount: "1" }));
      await catalog.checkOrigins();
      await later(20);
    }
    expect(await store.get(id)).toMatchObject({ state: "pending" });
    expect((await store.versions(id)).map((version) => version.cause)).toEqual(["settlement"]);
    // The origin is back: the scheduled retry, 5 minutes after the second, lists it with no settlement.
    answers.set(item.url, { kind: "payment_required", paymentRequired: paymentRequiredFor(item) });
    for (let minute = 0; minute < 6; minute++) {
      await catalog.checkOrigins();
      await later(60);
    }
    expect(await store.get(id)).toMatchObject({ state: "published" });
  });
});

describe("postgres: settlements observed before their payee was recorded", () => {
  it("are attributed to the listing's owner when they were observed, so usage counts only the current owner's", async () => {
    const schema = `test_${randomBytes(6).toString("hex")}`;
    const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    await admin.destroy();
    const db = createDatabase({ connectionString: URL, schema, maxConnections: 2 });
    opened.push(db);
    const previous = await mkdtemp(join(tmpdir(), "rail402-migrations-"));
    try {
      for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
        if (name.endsWith(".sql") && name < "0026") {
          await copyFile(join(MIGRATIONS_DIRECTORY, name), join(previous, name));
        }
      }
      await migrate(db, `${previous}/`);
    } finally {
      await rm(previous, { recursive: true, force: true });
    }
    // A listing first owned by GFIRST, transferred to GSECOND by an origin check an hour later.
    const id = randomUUID();
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes));
    await sql`INSERT INTO listings (id, network, kind, resource, method, tool_name, scope, owner, trust,
                state, version, content, content_hash, first_cataloged_at, last_updated, last_settled_at,
                settlements, listed_at)
              VALUES (${id}, 'stellar:testnet', 'http', 'https://api.example.com/w', 'GET', '', '',
                'GSECOND', 'origin_verified', 'published', 2, '{"accepts":[]}', 'hash', ${at(0)},
                ${at(30)}, ${at(45)}, 2, ${at(0)})`.execute(db);
    for (const [version, owner, minutes] of [
      [1, "GFIRST", 0],
      [2, "GSECOND", 30],
    ] as const) {
      await sql`INSERT INTO listing_versions (listing_id, version, created_at, cause, owner, trust, state, content)
                VALUES (${id}, ${version}, ${at(minutes)}, 'settlement', ${owner}, 'settled', 'published',
                  '{}')`.execute(db);
    }
    for (const [transaction, minutes] of [
      ["a".repeat(64), 0],
      ["b".repeat(64), 10],
      ["c".repeat(64), 45],
    ] as const) {
      await sql`INSERT INTO listing_observations (listing_id, transaction, payer, asset, amount, observed_at)
                VALUES (${id}, ${transaction}, 'GPAYER', 'CASSET', '1', ${at(minutes)})`.execute(db);
    }

    await migrate(db);
    const rows = await sql<{ transaction: string; pay_to: string }>`
      SELECT transaction, pay_to FROM listing_observations ORDER BY transaction`.execute(db);
    expect(rows.rows.map((row) => [row.transaction[0], row.pay_to])).toEqual([
      ["a", "GFIRST"],
      ["b", "GFIRST"],
      ["c", "GSECOND"],
    ]);
    const store = new PostgresCatalogStore(db);
    const listing = await store.get(id);
    expect(listing).toBeDefined();
    if (listing === undefined) return;
    const usage = await store.listingUsage(listing, 20);
    expect(usage.recent.map((observation) => observation.transaction)).toEqual(["c".repeat(64)]);
  });
});

describe("postgres: quarantine reasons", () => {
  it("keeps quarantines recorded before reasons were and refuses a new one without a reason", async () => {
    const schema = `test_${randomBytes(6).toString("hex")}`;
    const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    await admin.destroy();
    const db = createDatabase({ connectionString: URL, schema, maxConnections: 2 });
    opened.push(db);
    const previous = await mkdtemp(join(tmpdir(), "rail402-migrations-"));
    try {
      for (const name of await readdir(MIGRATIONS_DIRECTORY)) {
        if (name.endsWith(".sql") && name < "0027") {
          await copyFile(join(MIGRATIONS_DIRECTORY, name), join(previous, name));
        }
      }
      await migrate(db, `${previous}/`);
    } finally {
      await rm(previous, { recursive: true, force: true });
    }
    const id = randomUUID();
    await sql`INSERT INTO listings (id, network, kind, resource, method, tool_name, scope, owner, trust,
                state, version, content, content_hash, first_cataloged_at, last_updated, last_settled_at,
                settlements)
              VALUES (${id}, 'stellar:testnet', 'mcp', 'https://tools.example.com/mcp', '', 'forecast',
                'GOWNER', 'GOWNER', 'settled', 'quarantined', 1, '{}', 'hash', now(), now(), now(), 1)`.execute(
      db,
    );
    const quarantine = (version: number, reason: string | null) =>
      sql`INSERT INTO listing_versions (listing_id, version, created_at, cause, owner, trust, state, reason, content)
          VALUES (${id}, ${version}, now(), 'quarantine', 'GOWNER', 'settled', 'quarantined', ${reason}, '{}')`.execute(
        db,
      );
    await quarantine(1, null);

    await migrate(db);
    await expect(quarantine(2, null)).rejects.toThrow(/listing_versions_quarantine_reason/);
    await quarantine(2, "origin_not_payment_required");
    const store = new PostgresCatalogStore(db);
    expect((await store.versions(id)).map((version) => version.reason)).toEqual([
      undefined,
      "origin_not_payment_required",
    ]);
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
