import { describe, expect, it } from "vitest";
import { paymentError, type PaymentTarget, type PayOptions } from "@rail402.dev/sdk/browser";
import { encodeTrace } from "../../../src/shared/trace.ts";
import { PICK_RULE, defaultPlan, pickHit, runAgent } from "../../src/engine/agent/planner.ts";
import { checkOutcome, runCheck } from "../../src/engine/checks/refusals.ts";
import type { LabEvent } from "../../src/engine/events.ts";
import type { RunBuyer } from "../../src/engine/scenarios/context.ts";
import { runOvercharge } from "../../src/engine/experiments/overcharge.ts";
import { runReplay } from "../../src/engine/experiments/replay.ts";
import { runPay } from "../../src/engine/scenarios/pay.ts";
import { lastBazaarTrace, runSell } from "../../src/engine/scenarios/sell.ts";
import { runUpto } from "../../src/engine/scenarios/upto.ts";
import { HASH, LISTING_ID, fakeBuyer, fakeContext, hit, paidResult, policyFor, view } from "./fakes.ts";
import { DEMO, ORIGIN, PAY_TO, exactRequired, header, testConfig } from "./helpers.ts";

const config = testConfig();
const policy = await policyFor(config);

function kinds(events: readonly LabEvent[]): string[] {
  return events.map((event) => ("phase" in event ? `${event.kind}:${event.phase}` : event.kind));
}

