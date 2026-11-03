import { sql, type Kysely } from "kysely";
import { PUBNET } from "@rail402.dev/stellar";
import {
  RuntimeRoleError,
  assertRuntimeRole,
  createDatabase,
  migrate,
  pendingMigrations,
} from "@rail402.dev/store-postgres";
import { ConfigError, type Config } from "./config.ts";
import { connectionsPerProcess, databasePools } from "./database-pools.ts";
import { resolveSecret } from "./secrets.ts";

/**
 * The database checks before the service uses a connection: with pubnet enabled the role must be
 * neither a superuser nor allowed to create roles, nor a member of such a role, nor own the schema or
 * its tables (`config_database_superuser`), and migrations are never applied through it
 * (`config_pubnet_migration_role_missing`): applying them would make it the tables' owner. Then
 * pending migrations are applied (`MIGRATE_ON_START=true`, through `DATABASE_MIGRATION_URL` when set,
 * which pubnet refuses in the service)
 * or must not exist (`config_schema_outdated`). With `apply: false` (the preflight) nothing is
 * changed; `pendingOk` (the preflight's `CHECK_CONFIG_PENDING_OK=true`, for a deploy that runs the
 * migrate command afterwards) skips only the two pending-migration refusals, never the role check.
 * Returns the migrations applied.
 */
export async function prepareDatabase<DB>(
  db: Kysely<DB>,
  config: Pick<Config, "networks" | "migrations">,
  options: { readonly apply: boolean; readonly pendingOk?: boolean },
): Promise<string[]> {
  const pendingOk = options.pendingOk === true && !options.apply;
  if (config.networks.some((network) => network.network === PUBNET)) {
    try {
      await assertRuntimeRole(db);
    } catch (error) {
      if (error instanceof RuntimeRoleError) {
        throw new ConfigError(`DATABASE_URL: ${error.message}`, "config_database_superuser");
      }
      throw error;
    }
    if (config.migrations.onStart && config.migrations.url === undefined) {
      if (pendingOk) return [];
      const pending = await pendingMigrations(db);
      if (pending.length > 0) {
        throw new ConfigError(
          `with pubnet, migrations run as the schema owner, never as the service's role (${pending.length.toString()} pending): run node dist/migrate.js with DATABASE_MIGRATION_URL_FILE, then start the service with MIGRATE_ON_START=false`,
          "config_pubnet_migration_role_missing",
        );
      }
      // Nothing to apply, and the service's role may not create even the migrations table.
      return [];
    }
  }
  if (!config.migrations.onStart) {
    if (pendingOk) return [];
    const pending = await pendingMigrations(db);
    if (pending.length > 0) {
      throw new ConfigError(
        `the database schema is behind this release (${pending.join(", ")} not applied) and MIGRATE_ON_START=false; run node dist/migrate.js first`,
        "config_schema_outdated",
      );
    }
    return [];
  }
  if (!options.apply) return [];
  const url = config.migrations.url;
  if (url === undefined) return migrate(db);
  const owner = createDatabase({ connectionString: url, maxConnections: 1 });
  try {
    return await migrate(owner);
  } finally {
    await owner.destroy();
  }
}

/** How many connections the database lets the service's role hold, against what one process opens. */
export interface ConnectionBudget {
  /** The most the role may hold at once: its `CONNECTION LIMIT`, or what the server's limit leaves it. */
  readonly connectionLimit: number;
  /** The most one process holds, every pool full (`databasePools`). */
  readonly perProcess: number;
  /** How many processes (replicas) the limit holds together. */
  readonly replicas: number;
}

/**
 * Reads how many connections the role may hold (its `CONNECTION LIMIT`, and the server's
 * `max_connections` less the slots reserved for superusers and reserved roles) and how many processes
 * of this configuration fit in it. Every pool of every replica must fit: a pool that cannot open a
 * connection because others hold the role's last slots (anonymous testnet or discovery load) fails its
 * requests, so with pubnet a limit below one process's pools stops startup
 * (`config_database_connections_low`). Undefined with the in-memory store.
 */
export async function checkConnectionBudget<DB>(
  db: Kysely<DB>,
  config: Pick<Config, "store" | "networks" | "bazaar" | "discovery">,
): Promise<ConnectionBudget | undefined> {
  const pools = databasePools(config);
  if (pools === undefined) return undefined;
  const { rows } = await sql<{
    role_limit: number;
    superuser: boolean;
    max_connections: number;
    superuser_reserved: number;
    reserved: number;
  }>`
    SELECT r.rolconnlimit AS role_limit, r.rolsuper AS superuser,
           current_setting('max_connections')::int AS max_connections,
           current_setting('superuser_reserved_connections')::int AS superuser_reserved,
           coalesce(current_setting('reserved_connections', true), '0')::int AS reserved
    FROM pg_roles r WHERE r.rolname = current_user`.execute(db);
  const row = rows[0];
  if (row === undefined) throw new Error("the database role could not be read");
  // A role's CONNECTION LIMIT and the reserved slots bind roles other than superusers only.
  const connectionLimit = row.superuser
    ? row.max_connections
    : Math.min(
        row.role_limit < 0 ? Number.POSITIVE_INFINITY : row.role_limit,
        row.max_connections - row.superuser_reserved - row.reserved,
      );
  const perProcess = connectionsPerProcess(pools);
  const replicas = Math.max(0, Math.floor(connectionLimit / perProcess));
  if (replicas < 1 && config.networks.some((network) => network.network === PUBNET)) {
    const sizes = Object.entries(pools)
      .map(([pool, size]) => `${pool} ${String(size)}`)
      .join(", ");
    throw new ConfigError(
      `DATABASE_URL: the role may hold ${String(connectionLimit)} connections, fewer than the ${String(perProcess)} one process opens (${sizes}); raise its CONNECTION LIMIT to ${String(perProcess)} per replica plus room for check-config and the CLI`,
      "config_database_connections_low",
    );
  }
  return { connectionLimit, perProcess, replicas };
}

/** The connection string migrations use, from the environment as the service reads it. */
export function migrationUrl(env: Readonly<Record<string, string | undefined>>): string {
  const pubnet = (env["NETWORKS"] ?? "").split(",").some((value) => value.trim() === PUBNET);
  const url =
    resolveSecret(env, { name: "DATABASE_MIGRATION_URL", fileOnly: pubnet }) ??
    resolveSecret(env, { name: "DATABASE_URL", fileOnly: pubnet });
  if (url === undefined) {
    throw new ConfigError("set DATABASE_MIGRATION_URL or DATABASE_URL (or their _FILE forms)");
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new ConfigError("the database URL must be a postgres:// URL");
  }
  return url;
}
