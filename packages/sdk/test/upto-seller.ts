/**
 * An upto seller for integration tests, built with the Rail402 seller helpers on the stock x402
 * packages: `GET /metered?charge=<base units>` charges what the query says (the HTTP side of metered
 * billing), `POST /mcp` serves a metered MCP tool (`tokens`, charging its `charge` argument through
 * `meteredToolServer`) and a stock-wrapped upto tool (`summary`, which @x402/mcp settles at the cap).
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { createPaymentWrapper } from "@x402/mcp";
import type { Keypair } from "@stellar/stellar-sdk";
import { TESTNET } from "@rail402.dev/stellar";
import {
  deployUpto,
  pinHorizon,
  type IssuedAsset,
  type LocalNetwork,
  type LocalUptoContract,
} from "@rail402.dev/testkit";
import {
  UptoStellarServerScheme,
  chargeUpto,
  httpRoute,
  mcpPaymentConfig,
  mcpTool,
  meteredToolServer,
  param,
  setUptoCharge,
  upto,
  type PaymentOption,
} from "@rail402.dev/sdk/seller";
import { startRail402, type RunningRail402 } from "./service.ts";

export interface UptoSellerOptions {
  /** The facilitator (Rail402) the seller settles through. */
  readonly facilitatorUrl: string;
  readonly payTo: string;
  /** Token contract and decimals the cap is priced in. */
  readonly asset: string;
  readonly decimals: number;
  /** The cap per call, in whole units. */
  readonly cap: string;
  /** Seconds the buyer's authorization stays valid. */
  readonly maxTimeoutSeconds?: number;
}

export interface UptoSeller {
  readonly url: string;
  readonly port: number;
  /** The MCP endpoint. */
  readonly mcpUrl: string;
  close(): Promise<void>;
}

