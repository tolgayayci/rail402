/**
 * `withSettleDedupe` end to end, through Rail402's HTTP service behind an edge and stock express
 * sellers with an `upfront` route (see settle-harness.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { withSettleDedupe } from "@rail402.dev/sdk/seller";
import { closeAll, send, signedPayment, sleep, startSeller, startService } from "./settle-harness.ts";

afterEach(closeAll);

describe("serving each payment once through Rail402", () => {
  const wrapped = (url: string) => startSeller(withSettleDedupe(new HTTPFacilitatorClient({ url })));

  it("serves a payment whose first settle answer was lost once, when the buyer sends it again", async () => {
    const rail402 = await startService();
    const seller = await wrapped(rail402.url);
    const payment = await signedPayment(seller.base);
    rail402.fail("lose");
    expect((await send(seller.base, payment)).paid).toBe(false);
    expect(await send(seller.base, payment)).toEqual({ status: 200, paid: true });
    expect(await send(seller.base, payment)).toMatchObject({ status: 402, paid: false });
    expect(seller.served()).toBe(1);
    expect(rail402.transfers()).toBe(1);
  });

  it("never serves a replayed payment again after a restart, even once the service refused a flood of its copies", async () => {
    const rail402 = await startService({ perMinute: 20 });
    const before = await wrapped(rail402.url);
    const payment = await signedPayment(before.base);
    expect(await send(before.base, payment)).toEqual({ status: 200, paid: true });

    // The seller restarts: a new process, with a new wrapper and an empty memory.
    const after = await wrapped(rail402.url);
    expect(await send(after.base, payment)).toMatchObject({ status: 402, paid: false });
    // Copies of the old payment until the service's address limit refuses the seller's settles.
    for (let copy = 0; copy < 40 && !rail402.settles.includes(429); copy++) {
      expect((await send(after.base, payment)).paid).toBe(false);
    }
    expect(rail402.settles).toContain(429);
    rail402.later(60_000);
    expect(await send(after.base, payment)).toMatchObject({ status: 402, paid: false });
    expect(before.served() + after.served()).toBe(1);
    expect(rail402.transfers()).toBe(1);
  });

  it("never serves a payment another seller started, though its own copy got no answer", async () => {
    // Two sellers that accept the same payment (replicas, or apps with the same recipient and price),
    // each with its own memory.
    const rail402 = await startService();
    const first = await wrapped(rail402.url);
    const second = await wrapped(rail402.url);
    const payment = await signedPayment(first.base);
    expect(await send(first.base, payment)).toEqual({ status: 200, paid: true });
    rail402.fail("edgeHtml429");
    expect((await send(second.base, payment)).paid).toBe(false);
    expect(await send(second.base, payment)).toMatchObject({ status: 402, paid: false });
    expect(first.served() + second.served()).toBe(1);
    expect(rail402.transfers()).toBe(1);
  });

  it("never serves a payment again whose first claim was taken over by another seller", async () => {
    // Seller A's settle claims the payment and its process dies there; A gets no answer. Once the
    // claim is stale, seller B (with a memory of its own) takes it over and settles; then the buyer sends
    // the payment to A again.
    const rail402 = await startService({ claimTtlMs: 400 });
    const a = await wrapped(rail402.url);
    const b = await wrapped(rail402.url);
    const payment = await signedPayment(a.base);
    rail402.stallNext();
    rail402.fail("cut");
    expect((await send(a.base, payment)).paid).toBe(false);
    // Past the claim's time to live.
    await rail402.claimed();
    await sleep(600);
    expect(await send(b.base, payment)).toEqual({ status: 200, paid: true });
    expect(await send(a.base, payment)).toMatchObject({ status: 402, paid: false });
    expect(await send(b.base, payment)).toMatchObject({ status: 402, paid: false });
    expect(a.served() + b.served()).toBe(1);
    expect(rail402.transfers()).toBe(1);
  });

  it("never serves a payment again that waited on a claim another seller then took over", async () => {
    // Seller A's settle claims the payment and its process dies there; the buyer's copy to A starts
    // waiting on that live claim. Once it is stale, seller B takes it over and settles, and A's waiting
    // copy is answered from B's settlement.
    const rail402 = await startService({ claimTtlMs: 400 });
    const a = await wrapped(rail402.url);
    const b = await wrapped(rail402.url);
    const payment = await signedPayment(a.base);
    rail402.stallNext();
    rail402.fail("cut");
    expect((await send(a.base, payment)).paid).toBe(false);
    await rail402.claimed();
    const waiting = send(a.base, payment);
    await sleep(600);
    expect(await send(b.base, payment)).toEqual({ status: 200, paid: true });
    expect(await waiting).toMatchObject({ status: 402, paid: false });
    expect(await send(a.base, payment)).toMatchObject({ status: 402, paid: false });
    expect(a.served() + b.served()).toBe(1);
    expect(rail402.transfers()).toBe(1);
  });

  for (const where of ["service", "edge"] as const) {
    it(`never serves an old payment again when its marked answer is held up (${where})`, async () => {
      // A payment settled three seconds ago and served; a restarted seller replays it after a settle with
      // no answer, while the service's answer is held up on its way back.
      const rail402 = await startService({ recordedMsAgo: 3_000 });
      const before = await wrapped(rail402.url);
      const payment = await signedPayment(before.base);
      expect(await send(before.base, payment)).toEqual({ status: 200, paid: true });
      const after = await wrapped(rail402.url);
      rail402.fail("reset");
      expect((await send(after.base, payment)).paid).toBe(false);
      rail402.holdAnswers(where, 2_500);
      expect(await send(after.base, payment)).toMatchObject({ status: 402, paid: false });
      expect(before.served() + after.served()).toBe(1);
      expect(rail402.transfers()).toBe(1);
    });
  }

  for (const failure of ["reset", "edge502", "edgeHtml429"] as const) {
    it(`never serves an old payment again after a restart when its next settle gets no answer (${failure})`, async () => {
      // The payment settled a minute ago and was served.
      const rail402 = await startService({ recordedMsAgo: 60_000 });
      const before = await wrapped(rail402.url);
      const payment = await signedPayment(before.base);
      expect(await send(before.base, payment)).toEqual({ status: 200, paid: true });

      // A restarted seller, whose first settle of the replayed payment gets no answer from the service.
      const after = await wrapped(rail402.url);
      rail402.fail(failure);
      expect((await send(after.base, payment)).paid).toBe(false);
      expect(await send(after.base, payment)).toMatchObject({ status: 402, paid: false });
      expect(await send(after.base, payment)).toMatchObject({ status: 402, paid: false });
      expect(before.served() + after.served()).toBe(1);
      expect(rail402.transfers()).toBe(1);
    });
  }
});
