/**
 * The services around the Playground on the private Stellar network (docker compose --profile
 * stellar up -d): Rail402 in this process (memory store, the upto contract deployed for the run,
 * loopback discovery), the RPC behind a TLS proxy (the stock exact client reaches an https RPC only;
 * this process trusts it, a browser is told to), the demo seller on loopback, and the Playground
 * server as a child process in local mode, paid to a fresh lab account. A test wallet buys USDC on
 * the exchange, where the issuer sells it one for one.
 *
 * The engine integration tests (Node) and the browser tests (Chromium) both run on this.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Asset, type Keypair, Operation } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createSeller } from "@rail402.dev/demo-seller";
import {
  ServiceProcess,
  deployUpto,
  pinHorizon,
  startTlsRpcProxy,
  type HorizonPin,
  type IssuedAsset,
  type LocalNetwork,
  type LocalUptoContract,
} from "@rail402.dev/testkit";
import { startRail402, type RunningRail402 } from "../../../packages/sdk/test/service.ts";

const SERVER_ENTRY = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** The ledger close time public Horizon reports in this process: the facilitator and the buyer agree. */
export const HORIZON_LEDGER_SECONDS = 5;

export interface LocalServicesOptions {
  /** The Playground server's port; a free one by default. */
  readonly port?: number;
  /** Server environment added to, or overriding, the local-mode defaults. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface LocalServices {
  readonly net: LocalNetwork;
  readonly usdc: IssuedAsset;
  readonly upto: LocalUptoContract;
  readonly rail402: RunningRail402;
  readonly demoSeller: { readonly url: string; readonly payTo: string };
  readonly playground: ServiceProcess;
  /** The Playground's public origin (its PUBLIC_URL). */
  readonly publicUrl: string;
  /** The https RPC the page and the server use. */
  readonly rpcUrl: string;
  /** The lab sellers' recipient. */
  readonly labPayTo: string;
  /** Asks the catalog to do now what its background workers do on a timer. */
  nudgeCatalog(): Promise<void>;
  stop(): Promise<void>;
}

export async function startLocalServices(
  net: LocalNetwork,
  options: LocalServicesOptions = {},
): Promise<LocalServices> {
  const horizon: HorizonPin = pinHorizon({ seconds: HORIZON_LEDGER_SECONDS });
  const [usdc, upto, proxy] = await Promise.all([
    net.issueAsset("USDC"),
    deployUpto(net),
    startTlsRpcProxy(net.rpcUrl),
  ]);
  proxy.trust();
  const directory = mkdtempSync(join(tmpdir(), "rail402-playground-local-"));
  const caFile = join(directory, "rpc-ca.pem");
  writeFileSync(caFile, proxy.certificate);
  const rail402 = await startRail402(net, usdc, {
    TESTNET_UPTO_CONTRACT: upto.address,
    TESTNET_UPTO_WASM_HASH: upto.wasmHash,
    TESTNET_UPTO_TTL_KEEPER: "false",
  });
  const [demoPayTo, labPayTo] = (await net.holders(usdc, 2, "0")) as [Keypair, Keypair];
  // Onboarding buys the asset on the exchange: the issuer sells it for XLM, one for one.
  await net.classic(usdc.issuer, [
    Operation.manageSellOffer({ selling: usdc.asset, buying: Asset.native(), amount: "100000", price: "1" }),
  ]);

  const sellerServer: Server = createSeller({
    payTo: demoPayTo.publicKey(),
    facilitator: new HTTPFacilitatorClient({ url: rail402.url }),
    asset: { contract: usdc.sac, decimals: 7 },
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => sellerServer.once("listening", resolve));
  const demoUrl = `http://127.0.0.1:${String((sellerServer.address() as AddressInfo).port)}`;

  const port = options.port ?? (await freePort());
  const publicUrl = `http://127.0.0.1:${String(port)}`;
  const playground = await ServiceProcess.start({
    entry: SERVER_ENTRY,
    port,
    env: {
      PLAYGROUND_MODE: "local",
      PUBLIC_URL: publicUrl,
      // The stock exact client reaches an RPC over https only, as in the browser.
      RPC_URL: proxy.url,
      NODE_EXTRA_CA_CERTS: caFile,
      FRIENDBOT_URL: net.friendbotUrl,
      FACILITATOR_URL: rail402.url,
      BAZAAR_URL: rail402.url,
      DEMO_SELLER_URL: demoUrl,
      ASSET_CONTRACT: usdc.sac,
      ASSET_SYMBOL: "USDC",
      ASSET_DECIMALS: "7",
      ASSET_CLASSIC: `USDC:${usdc.issuer.publicKey()}`,
      UPTO_CONTRACT: upto.address,
      PLAYGROUND_PAY_TO: labPayTo.publicKey(),
      LOG_LEVEL: "trace",
      // One test client sends every call; the per-IP limits are for many visitors.
      RELAY_UNPAID_PER_MINUTE: "600",
      RELAY_UNPAID_BURST: "200",
      RELAY_PAID_PER_MINUTE: "200",
      RELAY_PAID_GLOBAL_PER_MINUTE: "600",
      PROXY_PER_MINUTE: "1200",
      PROXY_GLOBAL_PER_MINUTE: "1200",
      LAB_UNPAID_PER_MINUTE: "600",
      LAB_PAID_PER_MINUTE: "200",
      LAB_PAID_GLOBAL_PER_MINUTE: "600",
      ...options.env,
    },
  });
  await playground.waitForLog("rail402-playground listening");

  return {
    net,
    usdc,
    upto,
    rail402,
    demoSeller: { url: demoUrl, payTo: demoPayTo.publicKey() },
    playground,
    publicUrl,
    rpcUrl: proxy.url,
    labPayTo: labPayTo.publicKey(),
    async nudgeCatalog() {
      const bazaar = rail402.runtime.bazaar;
      if (bazaar === undefined) return;
      await bazaar.catalog.checkOrigins();
      await bazaar.catalog.enrich();
      await bazaar.search.refresh();
    },
    async stop() {
      await playground.kill();
      sellerServer.closeAllConnections();
      await new Promise((resolve) => sellerServer.close(resolve));
      await Promise.all([rail402.stop(), proxy.close()]);
      horizon.restore();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
