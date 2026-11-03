/**
 * Applies the database migrations of this release and exits, run with the service's environment
 * before the service starts with `MIGRATE_ON_START=false`:
 *
 *   node dist/migrate.js
 *
 * It connects through `DATABASE_MIGRATION_URL` (or `DATABASE_MIGRATION_URL_FILE`), the role that owns
 * the schema, falling back to `DATABASE_URL`; with pubnet enabled both must come from files. It prints
 * one JSON line naming the migrations applied, and exits 78 with `rail402: <code>: <message>` when the
 * connection settings are unusable. Replicas and repeated runs are safe: migrations are serialised by
 * an advisory lock and each is applied once.
 */
import { createDatabase, migrate } from "@rail402.dev/store-postgres";
import { ConfigError, configFailureLine } from "./config.ts";
import { migrationUrl } from "./database-checks.ts";

async function main(): Promise<void> {
  const db = createDatabase({ connectionString: migrationUrl(process.env), maxConnections: 1 });
  try {
    const applied = await migrate(db);
    process.stdout.write(`${JSON.stringify({ applied })}\n`);
  } finally {
    await db.destroy();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(configFailureLine(error));
    process.exitCode = 78;
  } else {
    process.stderr.write(`rail402: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
