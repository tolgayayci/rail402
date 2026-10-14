import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Keypair } from "@stellar/stellar-sdk";
import { silentLogger } from "@rail402.dev/facilitator";
import { Metrics, createApp, createRuntime, loadConfig, type Runtime } from "@rail402.dev/service";
import type { IssuedAsset, LocalNetwork } from "@rail402.dev/testkit";

export interface RunningRail402 {
  readonly url: string;
  readonly runtime: Runtime;
  /** The facilitator's fee sponsor. */
  readonly sponsor: string;
  stop(): Promise<void>;
}

/**
 * Rail402 in this process, in memory, as facilitator and Bazaar for the local network: settlements
 * are real, the catalog and lexical search run without Postgres or an embedding model. `env` adds
 * or overrides configuration, such as the upto settlement contract deployed for a run.
 */
export async function startRail402(
  net: LocalNetwork,
  usdc: IssuedAsset,
  env: Readonly<Record<string, string>> = {},
): Promise<RunningRail402> {
  const sponsor = Keypair.random();
  await net.fund(sponsor);
  const config = loadConfig({
    STORE: "memory",
    TESTNET_RPC_URL: net.rpcUrl,
    TESTNET_SPONSOR_SECRET: sponsor.secret(),
    TESTNET_CHANNEL_COUNT: "2",
    TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
    TESTNET_MAX_TX_FEE_STROOPS: "2000000",
    TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
    RATE_LIMIT_PER_MINUTE: "0",
    DISCOVERY_ALLOW_LOOPBACK: "true",
    ORIGIN_CHECK_INTERVAL_MS: "600000",
    SEARCH_EMBEDDINGS: "false",
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
    sponsor: sponsor.publicKey(),
    stop: async () => {
      await new Promise((resolve) => server.close(resolve));
      await runtime.stop();
    },
  };
}
