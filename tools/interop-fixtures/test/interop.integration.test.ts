/** The interoperability suite on a Postgres catalog (docker compose up -d postgres). */
import { randomBytes } from "node:crypto";
import { afterAll } from "vitest";
import { sql, type Kysely } from "kysely";
import { PostgresCatalogStore, createDatabase, migrate, type Database } from "@rail402.dev/store-postgres";
import { interopSuite } from "./suite.ts";

const URL = process.env["RAIL402_TEST_DATABASE_URL"] ?? "postgres://rail402:rail402@localhost:5432/rail402";
const schema = `interop_${randomBytes(6).toString("hex")}`;
let db: Kysely<Database> | undefined;

afterAll(async () => {
  await db?.destroy();
  const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
  await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin);
  await admin.destroy();
});

interopSuite("postgres", async () => {
  const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
  await admin.destroy();
  db = createDatabase({ connectionString: URL, schema, maxConnections: 5 });
  await migrate(db);
  return new PostgresCatalogStore(db);
});
