import { Buffer } from "buffer";
import { isRail402Error } from "@rail402.dev/errors";
import { isEgressError } from "@rail402.dev/safe-fetch/codes";
import {
  isPaymentError,
  redact,
  redactDeep,
  sanitizeText,
  toDecimal,
  type BudgetSnapshot,
  type CallResult,
  type Paid,
  type ResolvedPolicy,
  type SearchHit,
} from "@rail402.dev/sdk/browser";
import { defaultPaidFor, isMcpServerCode, mcpServerCodes, type McpServerCode } from "./codes.ts";
import {
  MAX_REASON_LENGTH,
  type BudgetOutput,
  type BudgetView,
  type PayOutput,
  type SearchOutput,
  type ToolError,
} from "./schemas.ts";

/** Largest seller-provided JSON value (schema or example) passed through to the agent. */
const MAX_SELLER_JSON_BYTES = 16_384;
/** Longest seller string inside such a value. */
const MAX_SELLER_STRING = 1_000;
const MAX_DEPTH = 12;

export interface ErrorOverrides {
  readonly reason?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly paid?: Paid;
}

/**
 * A coded error object for a tool result. The reason is redacted, bounded and never empty; details
 * are passed as given, so callers redact what did not come from the SDK already redacted.
 */
export function toolError(code: McpServerCode, overrides: ErrorOverrides = {}): ToolError {
  const spec = mcpServerCodes[code];
  const reason = clampReason(redact(overrides.reason ?? spec.reason));
  return {
    code,
    reason: reason === "" ? spec.reason : reason,
    retryable: spec.retryable,
    paid: overrides.paid ?? defaultPaidFor(code),
    ...(overrides.details === undefined ? {} : { details: { ...overrides.details } }),
  };
}

/**
 * Maps anything a handler threw to a coded error. SDK errors keep their code, reason and `paid`;
 * egress errors report the stage but never the address; anything else is an internal error, which
 * for a payment means the outcome is unknown.
 */
export function errorFrom(error: unknown, duringPayment: boolean): ToolError {
  if (isPaymentError(error) && isMcpServerCode(error.code)) {
    // The SDK redacted these details already; the receipt's transaction hash must stay readable.
    const details: Record<string, unknown> = { ...error.details };
    if (error.callId !== undefined) details["callId"] = error.callId;
    if (error.receipt !== undefined) details["receipt"] = error.receipt;
    return toolError(error.code, {
      reason: error.reason,
      paid: error.paid,
      ...(Object.keys(details).length === 0 ? {} : { details }),
    });
  }
  if (isEgressError(error)) {
    return toolError(error.code, { reason: error.reason, details: { stage: error.stage } });
  }
  if (isRail402Error(error) && isMcpServerCode(error.code)) {
    return toolError(error.code, {
      reason: error.reason,
      ...(error.details === undefined ? {} : { details: redactDeep({ ...error.details }) }),
    });
  }
  if (isAbort(error)) return toolError("tool_cancelled");
  return toolError("tool_internal_error", { paid: duringPayment ? "unknown" : "none" });
}

export function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function clampReason(text: string): string {
  const clean = sanitizeText(text, MAX_REASON_LENGTH).trim();
  return clean.length > MAX_REASON_LENGTH ? `${clean.slice(0, MAX_REASON_LENGTH - 1)}…` : clean;
}

/**
 * A seller-provided JSON value, bounded: strings stripped of control characters and truncated,
 * nesting limited, and the whole value dropped (undefined) when it is still too large.
 */
export function sellerJson(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  const clean = cleanValue(value, 0);
  const size = Buffer.byteLength(JSON.stringify(clean), "utf8");
  return size > MAX_SELLER_JSON_BYTES ? undefined : clean;
}

function cleanValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return sanitizeText(value, MAX_SELLER_STRING);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (depth >= MAX_DEPTH || typeof value !== "object") return null;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => cleanValue(item, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    copy[sanitizeText(key, 128)] = cleanValue(item, depth + 1);
  }
  return copy;
}

type SearchResult = Extract<SearchOutput, { ok: true }>["results"][number];

