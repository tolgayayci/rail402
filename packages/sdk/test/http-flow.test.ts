import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, type rpc } from "@stellar/stellar-sdk";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { TESTNET, type FoundTransfer } from "@rail402.dev/stellar";
import {
  MemorySpendLedger,
  budgetSnapshot,
  buildHttpRequest,
  isPaymentError,
  paymentError,
  type BudgetWindow,
  type CallResult,
  type FlowChain,
  type FlowContext,
  type PaymentError,
  type PaymentEvent,
  type Reservation,
  type SpendLedger,
  type WindowSpec,
} from "@rail402.dev/sdk";
import { SqliteSpendLedger } from "@rail402.dev/sdk/sqlite";
import { payHttp, quoteHttp } from "../src/flow/http.ts";
import {
  TX_HASH,
  countingSigner,
  flowContext,
  fundedChain,
  paidRoute,
  startSeller,
  type FakeSeller,
  type SellerRoute,
} from "./flow-harness.ts";
import { exactSettlement } from "./chain-fixtures.ts";
import { LATEST, tamperingAdapter, usdc } from "./helpers.ts";

const cap = { amount: "0.05" };

/** Settlement refusals and what a caller learns from each: whether to retry, and what was paid. */
const SETTLE_REFUSALS = [
  ["settlement_pending", false, "unknown"],
  ["settle_exact_stellar_settlement_in_progress", false, "unknown"],
  ["settle_exact_stellar_channel_unavailable", true, "not_settled"],
  ["settle_exact_stellar_transaction_submission_failed", false, "unknown"],
  ["settle_exact_stellar_transaction_expired", false, "not_settled"],
  ["invalid_exact_stellar_payload_invalid_signature", false, "unknown"],
  ["invalid_exact_stellar_payload_wrong_amount", false, "not_settled"],
] as const;

async function refusal(promise: Promise<unknown>): Promise<PaymentError> {
  try {
    await promise;
  } catch (error) {
    if (isPaymentError(error)) return error;
    throw error;
  }
  throw new Error("expected a PaymentError");
}