describe("pay for an API", () => {
  it("pays the weather endpoint once under the run's cap and key, then reads the chain", async () => {
    const calls: [PaymentTarget, PayOptions][] = [];
    const buyer = fakeBuyer(policy, {
      pay: (target, options) => {
        calls.push([target, options]);
        return Promise.resolve(paidResult());
      },
    });
    const { context, run } = fakeContext({ buyer, balances: ["1", "0.999"] });
    const outcome = await runPay(context, { city: "Izmir", ignored: "x" });
    expect(outcome).toEqual({ status: "ok", reason: "Paid and delivered." });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toEqual({ kind: "http", url: `${DEMO}/weather?city=Izmir` });
    expect(calls[0]?.[1]).toMatchObject({
      maxAmount: { amount: "0.01", asset: "USDC" },
      idempotencyKey: "pg_run-1",
    });
    expect(kinds(run.events)).toEqual(["delivery", "chain:tx", "chain:balance"]);
    expect(run.events[0]).toMatchObject({
      view: {
        target: "http",
        status: 200,
        contentType: "application/json",
        body: '{"ok":true}',
        truncated: false,
        receipt: { status: "settled", transaction: HASH, settled: "10000", verifiedOnChain: true },
      },
    });
    expect(run.events[2]).toMatchObject({ role: "payer", before: "1", after: "0.999" });
  });

  it("is not ok until the SDK proves the settlement on chain", async () => {
    const unproven = paidResult();
    const buyer = fakeBuyer(policy, {
      pay: () =>
        Promise.resolve({
          ...unproven,
          payment: unproven.payment === null ? null : { ...unproven.payment, verifiedOnChain: false },
        }),
    });
    const { context } = fakeContext({ buyer, balances: ["1", "0.999"] });
    expect(await runPay(context)).toMatchObject({ status: "info", code: "payment_settlement_unconfirmed" });
    const unknown = fakeBuyer(policy, {
      pay: () =>
        Promise.resolve({
          ...unproven,
          payment:
            unproven.payment === null
              ? null
              : { ...unproven.payment, status: "unknown", transaction: null, verifiedOnChain: false },
        }),
    });
    const second = fakeContext({ buyer: unknown, balances: ["1", "0.999"] });
    expect(await runPay(second.context)).toMatchObject({
      status: "info",
      code: "payment_settlement_unconfirmed",
    });
  });

  it("delivers a bounded body with payment material and control characters removed", async () => {
    const body = `${"x".repeat(5_000)}\u0007`;
    const buyer = fakeBuyer(policy, {
      pay: () =>
        Promise.resolve({
          ...paidResult(),
          response: {
            kind: "http",
            status: 200,
            contentType: "text/plain",
            text: body,
            bytes: 5_001,
            truncated: false,
          },
        }),
    });
    const { context, run } = fakeContext({ buyer, balances: ["1", "0.999"] });
    await runPay(context);
    const delivery = run.events.find((event) => event.kind === "delivery");
    expect(delivery).toMatchObject({ view: { truncated: true, contentType: "text/plain" } });
    const text = delivery?.kind === "delivery" ? (delivery.view.body ?? "") : "";
    expect(text.length).toBeLessThanOrEqual(4_096);
    expect(text).not.toContain("\u0007");
  });

  it("ends with the relay's own code when the relay refuses a payment's request", async () => {
    // The SDK wraps the relay's refusal as an egress payment error; the relay code survives it.
    const buyer = fakeBuyer(policy, {
      pay: () =>
        Promise.reject(
          paymentError("egress_connection_failed", {
            reason: "Too many requests from this client.",
            details: { relay: "playground_rate_limited", stage: "connect" },
          }),
        ),
    });
    const { context, run } = fakeContext({ buyer, balances: ["1"] });
    expect(await runPay(context)).toMatchObject({ status: "refused", code: "playground_rate_limited" });
    expect(run.events[0]).toMatchObject({ kind: "refusal", layer: "relay", code: "playground_rate_limited" });
  });

  it("reports a refusal before signing at the policy layer, with balances unchanged", async () => {
    const buyer = fakeBuyer(policy, {
      pay: () =>
        Promise.reject(paymentError("payment_per_call_cap_exceeded", { details: { price: "0.001" } })),
    });
    const { context, run } = fakeContext({ buyer, balances: ["1"] });
    const outcome = await runPay(context);
    expect(outcome).toMatchObject({ status: "refused", code: "payment_per_call_cap_exceeded" });
    expect(run.events[0]).toMatchObject({
      kind: "refusal",
      layer: "policy",
      code: "payment_per_call_cap_exceeded",
      details: { price: "0.001", paid: "none" },
    });
    expect(run.events[1]).toMatchObject({ kind: "chain", phase: "balance", before: "1", after: "1" });
  });

  it("calls a free resource info, not a payment", async () => {
    const buyer = fakeBuyer(policy, { pay: () => Promise.resolve(paidResult({ paid: false })) });
    const { context } = fakeContext({ buyer });
    expect((await runPay(context)).status).toBe("info");
  });
});