/** A search hit as the agent sees it. Seller text arrives already sanitized by the SDK. */
export function searchResult(hit: SearchHit): SearchResult {
  const schema = sellerJson(hit.input.schema);
  const example = sellerJson(hit.input.example);
  const outputExample = sellerJson(hit.output.example);
  return {
    listingId: hit.listingId,
    type: hit.type,
    resource: hit.resource,
    method: hit.method,
    toolName: hit.toolName,
    transport: hit.transport,
    routeTemplate: hit.routeTemplate,
    callable: hit.callable,
    notCallableReason: hit.notCallableReason,
    withinPolicy: hit.withinPolicy,
    prices: hit.prices.map((price) => ({
      scheme: price.scheme,
      amount: price.amount,
      atomic: price.atomic,
      asset: price.asset,
      assetContract: price.assetContract,
      decimals: price.decimals,
      payTo: price.payTo,
      feesSponsored: price.feesSponsored,
      receivable: price.receivable,
      withinPolicy: price.withinPolicy,
    })),
    trust: hit.trust,
    settlements: hit.settlements,
    seller: {
      serviceName: hit.seller.serviceName,
      description: hit.seller.description,
      tags: [...hit.seller.tags],
    },
    input: {
      ...(schema === undefined ? {} : { schema }),
      ...(example === undefined ? {} : { example }),
      pathParams: [...hit.input.pathParams],
    },
    output: outputExample === undefined ? {} : { example: outputExample },
  };
}

export function budgetView(snapshot: BudgetSnapshot): BudgetView {
  return {
    session: snapshot.session,
    window: snapshot.window,
    payer: snapshot.payer,
    startedAt: snapshot.startedAt,
    expiresAt: snapshot.expiresAt,
    autoRenew: snapshot.autoRenew,
    assets: snapshot.assets.map((asset) => ({ ...asset })),
    awaitingProof: snapshot.awaitingProof,
    falseClaims: snapshot.falseClaims,
  };
}

type PaySuccess = Extract<PayOutput, { ok: true }>;

export function payResult(result: CallResult, target: PaySuccess["target"]): PaySuccess {
  const { response } = result;
  return {
    ok: true,
    callId: result.callId,
    replayed: result.replayed,
    target,
    paid: result.paid,
    payment:
      result.payment === null
        ? null
        : {
            ...result.payment,
            authorized: { ...result.payment.authorized },
            settled: result.payment.settled === null ? null : { ...result.payment.settled },
          },
    response:
      response.kind === "http"
        ? {
            kind: "http",
            status: response.status,
            contentType: response.contentType,
            ...(response.json === undefined ? {} : { json: response.json }),
            ...(response.text === undefined ? {} : { text: response.text }),
            bytes: response.bytes,
            truncated: response.truncated,
          }
        : {
            kind: "mcp",
            isError: response.isError,
            content: response.content.map((item) => ({ type: "text" as const, text: item.text })),
            ...(response.structuredContent === undefined
              ? {}
              : { structuredContent: response.structuredContent }),
            truncated: response.truncated,
          },
    budget: result.budget === null ? null : budgetView(result.budget),
  };
}

type BudgetSuccess = Extract<BudgetOutput, { ok: true }>;

/** The policy in force, in whole units, for get_budget. */
export function policyView(policy: ResolvedPolicy): BudgetSuccess["policy"] {
  const decimal = (value: bigint | undefined, decimals: number): string | null =>
    value === undefined ? null : toDecimal(value, decimals);
  return {
    assets: policy.assets.map((asset) => ({
      asset: asset.symbol,
      contract: asset.contract,
      decimals: asset.decimals,
      perCallCap: decimal(asset.perCall, asset.decimals),
      sessionCap: decimal(asset.sessionTotal, asset.decimals),
    })),
    schemes: [...policy.schemes],
    uptoContracts: [...policy.uptoContracts],
    uptoFacilitators: policy.uptoFacilitators === undefined ? "any" : [...policy.uptoFacilitators].sort(),
    recipients:
      policy.recipients.allow !== undefined
        ? "allowlist"
        : policy.recipients.deny.size > 0
          ? "denylist"
          : "any",
    maxAuthorizationSeconds: policy.maxAuthorizationSeconds,
    requireCatalogListing: policy.requireCatalogListing,
    minTrust: { ...policy.minTrust },
  };
}
