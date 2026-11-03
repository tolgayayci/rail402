import type { FacilitatorClient } from "@x402/core/server";
import {
  SettleError,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
} from "@x402/core/types";
import { toBase64Url } from "../bytes.ts";
import { sellerCodes } from "./codes.ts";

/**
 * Remembers which settlements were already served. `claim` returns true the first time it sees a
 * key and false afterwards; a shared implementation (a database table with a unique key) extends
 * the guarantee across replicas.
 */
export interface SettlementMemory {
  claim(key: string): boolean | Promise<boolean>;
}

/** An in-process memory of the most recent settlements, oldest forgotten first. */
export class MemorySettlementMemory implements SettlementMemory {
  private readonly seen = new Set<string>();
  private readonly capacity: number;

  constructor(capacity = 100_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("capacity must be positive");
    this.capacity = capacity;
  }

  claim(key: string): boolean {
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.capacity) {
      const [oldest] = this.seen;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(key);
    return true;
  }
}

export interface RepeatEvent {
  readonly network: string;
  readonly transaction: string;
  /** How the repeat was recognised: the facilitator's marker, or this seller's own memory. */
  readonly detectedBy: "facilitator" | "memory";
}

export interface SettleDedupeOptions {
  /**
   * Defaults to an in-process memory. Pass one shared memory to every wrapper that can accept the same
   * payment (replicas, or other routes or apps with the same recipient, asset and amount).
   */
  readonly memory?: SettlementMemory;
  /** Called for every refused repeat, e.g. to log it. */
  readonly onRepeat?: (event: RepeatEvent) => void;
  /**
   * Whether each settle request carries a new random attempt id in `extensions.rail402` (default
   * true). Rail402 records and echoes it, which is what lets the wrapper serve a buyer whose answer
   * was lost or pending. Any other facilitator receives an extension key it does not know, and echoes
   * nothing: turn it off there if that facilitator should not see the key.
   */
  readonly attemptIds?: boolean;
}

/** How many of its own unfinished settle attempts a wrapper keeps. */
const TRACKED_CAPACITY = 10_000;

/** How long an unfinished attempt is kept: well past any payment's validity. */
const WAIT_MS = 15 * 60_000;

/**
 * Where a wrapper puts its settle attempt id in the request (`extensions.rail402.settlement.attempt`),
 * and where Rail402 echoes the id of the attempt that started a settlement in a repeat's marker
 * (`extensionResponses.rail402.settlement.attempt`).
 */
const RAIL402_EXTENSION = "rail402";

/**
 * The wrapper's own settle attempts that may have started a settlement without a success served for it:
 * the facilitator answered `settlement_pending`, or gave no answer of its own. Each is kept for
 * `WAIT_MS`. When the set is full of live attempts a new one is dropped rather than an old one evicted:
 * the wrapper cannot tell buyers apart (it sees only the signed payment), so this keeps every attempt
 * made before a flood of failing payments, and a payment whose attempt is dropped is only refused on
 * the marker, never served twice.
 */
class UnfinishedAttempts {
  private readonly started = new Map<string, number>();

  add(attempt: string, startedAt: number): void {
    // Attempts are added in about the order they started: expired ones are at the front.
    for (const [known, since] of this.started) {
      if (startedAt - since < WAIT_MS) break;
      this.started.delete(known);
    }
    if (this.started.size < TRACKED_CAPACITY) this.started.set(attempt, startedAt);
  }

  /** Whether `attempt` is one of these, and forgets it: a settlement is resumed once. */
  take(attempt: string | undefined, now: number): boolean {
    if (attempt === undefined) return false;
    const since = this.started.get(attempt);
    this.started.delete(attempt);
    return since !== undefined && now - since < WAIT_MS;
  }
}