describe("send it twice", () => {
  it("resends the held paid request and shows the refusal and the balance since", async () => {
    let dropped = false;
    let resent = 0;
    const required = header(exactRequired({ error: "invalid_exact_stellar_payload_nonce_already_used" }));
    const buyer = fakeBuyer(policy, { pay: () => Promise.resolve(paidResult()) });
    const { context, run } = fakeContext({
      buyer,
      balances: ["1", "0.999", "0.999", "0.999"],
      replay: {
        get held() {
          return resent === 0;
        },
        resend: () => {
          resent++;
          return Promise.resolve(
            new Response(null, { status: 402, headers: { "payment-required": required } }),
          );
        },
        drop: () => {
          dropped = true;
        },
      },
    });
    const outcome = await runReplay(context);
    expect(outcome).toMatchObject({
      status: "info",
      code: "invalid_exact_stellar_payload_nonce_already_used",
    });
    expect(resent).toBe(1);
    expect(dropped).toBe(true);
    expect(kinds(run.events)).toEqual(["delivery", "chain:tx", "chain:balance", "chain:balance", "refusal"]);
    expect(run.events[3]).toMatchObject({ before: "0.999", after: "0.999" });
    expect(run.events[4]).toMatchObject({
      layer: "facilitator",
      code: "invalid_exact_stellar_payload_nonce_already_used",
    });
  });

  function replayWith(options: {
    readonly code?: string;
    readonly status?: number;
    readonly balances: readonly string[];
    readonly first?: () => Promise<ReturnType<typeof paidResult>>;
  }) {
    const required = header(exactRequired(options.code === undefined ? {} : { error: options.code }));
    let resent = 0;
    const buyer = fakeBuyer(policy, { pay: options.first ?? (() => Promise.resolve(paidResult())) });
    return fakeContext({
      buyer,
      balances: [...options.balances],
      replay: {
        get held() {
          return resent === 0;
        },
        resend: () => {
          resent++;
          return Promise.resolve(
            new Response(null, {
              status: options.status ?? 402,
              headers: { "payment-required": required },
            }),
          );
        },
        drop: () => undefined,
      },
    });
  }

  it("says why the copy was refused, per code", async () => {
    const expired = replayWith({
      code: "invalid_exact_stellar_signature_expired",
      balances: ["1", "0.999", "0.999", "0.999"],
    });
    const outcome = await runReplay(expired.context);
    expect(outcome).toMatchObject({ status: "info", code: "invalid_exact_stellar_signature_expired" });
    expect(outcome.reason).toContain("expired");
    const other = replayWith({
      code: "invalid_exact_stellar_payload_amount_mismatch",
      balances: ["1", "0.999", "0.999", "0.999"],
    });
    expect(await runReplay(other.context)).toMatchObject({
      status: "error",
      code: "invalid_exact_stellar_payload_amount_mismatch",
    });
  });

  it("does not claim a single charge when the balance moved on the resend or the first payment failed", async () => {
    const moved = replayWith({
      code: "invalid_exact_stellar_payload_nonce_already_used",
      balances: ["1", "0.999", "0.999", "0.998"],
    });
    expect(await runReplay(moved.context)).toMatchObject({
      status: "error",
      code: "playground_unexpected_error",
    });
    const unfunded = replayWith({
      balances: ["0", "0"],
      first: () => Promise.reject(paymentError("payment_insufficient_funds")),
    });
    expect(await runReplay(unfunded.context)).toMatchObject({
      status: "refused",
      code: "payment_insufficient_funds",
    });
  });
});

describe("pay per use", () => {
  it("pays the history endpoint and says how much of the cap was used", async () => {
    let url = "";
    const result = paidResult();
    const buyer = fakeBuyer(policy, {
      pay: (target) => {
        url = target.url;
        return Promise.resolve({
          ...result,
          payment:
            result.payment === null
              ? null
              : {
                  ...result.payment,
                  scheme: "upto",
                  authorized: { amount: "0.01", atomic: "100000" },
                  settled: { amount: "0.0021", atomic: "21000" },
                },
        });
      },
    });
    const { context } = fakeContext({ buyer });
    expect(await runUpto(context)).toMatchObject({
      status: "ok",
      reason: expect.stringContaining("0.0021 of 0.01") as string,
    });
    expect(url).toBe(`${DEMO}/history?city=Berlin&days=7`);
  });

  it("reports the overcharge Rail402 refused at the facilitator layer", async () => {
    let url = "";
    const buyer = fakeBuyer(policy, {
      pay: (target) => {
        url = target.url;
        return Promise.reject(
          paymentError("payment_rejected", {
            details: {
              upstream: {
                code: "invalid_upto_stellar_payload_settlement_exceeds_amount",
                reason: "too much",
              },
            },
          }),
        );
      },
    });
    const { context, run } = fakeContext({ buyer, balances: ["1"] });
    const outcome = await runOvercharge(context);
    expect(url).toBe(`${ORIGIN}/lab/greedy/history?city=Berlin&days=7`);
    expect(outcome).toMatchObject({
      status: "refused",
      code: "invalid_upto_stellar_payload_settlement_exceeds_amount",
    });
    expect(run.events[0]).toMatchObject({ kind: "refusal", layer: "facilitator", code: "payment_rejected" });
    expect(run.events[1]).toMatchObject({ before: "1", after: "1" });
  });
});

