import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql, type Kysely } from "kysely";

/** Directory of the SQL migrations shipped with this package. */
export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations/", import.meta.url));

const LOCK_ID = 402_402_001;

/**
 * Applies pending SQL migrations in file-name order, each in its own transaction. A transaction-level
 * advisory lock serialises concurrent starts, so several replicas can boot at once.
 * Returns the names of the migrations it applied.
 */
export async function migrate<DB>(db: Kysely<DB>, directory = MIGRATIONS_DIRECTORY): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const applied: string[] = [];

  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);

  for (const name of files) {
    const text = await readFile(`${directory}${name}`, "utf8");
    const didApply = await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${LOCK_ID})`.execute(trx);
      const done = await sql<{
        name: string;
      }>`SELECT name FROM schema_migrations WHERE name = ${name}`.execute(trx);
      if (done.rows.length > 0) return false;
      await sql.raw(text).execute(trx);
      await sql`INSERT INTO schema_migrations (name) VALUES (${name})`.execute(trx);
      return true;
    });
    if (didApply) applied.push(name);
  }
  return applied;
}
