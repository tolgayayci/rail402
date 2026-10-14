/**
 * Creates or drops the Postgres schema the evidence run's Rail402 replicas share, so the run never
 * touches tables of another deployment on the same database; `ping` only checks that the database
 * answers (the evidence run's preflight for the steps that need it).
 *
 *   node --conditions=@rail402/source tools/conformance/src/evidence-db.ts create|drop <database url> <schema>
 *   node --conditions=@rail402/source tools/conformance/src/evidence-db.ts ping <database url>
 */
import { sql } from "kysely";
import { createDatabase } from "@rail402.dev/store-postgres";

const [action, url, schema = ""] = process.argv.slice(2);
const usage =
  url === undefined ||
  (action === "ping" ? schema !== "" : (action !== "create" && action !== "drop") || schema === "");
if (usage) {
  process.stderr.write("usage: evidence-db.ts create|drop <database url> <schema> | ping <database url>\n");
  process.exit(64);
}
if (action !== "ping" && !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
  process.stderr.write(`evidence-db: invalid schema name "${schema}"\n`);
  process.exit(64);
}

const admin = createDatabase({ connectionString: url, maxConnections: 1 });
try {
  if (action === "ping") await sql`SELECT 1`.execute(admin);
  else if (action === "create") await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
  else await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin);
} finally {
  await admin.destroy();
}