describe("sell and get listed", () => {
  it("ends refused with the catalog's code when the Bazaar will not list the route", async () => {
    const trace = encodeTrace({
      v: 1,
      bazaar: { status: "rejected", code: "bazaar_resource_unsafe", reason: "A loopback URL." },
    });
    const buyer = fakeBuyer(policy, {
      pay: () => {
        run.emit({
          kind: "http",
          phase: "response",
          id: "direct-2",
          status: 200,
          ms: 1,
          trace: decodeTraceOf(trace),
        });
        return Promise.resolve(paidResult());
      },
    });
    const { context, run } = fakeContext({ buyer, balances: ["1", "0.99"] });
    const outcome = await runSell(context);
    expect(outcome).toMatchObject({ status: "refused", code: "bazaar_resource_unsafe" });
    expect(outcome.reason).toBe("Paid, but the Bazaar refused to list this route: A loopback URL.");
  });

  it("pays the sandbox seller, waits for the origin check and finds the listing", async () => {
    const trace = encodeTrace({
      v: 1,
      bazaar: {
        status: "processing",
        code: "awaiting_origin_verification",
        listingId: LISTING_ID,
        version: 1,
      },
    });
    let reads = 0;
    const listed = view(hit({ type: "http", toolName: null, method: "GET" }), null);
    const buyer = fakeBuyer(policy, {
      pay: (target) => {
        expect(target.url).toBe(`${ORIGIN}/lab/sell/forecast/Ankara`);
        run.emit({
          kind: "http",
          phase: "response",
          id: "direct-2",
          status: 200,
          ms: 1,
          trace: decodeTraceOf(trace),
        });
        return Promise.resolve(paidResult());
      },
    });
    const { context, run } = fakeContext({
      buyer,
      catalog: {
        listing: () => {
          reads++;
          return Promise.resolve({
            hit: hit(),
            view: { ...listed, state: reads < 3 ? "pending" : "published" },
          });
        },
        // The origin check after this payment (catalog version 1) shows up as version 2.
        versions: () =>
          Promise.resolve([
            {
              version: 1,
              createdAt: "t",
              cause: "settlement",
              transaction: HASH,
              owner: PAY_TO,
              trust: "settled",
              state: "pending",
              reason: null,
            },
            ...(reads < 3
              ? []
              : [
                  {
                    version: 2,
                    createdAt: "t2",
                    cause: "origin_verification",
                    transaction: null,
                    owner: PAY_TO,
                    trust: "origin_verified" as const,
                    state: "published",
                    reason: null,
                  },
                ]),
          ]),
        search: () =>
          Promise.resolve({
            page: { hits: [], nextCursor: null, partialResults: false, method: "hybrid" },
            views: [{ ...listed, rank: 2 }],
          }),
      },
    });
    const outcome = await runSell(context);
    expect(lastBazaarTrace(run.events)?.code).toBe("awaiting_origin_verification");
    expect(reads).toBe(3);
    expect(outcome).toEqual({ status: "ok", reason: "Listed · origin_verified; search ranks it #2." });
    expect(kinds(run.events)).toEqual([
      "http:response",
      "delivery",
      "chain:tx",
      "chain:balance",
      "bazaar:listing",
      "bazaar:listing",
      "bazaar:versions",
      "bazaar:search",
    ]);
  });
});

function decodeTraceOf(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as never;
}

