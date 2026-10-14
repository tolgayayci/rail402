import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import { FacilitatorResponseError, type FacilitatorClient } from "@x402/core/server";
import {
  SettleError,
  VerifyError,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "@x402/core/types";
import type { Metrics } from "../metrics.ts";
import {
  TRACE_HEADER,
  TRACE_REASON_MAX,
  TRACE_VERSION,
  encodeTrace,
  serverTimingOf,
  type SellerTrace,
} from "../shared/trace.ts";

/**
 * What a lab seller saw of the facilitator during one request, reported back to the buyer in
 * `Rail402-Trace` and `Server-Timing`. A traced facilitator client records outcomes into the request's
 * trace through AsyncLocalStorage; the middleware sends the trace on every lab response. Payment
 * payloads pass through the client untouched and are never recorded.
 */

type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** The trace being built for one lab request, plus the route label its metrics use. */
interface TraceState {
  readonly route: string;
  readonly trace: Writable<SellerTrace>;
}

const CODE = /^[a-z][a-z0-9_]{0,99}$/;
const TRANSACTION = /^[0-9a-f]{64}$/;
const ATOMIC = /^(0|[1-9]\d{0,38})$/;

/** The facilitator failed without a coded answer: unreachable, late or malformed. */
const UNAVAILABLE = {
  code: "playground_upstream_unavailable",
  reason: "The facilitator did not answer in time or answered with an invalid response.",
} as const;

export class TraceRecorder {
  private readonly store = new AsyncLocalStorage<TraceState>();
  private readonly metrics: Metrics | undefined;

  constructor(metrics?: Metrics) {
    this.metrics = metrics;
  }

  /**
   * Middleware that opens a trace for the request and, once the response is ready, sends it as
   * `Rail402-Trace` (always, version 1, outcomes only) and `Server-Timing` (when the facilitator was
   * called). `route` names the lab route for metrics.
   */
  middleware(route: (path: string) => string): MiddlewareHandler {
    return async (c, next) => {
      const state: TraceState = { route: route(c.req.path), trace: { v: TRACE_VERSION } };
      await this.store.run(state, next);
      c.res.headers.set(TRACE_HEADER, encodeTrace(state.trace));
      const timing = serverTimingOf(state.trace);
      if (timing !== "") c.res.headers.set("server-timing", timing);
    };
  }

  /**
   * Wraps a facilitator client so verify and settle outcomes land in the current request's trace.
   * Answers pass through unchanged. A failure that is not a coded verify or settle answer (a
   * timeout, an unreachable or misbehaving facilitator) is rethrown as a FacilitatorResponseError
   * without its original message, so nothing the facilitator echoed can reach a log or the buyer.
   */
  wrap(inner: FacilitatorClient): FacilitatorClient {
    return {
      verify: (payload: PaymentPayload, requirements: PaymentRequirements) =>
        this.timed("verify", async () => {
          try {
            const result: VerifyResponse = await inner.verify(payload, requirements);
            this.record("verify", verifyEntry(result));
            return result;
          } catch (error) {
            if (error instanceof VerifyError) {
              this.record(
                "verify",
                verifyEntry({
                  isValid: false,
                  invalidReason: error.invalidReason,
                  invalidMessage: error.invalidMessage,
                }),
              );
              throw error;
            }
            this.record("verify", { isValid: false, ...UNAVAILABLE, ms: 0 });
            throw new FacilitatorResponseError(UNAVAILABLE.reason);
          }
        }),
      settle: (payload: PaymentPayload, requirements: PaymentRequirements) =>
        this.timed("settle", async () => {
          const requested = requirements.scheme === "upto" ? requirements.amount : undefined;
          try {
            const result: SettleResponse = await inner.settle(payload, requirements);
            this.record("settle", settleEntry(result, requested));
            this.recordBazaar(result.extensionResponses?.["bazaar"]);
            return result;
          } catch (error) {
            if (error instanceof SettleError) {
              this.record(
                "settle",
                settleEntry(
                  {
                    success: false,
                    errorReason: error.errorReason,
                    errorMessage: error.errorMessage,
                    transaction: error.transaction,
                    network: requirements.network,
                  },
                  requested,
                ),
              );
              throw error;
            }
            this.record("settle", {
              success: false,
              ...UNAVAILABLE,
              ...(requested === undefined || !ATOMIC.test(requested) ? {} : { requested }),
              ms: 0,
            });
            throw new FacilitatorResponseError(UNAVAILABLE.reason);
          }
        }),
      getSupported: (): Promise<SupportedResponse> => inner.getSupported(),
    };
  }

  private async timed<T>(phase: "verify" | "settle", run: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await run();
    } finally {
      const entry = this.store.getStore()?.trace[phase];
      if (entry !== undefined) entry.ms = Math.max(0, Math.round(performance.now() - started));
    }
  }

  private record(phase: "verify", entry: VerifyEntry): void;
  private record(phase: "settle", entry: SettleEntry): void;
  private record(phase: "verify" | "settle", entry: VerifyEntry | SettleEntry): void {
    const state = this.store.getStore();
    if (state === undefined) return;
    const ok = "isValid" in entry ? entry.isValid : entry.success;
    this.metrics?.labOutcomes.inc({
      route: state.route,
      phase,
      code: ok ? "ok" : (entry.code ?? "unknown"),
    });
    if (phase === "verify") state.trace.verify = entry as VerifyEntry;
    else state.trace.settle = entry as SettleEntry;
  }

  /** The Bazaar's cataloging outcome, when the facilitator reported one well formed. */
  private recordBazaar(value: unknown): void {
    const state = this.store.getStore();
    if (state === undefined || value === null || typeof value !== "object") return;
    const outcome = value as Record<string, unknown>;
    const status = outcome["status"];
    const code = outcome["code"];
    if (status !== "success" && status !== "processing" && status !== "rejected") return;
    if (typeof code !== "string" || !CODE.test(code)) return;
    const listingId = outcome["listingId"];
    const version = outcome["version"];
    const reason = outcome["rejectedReason"] ?? outcome["reason"];
    state.trace.bazaar = {
      status,
      code,
      ...(typeof listingId === "string" && listingId.length <= 200 ? { listingId } : {}),
      ...(Number.isSafeInteger(version) && (version as number) >= 0 ? { version: version as number } : {}),
      ...(typeof reason === "string" && reason !== "" ? { reason: cut(reason) } : {}),
    };
  }
}

