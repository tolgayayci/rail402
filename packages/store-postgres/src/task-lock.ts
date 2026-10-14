import { sql, type Kysely } from "kysely";
import type { TaskLock } from "@rail402.dev/facilitator";
import type { Database } from "./database.ts";

/**
 * A task lock shared by every replica: a session-level Postgres advisory lock held on one pooled
 * connection for the task's duration. `pg_try_advisory_lock` never waits, so a replica that finds the
 * lock taken skips the task. A replica that dies releases the lock with its connection.
 */
export class PostgresTaskLock implements TaskLock {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  run<T>(name: string, task: () => Promise<T>): Promise<T | undefined> {
    return this.db.connection().execute(async (connection) => {
      const { rows } = await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_lock(hashtextextended(${name}, 402)) AS locked`.execute(connection);
      if (rows[0]?.locked !== true) return undefined;
      try {
        return await task();
      } finally {
        await sql`SELECT pg_advisory_unlock(hashtextextended(${name}, 402))`.execute(connection);
      }
    });
  }
}
