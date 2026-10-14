import { SETTLEMENT_OVERRIDES_HEADER, type SettlePhase, type SettlementOverrides } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { uptoSettlementOverrides } from "@rail402.dev/upto/server";
import { sellerError } from "./codes.ts";

/**
 * Charging the amount an `upto` call used. The buyer authorized a cap; the seller settles what the
 * call consumed, from zero up to that cap, after serving it. The facilitator refuses anything above
 * the cap, and the buyer's budget returns the rest of the cap once the chain shows the settlement.
 */

export { UptoStellarScheme as UptoStellarServerScheme } from "@rail402.dev/upto/server";

/**
 * An amount to charge: atomic units of the asset (a bigint, safe integer or integer string), a
 * percentage of the cap (`"25%"`, at most two decimals) or a dollar price (`"$0.002"`, which the
 * upto server scheme converts with the asset's decimals).
 */
export type UptoCharge = bigint | number | string;

/** The part of an HTTP response `setUptoCharge` needs (Express, Node's `ServerResponse`, …). */
export interface HeaderSink {
  setHeader(name: string, value: string): unknown;
}

/**
 * Sets the amount an `upto` HTTP route charges for this request. Call it in the handler before the
 * response is sent; the stock payment middleware reads it when it settles. Without it the middleware
 * settles the full cap. Throws `seller_declaration_invalid` for a malformed amount.
 */
export function setUptoCharge(response: HeaderSink, amount: UptoCharge): void {
  response.setHeader(SETTLEMENT_OVERRIDES_HEADER, JSON.stringify(uptoOverrides(amount)));
}

/** The `_meta` key a metered MCP tool result carries its charge under, until settlement reads it. */
export const UPTO_CHARGE_META_KEY = "rail402/upto-charge";

/** A tool result an MCP handler returns. */
export interface ToolResult {
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Records what an `upto` MCP tool call charges on the result the handler returns. Only a resource
 * server wrapped with `meteredToolServer` reads it; it is removed from the result before the result
 * reaches the buyer.
 */
export function chargeUpto<T extends ToolResult>(
  result: T,
  amount: UptoCharge,
): T & { _meta: Record<string, unknown> } {
  return { ...result, _meta: { ...result._meta, [UPTO_CHARGE_META_KEY]: uptoOverrides(amount).amount } };
}

/** The resource server method a metered tool server intercepts. */
export interface SettlingServer {
  settlePayment(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    declaredExtensions?: Record<string, unknown>,
    transportContext?: unknown,
    settlementOverrides?: SettlementOverrides,
    phase?: SettlePhase,
  ): Promise<SettleResponse>;
}

/**
 * Wraps an `x402ResourceServer` for `@x402/mcp`'s `createPaymentWrapper`, so `upto` tools settle what
 * the handler charged with `chargeUpto`. The stock wrapper passes no settlement override, so on its
 * own it settles the full cap of every upto tool. A result without a charge still settles the cap.
 * Every other method is the resource server's own.
 */
export function meteredToolServer<T extends object>(server: T): T {
  const target = server as unknown as SettlingServer;
  if (typeof target.settlePayment !== "function") {
    throw sellerError("seller_declaration_invalid", "meteredToolServer needs an x402ResourceServer.", {
      path: "server",
    });
  }
  const settlePayment = (...args: Parameters<SettlingServer["settlePayment"]>) => {
    const [payload, requirements, extensions, transportContext, overrides, phase] = args;
    let resolved = overrides;
    if (resolved === undefined && requirements.scheme === "upto") {
      const charge = takeCharge(transportContext);
      if (charge !== undefined) resolved = { amount: charge };
    }
    return target.settlePayment(payload, requirements, extensions, transportContext, resolved, phase);
  };
  return new Proxy(server, {
    get(object, property, receiver) {
      if (property === "settlePayment") return settlePayment;
      const value: unknown = Reflect.get(object, property, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
    },
  });
}

/** The charge the handler recorded on its result, removed from the result the buyer receives. */
function takeCharge(transportContext: unknown): string | undefined {
  if (transportContext === null || typeof transportContext !== "object") return undefined;
  const result = (transportContext as { result?: unknown }).result;
  if (result === null || typeof result !== "object") return undefined;
  const meta: unknown = (result as { _meta?: unknown })._meta;
  if (meta === null || typeof meta !== "object") return undefined;
  const fields = meta as Record<string, unknown>;
  const charge = fields[UPTO_CHARGE_META_KEY];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete fields[UPTO_CHARGE_META_KEY];
  return typeof charge === "string" ? uptoOverrides(charge).amount : undefined;
}

function uptoOverrides(amount: UptoCharge): { amount: string } {
  try {
    return uptoSettlementOverrides(amount);
  } catch (error) {
    throw sellerError(
      "seller_declaration_invalid",
      error instanceof Error ? error.message : "The upto charge is not a valid amount.",
      { path: "amount" },
    );
  }
}
