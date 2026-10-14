/**
 * The local-network world the secret canary scans pay in: Rail402 in this process as facilitator and
 * Bazaar, a TLS front for the RPC, a funded canary payer, a stock @x402/express seller and a stock
 * @x402/mcp seller, and a decoy origin. The sellers record every payment they receive, so each
 * suite can turn them into needles whichever process signed them.
 *
 * Express routes: `/weather` (paid, served), `/premium` (above any test cap), `/broken` (paid, the
 * handler fails, so nothing settles), `/unsettled` (the facilitator reports a failed settlement)
 * `/redirect` (paid and settled, then redirected to the decoy) and `/echo` (paid and served, the
 * answer echoing the payment it was paid with). The MCP seller's `echo-payment` tool does the same.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Networks, type Keypair } from "@stellar/stellar-sdk";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import { TESTNET } from "@rail402.dev/stellar";
import {
  type SecretScanner,
  paymentEcho,
  startDecoyOrigin,
  startTlsRpcProxy,
  type DecoyOrigin,
  type IssuedAsset,
  type LocalNetwork,
  type TlsRpcProxy,
} from "@rail402.dev/testkit";
import { startMcpSeller, type McpSeller } from "./mcp-seller.ts";
import { startRail402, type RunningRail402 } from "./service.ts";

export interface SecretWorld {
  readonly asset: IssuedAsset;
  readonly rail402: RunningRail402;
  readonly proxy: TlsRpcProxy;
  /** The funded payer whose seed is the canary. */
  readonly payer: Keypair;
  readonly sellerUrl: string;
  readonly sellerPort: number;
  readonly mcpSeller: McpSeller;
  readonly decoy: DecoyOrigin;
  /** PAYMENT-SIGNATURE headers the express seller received. */
  readonly paymentHeaders: readonly string[];
  /** Loopback ports a buyer must be allowed to reach. */
  readonly ports: readonly number[];
  /** Registers everything the sellers received as needles. */
  addReceivedPayments(scanner: SecretScanner): void;
  close(): Promise<void>;
}

const PRICE = "150000";

export async function startSecretWorld(net: LocalNetwork, symbol = "TUSD"): Promise<SecretWorld> {
  const asset = await net.issueAsset(symbol);
  const [rail402, proxy, decoy] = await Promise.all([
    startRail402(net, asset),
    startTlsRpcProxy(net.rpcUrl),
    startDecoyOrigin(),
  ]);
  const [seller, refused] = (await net.holders(asset, 2, "0")) as [Keypair, Keypair];
  const [payer] = (await net.holders(asset, 1, "10")) as [Keypair];

  const upstream = new HTTPFacilitatorClient({ url: rail402.url });
  // Settlements to `refused` fail at the facilitator, as a failed settlement on chain would.
  const facilitator: FacilitatorClient = {
    getSupported: () => upstream.getSupported(),
    verify: (payload, requirements) => upstream.verify(payload, requirements),
    settle: (payload, requirements) =>
      requirements.payTo === refused.publicKey()
        ? Promise.resolve({
            success: false,
            errorReason: "settle_exact_stellar_transaction_failed",
            transaction: "",
            network: TESTNET,
          })
        : upstream.settle(payload, requirements),
  };
  const resourceServer = new x402ResourceServer(facilitator)
    .register(TESTNET, new ExactStellarServer())
    .registerExtension(bazaarResourceServerExtension);
  const paid = (payTo: string, amount = PRICE) => ({
    accepts: {
      scheme: "exact" as const,
      price: { amount, asset: asset.sac },
      network: TESTNET as `${string}:${string}`,
      payTo,
    },
  });

  const paymentHeaders: string[] = [];
  const app = express();
  app.use((request, _response, next) => {
    const header = request.headers["payment-signature"];
    if (typeof header === "string") paymentHeaders.push(header);
    next();
  });
  app.use(
    paymentMiddleware(
      {
        "GET /weather": {
          ...paid(seller.publicKey()),
          description: "Current weather for a city",
          mimeType: "application/json",
          extensions: declareDiscoveryExtension({
            input: { city: "Ankara" },
            inputSchema: {
              properties: { city: { type: "string", description: "City name" } },
              required: ["city"],
            },
            output: { example: { temperature: 21, conditions: "sunny" } },
          }),
        },
        "GET /premium": { ...paid(seller.publicKey(), "90000000"), description: "An expensive report" },
        "GET /broken": { ...paid(seller.publicKey()), description: "A resource that fails" },
        "GET /unsettled": { ...paid(refused.publicKey()), description: "A settlement that fails" },
        "GET /redirect": { ...paid(seller.publicKey()), description: "A resource that moved" },
        "GET /echo": { ...paid(seller.publicKey()), description: "A resource that echoes its request" },
      },
      resourceServer,
    ),
  );
  app.get("/weather", (request, response) => {
    response.json({ city: request.query["city"] ?? null, temperature: 21, conditions: "sunny" });
  });
  app.get("/premium", (_request, response) => {
    response.json({ report: "…" });
  });
  app.get("/broken", (_request, response) => {
    response.status(500).json({ error: "the handler failed" });
  });
  app.get("/unsettled", (_request, response) => {
    response.json({ served: true });
  });
  app.get("/echo", (request, response) => {
    const header = request.headers["payment-signature"];
    if (typeof header !== "string") {
      response.status(400).json({ error: "no payment" });
      return;
    }
    const payment = decodePaymentSignatureHeader(header) as unknown as Record<string, unknown>;
    response.json(paymentEcho(payment, Networks.TESTNET, header));
  });
  app.get("/redirect", (_request, response) => {
    response.redirect(302, `${decoy.url}/moved`);
  });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const sellerPort = (server.address() as AddressInfo).port;

  const mcpSeller = await startMcpSeller({
    mode: "stateless",
    facilitator: upstream,
    payTo: seller.publicKey(),
    asset: asset.sac,
    amount: "250000",
  });

  return {
    asset,
    rail402,
    proxy,
    payer,
    sellerUrl: `http://127.0.0.1:${String(sellerPort)}`,
    sellerPort,
    mcpSeller,
    decoy,
    paymentHeaders,
    ports: [sellerPort, mcpSeller.port, decoy.port],
    addReceivedPayments(scanner) {
      for (const header of paymentHeaders) scanner.addPaymentHeader(header, Networks.TESTNET);
      for (const payment of mcpSeller.payments) scanner.addPayment(payment, Networks.TESTNET);
    },
    close: async () => {
      await mcpSeller.close();
      await new Promise((resolve) => server.close(resolve));
      await Promise.all([rail402.stop(), proxy.close(), decoy.close()]);
    },
  };
}

/** Asserts that the decoy never received a payment. */
export function decoyUnpaid(decoy: DecoyOrigin): boolean {
  return decoy.requests.every(
    (request) =>
      request.headers["payment-signature"] === undefined && request.headers["x-payment"] === undefined,
  );
}
