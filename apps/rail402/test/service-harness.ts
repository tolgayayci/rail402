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
  stop(): Promise<void>;
}

/** Boots the whole service (config, Postgres in a fresh schema, channels, HTTP) on a random port. */
export async function startService(
  net: LocalNetwork,
  usdc: IssuedAsset,
  env: Record<string, string> = {},
): Promise<RunningService> {
  const sponsor = Keypair.random();
  await net.fund(sponsor);
  const schema = `svc_${randomBytes(6).toString("hex")}`;
  const admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
  await admin.destroy();

  const config = loadConfig({
    DATABASE_URL: `${DATABASE_URL}?options=-c%20search_path%3D${schema}`,
    TESTNET_RPC_URL: net.rpcUrl,
    TESTNET_SPONSOR_SECRET: sponsor.secret(),
    TESTNET_CHANNEL_COUNT: "4",
    TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
    TESTNET_MAX_TX_FEE_STROOPS: "2000000",
    TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
    RATE_LIMIT_PER_MINUTE: "0",
    ...env,
  });
  const metrics = new Metrics();
  const runtime = await createRuntime(config, metrics, silentLogger);
  runtime.start();
  const app = createApp({
    config,
    facilitator: runtime.facilitator,
    metrics,
    log: silentLogger,
    readiness: () => runtime.readiness(),
    version: "test",
    ...(runtime.bazaar === undefined ? {} : { bazaar: runtime.bazaar }),
  });
  const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    runtime,
    metrics,
    stop: async () => {
      await new Promise((resolve) => server.close(resolve));
      await runtime.stop();
      const cleanup = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
      await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(cleanup);
      await cleanup.destroy();
    },
  };
}
