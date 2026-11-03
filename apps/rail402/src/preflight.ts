import { sql } from "kysely";
import { createDatabase } from "@rail402.dev/store-postgres";
import { ConfigError, loadConfig, networkSettingsDigest, type Config } from "./config.ts";
import { checkConnectionBudget, prepareDatabase, type ConnectionBudget } from "./database-checks.ts";

/** What a passing preflight checked, printed as one JSON line by `check-config`. */
export interface PreflightReport {
  readonly ok: true;
  readonly networks: readonly string[];
  readonly store: "postgres" | "memory";
  /** A digest of each network's effective settings (no secrets), as the service logs it at startup. */
  readonly settings: Readonly<Record<string, string>>;
  /**
   * With Postgres: the connections the role may hold, the most one process opens, and how many
   * replicas fit in the limit together.
   */
  readonly database?: ConnectionBudget;
}

/**
 * Everything the service decides before it touches a network: the configuration and every file it
 * names, and with Postgres the database role and schema (it connects but changes nothing). A failure
 * is a `ConfigError` with the same code the service would stop with, so a deploy can
 * run this first and leave the running service untouched when it fails. With
 * `CHECK_CONFIG_PENDING_OK=true` pending migrations are expected (a deploy that applies them with the
 * migrate command next): only the pending-migration refusals are skipped, the role checks still run.
 */
export async function preflight(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<PreflightReport> {
  const config: Config = loadConfig(env);
  const pendingOk = env["CHECK_CONFIG_PENDING_OK"] === "true";
  let database: ConnectionBudget | undefined;
  if (config.store.kind === "postgres") {
    const db = createDatabase({ connectionString: config.store.url, maxConnections: 1 });
    try {
      await sql`SELECT 1`.execute(db);
      await prepareDatabase(db, config, { apply: false, pendingOk });
      database = await checkConnectionBudget(db, config);
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(
        `DATABASE_URL: the database cannot be reached or read (${error instanceof Error ? error.name : "error"})`,
        "config_database_unreachable",
      );
    } finally {
      await db.destroy();
    }
  }
  return {
    ok: true,
    networks: config.networks.map((network) => network.network),
    store: config.store.kind,
    settings: Object.fromEntries(
      config.networks.map((network) => [network.network, networkSettingsDigest(network)]),
    ),
    ...(database === undefined ? {} : { database }),
  };
}

export { ConfigError };