describe("refusal checks", () => {
  it("pays the lab offer and passes on the expected code", async () => {
    const urls: string[] = [];
    const buyer = fakeBuyer(policy, {
      pay: (target) => {
        urls.push(target.url);
        return Promise.reject(paymentError("payment_network_not_permitted"));
      },
    });
    const { context } = fakeContext({ buyer, balances: ["1"] });
    expect(await runCheck(context, "network")).toMatchObject({
      status: "refused",
      code: "payment_network_not_permitted",
    });
    expect(urls).toEqual([`${ORIGIN}/lab/offers/pubnet`]);
  });

  it("denies exactly the seller's recipient with a one-off buyer", async () => {
    const derived: unknown[] = [];
    const strict = fakeBuyer(policy, {
      pay: () => Promise.reject(paymentError("payment_recipient_not_permitted")),
    });
    const buyer = fakeBuyer(policy, {
      quote: () =>
        Promise.resolve({
          callId: "q",
          resource: `${DEMO}/weather`,
          paymentRequired: true,
          status: 402,
          options: [{ payTo: PAY_TO } as never],
          chosen: 0,
          refused: null,
          warnings: [],
        }),
    });
    const { context } = fakeContext({
      buyer,
      derive: (options) => {
        derived.push(options);
        return Promise.resolve(strict);
      },
    });
    expect(await runCheck(context, "recipient")).toMatchObject({
      status: "refused",
      code: "payment_recipient_not_permitted",
    });
    expect(derived).toEqual([{ policy: { deny: [PAY_TO] } }]);
  });

  it("spends the session check window once, then is refused", async () => {
    const keys: (string | undefined)[] = [];
    let paid = 0;
    const strict = fakeBuyer(policy, {
      pay: (_target, options) => {
        keys.push(options.idempotencyKey);
        return paid++ === 0
          ? Promise.resolve(paidResult())
          : Promise.reject(paymentError("payment_session_cap_exceeded"));
      },
    });
    const derived: unknown[] = [];
    const { context } = fakeContext({
      buyer: fakeBuyer(policy),
      derive: (options) => {
        derived.push(options);
        return Promise.resolve(strict);
      },
    });
    const outcome = await runCheck(context, "session-budget");
    expect(outcome).toMatchObject({ status: "refused", code: "payment_session_cap_exceeded" });
    // The first payment's transaction is named in the run's summary.
    expect(outcome.transactions).toEqual([paidResult().payment?.transaction]);
    expect(outcome.transactions?.[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys).toEqual(["pg_run-1-1", "pg_run-1-2"]);
    // Your own window, lowered to what it holds (0.001 spent) plus one price.
    expect(derived).toEqual([
      {
        policy: { perCall: "0.001", sessionTotal: "0.002" },
        session: { name: "default", ttlMs: config.caps.sessionTtlMs, autoRenew: true },
      },
    ]);
  });

  it("tries both private addresses through the relay", async () => {
    const urls: string[] = [];
    const buyer = fakeBuyer(policy, {
      pay: (target) => {
        urls.push(target.url);
        return Promise.reject(paymentError("egress_destination_not_allowed", { details: { stage: "url" } }));
      },
    });
    const { context, run } = fakeContext({ buyer, balances: ["1"] });
    expect(await runCheck(context, "private-address")).toMatchObject({
      status: "refused",
      code: "egress_destination_not_allowed",
    });
    expect(urls).toEqual(["https://127.0.0.1/", "https://169.254.169.254/"]);
    expect(run.events.flatMap((event) => (event.kind === "refusal" ? [event.layer] : []))).toEqual([
      "relay",
      "relay",
    ]);
  });

  const target = "https://seller.example/";
  const refusedAt = (stage: string) => ({
    ok: false as const,
    error: paymentError("egress_destination_not_allowed", { details: { stage } }),
  });

  it("fails a check whose payment went through, and reports another refusal as it is", () => {
    expect(checkOutcome("amount", [{ target, paid: { ok: true, result: paidResult() } }])).toMatchObject({
      status: "error",
      code: "playground_unexpected_error",
    });
    expect(
      checkOutcome("amount", [
        { target, paid: { ok: false, error: paymentError("payment_scheme_not_permitted") } },
      ]),
    ).toMatchObject({
      status: "refused",
      code: "payment_scheme_not_permitted",
    });
  });

  it("says a seller that answered without asking for payment paid nothing", () => {
    const outcome = checkOutcome("network", [
      { target, paid: { ok: true, result: paidResult({ paid: false }) } },
    ]);
    expect(outcome).toMatchObject({ status: "error", code: "playground_unexpected_error" });
    expect(outcome.reason).toContain("without asking for payment; nothing was paid");
    expect(outcome.reason).not.toContain("went through");
  });

  it("passes the private-address check only when every target is refused before connecting", () => {
    const first = "https://127.0.0.1/";
    const second = "https://169.254.169.254/";
    expect(
      checkOutcome("private-address", [
        { target: first, paid: refusedAt("url") },
        { target: second, paid: refusedAt("dns") },
      ]),
    ).toMatchObject({ status: "refused", code: "egress_destination_not_allowed" });
    // One target answered: the check fails, whatever the other did.
    expect(
      checkOutcome("private-address", [
        { target: first, paid: { ok: true, result: paidResult({ paid: false }) } },
        { target: second, paid: refusedAt("url") },
      ]),
    ).toMatchObject({ status: "error", code: "playground_unexpected_error" });
    // Refused only once the relay tried to connect: not a pass.
    expect(
      checkOutcome("private-address", [
        { target: first, paid: refusedAt("connect") },
        { target: second, paid: refusedAt("url") },
      ]),
    ).toMatchObject({ status: "error" });
    // Local mode allows loopback on purpose: that target is shown but not counted.
    expect(
      checkOutcome("private-address", [
        {
          target: first,
          paid: { ok: false, error: paymentError("egress_connection_failed") },
          exempt: true,
        },
        { target: second, paid: refusedAt("url") },
      ]),
    ).toMatchObject({ status: "refused", code: "egress_destination_not_allowed" });
  });
});

describe("scripted agent", () => {
  const plan = defaultPlan("0.01", "USDC", undefined, "https://demo.example");

  it("picks by the stated rule", () => {
    expect(PICK_RULE).toContain("hourly_forecast");
    const wrongTool = hit({ toolName: "forecast" });
    const lowTrust = hit({ trust: "settled" });
    const outOfPolicy = hit({ withinPolicy: false });
    const unlisted = hit({ listingId: null });
    // Anyone can list a tool of the same name: only the demo seller's is picked.
    const foreign = hit({
      resource: "https://evil.example/mcp",
      listingId: "1f8c0f0e-0000-4000-8000-000000000003",
    });
    const good = hit({ listingId: "1f8c0f0e-0000-4000-8000-000000000001" });
    expect(pickHit([foreign, wrongTool, lowTrust, outOfPolicy, unlisted, good], plan)).toBe(good);
    expect(pickHit([wrongTool, lowTrust, foreign], plan)).toBeUndefined();
  });

  it("searches, checks its budget and pays the pick through the real tools", async () => {
    const picked = hit();
    const payListing: unknown[] = [];
    const buyer = fakeBuyer(policy, {
      listing: () => Promise.resolve({ ...picked, state: "published" as const }),
      payListing: (listing, call, options) => {
        payListing.push([
          typeof listing === "string" ? listing : listing.listingId,
          call,
          options.idempotencyKey,
        ]);
        return Promise.resolve(paidResult());
      },
    });
    const { context, run } = fakeContext({
      buyer,
      catalog: {
        search: (query, filters) => {
          expect(query).toBe("hourly weather forecast");
          expect(filters).toMatchObject({ type: "mcp", maxPrice: "0.05" });
          const decoy = hit({ toolName: "forecast", listingId: "1f8c0f0e-0000-4000-8000-000000000002" });
          return Promise.resolve({
            page: { hits: [decoy, picked], nextCursor: null, partialResults: false, method: "hybrid" },
            views: [view(decoy, 1), view(picked, 2)],
          });
        },
      },
    });
    const outcome = await runAgent(context, plan);
    expect(outcome.status).toBe("ok");
    expect(payListing).toEqual([[LISTING_ID, { arguments: { city: "Izmir", hours: 6 } }, "pg_run-1"]]);
    expect(kinds(run.events)).toEqual([
      "tool:call",
      "bazaar:search",
      "tool:result",
      "bazaar:listing",
      "tool:call",
      "tool:result",
      "tool:call",
      "tool:result",
      "delivery",
      "chain:tx",
      "chain:balance",
    ]);
    const names = run.events.flatMap((event) =>
      event.kind === "tool" && event.phase === "call" ? [event.name] : [],
    );
    expect(names).toEqual(["search_stellar_resources", "get_budget", "pay_and_call"]);
  });

  /** A context whose search returns one pickable hit and whose buyer pays it with `payListing`. */
  function agentContext(payListing: RunBuyer["payListing"]) {
    const picked = hit();
    const buyer = fakeBuyer(policy, {
      listing: () => Promise.resolve({ ...picked, state: "published" as const }),
      payListing,
    });
    return fakeContext({
      buyer,
      catalog: {
        search: () =>
          Promise.resolve({
            page: { hits: [picked], nextCursor: null, partialResults: false, method: "hybrid" },
            views: [view(picked)],
          }),
      },
    });
  }

  it("ends info, not ok, while the chain has not proven the agent's payment", async () => {
    const { context, run } = agentContext(() => Promise.resolve(paidResult({ verifiedOnChain: false })));
    expect(await runAgent(context, plan)).toMatchObject({
      status: "info",
      code: "payment_settlement_unconfirmed",
    });
    expect(run.events.find((event) => event.kind === "delivery")).toMatchObject({
      view: { target: "mcp", receipt: { verifiedOnChain: false, transaction: HASH } },
    });
  });

  it("reports the receipt and transaction of a tool call that failed after paying", async () => {
    const receipt = paidResult().payment;
    if (receipt === null) throw new Error("no receipt");
    const { context, run } = agentContext(() =>
      Promise.reject(paymentError("payment_resource_failed", { receipt })),
    );
    expect(await runAgent(context, plan)).toMatchObject({ status: "error", code: "payment_resource_failed" });
    expect(run.events.find((event) => event.kind === "refusal")).toMatchObject({
      details: { paid: "settled" },
    });
    expect(run.events.find((event) => event.kind === "delivery")).toMatchObject({
      view: { body: null, receipt: { transaction: HASH, status: "settled" } },
    });
    expect(run.events.some((event) => event.kind === "chain" && event.phase === "tx")).toBe(true);
  });

  it("refuses when nothing passes the pick rule", async () => {
    const buyer = fakeBuyer(policy);
    const { context, run } = fakeContext({
      buyer,
      catalog: {
        search: () =>
          Promise.resolve({
            page: { hits: [], nextCursor: null, partialResults: false, method: "hybrid" },
            views: [],
          }),
      },
    });
    expect(await runAgent(context, plan)).toMatchObject({ status: "refused", code: "listing_not_payable" });
    expect(run.events.at(-1)).toMatchObject({ kind: "refusal", code: "listing_not_payable" });
  });

  it("reports a refused tool payment at its layer", async () => {
    const picked = hit();
    const buyer = fakeBuyer(policy, {
      listing: () => Promise.resolve({ ...picked, state: "published" as const }),
      payListing: () => Promise.reject(paymentError("payment_per_call_cap_exceeded")),
    });
    const { context, run } = fakeContext({
      buyer,
      catalog: {
        search: () =>
          Promise.resolve({
            page: { hits: [picked], nextCursor: null, partialResults: false, method: "hybrid" },
            views: [view(picked)],
          }),
      },
    });
    expect(await runAgent(context, plan)).toMatchObject({
      status: "refused",
      code: "payment_per_call_cap_exceeded",
    });
    expect(run.events.find((event) => event.kind === "refusal")).toMatchObject({ layer: "policy" });
  });
});
