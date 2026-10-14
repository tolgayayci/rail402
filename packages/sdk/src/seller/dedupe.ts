import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
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
  /** Defaults to an in-process memory; pass a shared one when the seller runs several replicas. */
  readonly memory?: SettlementMemory;
  /** Called for every refused repeat, e.g. to log it. */
  readonly onRepeat?: (event: RepeatEvent) => void;
}

/**
 * Wraps a facilitator client so a payment is served once. An idempotent facilitator answers a repeated
 * `/settle` of the same signed payment with the original success; stock middleware would then serve
 * the resource again for one payment. The wrapper turns such a repeat into a settlement failure
 * (`seller_settlement_repeat`), which the middleware answers with 402 instead of the resource.
 *
 * A repeat is recognised by Rail402's `extensionResponses.rail402.settlement.repeat` marker when the
 * facilitator sends it, and otherwise by the transaction hash already being in `memory`.
 */
export function withSettleDedupe(
  client: FacilitatorClient,
  options: SettleDedupeOptions = {},
): FacilitatorClient {
  const memory = options.memory ?? new MemorySettlementMemory();
  return {
    verify: (payload: PaymentPayload, requirements: PaymentRequirements) =>
      client.verify(payload, requirements),
    getSupported: () => client.getSupported(),
    settle: async (payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> => {
      const result = await client.settle(payload, requirements);
      if (!result.success || result.transaction === "") return result;
      let detectedBy: RepeatEvent["detectedBy"] | undefined;
      if (repeatMarker(result.extensionResponses)) detectedBy = "facilitator";
      // Claimed even for a marked repeat, so a later repeat without the marker is still recognised.
      const first = await memory.claim(`${result.network}:${result.transaction}`);
      if (!first) detectedBy ??= "memory";
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
