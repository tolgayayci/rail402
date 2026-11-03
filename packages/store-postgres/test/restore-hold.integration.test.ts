/**
 * The `upto` hold after a restore with the Postgres settlement ledger shared by two replicas: the ledger
 * it counts from is recorded once for both, and a request's reading far below it, which a lagging,
 * wrong or compromised provider can give, never moves it. Runs against Postgres (docker compose up -d
 * postgres); each test gets its own schema.
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { MemoryChannelPool, SettlementEngine, StellarUptoScheme } from "@rail402.dev/facilitator";
import {
  PostgresSettlementLedger,
  createDatabase,
  migrate,
  type Database,
} from "@rail402.dev/store-postgres";
import {
  FakeServer,
  LEDGER,
  NETWORK,
  PASSPHRASE,
  authority,
  channel,
  entry,
  payment,
  policy,
  requirements,
  sponsor,
  terms,
  uptoPolicy,
} from "../../facilitator/test/upto-helpers.ts";

const URL = process.env["RAIL402_TEST_DATABASE_URL"] ?? "postgres://rail402:rail402@localhost:5432/rail402";
const opened: Kysely<Database>[] = [];
const schemas: string[] = [];

afterAll(async () => {
  await Promise.all(opened.map((db) => db.destroy()));
  const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
  for (const schema of schemas) await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin);
  await admin.destroy();
});

async function restoredDatabase(): Promise<Kysely<Database>> {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  schemas.push(schema);
  const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
  await admin.destroy();
  const db = createDatabase({ connectionString: URL, schema, maxConnections: 4 });
  opened.push(db);
  await migrate(db);
  await sql`INSERT INTO settlement_rewinds (reason) VALUES ('restore')`.execute(db);
  return db;
}

/** One facilitator replica on its own pool and RPC, with the zero settled off-chain. */
function replica(db: Kysely<Database>, ledger: number) {
  const server = new FakeServer();
  server.ledger = ledger;
  const engine = new SettlementEngine({
    network: NETWORK,
    passphrase: PASSPHRASE,
    rpcUrl: "http://127.0.0.1:1/rpc",
    server: server.asServer(),
    policy,
    ledger: new PostgresSettlementLedger(db),
    channels: new MemoryChannelPool([channel.publicKey()]),
    channelKeys: new Map([[channel.publicKey(), channel]]),
    sponsor,
    authority,
    timing: { pollIntervalMs: 5, duplicateWaitMs: 100, channelWaitMs: 20, confirmTimeoutMs: 1_000 },
  });
  const scheme = new StellarUptoScheme({
    network: NETWORK,
    passphrase: PASSPHRASE,
    server: server.asServer(),
    policy,
    upto: { ...uptoPolicy, zeroSettlement: "offchain" },
    engine,
  });
  return { server, scheme };
}

const paymentAt = (ledger: number) =>
  payment({ authorization: entry({ terms: terms({ expirationLedger: ledger + 12 }) }) });

describe("postgres: the upto hold after a restore", () => {
  it("is not set by a request's reading before a replica has recorded it", async () => {
    const db = await restoredDatabase();
    // A provider answers ledger 10 to the first request after the restore.
    const low = replica(db, 10);
    expect(await low.scheme.verify(paymentAt(10), requirements())).toMatchObject({
      isValid: false,
      invalidReason: "settle_upto_stellar_authority_unavailable",
    });
    const rows = await sql<{
      ledger: string;
    }>`SELECT ledger::text AS ledger FROM settlement_rewind_ledgers`.execute(db);
    expect(rows.rows).toEqual([]);
    const later = replica(db, LEDGER + 20);
    const settled = await later.scheme.settle(paymentAt(LEDGER + 20), requirements({ amount: "5" }));
    expect(settled).toMatchObject({
      success: false,
      errorReason: "settle_upto_stellar_authority_unavailable",
    });
    expect(later.server.sent).toEqual([]);
  });

  it("is not moved by one replica's reading far below the recorded ledger", async () => {
    const db = await restoredDatabase();
    // The network poll recorded where the hold counts from.
    await new PostgresSettlementLedger(db).rewindLedger(NETWORK, LEDGER);
    const a = replica(db, LEDGER);
    expect(await a.scheme.verify(paymentAt(LEDGER), requirements())).toMatchObject({ isValid: false });
    // Another replica's provider answers 400 ledgers behind, and a request fits that reading.
    const b = replica(db, LEDGER - 400);
    expect(await b.scheme.verify(paymentAt(LEDGER - 400), requirements())).toMatchObject({
      isValid: false,
      invalidReason: "settle_upto_stellar_authority_unavailable",
    });
    const rows = await sql<{ ledger: string }>`
      SELECT ledger::text AS ledger FROM settlement_rewind_ledgers WHERE network = ${NETWORK}`.execute(db);
    expect(rows.rows).toEqual([{ ledger: String(LEDGER) }]);
    // 20 ledgers on, still held.
    const later = replica(db, LEDGER + 20);
    const settled = await later.scheme.settle(paymentAt(LEDGER + 20), requirements({ amount: "5" }));
    expect(settled).toMatchObject({
      success: false,
      errorReason: "settle_upto_stellar_authority_unavailable",
    });
    expect(later.server.sent).toEqual([]);
  });
});
