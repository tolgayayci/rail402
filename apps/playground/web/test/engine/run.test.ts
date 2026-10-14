import { describe, expect, it } from "vitest";
import { EgressError } from "@rail402.dev/safe-fetch/shared";
import { paymentError } from "@rail402.dev/sdk/browser";
import { playgroundError } from "../../../src/shared/codes.ts";
import {
  EngineError,
  codedError,
  engineError,
  layerOfCode,
  nothingPaid,
  refusalLayer,
} from "../../src/engine/errors.ts";
import type { LabEvent } from "../../src/engine/events.ts";
import { ReconcileLoop } from "../../src/engine/reconcile.ts";
import { Run } from "../../src/engine/run.ts";
import { relayRefusal } from "../../src/transport/relay-fetch.ts";

describe("run", () => {
  it("stamps events, replays them to late subscribers and ends once", async () => {
    let now = 100;
    const run = new Run("r1", () => now);
    run.emit({ kind: "wallet", step: "created" });
    now = 130;
    const seen: LabEvent[] = [];
    run.subscribe((event) => seen.push(event));
    run.finish({ status: "ok", reason: "done" });
    run.finish({ status: "error", code: "x" });
    expect(await run.done).toEqual({ runId: "r1", status: "ok", reason: "done" });
    expect(seen).toEqual([
      { runId: "r1", at: 0, kind: "wallet", step: "created" },
      { runId: "r1", at: 30, kind: "run", phase: "end", status: "ok", reason: "done" },
    ]);
    // Events of its payments still arrive after the end.
    run.emit({ kind: "wallet", step: "forgotten" });
    expect(run.events).toHaveLength(3);
  });

  it("keeps going when a listener throws, and aborts through its signal", () => {
    const run = new Run("r2");
    run.subscribe(() => {
      throw new Error("listener");
    });
    expect(() => {
      run.emit({ kind: "wallet", step: "created" });
    }).not.toThrow();
    run.abort();
    expect(run.signal.aborted).toBe(true);
  });
});

describe("coded errors", () => {
  it("keeps codes and reasons, adds what the page needs, and hides everything else", () => {
    expect(
      codedError(paymentError("payment_rejected", { details: { upstream: { code: "invalid_x" } } })),
    ).toEqual({
      code: "payment_rejected",
      reason: expect.any(String) as string,
      retryable: false,
      details: { upstream: { code: "invalid_x" }, paid: "not_settled" },
    });
    expect(codedError(new EgressError("egress_timeout", "response"))).toMatchObject({
      code: "egress_timeout",
      details: { stage: "response" },
    });
    expect(codedError(relayRefusal("playground_rate_limited", "slow"))).toEqual({
      code: "playground_rate_limited",
      reason: "slow",
      retryable: true,
      details: { stage: "connect" },
    });
    const unknown = codedError(new Error("internal detail at /home/x"));
    expect(unknown.code).toBe("playground_unexpected_error");
    expect(JSON.stringify(unknown)).not.toContain("internal detail");
    expect(codedError(new DOMException("stop", "AbortError")).code).toBe("playground_run_aborted");
    const thrown = engineError(playgroundError("playground_wallet_locked"));
    expect(thrown).toBeInstanceOf(EngineError);
    expect(engineError(thrown)).toBe(thrown);
    expect(codedError(thrown)).toEqual(thrown.toJSON());
  });

  it("names the layer that refused", () => {
    expect(refusalLayer(paymentError("payment_network_not_permitted"))).toBe("policy");
    expect(refusalLayer(paymentError("payment_authorization_rejected"))).toBe("guard");
    expect(refusalLayer(new EgressError("egress_destination_not_allowed", "url"))).toBe("relay");
    expect(refusalLayer(relayRefusal("playground_relay_busy", "busy"))).toBe("relay");
    expect(
      refusalLayer(paymentError("payment_rejected", { details: { upstream: { code: "invalid_upto_x" } } })),
    ).toBe("facilitator");
    expect(refusalLayer(paymentError("payment_rejected", { details: { upstream: { reason: "no" } } }))).toBe(
      "seller",
    );
    expect(refusalLayer(paymentError("mcp_tool_not_found"))).toBe("seller");
    expect(refusalLayer(playgroundError("playground_wallet_missing"))).toBe("playground");
    expect(layerOfCode("invalid_exact_stellar_payload_nonce_already_used")).toBe("facilitator");
    expect(nothingPaid(paymentError("payment_settlement_unconfirmed"))).toBe(false);
    expect(nothingPaid(paymentError("payment_rejected"))).toBe(true);
  });
});

describe("reconcile loop", () => {
  it("runs a round at start, on the interval and on focus, only when one is due", async () => {
    let interval: (() => void) | undefined;
    let due = true;
    let rounds = 0;
    const focus = new EventTarget();
    const loop = new ReconcileLoop({
      due: () => due,
      tick: () => {
        rounds++;
        return Promise.resolve();
      },
      focus,
      timers: {
        setInterval: (callback) => {
          interval = callback;
          return 1;
        },
        clearInterval: () => {
          interval = undefined;
        },
      },
    });
    loop.start();
    await Promise.resolve();
    expect(rounds).toBe(1);
    interval?.();
    await Promise.resolve();
    focus.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(rounds).toBe(3);
    due = false;
    interval?.();
    await Promise.resolve();
    expect(rounds).toBe(3);
    loop.stop();
    expect(interval).toBeUndefined();
    focus.dispatchEvent(new Event("focus"));
    expect(rounds).toBe(3);
  });
});
