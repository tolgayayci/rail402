import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { ProtocolError, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import {
  budgetSnapshot,
  isPaymentError,
  type FlowContext,
  type PaymentError,
  type PaymentTarget,
} from "@rail402.dev/sdk";

type McpTarget = Extract<PaymentTarget, { kind: "mcp" }>;
import {
  classifyCallError,
  payMcp,
  paymentRequiredFromError,
  paymentRequiredFromResult,
  quoteMcp,
  toOutcome,
} from "../src/flow/mcp.ts";
import { TX_HASH, countingSigner, flowContext, fundedChain } from "./flow-harness.ts";
import { LATEST, usdc } from "./helpers.ts";
import { acceptingFacilitator, startMcpSeller, type McpMode, type McpSeller } from "./mcp-seller.ts";

const cap = { amount: "0.05" };

async function refusal(promise: Promise<unknown>): Promise<PaymentError> {
  try {
    await promise;
  } catch (error) {
    if (isPaymentError(error)) return error;
    throw error;
  }
  throw new Error("expected a PaymentError");
}

describe.each<McpMode>(["stateless", "stateful", "sse"])("paid MCP tool calls (%s)", (mode) => {
  let seller: McpSeller;
  const payTo = Keypair.random().publicKey();

  beforeAll(async () => {
    seller = await startMcpSeller({
      mode,
      facilitator: acceptingFacilitator(TX_HASH),
      payTo,
      asset: usdc,
      amount: "20000",
      slowMs: 1_500,
    });
  });

  afterAll(async () => {
    await seller.close();
  });

  const context = (options: Parameters<typeof flowContext>[0] = {}) =>
    flowContext({ ports: [seller.port], ...options });
  const target = (toolName: string, args: Record<string, unknown> = {}): McpTarget => ({
    kind: "mcp",
    url: seller.url,
    toolName,
    arguments: args,
    ...(mode === "sse" ? { transport: "sse" } : {}),
  });

  it("pays a tool once and returns its content with a settled receipt", async () => {
    const signer = countingSigner();
    const before = seller.calls.length;
    const result = await payMcp(await context({ signer }), target("forecast", { city: "Izmir" }), {
      maxAmount: cap,
    });
    expect(signer.signatures).toBe(1);
    expect(result).toMatchObject({
      paid: true,
      response: { kind: "mcp", isError: false, content: [{ type: "text", text: "Sunny in Izmir" }] },
      payment: {
        status: "settled",
        payTo,
        transaction: TX_HASH,
        authorized: { amount: "0.002", atomic: "20000" },
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${TX_HASH}`,
      },
    });
    expect(seller.calls.slice(before)).toEqual([
      { tool: "forecast", paid: false },
      { tool: "forecast", paid: true },
    ]);
  });

  it("runs a free tool on the unpaid call", async () => {
    const signer = countingSigner();
    const result = await payMcp(await context({ signer }), target("echo", { text: "hello" }), {
      maxAmount: cap,
    });
    expect(result).toMatchObject({ paid: false, payment: null, response: { content: [{ text: "hello" }] } });
    expect(signer.signatures).toBe(0);
  });

  it("refuses above the cap without signing or a paid call", async () => {
    const signer = countingSigner();
    const before = seller.calls.filter((call) => call.paid).length;
    await expect(
      payMcp(await context({ signer }), target("forecast", { city: "Van" }), {
        maxAmount: { amount: "0.001" },
      }),
    ).rejects.toMatchObject({ code: "payment_per_call_cap_exceeded", paid: "none" });
    expect(signer.signatures).toBe(0);
    expect(seller.calls.filter((call) => call.paid)).toHaveLength(before);
  });

  it("keeps the budget pending when the tool fails without settling", async () => {
    const ctx = await context();
    const error = await refusal(payMcp(ctx, target("broken"), { maxAmount: cap }));
    expect(error).toMatchObject({ code: "payment_settlement_unconfirmed", paid: "unknown" });
    const budget = budgetSnapshot(ctx.ledger, ctx.spec as NonNullable<FlowContext["spec"]>, ctx.policy);
    expect(budget.assets[0]).toMatchObject({ spent: "0", pending: "0.002" });
  });

  it("frees an idempotency key on the retry itself once the chain shows its authorization unused", async () => {
    const signer = countingSigner();
    let latest = LATEST;
    const chain = fundedChain({
      reader: {
        latestLedger: () => Promise.resolve(latest),
        findTransfers: () => Promise.resolve([]),
        transaction: () => Promise.resolve("missing"),
      },
    });
    const ctx = await context({ signer, chain });
    const options = { maxAmount: cap, idempotencyKey: "tool-retry-1" };
    await refusal(payMcp(ctx, target("broken"), options));
    expect(await refusal(payMcp(ctx, target("broken"), options))).toMatchObject({
      code: "payment_settlement_unconfirmed",
      paid: "unknown",
    });
    expect(signer.signatures).toBe(1);
    latest = LATEST + 100_000;
    await refusal(payMcp(ctx, target("broken"), options));
    expect(signer.signatures).toBe(2);
  });

  it("binds a listing's recipient", async () => {
    await expect(
      payMcp(
        await context(),
        target("forecast", { city: "Kars" }),
        { maxAmount: cap },
        {
          listing: { binding: { type: "mcp", owner: Keypair.random().publicKey() } },
        },
      ),
    ).rejects.toMatchObject({ code: "payment_listing_mismatch" });
  });

  it("refuses an idempotency key reused for another tool instead of replaying its result", async () => {
    const signer = countingSigner();
    const ctx = await context({ signer });
    const options = { maxAmount: cap, idempotencyKey: "tool-reused-1" };
    const first = await payMcp(ctx, target("forecast", { city: "Mus" }), options);
    expect(await refusal(payMcp(ctx, target("slow"), options))).toMatchObject({
      code: "payment_request_invalid",
      paid: "none",
    });
    expect(signer.signatures).toBe(1);
    await expect(payMcp(ctx, target("forecast", { city: "Mus" }), options)).resolves.toMatchObject({
      replayed: true,
      callId: first.callId,
    });
  });

  it("binds a listing's price: a live price above the listed one is refused before signing", async () => {
    const signer = countingSigner();
    const ctx = await context({ signer });
    const listed = (amount: string) => ({
      listing: {
        binding: {
          type: "mcp" as const,
          owner: payTo,
          prices: [{ scheme: "exact", asset: usdc, payTo, amount }],
        },
      },
    });
    const before = seller.calls.filter((call) => call.paid).length;
    const refused = await refusal(
      payMcp(ctx, target("forecast", { city: "Kars" }), { maxAmount: cap }, listed("10000")),
    );
    expect(refused).toMatchObject({
      code: "payment_listing_mismatch",
      paid: "none",
      details: { listed: "0.001", live: "0.002" },
    });
    expect(signer.signatures).toBe(0);
    expect(seller.calls.filter((call) => call.paid)).toHaveLength(before);
    await expect(
      payMcp(ctx, target("forecast", { city: "Kars" }), { maxAmount: cap }, listed("20000")),
    ).resolves.toMatchObject({ paid: true });
  });

  it("waits for a paid tool that works longer than the probe's idle timeout", async () => {
    // Probes may give up after 400 ms of silence; the paid call waits for the settlement.
    const ctx = await context({
      egress: {
        schemes: ["http:"],
        ports: [seller.port],
        allowPrivateNetwork: "loopback",
        timeouts: { idleMs: 400 },
      },
    });
    const result = await payMcp(ctx, target("slow"), { maxAmount: cap });
    expect(result).toMatchObject({ paid: true, payment: { status: "settled", transaction: TX_HASH } });
    expect(result.response).toMatchObject({ content: [{ text: "done after a while" }] });
  });

  it("refuses a paid call that would exceed the request limit with its payment, before sending it", async () => {
    const signer = countingSigner();
    const ctx = await context({ signer });
    const before = seller.calls.length;
    const error = await refusal(
      payMcp(ctx, target("forecast", { city: "x".repeat(64_900) }), { maxAmount: cap }),
    );
    expect(error).toMatchObject({ code: "egress_request_too_large", paid: "none" });
    expect(signer.signatures).toBe(1);
    // Only the unpaid probe reached the seller.
    expect(seller.calls.slice(before)).toEqual([{ tool: "forecast", paid: false }]);
  });

  it("quotes a paid tool without paying", async () => {
    const quote = await quoteMcp(await context(), target("forecast", { city: "Rize" }));
    expect(quote).toMatchObject({ paymentRequired: true, chosen: 0, warnings: [] });
    expect(quote.options[0]).toMatchObject({ amount: "0.002", acceptable: true, payTo });
  });
});

describe("MCP flow edges", () => {
  it("refuses endpoints it cannot reach and oversized arguments before connecting", async () => {
    const ctx = await flowContext();
    await expect(
      payMcp(ctx, { kind: "mcp", url: "mcp://tool/forecast", toolName: "forecast" }, { maxAmount: cap }),
    ).rejects.toMatchObject({ code: "mcp_endpoint_unresolvable" });
    await expect(
      payMcp(
        ctx,
        {
          kind: "mcp",
          url: "https://tools.example/mcp",
          toolName: "forecast",
          arguments: { big: "x".repeat(70_000) },
        },
        { maxAmount: cap },
      ),
    ).rejects.toMatchObject({ code: "egress_request_too_large" });
    await expect(
      payMcp(ctx, { kind: "mcp", url: "http://127.0.0.1:9/mcp", toolName: "forecast" }, { maxAmount: cap }),
    ).rejects.toMatchObject({ code: "egress_port_not_allowed", paid: "none" });
  });

  it("reports an unknown tool", async () => {
    const seller = await startMcpSeller({
      mode: "stateless",
      facilitator: acceptingFacilitator(TX_HASH),
      payTo: Keypair.random().publicKey(),
      asset: usdc,
      amount: "20000",
    });
    try {
      const ctx = await flowContext({ ports: [seller.port] });
      await expect(
        payMcp(ctx, { kind: "mcp", url: seller.url, toolName: "missing" }, { maxAmount: cap }),
      ).rejects.toMatchObject({ code: "mcp_tool_not_found", paid: "none" });
    } finally {
      await seller.close();
    }
  });

  it("recognises payment required as a result and as a JSON-RPC error", () => {
    const required = { x402Version: 2, accepts: [], resource: { url: "x" } };
    expect(paymentRequiredFromResult({ isError: true, structuredContent: required, content: [] })).toEqual(
      required,
    );
    expect(
      paymentRequiredFromResult({
        isError: true,
        content: [{ type: "text", text: JSON.stringify(required) }],
      } as never),
    ).toEqual(required);
    expect(
      paymentRequiredFromResult({ content: [{ type: "text", text: JSON.stringify(required) }] } as never),
    ).toBe(undefined);
    expect(paymentRequiredFromError(new ProtocolError(-32042, "Payment required", required))).toEqual(
      required,
    );
    expect(
      paymentRequiredFromError(new ProtocolError(-32042, "Payment required", { x402: required })),
    ).toEqual(required);
    expect(paymentRequiredFromError(new ProtocolError(-32603, "boom", required))).toBe(undefined);
  });

  it("refuses interactive input and maps protocol failures", () => {
    expect(
      classifyCallError(new SdkError(SdkErrorCode.UnsupportedResultType, "input_required")),
    ).toMatchObject({
      code: "mcp_input_required_unsupported",
    });
    expect(classifyCallError(new ProtocolError(-32602, "Tool missing not found"))).toMatchObject({
      code: "mcp_tool_not_found",
    });
    expect(classifyCallError(new ProtocolError(-32603, "internal"))).toMatchObject({
      code: "mcp_protocol_error",
      retryable: true,
    });
  });

  it("refuses an endpoint the URL parser cannot read, with nothing paid", async () => {
    const ctx = await flowContext();
    for (const url of ["https://%", "http://[::1", "https://exa mple.com/mcp"]) {
      await expect(
        payMcp(ctx, { kind: "mcp", url, toolName: "forecast" }, { maxAmount: cap }),
      ).rejects.toMatchObject({ code: "egress_url_invalid", paid: "none" });
    }
  });

  it("sanitizes structured seller content and bounds a structured payment request", () => {
    const structuredContent: unknown = JSON.parse('{"note":"a\u202eb\u200bc","__proto__":{"polluted":1}}');
    const outcome = toOutcome({ content: [], structuredContent });
    const structured = outcome.structuredContent as Record<string, unknown>;
    expect(structured["note"]).toBe("abc");
    expect(Object.keys(structured)).toEqual(["note", "__proto__"]);
    expect(Object.getPrototypeOf(structured)).toBe(Object.prototype);
    const huge = { x402Version: 2, accepts: [], resource: { url: "x" }, padding: "p".repeat(70_000) };
    expect(paymentRequiredFromResult({ isError: true, structuredContent: huge, content: [] })).toBe(
      undefined,
    );
  });

  it("bounds and summarizes seller content", () => {
    const outcome = toOutcome({
      content: [
        { type: "text", text: "a\u0000b" },
        { type: "image", mimeType: "image/png", data: "AAAA" },
        { type: "text", text: "x".repeat(70_000) },
      ],
    } as never);
    expect(outcome.content[0]?.text).toBe("ab");
    expect(outcome.content[1]?.text).toBe("[image/png, 3 bytes omitted]");
    expect(outcome.truncated).toBe(true);
  });
});
