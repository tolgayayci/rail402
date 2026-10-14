/**
 * A seller that echoes its request must not hand the buyer's payment back into the call's result or
 * the budget ledger: the paid answer is returned with the call's own payment material replaced.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import {
  INLINE_BODY_BYTES,
  KeyHolder,
  MemorySpendLedger,
  REDACTED,
  type FlowContext,
} from "@rail402.dev/sdk";
import { SecretScanner, paymentEcho } from "@rail402.dev/testkit";
import { TESTNET } from "@rail402.dev/stellar";
import { payHttp } from "../src/flow/http.ts";
import { payMcp } from "../src/flow/mcp.ts";
import { paymentMaterial, scrubText } from "../src/flow/scrub.ts";
import { TX_HASH, flowContext, startSeller, type FakeSeller } from "./flow-harness.ts";
import { usdc } from "./helpers.ts";
import { acceptingFacilitator, startMcpSeller, type McpSeller } from "./mcp-seller.ts";

const cap = { amount: "0.05" };

describe("payment material in a seller's paid answer", () => {
  const canary = Keypair.random();
  let seller: FakeSeller;
  let mcpSeller: McpSeller;
  let ledger: MemorySpendLedger;
  let context: FlowContext;
  let scanner: SecretScanner;

  beforeAll(async () => {
    seller = await startSeller({
      "/echo": (request, response, s) => {
        const header = request.headers["payment-signature"];
        if (request.payment === undefined || typeof header !== "string") s.paymentRequired(response);
        else {
          s.settled(response, {
            ...paymentEcho(request.payment, Networks.TESTNET, header),
            weather: "sunny",
          });
        }
      },
      // Echoed as text beyond the inline limit, so the copy is cut off inside the header.
      "/echo-long": (request, response, s) => {
        const header = request.headers["payment-signature"];
        if (request.payment === undefined || typeof header !== "string") s.paymentRequired(response);
        else {
          const lead = "x".repeat(INLINE_BODY_BYTES - Math.floor(header.length / 2));
          response
            .writeHead(200, {
              "content-type": "text/plain",
              "payment-response": Buffer.from(
                JSON.stringify({ success: true, transaction: TX_HASH, network: TESTNET, payer: "" }),
              ).toString("base64"),
            })
            .end(`${lead}${header} and more`);
        }
      },
    });
    mcpSeller = await startMcpSeller({
      mode: "stateless",
      facilitator: acceptingFacilitator(TX_HASH),
      payTo: Keypair.random().publicKey(),
      asset: usdc,
      amount: "20000",
    });
    ledger = new MemorySpendLedger();
    scanner = new SecretScanner(canary.secret());
    context = await flowContext({
      signer: scanner.tap(KeyHolder.fromSecret(canary.secret())),
      ledger,
      ports: [seller.port, mcpSeller.port],
    });
  });

  afterAll(async () => {
    await Promise.all([seller.close(), mcpSeller.close()]);
  });

  const stored = (key: string) =>
    ledger.findByIdempotencyKey(ledger.window(context.spec as NonNullable<FlowContext["spec"]>).id, key);
  const registerReceived = () => {
    for (const request of seller.seen) {
      const header = request.headers["payment-signature"];
      if (typeof header === "string") scanner.addPaymentHeader(header, Networks.TESTNET);
    }
    for (const payment of mcpSeller.payments) scanner.addPayment(payment, Networks.TESTNET);
  };

  it("removes the payment from an HTTP answer and its stored replay, keeping the rest", async () => {
    const target = { kind: "http" as const, url: `${seller.url}/echo` };
    const options = { maxAmount: cap, idempotencyKey: "echo-order-1" };
    const result = await payHttp(context, target, options);
    const replay = await payHttp(context, target, options);
    expect(replay.replayed).toBe(true);
    expect(result.paid).toBe(true);
    const json = result.response.kind === "http" ? (result.response.json as Record<string, unknown>) : {};
    expect(json).toMatchObject({
      echo: "the request as received",
      weather: "sunny",
      header: REDACTED,
      paymentJson: REDACTED,
      headerInQuery: `/receipt?payment=${REDACTED}`,
      payload: { transaction: REDACTED },
    });
    expect((json["entries"] as unknown[]).length).toBeGreaterThan(0);
    expect(json["entries"]).toEqual((json["entries"] as unknown[]).map(() => REDACTED));
    expect(json["signatures"]).toEqual((json["signatures"] as unknown[]).map(() => REDACTED));
    expect(json["signatureValues"]).toEqual((json["signatureValues"] as unknown[]).map(() => REDACTED));
    expect(json["preimages"]).toEqual((json["preimages"] as unknown[]).map(() => REDACTED));
    // Public fields of the echoed payment stay as they were.
    expect(json["payment"]).toMatchObject({ x402Version: 2, accepted: { payTo: seller.payTo } });

    registerReceived();
    scanner.capture("result", result);
    scanner.capture("replay", replay);
    expect(stored("echo-order-1")?.result).toContain(REDACTED);
    scanner.capture("stored result", stored("echo-order-1"));
    scanner.assertClean();
  });

  it("removes a copy cut off at the inline limit", async () => {
    const result = await payHttp(
      context,
      { kind: "http", url: `${seller.url}/echo-long` },
      { maxAmount: cap },
    );
    expect(result.response).toMatchObject({ kind: "http", truncated: true });
    const text = result.response.kind === "http" ? (result.response.text ?? "") : "";
    expect(text.endsWith(REDACTED)).toBe(true);
    registerReceived();
    scanner.capture("truncated result", result);
    scanner.assertClean();
  });

  it("removes the payment from an MCP tool's content and structured content", async () => {
    const result = await payMcp(
      context,
      { kind: "mcp", url: mcpSeller.url, toolName: "echo-payment" },
      { maxAmount: cap, idempotencyKey: "echo-tool-1" },
    );
    expect(result.paid).toBe(true);
    const response = result.response.kind === "mcp" ? result.response : undefined;
    expect(response?.content[1]?.text).toBe(`paid with ${REDACTED}`);
    expect(response?.structuredContent).toMatchObject({
      paymentJson: REDACTED,
      payload: { transaction: REDACTED },
    });
    registerReceived();
    scanner.capture("mcp result", result);
    expect(stored("echo-tool-1")?.result).toContain(REDACTED);
    scanner.capture("stored result", stored("echo-tool-1"));
    scanner.assertClean();
  });
});

describe("scrubText", () => {
  const payload = {
    x402Version: 2,
    accepted: { scheme: "exact", network: TESTNET },
    payload: { transaction: "QUJD".repeat(40), note: "short" },
  } as never;
  const material = paymentMaterial(payload, TESTNET, "SEVBREVS".repeat(8));

  it("replaces verbatim, JSON-escaped and URL-encoded copies", () => {
    const transaction = "QUJD".repeat(40);
    const json = JSON.stringify(payload);
    expect(scrubText(`a ${transaction} b`, material)).toBe(`a ${REDACTED} b`);
    expect(scrubText(JSON.stringify({ text: json }), material)).toBe(`{"text":"${REDACTED}"}`);
    expect(scrubText(`?p=${encodeURIComponent(json)}`, material)).toBe(`?p=${REDACTED}`);
    expect(scrubText(`h=${"SEVBREVS".repeat(8)}`, material)).toBe(`h=${REDACTED}`);
  });

  it("leaves other content, and short payload values, as they were", () => {
    expect(scrubText("the weather is short and sunny", material)).toBe("the weather is short and sunny");
    expect(scrubText(`${"QUJD".repeat(3)} partial`, material)).toBe(`${"QUJD".repeat(3)} partial`);
  });
});
