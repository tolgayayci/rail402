/**
 * Secret canary scan of the buyer's payment flows: every HTTP and MCP flow, including refusals, a
 * rejected payment, failures after paying, redirects and sellers that echo the payment they were
 * paid with into their answer, runs with a canary key. Everything the
 * caller can see (results, errors with their cause chains, events, the budget, the SQLite ledger
 * files, the key holder itself) and everything a second origin received must be free of the seed,
 * its raw bytes, signatures, preimages, signed authorization entries and payment headers.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { KeyHolder, budgetSnapshot, type FlowContext, type PaymentEvent } from "@rail402.dev/sdk";
import { SqliteSpendLedger } from "@rail402.dev/sdk/sqlite";
import { SecretScanner, startDecoyOrigin, type DecoyOrigin } from "@rail402.dev/testkit";
import { payHttp } from "../src/flow/http.ts";
import { payMcp } from "../src/flow/mcp.ts";
import { TX_HASH, echoRoute, flowContext, paidRoute, startSeller, type FakeSeller } from "./flow-harness.ts";
import { usdc } from "./helpers.ts";
import { acceptingFacilitator, startMcpSeller, type McpSeller } from "./mcp-seller.ts";

const canary = Keypair.random();
const cap = { amount: "0.05" };

describe("secret canary scan of the buyer", () => {
  const scanner = new SecretScanner(canary.secret());
  const events: PaymentEvent[] = [];
  let seller: FakeSeller;
  let mcpSeller: McpSeller;
  let decoy: DecoyOrigin;
  let directory: string;
  let ledger: SqliteSpendLedger;
  let context: FlowContext;

  /** Runs a flow and captures whatever it returns or throws. */
  const outcome = async (name: string, run: () => Promise<unknown>): Promise<unknown> => {
    try {
      const result = await run();
      scanner.capture(`result ${name}`, result);
      return result;
    } catch (error) {
      scanner.capture(`error ${name}`, error);
      return error;
    }
  };

  beforeAll(async () => {
    decoy = await startDecoyOrigin();
    seller = await startSeller({
      "/paid": paidRoute({}, { weather: "sunny" }),
      "/expensive": paidRoute({ amount: "5000000" }),
      "/reject": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else s.paymentRequired(response, {}, { error: "invalid_exact_stellar_payload_signature" });
      },
      // A seller that echoes the payment deep into its refusal: the reason is cut to 300 characters.
      "/echo-reject": (request, response, s) => {
        const transaction = (request.payment?.payload as { transaction?: string } | undefined)?.transaction;
        if (transaction === undefined) s.paymentRequired(response);
        else s.paymentRequired(response, {}, { error: `${"x".repeat(250)} ${transaction}` });
      },
      // A seller that echoes the payment into its paid answer.
      "/echo-paid": echoRoute,
      "/redirect-after-pay": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else response.writeHead(302, { location: `${decoy.url}/stolen` }).end();
      },
      "/moved-away": (_request, response) => {
        response.writeHead(302, { location: `${decoy.url}/elsewhere` }).end();
      },
      "/no-settlement": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else response.writeHead(200, { "content-type": "text/plain" }).end("served anyway");
      },
      "/fails-after-settling": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else s.settled(response, { error: "boom" }, 500);
      },
      "/malformed-settlement": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else response.writeHead(200, { "payment-response": "%%%" }).end("{}");
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
    directory = mkdtempSync(join(tmpdir(), "rail402-secrets-"));
    ledger = new SqliteSpendLedger(join(directory, "ledger.sqlite"));
    context = await flowContext({
      signer: scanner.tap(KeyHolder.fromSecret(canary.secret())),
      ledger,
      events,
      ports: [seller.port, mcpSeller.port, decoy.port],
    });
  });

  afterAll(async () => {
    ledger.close();
    await Promise.all([seller.close(), mcpSeller.close(), decoy.close()]);
    rmSync(directory, { recursive: true, force: true });
  });

  const http = (path: string, options: Record<string, unknown> = {}) =>
    payHttp(context, { kind: "http", url: `${seller.url}${path}` }, { maxAmount: cap, ...options });
  const tool = (toolName: string, args: Record<string, unknown> = {}) =>
    payMcp(context, { kind: "mcp", url: mcpSeller.url, toolName, arguments: args }, { maxAmount: cap });

  it("pays HTTP resources through every outcome", async () => {
    await outcome("paid", () => http("/paid", { idempotencyKey: "canary-order-1" }));
    await outcome("replayed", () => http("/paid", { idempotencyKey: "canary-order-1" }));
    await outcome("cap exceeded", () => http("/expensive"));
    await outcome("rejected", () => http("/reject", { idempotencyKey: "canary-order-2" }));
    await outcome("rejected replay", () => http("/reject", { idempotencyKey: "canary-order-2" }));
    expect(await outcome("rejected with an echo", () => http("/echo-reject"))).toMatchObject({
      code: "payment_rejected",
    });
    expect(
      await outcome("paid with an echo", () => http("/echo-paid", { idempotencyKey: "canary-echo-1" })),
    ).toMatchObject({ paid: true });
    await outcome("echo replayed", () => http("/echo-paid", { idempotencyKey: "canary-echo-1" }));
    await outcome("no settlement", () => http("/no-settlement"));
    await outcome("fails after settling", () => http("/fails-after-settling"));
    await outcome("malformed settlement", () => http("/malformed-settlement"));
    await outcome("dropped after paying", () => http("/drops-after-pay"));
    await outcome("free", () =>
      payHttp(context, { kind: "http", url: `${decoy.url}/free` }, { maxAmount: cap }),
    );
  });

  it("keeps the payment away from other origins on redirects", async () => {
    const after = await outcome("redirect after paying", () => http("/redirect-after-pay"));
    expect(after).toMatchObject({ code: "payment_redirect_after_payment" });
    const probe = await outcome("cross-origin probe redirect", () => http("/moved-away"));
    expect(probe).toMatchObject({ code: "egress_redirect_not_allowed", paid: "none" });

    // The decoy served only the free call it was asked for, and never saw a payment.
    expect(decoy.requests.map((request) => request.url)).toEqual(["/free"]);
    for (const request of decoy.requests) {
      expect(request.headers["payment-signature"]).toBeUndefined();
      expect(request.headers["x-payment"]).toBeUndefined();
    }
    scanner.capture("decoy origin requests", decoy.requests);
  });

  it("sends no payment on an unpaid probe", () => {
    const probes = seller.seen.filter((_request, index, all) => {
      const next = all[index + 1];
      return next !== undefined && next.path === _request.path && next.payment !== undefined;
    });
    expect(probes.length).toBeGreaterThan(0);
    for (const request of probes) expect(request.headers["payment-signature"]).toBeUndefined();
  });

  it("pays MCP tools, including one that fails after payment", async () => {
    await outcome("mcp paid", () => tool("forecast", { city: "Izmir" }));
    await outcome("mcp tool failed", () => tool("broken"));
    expect(await outcome("mcp paid with an echo", () => tool("echo-payment"))).toMatchObject({ paid: true });
    await outcome("mcp free", () => tool("echo", { text: "hello" }));
    expect(mcpSeller.payments.length).toBe(3);
  });

  it("refuses signer failures that carry the seed without repeating it", async () => {
    const throwing = await flowContext({
      signer: {
        address: canary.publicKey(),
        signAuthEntry: () => Promise.reject(new Error(`wallet exploded holding ${canary.secret()}`)),
      },
      ports: [seller.port],
      events,
    });
    await outcome("signer threw", () =>
      payHttp(throwing, { kind: "http", url: `${seller.url}/paid` }, { maxAmount: cap }),
    );
    const erroring = await flowContext({
      signer: {
        address: canary.publicKey(),
        signAuthEntry: () => Promise.resolve({ signedAuthEntry: "", error: { seed: canary.secret() } }),
      },
      ports: [seller.port],
      events,
    });
    await outcome("signer returned an error", () =>
      payHttp(erroring, { kind: "http", url: `${seller.url}/paid` }, { maxAmount: cap }),
    );
  });

  it("leaks nothing into results, errors, events, the budget, the ledger or the key holder", () => {
    // Everything the paid origins received is secret: register it as needles.
    for (const request of seller.seen) {
      const header = request.headers["payment-signature"];
      if (typeof header === "string") scanner.addPaymentHeader(header, Networks.TESTNET);
    }
    for (const payment of mcpSeller.payments) scanner.addPayment(payment, Networks.TESTNET);
    expect(seller.seen.filter((request) => request.payment !== undefined).length).toBeGreaterThanOrEqual(8);

    const key = KeyHolder.fromSecret(canary.secret());
    scanner.capture("key holder", [JSON.stringify(key), inspect(key, { showHidden: true }), String(key)]);
    scanner.capture("events", events);
    scanner.capture(
      "budget",
      budgetSnapshot(ledger, context.spec as NonNullable<FlowContext["spec"]>, context.policy),
    );
    const file = join(directory, "ledger.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(file + suffix)) scanner.capture(`ledger file${suffix}`, readFileSync(file + suffix));
    }

    expect(scanner.needles).toBeGreaterThan(40);
    expect(scanner.channels.length).toBeGreaterThan(20);
    scanner.assertClean();
  });
});
