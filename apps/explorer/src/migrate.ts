/**
 * Applies the Explorer's pending migrations as the schema owner, then exits: the one-shot step a deploy
 * runs before it starts the indexers, so no long-running process holds the owner's credentials.
 *
 *   EXPLORER_MIGRATION_DATABASE_URL_FILE=/run/secrets/explorer_owner_url node src/main.ts migrate
 *
 * Prints the migrations it applied as one JSON line; exits 78 when the URL is missing.
 */
import { migrate } from "@rail402.dev/store-postgres";
import { ExplorerConfigError, secret } from "./config.ts";
import { EXPLORER_MIGRATIONS, createExplorerDatabase } from "./db.ts";

/** Migrates the database named by `EXPLORER_MIGRATION_DATABASE_URL` (or `_FILE`); returns what it applied. */
export async function migrateExplorer(env: Readonly<Record<string, string | undefined>>): Promise<string[]> {
  const url = secret(env, "EXPLORER_MIGRATION_DATABASE_URL");
  if (url === undefined) {
    throw new ExplorerConfigError(
      "config_database_missing",
      "EXPLORER_MIGRATION_DATABASE_URL (or _FILE) is required to migrate",
    );
  }
  const owner = createExplorerDatabase({ connectionString: url, maxConnections: 1 });
  try {
    return await migrate(owner, EXPLORER_MIGRATIONS);
  } finally {
    await owner.destroy();
  }
}

/** The `migrate` role: migrate, print the result, and exit 78 on a configuration error. */
export async function runMigrate(): Promise<void> {
  try {
    process.stdout.write(`${JSON.stringify({ applied: await migrateExplorer(process.env) })}\n`);
  } catch (error) {
    if (!(error instanceof ExplorerConfigError)) throw error;
    process.stderr.write(`rail402-explorer: ${error.code}: ${error.message}\n`);
    process.exitCode = 78;
  }
}