type VerifyEntry = Writable<NonNullable<SellerTrace["verify"]>>;
type SettleEntry = Writable<NonNullable<SellerTrace["settle"]>>;

function verifyEntry(
  result: Pick<VerifyResponse, "isValid" | "invalidReason" | "invalidMessage">,
): VerifyEntry {
  return {
    isValid: result.isValid,
    ...codeAndReason(result.invalidReason, result.invalidMessage),
    ms: 0,
  };
}

function settleEntry(result: SettleResponse, requested: string | undefined): SettleEntry {
  return {
    success: result.success,
    ...codeAndReason(result.errorReason, result.errorMessage),
    ...(TRANSACTION.test(result.transaction) ? { transaction: result.transaction } : {}),
    ...(result.amount !== undefined && ATOMIC.test(result.amount) ? { amount: result.amount } : {}),
    ...(requested !== undefined && ATOMIC.test(requested) ? { requested } : {}),
    ms: 0,
  };
}

function codeAndReason(
  code: string | undefined,
  reason: string | undefined,
): { code?: string; reason?: string } {
  if (code === undefined || !CODE.test(code)) return {};
  return { code, ...(reason === undefined || reason === "" ? {} : { reason: cut(reason) }) };
}

function cut(reason: string): string {
  return reason.slice(0, TRACE_REASON_MAX);
}