/**
 * Wraps a facilitator client so a payment is served once. An idempotent facilitator answers a repeated
 * `/settle` of the same signed payment with the original success; stock middleware would then serve
 * the resource again for one payment. The wrapper turns such a repeat into a settlement failure
 * (`seller_settlement_repeat`), which the middleware answers with 402 instead of the resource.
 *
 * A repeat is recognised by Rail402's `extensionResponses.rail402.settlement` marker when the
 * facilitator sends it, and otherwise by the transaction hash already being in `memory`.
 *
 * Every `/settle` the wrapper sends carries a new random attempt id in
 * `extensions.rail402.settlement.attempt` (unless `attemptIds` is false). Rail402 records the id of the
 * request that holds the settlement's claim (the one that started it, or the one that took a stale
 * claim over and settled it) and echoes it in every repeat's marker, as the settlement stands when the
 * repeat is answered, also for a repeat that waited through a takeover. A facilitator other than Rail402
 * receives the key too, as an extension it does not know. The marker is set aside for one case only: a
 * marked success whose echoed id is one of this wrapper's own attempts that may have started the
 * settlement without a success served for it, because the facilitator answered `settlement_pending`
 * (which the stock resource server settles again at once) or gave no answer of its own. No answer of
 * its own means anything but the facilitator's x402 settle body: a timeout, a reset connection, an
 * empty 502 from a proxy, an HTML block or rate-limit page from a CDN or firewall, a reply that is not
 * x402 JSON. The first such success is served once, if `memory` agrees it is the first. A marked
 * success that echoes another id, no id (a facilitator that does not echo it), or an id this wrapper
 * already resumed is refused: whatever the timing, a payment started by another wrapper, another
 * process or an earlier run of this one is never served here again.
 *
 * In the `authorization` flow the facilitator's `/verify` refuses a payment that is being settled or
 * was, so a buyer's second send after a lost answer reaches the wrapper only on `upfront` routes. A
 * facilitator that does not record and echo the attempt id leaves such a buyer refused. Without the
 * marker (a facilitator that does not send it), `memory` alone recognises repeats: give every wrapper
 * that can accept the same payment (replicas, or other routes or apps with the same recipient, asset
 * and amount) one shared `memory`. A refused repeat is never recorded in `memory`.
 */
export function withSettleDedupe(
  client: FacilitatorClient,
  options: SettleDedupeOptions = {},
): FacilitatorClient {
  const memory = options.memory ?? new MemorySettlementMemory();
  const unfinished = new UnfinishedAttempts();
  const tagged = options.attemptIds !== false;
  return {
    verify: (payload: PaymentPayload, requirements: PaymentRequirements) =>
      client.verify(payload, requirements),
    getSupported: () => client.getSupported(),
    settle: async (payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> => {
      const attempt = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      const startedAt = Date.now();
      let result: SettleResponse;
      try {
        result = await client.settle(tagged ? withAttempt(payload, attempt) : payload, requirements);
      } catch (error) {
        // No answer of the facilitator's own, or a pending answer raised as a SettleError: this
        // attempt may have started the settlement. Any other raised answer settled nothing.
        if (tagged && (!isSettleAnswer(error) || isPending(error))) unfinished.add(attempt, startedAt);
        throw error;
      }
      if (!result.success) {
        if (tagged && isPending(result)) unfinished.add(attempt, startedAt);
        return result;
      }
      if (result.transaction === "") return result;
      const key = `${result.network}:${result.transaction}`;
      const marker = markerOf(result.extensionResponses);
      const resumed = marker !== undefined && unfinished.take(marker.attempt, Date.now());
      let detectedBy: RepeatEvent["detectedBy"] | undefined;
      if (marker !== undefined && !resumed) detectedBy = "facilitator";
      else if (!(await memory.claim(key))) detectedBy = "memory";
      if (detectedBy === undefined) return result;
      options.onRepeat?.({ network: result.network, transaction: result.transaction, detectedBy });
      return {
        success: false,
        errorReason: "seller_settlement_repeat",
        errorMessage: sellerCodes.seller_settlement_repeat.reason,
        transaction: result.transaction,
        network: result.network,
        ...(result.payer === undefined ? {} : { payer: result.payer }),
      };
    },
  };
}

/** A copy of the payment with this attempt's id in its extensions; the buyer's object is not changed. */
function withAttempt(payload: PaymentPayload, attempt: string): PaymentPayload {
  return {
    ...payload,
    extensions: { ...payload.extensions, [RAIL402_EXTENSION]: { settlement: { attempt } } },
  };
}

/** Rail402's repeat marker, with the attempt id it echoes when it has one. */
function markerOf(extensionResponses: unknown): { readonly attempt: string | undefined } | undefined {
  const settlement = field(field(extensionResponses, RAIL402_EXTENSION), "settlement");
  if (field(settlement, "repeat") !== true) return undefined;
  const attempt = field(settlement, "attempt");
  return { attempt: typeof attempt === "string" ? attempt : undefined };
}

/** Whether a raised error is the facilitator's answer (a SettleError), not the lack of one. */
function isSettleAnswer(error: unknown): boolean {
  return error instanceof SettleError || field(error, "name") === "SettleError";
}

/** Whether an answer, returned or raised, says the settlement is still pending. */
function isPending(answer: unknown): boolean {
  return field(answer, "errorReason") === "settlement_pending";
}

/** True when the facilitator marked the settlement as a repeat of an earlier one. */
export function repeatMarker(extensionResponses: unknown): boolean {
  const rail402 = field(extensionResponses, "rail402");
  return field(field(rail402, "settlement"), "repeat") === true;
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
