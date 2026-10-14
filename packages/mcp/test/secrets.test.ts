/**
 * Secret canary scan of rail402-mcp: an MCP client talks to the server over Streamable HTTP (in
 * process, with a bearer token) and pays HTTP and MCP sellers with a canary key through the real
 * payment flows, including sellers that echo the payment they were paid with into their answer. The tool list, every tool result (content, structured content, `_meta`) on success
 * and on error, protocol errors and the logs at trace level must be free of the seed, its raw bytes,
 * signatures, preimages, signed authorization entries, payment headers and the HTTP token.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { KeyHolder, budgetSnapshot, type FlowContext } from "@rail402.dev/sdk";
import {
  MCP_PATH,
  createHttpHandler,
  createLogger,
  createRail402Mcp,
  type ToolBuyer,
} from "@rail402.dev/mcp";
import { SecretScanner, schemaFindings } from "@rail402.dev/testkit";
import { payHttp } from "../../sdk/src/flow/http.ts";
import { payMcp } from "../../sdk/src/flow/mcp.ts";
import {
  TX_HASH,
  echoRoute,
  flowContext,
  paidRoute,
  startSeller,
  type FakeSeller,
} from "../../sdk/test/flow-harness.ts";
import { usdc } from "../../sdk/test/helpers.ts";
import { acceptingFacilitator, startMcpSeller, type McpSeller } from "../../sdk/test/mcp-seller.ts";
import { hit, policy } from "./helpers.ts";

const canary = Keypair.random();
const token = randomBytes(32).toString("base64url");
const cap = { amount: "0.05" };

describe("secret canary scan of rail402-mcp", () => {
  const scanner = new SecretScanner(canary.secret());
  const logs: string[] = [];
  const logger = createLogger("trace", (line) => logs.push(line));
  let seller: FakeSeller;
  let mcpSeller: McpSeller;
  let context: FlowContext;
  let client: Client;
  let handler: ReturnType<typeof createHttpHandler>;

  const call = async (name: string, args: Record<string, unknown>) => {
    try {
      const result = await client.callTool({ name, arguments: args });
      scanner.capture(`tool ${name} ${JSON.stringify(args).slice(0, 80)}`, result);
      return result as { isError?: boolean; structuredContent?: Record<string, unknown> };
    } catch (error) {
      scanner.capture(`protocol error ${name}`, error);
      return undefined;
    }
  };

  beforeAll(async () => {
    scanner.addNeedle("RAIL402_MCP_TOKEN", token);
    seller = await startSeller({
      "/paid": paidRoute({}, { weather: "sunny" }),
      "/echo-paid": echoRoute,
      "/reject": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else s.paymentRequired(response, {}, { error: "invalid_exact_stellar_payload_signature" });
      },
      "/fails-after-settling": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else s.settled(response, { error: "boom" }, 500);
      },
      "/drops-after-pay": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else response.socket?.destroy();
      },
    });
    mcpSeller = await startMcpSeller({
      mode: "stateless",
      facilitator: acceptingFacilitator(TX_HASH),
      payTo: Keypair.random().publicKey(),
      asset: usdc,
      amount: "20000",
    });
    context = await flowContext({
      signer: scanner.tap(KeyHolder.fromSecret(canary.secret())),
      ports: [seller.port, mcpSeller.port],
    });
    // Payment events are logged the way the configured server logs them.
    context = {
      ...context,
      onEvent: (event) => {
        logger.debug("payment event", { ...event });
      },
    };
    const buyer: ToolBuyer = {
      network: context.network,
      address: canary.publicKey(),
      policy,
      search: () =>
        Promise.resolve({ hits: [hit()], nextCursor: null, partialResults: false, method: "hybrid" }),
      listing: () => Promise.reject(new Error("no listings in this test")),
      pay: (target, options) =>
        target.kind === "http" ? payHttp(context, target, options) : payMcp(context, target, options),
      payListing: () => Promise.reject(new Error("no listings in this test")),
      budget: () =>
        Promise.resolve(
          budgetSnapshot(context.ledger, context.spec as NonNullable<FlowContext["spec"]>, context.policy),
        ),
      reconcile: () => Promise.reject(new Error("no reconciliation in this test")),
    };
    const { factory } = createRail402Mcp({ buyer, logger });
    handler = createHttpHandler(factory, {
      token,
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: ["127.0.0.1"],
      logger,
    });
    const fetch = (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("host", new URL(url).host);
      return handler.fetch(new Request(url, { ...init, headers }));
    };
    client = new Client({ name: "secret-scan", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1${MCP_PATH}`), {
        fetch,
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    await handler.close();
    await Promise.all([seller.close(), mcpSeller.close()]);
  });

  it("publishes tool schemas with no secret-like property and no x-mcp-header", async () => {
    const listed = await client.listTools();
    scanner.capture("tools/list", listed);
    expect(listed.tools).toHaveLength(3);
    for (const tool of listed.tools) {
      expect(schemaFindings(tool.inputSchema), tool.name).toEqual([]);
      // The policy's authorization lifetime, in seconds: read by the agent, never an input.
      expect(schemaFindings(tool.outputSchema, { allow: ["maxAuthorizationSeconds"] }), tool.name).toEqual(
        [],
      );
    }
  });

  it("pays through the tools on success and on every error path", async () => {
    const http = (path: string, extra: Record<string, unknown> = {}) =>
      call("pay_and_call", { resource: `${seller.url}${path}`, spendingCap: cap, ...extra });
    expect(await http("/paid", { idempotencyKey: "canary-mcp-1" })).toMatchObject({
      structuredContent: { ok: true, paid: true },
    });
    expect(await http("/paid", { idempotencyKey: "canary-mcp-1" })).toMatchObject({
      structuredContent: { ok: true, replayed: true },
    });
    expect(await http("/echo-paid", { idempotencyKey: "canary-mcp-echo" })).toMatchObject({
      structuredContent: { ok: true, paid: true },
    });
    await http("/echo-paid", { idempotencyKey: "canary-mcp-echo" });
    expect(await http("/reject")).toMatchObject({
      structuredContent: { ok: false, error: { code: "payment_rejected" } },
    });
    await http("/fails-after-settling");
    await http("/drops-after-pay");
    await http("/paid", { spendingCap: { amount: "0.0000001" } });
    expect(
      await call("pay_and_call", {
        resource: mcpSeller.url,
        toolName: "forecast",
        arguments: { city: "Izmir" },
        spendingCap: cap,
      }),
    ).toMatchObject({ structuredContent: { ok: true, paid: true } });
    await call("pay_and_call", { resource: mcpSeller.url, toolName: "broken", spendingCap: cap });
    expect(
      await call("pay_and_call", { resource: mcpSeller.url, toolName: "echo-payment", spendingCap: cap }),
    ).toMatchObject({ structuredContent: { ok: true, paid: true } });
    await call("pay_and_call", { resource: "http://10.0.0.1/x", spendingCap: cap });
    await call("pay_and_call", { resource: `${seller.url}/paid` });
    await call("search_stellar_resources", { query: "weather" });
    await call("get_budget", {});
    await call("transfer_everything", {});
  });

  it("leaks nothing into tool results, protocol errors or logs", () => {
    for (const request of seller.seen) {
      const header = request.headers["payment-signature"];
      if (typeof header === "string") scanner.addPaymentHeader(header, Networks.TESTNET);
    }
    for (const payment of mcpSeller.payments) scanner.addPayment(payment, Networks.TESTNET);
    expect(logs.some((line) => line.includes('"payment event"'))).toBe(true);
    scanner.capture("logs (trace)", logs.join(""));
    expect(scanner.needles).toBeGreaterThan(30);
    scanner.assertClean();
  });
});
