import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Keypair } from "@stellar/stellar-sdk";
import { sql } from "kysely";
import { silentLogger } from "@rail402.dev/facilitator";
import { createDatabase } from "@rail402.dev/store-postgres";
import { Metrics, createApp, createRuntime, loadConfig, type Runtime } from "@rail402.dev/service";
import type { IssuedAsset, LocalNetwork } from "@rail402.dev/testkit";

export const DATABASE_URL =
  process.env["RAIL402_TEST_DATABASE_URL"] ?? "postgres://rail402:rail402@localhost:5432/rail402";

export interface RunningService {
  readonly url: string;
  readonly runtime: Runtime;
  readonly metrics: Metrics;
  /** The fee sponsor; its derived channel keys are the service's channel accounts. */
  readonly sponsor: Keypair;
  stop(): Promise<void>;
}

export interface ServiceOptions {
  /**
   * Runs as another replica of an existing deployment: this sponsor (so the same derived channels)
   * and this Postgres schema, which the caller created and drops. Without it, a funded sponsor and a
   * fresh schema are created and the schema is dropped on `stop()`.
   */
  readonly replicaOf?: { readonly sponsor: Keypair; readonly schema: string };
}

/** Creates an empty Postgres schema for a service, and returns its name. */
export async function createServiceSchema(): Promise<string> {
  const schema = `svc_${randomBytes(6).toString("hex")}`;
  const admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
  await admin.destroy();
  return schema;
}

export async function dropServiceSchema(schema: string): Promise<void> {
  const cleanup = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
  await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(cleanup);
  await cleanup.destroy();
}

/** Boots the whole service (config, Postgres in a fresh schema, channels, HTTP) on a random port. */
export async function startService(
  net: LocalNetwork,
  usdc: IssuedAsset,
  env: Record<string, string> = {},
  options: ServiceOptions = {},
): Promise<RunningService> {
  const replica = options.replicaOf;
  const sponsor = replica?.sponsor ?? Keypair.random();
  if (replica === undefined) await net.fund(sponsor);
  const schema = replica?.schema ?? (await createServiceSchema());

  const config = loadConfig({
    DATABASE_URL: `${DATABASE_URL}?options=-c%20search_path%3D${schema}`,
    TESTNET_RPC_URL: net.rpcUrl,
    TESTNET_SPONSOR_SECRET: sponsor.secret(),
    TESTNET_CHANNEL_COUNT: "4",
    TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
    TESTNET_MAX_TX_FEE_STROOPS: "2000000",
    TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
    // The canonical upto contract is not on a private network; suites that pay upto deploy their own.
    TESTNET_UPTO_ENABLED: "false",
    RATE_LIMIT_PER_MINUTE: "0",
    ...env,
  });
  const metrics = new Metrics();
  const runtime = await createRuntime(config, metrics, silentLogger, { version: "test" });
  runtime.start();
  const app = createApp({
    config,
    facilitator: runtime.facilitator,
    metrics,
    log: silentLogger,
    readiness: () => runtime.readiness(),
    health: () => runtime.health(),
    version: "test",
    ...(runtime.bazaar === undefined ? {} : { bazaar: runtime.bazaar }),
    // As main.ts wires them: the shared Postgres limiter and meter.
    ...(runtime.access === undefined
      ? {}
      : { rateLimiter: runtime.access.rateLimiter, meter: runtime.access.meter }),
  });
  const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    runtime,
    metrics,
    sponsor,
    stop: async () => {
      await new Promise((resolve) => server.close(resolve));
      await runtime.stop();
      if (replica === undefined) await dropServiceSchema(schema);
    },
  };
}