export async function startUptoSeller(options: UptoSellerOptions): Promise<UptoSeller> {
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: options.facilitatorUrl }))
    .register(TESTNET, new UptoStellarServerScheme())
    .registerExtension(bazaarResourceServerExtension);
  const option: PaymentOption = upto({
    network: TESTNET,
    payTo: options.payTo,
    maxPrice: { amount: options.cap, asset: options.asset, decimals: options.decimals },
    maxTimeoutSeconds: options.maxTimeoutSeconds ?? 120,
  });
  const metered = httpRoute({
    method: "GET",
    path: "/metered",
    description: "Metered report: charges the base units given in charge, up to the cap",
    payment: option,
    query: {
      charge: param.string({
        description: "Base units to charge for this call, at most the cap",
        required: true,
        example: "1000",
        pattern: "^[0-9]{1,20}$",
      }),
    },
    output: { example: { charged: "1000" } },
  });

  const app = express();
  app.use(paymentMiddleware({ [metered.key]: metered.config }, resourceServer));
  app.get("/metered", (request, response) => {
    const charge = typeof request.query["charge"] === "string" ? request.query["charge"] : "0";
    setUptoCharge(response, charge);
    response.json({ charged: charge });
  });

  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(port)}`;
  const mcpUrl = `${url}/mcp`;

  await resourceServer.initialize();
  const tokens = mcpTool({
    endpoint: mcpUrl,
    toolName: "tokens",
    description: "Metered text generation: charges the base units given in charge, up to the cap",
    payment: option,
    arguments: {
      prompt: param.string({ description: "What to write about", required: true, example: "rain" }),
      charge: param.integer({
        description: "Base units to charge, at most the cap",
        required: true,
        example: 1000,
      }),
    },
    output: { example: { text: "…", charged: 1000 } },
    transport: "streamable-http",
  });
  const summary = mcpTool({
    endpoint: mcpUrl,
    toolName: "summary",
    description: "A summary priced with upto but wrapped by the stock payment wrapper alone",
    payment: option,
    arguments: { topic: param.string({ description: "Topic", required: true, example: "rain" }) },
    transport: "streamable-http",
  });
  const meteredWrapper = createPaymentWrapper(
    meteredToolServer(resourceServer),
    await mcpPaymentConfig(resourceServer, tokens),
  );
  const stockWrapper = createPaymentWrapper(resourceServer, await mcpPaymentConfig(resourceServer, summary));

  const build = (): McpServer => {
    const mcp = new McpServer({ name: "upto-seller", version: "1.0.0" });
    const tokensHandler = meteredWrapper((args: { prompt: string; charge: number }) =>
      chargeUpto(
        {
          content: [{ type: "text" as const, text: `A few words on ${args.prompt}.` }],
          structuredContent: { text: `A few words on ${args.prompt}.`, charged: args.charge },
        },
        args.charge,
      ),
    );
    mcp.registerTool(
      tokens.toolName,
      { description: tokens.description, inputSchema: tokens.zodShape },
      (args, extra) => tokensHandler(args as { prompt: string; charge: number }, extra),
    );
    const summaryHandler = stockWrapper((args: { topic: string }) => ({
      content: [{ type: "text" as const, text: `Summary of ${args.topic}.` }],
    }));
    mcp.registerTool(
      summary.toolName,
      { description: summary.description, inputSchema: summary.zodShape },
      (args, extra) => summaryHandler(args as { topic: string }, extra),
    );
    return mcp;
  };
  app.post("/mcp", express.json(), (request, response) => {
    const mcp = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    void mcp
      .connect(transport)
      .then(() => transport.handleRequest(request, response, request.body))
      .catch(() => {
        if (!response.headersSent) response.status(500).end();
      });
  });

  return {
    url,
    port,
    mcpUrl,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export interface UptoEnvironment {
  readonly asset: IssuedAsset;
  readonly contract: LocalUptoContract;
  readonly rail402: RunningRail402;
  /** The seller's account, holding a trustline and nothing else at the start. */
  readonly seller: Keypair;
  readonly shop: UptoSeller;
  /** The facilitator's upto settlement authority, from its /supported. */
  readonly authority: string;
  stop(): Promise<void>;
}

/**
 * Everything an upto payment test needs on the local network: a test token, the settlement contract
 * deployed for this run, Rail402 in this process serving upto with it, and the upto seller. Horizon's
 * ledger close time is pinned for this process at `ledgerSeconds` (the facilitator's expiry bound);
 * buyers in other processes estimate their own, which on a private network is longer and so stays
 * inside that bound.
 */
export async function startUptoEnvironment(
  net: LocalNetwork,
  options: {
    readonly code?: string;
    readonly ledgerSeconds?: number;
    readonly maxTimeoutSeconds?: number;
  } = {},
): Promise<UptoEnvironment> {
  const horizon = pinHorizon({ seconds: options.ledgerSeconds ?? 2 });
  try {
    const [asset, contract] = await Promise.all([net.issueAsset(options.code ?? "USDC"), deployUpto(net)]);
    const rail402 = await startRail402(net, asset, {
      TESTNET_UPTO_CONTRACT: contract.address,
      TESTNET_UPTO_WASM_HASH: contract.wasmHash,
      TESTNET_UPTO_TTL_KEEPER: "false",
    });
    const seller = await net.holder(asset, "0");
    const supported = (await (await fetch(`${rail402.url}/supported`)).json()) as {
      kinds: { scheme: string; extra?: { facilitatorAddress?: string } }[];
    };
    const authority = supported.kinds.find((kind) => kind.scheme === "upto")?.extra?.facilitatorAddress;
    if (authority === undefined) throw new Error("the facilitator does not advertise upto");
    const shop = await startUptoSeller({
      facilitatorUrl: rail402.url,
      payTo: seller.publicKey(),
      asset: asset.sac,
      decimals: 7,
      cap: "0.05",
      ...(options.maxTimeoutSeconds === undefined ? {} : { maxTimeoutSeconds: options.maxTimeoutSeconds }),
    });
    return {
      asset,
      contract,
      rail402,
      seller,
      shop,
      authority,
      stop: async () => {
        await shop.close();
        await rail402.stop();
        horizon.restore();
      },
    };
  } catch (error) {
    horizon.restore();
    throw error;
  }
}
