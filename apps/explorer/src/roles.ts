import { sql, type Kysely } from "kysely";
import type { ExplorerDatabase } from "./db.ts";

const TABLES = [
  "settlements",
  "failed_attempts",
  "discovery_routes",
  "candidate_ledgers",
  "indexed_ledgers",
  "ledger_exclusions",
  "facilitators",
  "facilitator_accounts",
  "upto_contracts",
  "daily_aggregates",
  "account_totals",
  "seller_summaries",
  "reports",
  "network_windows",
  "anchors",
] as const;

/** The connected role is not the one the process must run as. */
export class ExplorerRoleError extends Error {
  readonly code = "explorer_role_unsafe";
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`the database role is unsafe for this process: ${problems.join("; ")}`);
    this.name = "ExplorerRoleError";
    this.problems = problems;
  }
}

export interface RoleCheckOptions {
  /** The facilitator's database, which no Explorer role may connect to. */
  readonly facilitatorDatabase?: string;
}

interface RoleFacts {
  readonly superuser: boolean;
  readonly createRole: boolean;
  readonly createDb: boolean;
  readonly bypassRls: boolean;
  readonly readOnly: string;
  readonly statementTimeoutMs: number;
  readonly facilitatorConnect: boolean | null;
}

async function roleFacts(db: Kysely<ExplorerDatabase>, options: RoleCheckOptions): Promise<RoleFacts> {
  const { rows } = await sql<{
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolbypassrls: boolean;
    read_only: string;
    timeout_ms: string;
  }>`SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls,
            current_setting('default_transaction_read_only') AS read_only,
            (SELECT setting FROM pg_settings WHERE name = 'statement_timeout') AS timeout_ms
       FROM pg_roles r WHERE r.rolname = current_user`.execute(db);
  const [row] = rows;
  if (row === undefined) throw new ExplorerRoleError(["the current role is not in pg_roles"]);
  let facilitatorConnect: boolean | null = null;
  if (options.facilitatorDatabase !== undefined) {
    const result = await sql<{ connect: boolean | null }>`
      SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname = ${options.facilitatorDatabase})
                  THEN has_database_privilege(current_user, ${options.facilitatorDatabase}, 'CONNECT') END AS connect`.execute(
      db,
    );
    facilitatorConnect = result.rows[0]?.connect ?? null;
  }
  return {
    superuser: row.rolsuper,
    createRole: row.rolcreaterole,
    createDb: row.rolcreatedb,
    bypassRls: row.rolbypassrls,
    readOnly: row.read_only,
    statementTimeoutMs: Number(row.timeout_ms),
    facilitatorConnect,
  };
}

function common(facts: RoleFacts, problems: string[]): void {
  if (facts.superuser) problems.push("it is a superuser");
  if (facts.createRole) problems.push("it can create roles");
  if (facts.createDb) problems.push("it can create databases");
  if (facts.bypassRls) problems.push("it bypasses row-level security");
  if (facts.facilitatorConnect === true) problems.push("it can connect to the facilitator's database");
}

/**
 * The indexer's role: no administrative attributes, no way to change the migration log and no way
 * into the facilitator's database.
 * Throws `ExplorerRoleError` otherwise, so the process refuses to start.
 */
export async function assertWriterRole(
  db: Kysely<ExplorerDatabase>,
  options: RoleCheckOptions = {},
): Promise<void> {
  const problems: string[] = [];
  common(await roleFacts(db, options), problems);
  const { rows } = await sql<{ writable: boolean | null }>`
    SELECT CASE WHEN to_regclass('schema_migrations') IS NOT NULL
                THEN has_table_privilege(current_user, 'schema_migrations', 'INSERT, UPDATE, DELETE, TRUNCATE') END AS writable`.execute(
    db,
  );
  if (rows[0]?.writable === true) problems.push("it can modify schema_migrations");
  if (problems.length > 0) throw new ExplorerRoleError(problems);
}

/**
 * The public pages' role: SELECT only on every Explorer table, read-only transactions by default, a
 * statement timeout of at most `maxStatementTimeoutMs`, no administrative attributes and no way into
 * the facilitator's database. Throws `ExplorerRoleError` otherwise.
 */
export async function assertReaderRole(
  db: Kysely<ExplorerDatabase>,
  options: RoleCheckOptions & { readonly maxStatementTimeoutMs?: number } = {},
): Promise<void> {
  const facts = await roleFacts(db, options);
  const problems: string[] = [];
  common(facts, problems);
  if (facts.readOnly !== "on") problems.push("default_transaction_read_only is not on");
  const limit = options.maxStatementTimeoutMs ?? 5_000;
  if (facts.statementTimeoutMs <= 0 || facts.statementTimeoutMs > limit) {
    problems.push(
      `statement_timeout is ${String(facts.statementTimeoutMs)} ms, not 1 to ${String(limit)} ms`,
    );
  }
  const { rows } = await sql<{ table: string; writable: boolean }>`
    SELECT t AS table, has_table_privilege(current_user, t, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS writable
      FROM unnest(${sql.val([...TABLES])}::text[]) AS t
     WHERE to_regclass(t) IS NOT NULL`.execute(db);
  for (const row of rows) if (row.writable) problems.push(`it can modify ${row.table}`);
  const schema = await sql<{ create: boolean }>`
    SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS create`.execute(db);
  if (schema.rows[0]?.create === true) problems.push("it can create objects in the public schema");
  if (problems.length > 0) throw new ExplorerRoleError(problems);
}