describe("HTTP payment flow", () => {
  let seller: FakeSeller;
  let redirectTarget = "";

  beforeAll(async () => {
    seller = await startSeller({
      "/free": (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" }).end('{"free":true}');
      },
      "/paid": paidRoute({}, { weather: "sunny" }),
      "/submit": (_request, response) => {
        response.writeHead(303, { location: "/result" }).end();
      },
      "/result": (request, response, s) => {
        if (request.method !== "GET") response.writeHead(405).end();
        else if (request.payment === undefined) s.paymentRequired(response);
        else s.settled(response, { result: true });
      },
      "/expensive": paidRoute({ amount: "5000000" }),
      "/unsponsored": paidRoute({ extra: {} }),
      "/no-extra": paidRoute({ extra: undefined }),
      "/null-extra": paidRoute({ extra: null as never }),
      "/numeric-reject": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else s.paymentRequired(response, {}, { error: 42 as never });
      },
      "/slow-paid": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else
          setTimeout(() => {
            s.settled(response, { slow: true });
          }, 1_200);
      },
      "/reject": (request, response, s) => {
        if (request.payment === undefined) {
          s.paymentRequired(response);
          return;
        }
        s.paymentRequired(response, {}, { error: "invalid_exact_stellar_payload_signature" });
      },
      // The facilitator refused the settlement with the code in the path, passed on by the seller.
      ...Object.fromEntries(
        SETTLE_REFUSALS.map(([code]) => [
          `/refused/${code}`,
          ((request, response, s) => {
            if (request.payment === undefined) {
              s.paymentRequired(response);
              return;
            }
            const answer = encodePaymentResponseHeader({
              success: false,
              errorReason: code,
              transaction: "",
              network: TESTNET,
            });
            response.writeHead(402, { "payment-response": answer }).end("{}");
          }) satisfies SellerRoute,
        ]),
      ),
      "/redirect-after-pay": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else response.writeHead(302, { location: `${s.url}/elsewhere` }).end();
      },
      "/no-settlement": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else response.writeHead(200, { "content-type": "text/plain" }).end("served\u0007 anyway");
      },
      "/fails-after-settling": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else s.settled(response, { error: "boom" }, 500);
      },
      "/server-error-after-pay": (request, response, s) => {
        if (request.payment === undefined) s.paymentRequired(response);
        else response.writeHead(503).end("down");
      },
      "/identified-down": (request, response, s) => {
        if (request.payment === undefined) {
          s.paymentRequired(
            response,
            {},
            { extensions: { "payment-identifier": { info: { required: false } } } },
          );
        } else {
          response.writeHead(503).end("down");
        }
      },
      "/v1": (_request, response) => {
        response.writeHead(402, { "content-type": "application/json" }).end('{"x402Version":1,"accepts":[]}');
      },
      "/garbled": (_request, response) => {
        response.writeHead(402, { "payment-required": "not base64 json" }).end();
      },
      "/moved": (_request, response, s) => {
        redirectTarget = `${s.url}/paid`;
        response.writeHead(302, { location: "/paid" }).end();
      },
      "/identified": (request, response, s) => {
        if (request.payment === undefined) {
          s.paymentRequired(
            response,
            {},
            { extensions: { "payment-identifier": { info: { required: false } } } },
          );
        } else {
          s.settled(response);
        }
      },
    });
  });

  afterAll(async () => {
    await seller.close();
  });

  const context = (options: Parameters<typeof flowContext>[0] = {}) =>
    flowContext({ ports: [seller.port], ...options });

  it("resolves a free resource without paying", async () => {
    const signer = countingSigner();
    const result = await payHttp(
      await context({ signer }),
      { kind: "http", url: `${seller.url}/free` },
      { maxAmount: cap },
    );
    expect(result).toMatchObject({ paid: false, payment: null, replayed: false });
    expect(result.response).toMatchObject({ kind: "http", status: 200, json: { free: true } });
    expect(signer.signatures).toBe(0);
  });

  it("pays once, sends the signature only to the paid origin and commits the budget", async () => {
    const signer = countingSigner();
    const events: PaymentEvent[] = [];
    const ctx = await context({ signer, events });
    const before = seller.seen.length;
    const result = await payHttp(
      ctx,
      { kind: "http", url: `${seller.url}/paid?city=Ankara` },
      { maxAmount: cap },
    );

    expect(signer.signatures).toBe(1);
    expect(result.paid).toBe(true);
    expect(result.payment).toMatchObject({
      status: "settled",
      scheme: "exact",
      asset: "USDC",
      assetContract: usdc,
      authorized: { amount: "0.001", atomic: "10000" },
      settled: { amount: "0.001", atomic: "10000" },
      payTo: seller.payTo,
      payer: signer.address,
      transaction: TX_HASH,
      explorerUrl: `https://explorer.rail402.dev/testnet/tx/${TX_HASH}`,
      verifiedOnChain: false,
    });
    expect(result.response).toMatchObject({ status: 200, json: { weather: "sunny" } });
    expect(result.budget?.assets[0]).toMatchObject({ spent: "0.001", pending: "0" });

    const requests = seller.seen.slice(before);
    expect(requests.map((request) => [request.path, request.payment !== undefined])).toEqual([
      ["/paid?city=Ankara", false],
      ["/paid?city=Ankara", true],
    ]);
    expect(requests[1]?.payment?.accepted).toMatchObject({ payTo: seller.payTo, amount: "10000" });
    expect(events.map((event) => event.type)).toEqual([
      "probe",
      "quote",
      "reserved",
      "signed",
      "sent",
      "settled",
    ]);
  });

  it("replays a finished call for a repeated idempotency key without signing again", async () => {
    const signer = countingSigner();
    const ctx = await context({ signer });
    const target = { kind: "http" as const, url: `${seller.url}/paid` };
    const first = await payHttp(ctx, target, { maxAmount: cap, idempotencyKey: "order-12345" });
    const paidRequests = seller.seen.filter((request) => request.payment !== undefined).length;
    const second = await payHttp(ctx, target, { maxAmount: cap, idempotencyKey: "order-12345" });

    expect(second).toMatchObject({ replayed: true, callId: first.callId, payment: first.payment });
    expect(signer.signatures).toBe(1);
    expect(seller.seen.filter((request) => request.payment !== undefined)).toHaveLength(paidRequests);
    expect(second.budget?.assets[0]?.spent).toBe("0.001");
  });

  it("refuses an idempotency key reused for another resource instead of replaying its result", async () => {
    const signer = countingSigner();
    const ctx = await context({ signer });
    const paid = { kind: "http" as const, url: `${seller.url}/paid` };
    const first = await payHttp(ctx, paid, { maxAmount: cap, idempotencyKey: "order-reused-1" });
    const paidRequests = seller.seen.filter((request) => request.payment !== undefined).length;
    for (const url of [`${seller.url}/result`, `${seller.url}/paid?city=Van`]) {
      const refused = await refusal(
        payHttp(ctx, { kind: "http", url }, { maxAmount: cap, idempotencyKey: "order-reused-1" }),
      );
      expect(refused).toMatchObject({ code: "payment_request_invalid", paid: "none" });
      expect(refused.reason).toMatch(/another resource/);
      expect(refused.callId).not.toBe(first.callId);
    }
    expect(signer.signatures).toBe(1);
    expect(seller.seen.filter((request) => request.payment !== undefined)).toHaveLength(paidRequests);
    // The key still replays its own call.
    await expect(
      payHttp(ctx, paid, { maxAmount: cap, idempotencyKey: "order-reused-1" }),
    ).resolves.toMatchObject({ replayed: true, callId: first.callId });
  });

  it("replays a stored failure with what the chain proved since", async () => {
    const signer = countingSigner();
    const ledger = new MemorySpendLedger();
    const ctx = await context({ signer, ledger });
    const target = { kind: "http" as const, url: `${seller.url}/server-error-after-pay` };
    const first = await refusal(payHttp(ctx, target, { maxAmount: cap, idempotencyKey: "lost-12345" }));
    expect(first).toMatchObject({ code: "payment_settlement_unconfirmed", paid: "unknown" });
    const row =
      ctx.spec === undefined
        ? undefined
        : ledger.findByIdempotencyKey(ledger.window(ctx.spec).id, "lost-12345");
    if (row === undefined) throw new Error("no reservation for the key");

    // Reconciliation later proves the payment settled: the replay says so instead of "unknown".
    ledger.settle(row.id, { transaction: TX_HASH, settledAmount: row.amount, verified: true });
    const replay = await refusal(payHttp(ctx, target, { maxAmount: cap, idempotencyKey: "lost-12345" }));
    expect(replay).toMatchObject({ code: "payment_resource_failed", paid: "settled" });
    expect(replay.receipt).toMatchObject({ status: "settled", transaction: TX_HASH, verifiedOnChain: true });
    expect(signer.signatures).toBe(1);
  });

  it("frees an idempotency key on the retry itself, once the chain shows its authorization unused", async () => {
    const signer = countingSigner();
    const ledger = new MemorySpendLedger();
    let latest = LATEST;
    const chain = fundedChain({
      reader: {
        latestLedger: () => Promise.resolve(latest),
        findTransfers: () => Promise.resolve([]),
        transaction: () => Promise.resolve("missing"),
      },
    });
    const ctx = await context({ signer, ledger, chain });
    const target = { kind: "http" as const, url: `${seller.url}/server-error-after-pay` };
    await refusal(payHttp(ctx, target, { maxAmount: cap, idempotencyKey: "expired-12345" }));
    // Before expiry the retry checks the chain, finds nothing yet, and replays the stored failure.
    expect(
      await refusal(payHttp(ctx, target, { maxAmount: cap, idempotencyKey: "expired-12345" })),
    ).toMatchObject({ code: "payment_settlement_unconfirmed" });
    expect(signer.signatures).toBe(1);

    // Once expired with nothing consumed, the same retry releases the payment and pays again.
    latest = LATEST + 100_000;
    await refusal(payHttp(ctx, target, { maxAmount: cap, idempotencyKey: "expired-12345" }));
    expect(signer.signatures).toBe(2);
    const budget = budgetSnapshot(ledger, ctx.spec as NonNullable<FlowContext["spec"]>, ctx.policy);
    // The released payment counts nothing; only the new one is pending.
    expect(budget.assets[0]).toMatchObject({ spent: "0" });
  });

  it("reports a keyed retry as paid once the chain shows its authorization consumed", async () => {
    const signer = countingSigner();
    const ledger = new MemorySpendLedger();
    let latest = LATEST;
    const found: FoundTransfer[] = [];
    const settlements = new Map<string, rpc.Api.GetSuccessfulTransactionResponse>();
    const chain = fundedChain({
      reader: {
        latestLedger: () => Promise.resolve(latest),
        findTransfers: () => Promise.resolve(found),
        transaction: (hash) => Promise.resolve(settlements.get(hash) ?? "missing"),
      },
    });
    const ctx = await context({ signer, ledger, chain });
    const target = { kind: "http" as const, url: `${seller.url}/server-error-after-pay` };
    await refusal(payHttp(ctx, target, { maxAmount: cap, idempotencyKey: "landed-12345" }));
    const row =
      ctx.spec === undefined
        ? undefined
        : ledger.findByIdempotencyKey(ledger.window(ctx.spec).id, "landed-12345");
    if (row?.nonce === undefined) throw new Error("no signed reservation for the key");
    // The seller settled it after all, and never said so.
    found.push({
      contract: row.asset,
      from: signer.address,
      to: row.payTo,
      amount: row.amount,
      ledger: (row.signedAtLedger ?? LATEST) + 1,
      transaction: TX_HASH,
    });
    settlements.set(
      TX_HASH,
      exactSettlement({
        asset: row.asset,
        payer: signer.address,
        payTo: row.payTo,
        amount: row.amount,
        nonce: row.nonce,
      }),
    );
    latest = LATEST + 100_000;
    const replay = await refusal(payHttp(ctx, target, { maxAmount: cap, idempotencyKey: "landed-12345" }));
    expect(replay).toMatchObject({ code: "payment_resource_failed", paid: "settled" });
    expect(replay.receipt).toMatchObject({ transaction: TX_HASH, verifiedOnChain: true });
    expect(signer.signatures).toBe(1);
  });

  /** A chain that, once `settled` is called, shows a reservation's authorization consumed by a settlement. */
  function settlingChain(payer: string): { chain: FlowChain; settled: (row: Reservation) => void } {
    const found: FoundTransfer[] = [];
    const settlements = new Map<string, rpc.Api.GetSuccessfulTransactionResponse>();
    const chain = fundedChain({
      reader: {
        latestLedger: () => Promise.resolve(LATEST),
        findTransfers: () => Promise.resolve(found),
        transaction: (hash) => Promise.resolve(settlements.get(hash) ?? "missing"),
      },
    });
    const settled = (row: Reservation) => {
      if (row.nonce === undefined) throw new Error("the reservation was never signed");
      found.push({
        contract: row.asset,
        from: payer,
        to: row.payTo,
        amount: row.amount,
        ledger: (row.signedAtLedger ?? LATEST) + 1,
        transaction: TX_HASH,
      });
      settlements.set(
        TX_HASH,
        exactSettlement({ asset: row.asset, payer, payTo: row.payTo, amount: row.amount, nonce: row.nonce }),
      );
    };
    return { chain, settled };
  }

  const windowChanges: readonly [string, (ledger: SpendLedger, spec: WindowSpec) => BudgetWindow][] = [
    // The window reached the end of its time to live and renewed.
    ["the window renewed", (ledger, spec) => ledger.window(spec, ledger.window(spec).expiresAt)],
    // The owner started a new session, as `rail402 session start --force` does.
    ["a new session", (ledger, spec) => ledger.startWindow(spec)],
  ];
  const keyedLedgers: readonly [string, () => SpendLedger][] = [
    ["memory", () => new MemorySpendLedger()],
    ["sqlite", () => new SqliteSpendLedger(":memory:")],
  ];

  for (const [change, move] of windowChanges) {
    for (const [kind, open] of keyedLedgers) {
      it(`never pays twice for a keyed retry in a later budget window (${change}, ${kind} ledger)`, async () => {
        const signer = countingSigner();
        const ledger = open();
        const { chain, settled } = settlingChain(signer.address);
        const ctx = await context({ signer, ledger, chain });
        const spec = ctx.spec as WindowSpec;
        const target = { kind: "http" as const, url: `${seller.url}/server-error-after-pay` };
        const options = { maxAmount: cap, idempotencyKey: "window-retry-1" };
        const paidRequests = () =>
          seller.seen.filter((request) => request.path === "/server-error-after-pay" && request.payment)
            .length;

        expect(await refusal(payHttp(ctx, target, options))).toMatchObject({ paid: "unknown" });
        const row = ledger.findByIdempotencyKey(ledger.window(spec).id, "window-retry-1");
        if (row === undefined) throw new Error("no reservation for the key");
        const sent = paidRequests();
        expect(move(ledger, spec).id).not.toBe(row.windowId);

        // Before the chain shows anything, the retry replays the open outcome.
        expect(await refusal(payHttp(ctx, target, options))).toMatchObject({
          code: "payment_settlement_unconfirmed",
          paid: "unknown",
        });
        expect(signer.signatures).toBe(1);
        // Once the chain shows the payment consumed, the retry says it paid.
        settled(row);
        const replay = await refusal(payHttp(ctx, target, options));
        expect(replay).toMatchObject({ code: "payment_resource_failed", paid: "settled" });
        expect(replay.receipt).toMatchObject({ transaction: TX_HASH, verifiedOnChain: true });
        expect(signer.signatures).toBe(1);
        expect(paidRequests()).toBe(sent);
        ledger.close();
      });
    }
  }

  it("keeps a key's payment identifier across budget windows", async () => {
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
    const target = { kind: "http" as const, url: `${seller.url}/identified-down` };
    const options = { maxAmount: cap, idempotencyKey: "identified-retry-1" };
    const identifiers = () =>
      seller.seen
        .filter((request) => request.path === "/identified-down" && request.payment !== undefined)
        .map((request) => request.payment?.extensions?.["payment-identifier"]);

    await refusal(payHttp(ctx, target, options));
    ctx.ledger.startWindow(ctx.spec as WindowSpec);
    // The chain shows the first authorization expired unused, so the retry pays again, as the same payment.
    latest = LATEST + 100_000;
    await refusal(payHttp(ctx, target, options));
    expect(signer.signatures).toBe(2);
    const [first, second] = identifiers();
    expect(first).toMatchObject({ info: { id: expect.stringMatching(/^rail402_/) as string } });
    expect(second).toEqual(first);
  });

  it("sends a new payment identifier when a freed key pays another resource", async () => {
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
    const options = { maxAmount: cap, idempotencyKey: "moved-key-1" };
    const identifierOf = (path: string) =>
      (
        seller.seen.filter((request) => request.path === path && request.payment !== undefined).at(-1)
          ?.payment?.extensions?.["payment-identifier"] as { info?: { id?: unknown } } | undefined
      )?.info?.id;
    await refusal(payHttp(ctx, { kind: "http", url: `${seller.url}/identified-down` }, options));
    // The first authorization expired unused, so the key is free; it now pays another resource.
    latest = LATEST + 100_000;
    await payHttp(ctx, { kind: "http", url: `${seller.url}/identified` }, options);
    expect(signer.signatures).toBe(2);
    expect(identifierOf("/identified")).toMatch(/^rail402_[A-Za-z0-9_-]{32}$/);
    expect(identifierOf("/identified")).not.toBe(identifierOf("/identified-down"));
  });

  it("appends the payment identifier kept with the idempotency key", async () => {
    const signer = countingSigner();
    const ctx = await context({ signer });
    await payHttp(
      ctx,
      { kind: "http", url: `${seller.url}/identified` },
      { maxAmount: cap, idempotencyKey: "key-abcdef" },
    );
    const sent = seller.seen.at(-1)?.payment?.extensions?.["payment-identifier"] as
      { info?: { id?: unknown } } | undefined;
    const kept = ctx.ledger.findIdempotencyKey(TESTNET, signer.address, "key-abcdef")?.paymentId;
    expect(kept).toMatch(/^rail402_[A-Za-z0-9_-]{32}$/);
    expect(sent?.info?.id).toBe(kept);
  });

  it("chooses a key's payment identifier at random, so the payer, network and key never give it away", async () => {
    const signer = countingSigner();
    const target = { kind: "http" as const, url: `${seller.url}/identified` };
    const options = { maxAmount: cap, idempotencyKey: "weather-ankara-1" };
    const identifiers: unknown[] = [];
    // The same payer, network and key, with two ledgers (two buyers of one key).
    for (let buyer = 0; buyer < 2; buyer++) {
      await payHttp(await context({ signer }), target, options);
      const sent = seller.seen.at(-1)?.payment?.extensions?.["payment-identifier"] as
        { info?: { id?: unknown } } | undefined;
      identifiers.push(sent?.info?.id);
    }
    expect(identifiers[0]).toMatch(/^rail402_[A-Za-z0-9_-]{32}$/);
    expect(identifiers[1]).toMatch(/^rail402_[A-Za-z0-9_-]{32}$/);
    expect(identifiers[0]).not.toBe(identifiers[1]);
  });

  it("refuses a price above the cap before anything is signed", async () => {
    const signer = countingSigner();
    const error = await refusal(
      payHttp(
        await context({ signer }),
        { kind: "http", url: `${seller.url}/expensive` },
        { maxAmount: cap },
      ),
    );
    expect(error).toMatchObject({ code: "payment_per_call_cap_exceeded", paid: "none" });
    expect(error.details).toMatchObject({ price: "0.5", cap: "0.05" });
    expect(signer.signatures).toBe(0);
  });

  it("refuses unsponsored fees, v1 and garbled requirements", async () => {
    const ctx = await context();
    await expect(
      payHttp(ctx, { kind: "http", url: `${seller.url}/unsponsored` }, { maxAmount: cap }),
    ).rejects.toMatchObject({ code: "payment_fees_not_sponsored" });
    await expect(
      payHttp(ctx, { kind: "http", url: `${seller.url}/v1` }, { maxAmount: cap }),
    ).rejects.toMatchObject({
      code: "payment_requirements_invalid",
    });
    await expect(
      payHttp(ctx, { kind: "http", url: `${seller.url}/garbled` }, { maxAmount: cap }),
    ).rejects.toMatchObject({ code: "payment_requirements_invalid" });
  });

  it("refuses an option without extra as unsponsored, in pay and in quote, before signing", async () => {
    const signer = countingSigner();
    const ctx = await context({ signer });
    for (const path of ["/no-extra", "/null-extra"]) {
      const target = { kind: "http" as const, url: `${seller.url}${path}` };
      await expect(payHttp(ctx, target, { maxAmount: cap })).rejects.toMatchObject({
        code: "payment_fees_not_sponsored",
        paid: "none",
      });
      const quote = await quoteHttp(ctx, target, { maxAmount: cap });
      expect(quote.options[0]).toMatchObject({ feesSponsored: false, acceptable: false });
    }
    expect(signer.signatures).toBe(0);
  });

  it("reports a rejection whose seller error is not text", async () => {
    const error = await refusal(
      payHttp(await context(), { kind: "http", url: `${seller.url}/numeric-reject` }, { maxAmount: cap }),
    );
    expect(error).toMatchObject({ code: "payment_rejected", paid: "not_settled" });
    expect(error.details).toMatchObject({ upstream: { reason: "42" } });
  });

  it("waits for a paid answer that takes longer than the probe's idle timeout", async () => {
    const ctx = await context({
      egress: {
        schemes: ["http:"],
        ports: [seller.port],
        allowPrivateNetwork: "loopback",
        timeouts: { idleMs: 400 },
      },
    });
    const result = await payHttp(ctx, { kind: "http", url: `${seller.url}/slow-paid` }, { maxAmount: cap });
    expect(result).toMatchObject({
      paid: true,
      payment: { status: "settled" },
      response: { json: { slow: true } },
    });
  });

  it("never reports a payment as unpaid when the ledger fails after it was sent", async () => {
    class FailingLedger extends MemorySpendLedger {
      override settle(): boolean {
        throw paymentError("payment_ledger_unavailable");
      }
    }
    const error = await refusal(
      payHttp(
        await context({ ledger: new FailingLedger() }),
        { kind: "http", url: `${seller.url}/paid` },
        { maxAmount: cap },
      ),
    );
    expect(error).toMatchObject({
      code: "payment_settlement_unconfirmed",
      paid: "unknown",
      retryable: false,
    });
  });

  it("reports a refused payment as not settled and keeps its budget pending", async () => {
    const ctx = await context();
    const error = await refusal(
      payHttp(ctx, { kind: "http", url: `${seller.url}/reject` }, { maxAmount: cap }),
    );
    expect(error).toMatchObject({ code: "payment_rejected", paid: "not_settled" });
    expect(error.details).toMatchObject({ upstream: { reason: "invalid_exact_stellar_payload_signature" } });
    const budget = budgetSnapshot(ctx.ledger, ctx.spec as NonNullable<FlowContext["spec"]>, ctx.policy);
    expect(budget.assets[0]).toMatchObject({ spent: "0", pending: "0.001" });
    // The refused payment's pending amount counts against the window, and never blocks the next payment
    // the window still has room for.
    const next = await payHttp(ctx, { kind: "http", url: `${seller.url}/paid` }, { maxAmount: cap });
    expect(next).toMatchObject({ paid: true, payment: { status: "settled" } });
    expect(
      budgetSnapshot(ctx.ledger, ctx.spec as NonNullable<FlowContext["spec"]>, ctx.policy).assets[0],
    ).toMatchObject({ pending: "0.001" });
  });

  it.each(SETTLE_REFUSALS)(
    "reports a settlement refused with %s as retryable %s, paid %s, and keeps its budget pending",
    async (code, retryable, paid) => {
      const ctx = await context();
      const error = await refusal(
        payHttp(ctx, { kind: "http", url: `${seller.url}/refused/${code}` }, { maxAmount: cap }),
      );
      expect(error).toMatchObject({ code: "payment_rejected", retryable, paid });
      expect(error.details).toMatchObject({ upstream: { code } });
      const budget = budgetSnapshot(ctx.ledger, ctx.spec as NonNullable<FlowContext["spec"]>, ctx.policy);
      expect(budget.assets[0]).toMatchObject({ spent: "0", pending: "0.001" });
    },
  );

  it("never follows a redirect after paying", async () => {
    const error = await refusal(
      payHttp(await context(), { kind: "http", url: `${seller.url}/redirect-after-pay` }, { maxAmount: cap }),
    );
    expect(error).toMatchObject({ code: "payment_redirect_after_payment", paid: "unknown" });
    expect(seller.seen.some((request) => request.path === "/elsewhere")).toBe(false);
  });

  it("returns an unknown receipt when the seller serves without reporting a settlement", async () => {
    const ctx = await context();
    const result = await payHttp(
      ctx,
      { kind: "http", url: `${seller.url}/no-settlement` },
      { maxAmount: cap },
    );
    expect(result.payment).toMatchObject({ status: "unknown", transaction: null, explorerUrl: null });
    expect(result.response).toMatchObject({ text: "served anyway" });
    expect(result.budget?.assets[0]).toMatchObject({ spent: "0", pending: "0.001" });
  });

  it("reports a settled payment whose resource failed", async () => {
    const error = await refusal(
      payHttp(
        await context(),
        { kind: "http", url: `${seller.url}/fails-after-settling` },
        { maxAmount: cap },
      ),
    );
    expect(error).toMatchObject({ code: "payment_resource_failed", paid: "settled" });
    expect(error.receipt).toMatchObject({ status: "settled", transaction: TX_HASH });
  });

  it("treats an error answer without a settlement report as unconfirmed", async () => {
    const error = await refusal(
      payHttp(
        await context(),
        { kind: "http", url: `${seller.url}/server-error-after-pay` },
        { maxAmount: cap },
      ),
    );
    expect(error).toMatchObject({ code: "payment_settlement_unconfirmed", paid: "unknown" });
  });

  it("follows a same-origin redirect on the probe and pays the final URL", async () => {
    const before = seller.seen.length;
    const result = await payHttp(
      await context(),
      { kind: "http", url: `${seller.url}/moved` },
      { maxAmount: cap },
    );
    expect(result.paid).toBe(true);
    const paid = seller.seen.slice(before).find((request) => request.payment !== undefined);
    expect(`${seller.url}${paid?.path ?? ""}`).toBe(redirectTarget);
  });

  it("pays the request the seller finally answered after a 303 turned a POST into a GET", async () => {
    const before = seller.seen.length;
    const result = await payHttp(
      await context(),
      { kind: "http", url: `${seller.url}/submit`, method: "POST", body: { order: 1 } },
      { maxAmount: cap },
    );
    expect(result).toMatchObject({ paid: true, response: { status: 200 } });
    const paid = seller.seen.slice(before).find((request) => request.payment !== undefined);
    expect(paid).toMatchObject({ method: "GET", path: "/result", body: "" });
    expect(paid?.headers["content-type"]).toBeUndefined();
  });

  it("does not follow redirects when paying a listing", async () => {
    const owner = Keypair.random().publicKey();
    await expect(
      payHttp(
        await context(),
        { kind: "http", url: `${seller.url}/moved` },
        { maxAmount: cap },
        { listing: { binding: { type: "http", owner } } },
      ),
    ).rejects.toMatchObject({ code: "egress_redirect_not_allowed", paid: "none" });
  });

  it("binds a listing's recipient and its price", async () => {
    const ctx = await context();
    const target = { kind: "http" as const, url: `${seller.url}/paid` };
    await expect(
      payHttp(
        ctx,
        target,
        { maxAmount: cap },
        { listing: { binding: { type: "http", owner: Keypair.random().publicKey() } } },
      ),
    ).rejects.toMatchObject({ code: "payment_listing_mismatch" });
    const listed = (amount: string) => ({
      listing: {
        binding: {
          type: "http" as const,
          owner: seller.payTo,
          prices: [{ scheme: "exact", asset: usdc, payTo: seller.payTo, amount }],
        },
      },
    });
    await expect(payHttp(ctx, target, { maxAmount: cap }, listed("9999"))).rejects.toMatchObject({
      code: "payment_listing_mismatch",
    });
    await expect(payHttp(ctx, target, { maxAmount: cap }, listed("10000"))).resolves.toMatchObject({
      paid: true,
    });
    // A binding without listed prices (a tool not confirmed at an origin) binds the recipient only.
    await expect(
      payHttp(
        ctx,
        target,
        { maxAmount: cap },
        { listing: { binding: { type: "mcp", owner: seller.payTo } } },
      ),
    ).resolves.toMatchObject({ paid: true });
  });

  it("checks funds and the recipient before signing", async () => {
    const target = { kind: "http" as const, url: `${seller.url}/paid` };
    const withFunds = (
      funds: { trustline: boolean; authorized: boolean; balance: bigint; available?: bigint } | undefined,
    ) =>
      context({
        chain: fundedChain({
          funds: () =>
            Promise.resolve(funds === undefined ? undefined : { available: funds.balance, ...funds }),
        }),
      });
    await expect(
      payHttp(await withFunds({ trustline: false, authorized: false, balance: 0n }), target, {
        maxAmount: cap,
      }),
    ).rejects.toMatchObject({ code: "payment_payer_trustline_missing" });
    await expect(
      payHttp(await withFunds({ trustline: true, authorized: false, balance: 10n ** 9n }), target, {
        maxAmount: cap,
      }),
    ).rejects.toMatchObject({ code: "payment_payer_trustline_missing" });
    await expect(
      payHttp(await withFunds({ trustline: true, authorized: true, balance: 9_999n }), target, {
        maxAmount: cap,
      }),
    ).rejects.toMatchObject({ code: "payment_insufficient_funds" });
    // Enough on the trustline, but most of it is held by open offers.
    const held = await refusal(
      payHttp(
        await withFunds({ trustline: true, authorized: true, balance: 10n ** 9n, available: 9_999n }),
        target,
        { maxAmount: cap },
      ),
    );
    expect(held).toMatchObject({ code: "payment_insufficient_funds", paid: "none" });
    expect(held.reason).toMatch(/available/);
    await expect(payHttp(await withFunds(undefined), target, { maxAmount: cap })).resolves.toMatchObject({
      paid: true,
    });
    await expect(
      payHttp(await context({ chain: fundedChain({ receivable: () => Promise.resolve(false) }) }), target, {
        maxAmount: cap,
      }),
    ).rejects.toMatchObject({ code: "payment_recipient_cannot_receive" });
    await expect(
      payHttp(
        await context({ chain: fundedChain({ funds: () => Promise.reject(new Error("down")) }) }),
        target,
        {
          maxAmount: cap,
        },
      ),
    ).rejects.toMatchObject({ code: "rpc_unavailable", retryable: true });
  });

  it("refuses a tampering scheme client after the probe, with nothing sent to the seller", async () => {
    const before = seller.seen.filter((request) => request.payment !== undefined).length;
    const error = await refusal(
      payHttp(
        await context({ tampering: { amount: 20_000n } }),
        { kind: "http", url: `${seller.url}/paid` },
        {
          maxAmount: cap,
        },
      ),
    );
    expect(error).toMatchObject({ code: "payment_authorization_rejected", paid: "none" });
    expect(seller.seen.filter((request) => request.payment !== undefined)).toHaveLength(before);
  });

  it("keeps the budget pending when the payload does not match what was signed", async () => {
    const ctx = await context({ tampering: { transactionTo: Keypair.random().publicKey() } });
    const error = await refusal(
      payHttp(ctx, { kind: "http", url: `${seller.url}/paid` }, { maxAmount: cap }),
    );
    expect(error.code).toBe("payment_authorization_rejected");
    const budget = budgetSnapshot(ctx.ledger, ctx.spec as NonNullable<FlowContext["spec"]>, ctx.policy);
    expect(budget.assets[0]?.pending).toBe("0.001");
  });

  it("verifies a reported settlement on chain", async () => {
    const adapter = {
      ...tamperingAdapter(),
      settledAmount: () => 10_000n,
    };
    const ctx = await context({
      adapters: [adapter],
      verify: "sync",
      chain: fundedChain({
        getTransaction: () =>
          Promise.resolve({ status: "SUCCESS" } as unknown as Awaited<
            ReturnType<FlowContext["chain"]["getTransaction"]>
          >),
      }),
    });
    const result = await payHttp(ctx, { kind: "http", url: `${seller.url}/paid` }, { maxAmount: cap });
    expect(result.payment?.verifiedOnChain).toBe(true);
  });

  it("counts a reused transaction hash against each payment that reports it", async () => {
    const ledger = new MemorySpendLedger();
    const ctx = await context({ ledger });
    const first = await payHttp(ctx, { kind: "http", url: `${seller.url}/paid` }, { maxAmount: cap });
    const second: CallResult = await payHttp(
      ctx,
      { kind: "http", url: `${seller.url}/paid` },
      { maxAmount: cap },
    );
    // The seller reported one hash twice: both stay claims that count as spent until the chain
    // proves each authorization on its own.
    expect(first.payment).toMatchObject({ status: "settled", verifiedOnChain: false });
    expect(second.payment).toMatchObject({ status: "settled", verifiedOnChain: false });
    expect(first.payment?.transaction).toBe(second.payment?.transaction);
    expect(second.budget?.assets[0]).toMatchObject({ spent: "0.002", pending: "0" });
  });

  it("needs a signer and a cap, and validates the request", async () => {
    const ctx = await context();
    await expect(
      payHttp(
        { ...ctx, signer: undefined, spec: undefined },
        { kind: "http", url: `${seller.url}/paid` },
        {
          maxAmount: cap,
        },
      ),
    ).rejects.toMatchObject({ code: "payment_signer_unavailable" });
    await expect(
      payHttp(
        ctx,
        { kind: "http", url: `${seller.url}/paid` },
        {} as unknown as { maxAmount: { amount: string } },
      ),
    ).rejects.toMatchObject({ code: "payment_cap_required" });
    await expect(
      payHttp(ctx, { kind: "http", url: `${seller.url}/paid` }, { maxAmount: cap, idempotencyKey: "short" }),
    ).rejects.toMatchObject({ code: "payment_request_invalid" });
    expect(() =>
      buildHttpRequest({ kind: "http", url: `${seller.url}/paid`, headers: { authorization: "x" } }),
    ).toThrow(/cannot be set/);
    expect(() => buildHttpRequest({ kind: "http", url: `${seller.url}/paid`, body: "x" })).toThrow(
      /cannot carry/,
    );
    expect(() => buildHttpRequest({ kind: "http", url: "/relative" })).toThrow(/absolute/);
    expect(
      buildHttpRequest({
        kind: "http",
        url: `${seller.url}/paid`,
        method: "POST",
        body: { city: "Izmir" },
        query: { units: "metric", tags: ["a", "b"] },
        headers: { Accept: "application/json" },
      }),
    ).toEqual({
      url: `${seller.url}/paid?units=metric&tags=a&tags=b`,
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: '{"city":"Izmir"}',
    });
  });

  it("refuses private destinations before sending anything", async () => {
    const ctx = await flowContext({ egress: {} });
    await expect(
      payHttp(ctx, { kind: "http", url: "https://169.254.169.254/latest" }, { maxAmount: cap }),
    ).rejects.toMatchObject({ code: "egress_destination_not_allowed", paid: "none" });
  });

  it("quotes without signing", async () => {
    const signer = countingSigner();
    const ctx = await context({ signer });
    const quote = await quoteHttp(ctx, { kind: "http", url: `${seller.url}/expensive` });
    expect(quote).toMatchObject({ paymentRequired: true, chosen: null });
    expect(quote.options[0]).toMatchObject({
      asset: "USDC",
      amount: "0.5",
      acceptable: false,
      refused: { code: "payment_per_call_cap_exceeded" },
    });
    const cheap = await quoteHttp(ctx, { kind: "http", url: `${seller.url}/paid` }, { maxAmount: cap });
    expect(cheap).toMatchObject({ paymentRequired: true, chosen: 0, refused: null });
    const free = await quoteHttp(ctx, { kind: "http", url: `${seller.url}/free` });
    expect(free).toMatchObject({ paymentRequired: false, status: 200 });
    expect(signer.signatures).toBe(0);
  });
});
