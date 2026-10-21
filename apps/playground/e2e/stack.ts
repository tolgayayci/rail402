/**
 * The browser tests' local stack, run as its own process by Playwright (`webServer`): the services
 * of test/local-services.ts with the Playground server serving the production build on
 * PLAYGROUND_E2E_PORT, plus a small control server on PLAYGROUND_E2E_CONTROL_PORT that the tests ask
 * for what a browser cannot see: chain balances, the server's logs, the decoy origin's requests.
 *
 * Before it reports ready, a separate buyer pays the demo seller's MCP tool once, so the Bazaar lists
 * it for the agent scenario. The catalog's origin checks run every second instead of on the hosted
 * timer. SIGTERM or SIGINT stops everything.
 *
 *   node --conditions=@rail402/source e2e/stack.ts
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { KeyHolder, createBuyer, exactScheme, uptoScheme } from "@rail402.dev/sdk";
import { TESTNET } from "@rail402.dev/stellar";
import { LocalNetwork, startDecoyOrigin } from "@rail402.dev/testkit";
import { startLocalServices } from "../test/local-services.ts";
import { E2E_CONTROL_PORT, E2E_PORT, type StackInfo } from "./ports.ts";

const CATALOG_INTERVAL_MS = 1_000;

const net = new LocalNetwork();
if (!(await net.available())) {
  console.error(
    `No Stellar network at ${net.rpcUrl}: start it with docker compose --profile stellar up -d --wait`,
  );
  process.exit(1);
}

const services = await startLocalServices(net, { port: E2E_PORT });
const decoy = await startDecoyOrigin();
// A seller that redirects every paid call to another origin: the relay must not follow it.
const redirector: Server = createServer((_request, response) => {
  response.writeHead(302, { location: `${decoy.url}/collect` }).end();
});
await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
const redirectorUrl = `http://127.0.0.1:${String((redirector.address() as AddressInfo).port)}`;

// The demo seller's tool is cataloged by its first settlement, from any buyer.
const holder = await net.holder(services.usdc, "1");
const primer = await createBuyer({
  network: TESTNET,
  signer: KeyHolder.fromSecret(holder.secret()),
  // The https proxy: the exact scheme's client refuses a plain http RPC.
  rpcUrl: services.rpcUrl,
  bazaarUrl: services.rail402.url,
  facilitatorUrl: services.rail402.url,
  policy: {
    assets: [{ asset: services.usdc.sac, symbol: "USDC", decimals: 7, perCall: "0.05", sessionTotal: "1" }],
    uptoContracts: [services.upto.address],
  },
  egress: {
    schemes: ["http:"],
    ports: [Number(new URL(services.demoSeller.url).port)],
    allowPrivateNetwork: "loopback",
  },
  schemes: [exactScheme(), uptoScheme({ contract: services.upto.address })],
});
try {
  // The Bazaar lists a tool once it has been paid: the Bazaar page's metered tool and the agent's pick.
  await primer.pay(
    {
      kind: "mcp",
      url: `${services.demoSeller.url}/mcp`,
      toolName: "hourly_forecast",
      arguments: { city: "Ankara", hours: 1 },
    },
    { maxAmount: { amount: "0.01", asset: "USDC" } },
  );
  await primer.pay(
    {
      kind: "mcp",
      url: `${services.demoSeller.url}/mcp`,
      toolName: "air_quality",
      arguments: { city: "Ankara" },
    },
    { maxAmount: { amount: "0.01", asset: "USDC" } },
  );
} finally {
  await primer.close();
}

let nudging = false;
const nudger = setInterval(() => {
  if (nudging) return;
  nudging = true;
  services
    .nudgeCatalog()
    .catch(() => undefined)
    .finally(() => {
      nudging = false;
    });
}, CATALOG_INTERVAL_MS);

const info: StackInfo = {
  publicUrl: services.publicUrl,
  rpcUrl: services.rpcUrl,
  friendbotUrl: net.friendbotUrl,
  rail402Url: services.rail402.url,
  sponsor: services.rail402.sponsor,
  demoSeller: services.demoSeller,
  labPayTo: services.labPayTo,
  asset: services.usdc.sac,
  assetIssuer: services.usdc.issuer.publicKey(),
  uptoContract: services.upto.address,
  redirectorUrl,
};

const control = createServer((request, response) => {
  void answer(request, response).catch((error: unknown) => {
    send(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://control");
  switch (url.pathname) {
    case "/ready":
      send(response, 200, { ready: true });
      return;
    case "/stack":
      send(response, 200, info);
      return;
    case "/balance": {
      const account = url.searchParams.get("account") ?? "";
      const balance = await net.tokenBalance(services.usdc.sac, account).catch(() => 0n);
      send(response, 200, { balance: balance.toString() });
      return;
    }
    case "/logs":
      send(response, 200, { logs: services.playground.logs, stderr: services.playground.stderr });
      return;
    case "/decoy":
      send(response, 200, { requests: decoy.requests.length });
      return;
    default:
      send(response, 404, { error: "not found" });
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

await new Promise<void>((resolve) => control.listen(E2E_CONTROL_PORT, "127.0.0.1", resolve));
console.log(`playground e2e stack ready at ${services.publicUrl}`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(nudger);
  control.closeAllConnections();
  control.close();
  redirector.closeAllConnections();
  redirector.close();
  await decoy.close();
  await services.stop();
  process.exit(0);
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
