import { readdir } from "node:fs/promises";
import { sql, type Kysely } from "kysely";
import { MIGRATIONS_DIRECTORY } from "./migrate.ts";

/** What the connected role may do beyond reading and writing rows. */
export interface RoleCapabilities {
  readonly role: string;
  readonly superuser: boolean;
  readonly createRole: boolean;
  /**
   * Privileged roles the connected role is a member of (and so may act as, `SET ROLE` or inherited):
   * superusers, roles that may create roles, and the predefined roles that read, write or run
   * programs on the database server.
   */
  readonly privilegedMemberships: readonly string[];
  /**
   * Tables of the current schema owned by the connected role or a role it is a member of, and the
   * schema itself when it owns that: owners may alter, drop or truncate them, the DDL rights the
   * role split keeps from the service.
   */
  readonly owned: readonly string[];
}

/** The predefined roles that reach the database server's file system or programs. */
const SERVER_ROLES = ["pg_execute_server_program", "pg_write_server_files", "pg_read_server_files"];

/** The connected role, its privileges and what it owns in the current schema. */
export async function roleCapabilities<DB>(db: Kysely<DB>): Promise<RoleCapabilities> {
  const result = await sql<{ role: string; superuser: boolean; create_role: boolean }>`
    SELECT rolname AS role, rolsuper AS superuser, rolcreaterole AS create_role
    FROM pg_roles WHERE rolname = current_user`.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error("the connected role is not in pg_roles");
  const memberships = await sql<{ role: string }>`
    SELECT rolname AS role FROM pg_roles
    WHERE rolname <> current_user
      AND pg_has_role(current_user, oid, 'MEMBER')
      AND (rolsuper OR rolcreaterole OR rolname IN (${sql.join(SERVER_ROLES)}))
    ORDER BY rolname`.execute(db);
  const owned = await sql<{ name: string }>`
    SELECT 'schema ' || nspname AS name FROM pg_namespace
    WHERE nspname = current_schema() AND pg_has_role(current_user, nspowner, 'MEMBER')
    UNION ALL
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
      AND pg_has_role(current_user, c.relowner, 'MEMBER')
    ORDER BY name`.execute(db);
  return {
    role: row.role,
    superuser: row.superuser,
    createRole: row.create_role,
    privilegedMemberships: memberships.rows.map((member) => member.role),
    owned: owned.rows.map((entry) => entry.name),
  };
}

/**
 * Refuses a connection whose role is a superuser or may create roles, is a member of such a role or
 * of a role that reaches the server's files or programs, or owns the schema or its tables. Such a
 * role can read and rewrite every row of every network, change other roles, run programs on the
 * database server (`COPY … TO PROGRAM`), or alter and drop the tables; a service that also serves the
 * public testnet must not hold it.
 */
export async function assertRuntimeRole<DB>(db: Kysely<DB>): Promise<void> {
  const capabilities = await roleCapabilities(db);
  if (
    capabilities.superuser ||
    capabilities.createRole ||
    capabilities.privilegedMemberships.length > 0 ||
    capabilities.owned.length > 0
  ) {
    throw new RuntimeRoleError(capabilities);
  }
}

export class RuntimeRoleError extends Error {
  override readonly name = "RuntimeRoleError";
  readonly capabilities: RoleCapabilities;

  constructor(capabilities: RoleCapabilities) {
    const what = capabilities.superuser
      ? "is a superuser"
      : capabilities.createRole
        ? "is allowed to create roles"
        : capabilities.privilegedMemberships.length > 0
          ? `is a member of ${capabilities.privilegedMemberships.join(", ")}`
          : `owns ${capabilities.owned.slice(0, 5).join(", ")}${capabilities.owned.length > 5 ? ", …" : ""} (run migrations as the schema owner through DATABASE_MIGRATION_URL)`;
    super(
      `the database role ${capabilities.role} ${what}; connect with a role that only reads and writes rows`,
    );
    this.capabilities = capabilities;
  }
}

/** The shipped migrations the database has not applied, in the order `migrate` would apply them. */
export async function pendingMigrations<DB>(
  db: Kysely<DB>,
  directory = MIGRATIONS_DIRECTORY,
): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const exists = await sql<{ present: boolean }>`
    SELECT to_regclass('schema_migrations') IS NOT NULL AS present`.execute(db);
  if (exists.rows[0]?.present !== true) return files;
  const applied = await sql<{ name: string }>`SELECT name FROM schema_migrations`.execute(db);
  const done = new Set(applied.rows.map((row) => row.name));
  return files.filter((name) => !done.has(name));
}
