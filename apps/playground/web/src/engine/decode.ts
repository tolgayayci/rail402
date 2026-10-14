/**
 * Decoders from wire data and SDK results to the public views lab events carry. Every view lists its
 * fields; seller text is cleaned, bounded and stripped of anything secret-shaped (`untrustedReason`),
 * and no view takes XDR, a signature, a preimage, a header value or a payment payload.
 */
import { scValToNative } from "@stellar/stellar-sdk";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import {
  decodeAuthorizationPreimage,
  decodeContractCall,
  decodeSacTransferArgs,
  type ContractCall,
} from "@rail402.dev/stellar";
import { accountOrContractOf, termsFromScVal } from "@rail402.dev/upto";
import {
  MCP_PAYMENT_META_KEY,
  MCP_PAYMENT_RESPONSE_META_KEY,
  parseAtomic,
  toDecimal,
  untrustedReason,
  type HitContext,
  type ListingVersion,
  type SearchHit,
  type TransactionReport,
} from "@rail402.dev/sdk/browser";
import type {
  AuthorizationView,
  JsonValue,
  ListingView,
  McpRequestView,
  McpResponseView,
  OptionView,
  RequiredView,
  SettleView,
  TxView,
  VersionView,
} from "./events.ts";

/** Seconds per ledger the views assume when they turn ledgers into time. */
export const LEDGER_SECONDS = 5;
/** Most payment options a view lists. */
const MAX_OPTIONS = 16;
const MAX_REASON = 300;
const MAX_TEXT = 1_000;
const HASH = /^[0-9a-f]{64}$/i;
/** JSON-RPC codes sellers use for "payment required": SEP-1036's -32042, and the older 402. */
const PAYMENT_REQUIRED_CODES = new Set([-32042, 402]);

export type Verdict = OptionView["verdict"];

/** What decoding a 402 needs from the engine: asset facts, the buyer's verdicts, the facilitator. */
export interface DecodeContext {
  /** Symbol and decimals of a token contract the page knows; undefined otherwise. */
  readonly assetFacts: (
    contract: string,
  ) => { readonly symbol: string; readonly decimals: number } | undefined;
  /** The buyer's verdict on each option of a payment request, in order. */
  readonly judge?: ((required: unknown) => readonly Verdict[] | undefined) | undefined;
  /** Whether an address is one of the facilitator's advertised signers or settlement authorities. */
  readonly advertised?: ((address: string) => boolean | null) | undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Untrusted text, cleaned and bounded; null when absent or not text. */
function text(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === "string" && value !== "" ? untrustedReason(value, max) : null;
}

/** A G… or C… strkey as is; anything else is null. */
function strkey(value: unknown): string | null {
  return typeof value === "string" && /^[GCM][A-Z2-7]{55}(?:[A-Z2-7]{13})?$/.test(value) ? value : null;
}

// ---------------------------------------------------------------------------------------------------
// Payment requests and settlement responses

/** A decoded `PAYMENT-REQUIRED` value (or an MCP payment-required payload); undefined if malformed. */
export function requiredView(value: unknown, context: DecodeContext): RequiredView | undefined {
  if (!isRecord(value) || typeof value["x402Version"] !== "number" || !Array.isArray(value["accepts"])) {
    return undefined;
  }
  const resource = record(value["resource"]);
  let verdicts: readonly Verdict[] | undefined;
  try {
    verdicts = context.judge?.(value);
  } catch {
    verdicts = undefined;
  }
  const extensions = record(value["extensions"]);
  const bazaar = extensions["bazaar"];
  const input = record(record(record(bazaar)["info"])["input"]);
  const kind = input["type"] === "http" || input["type"] === "mcp" ? input["type"] : null;
  return {
    x402Version: value["x402Version"],
    resource: {
      url: text(resource["url"], 2_048) ?? "",
      description: text(resource["description"]),
      mimeType: text(resource["mimeType"], 200),
    },
    error: text(value["error"], MAX_REASON),
    options: value["accepts"]
      .slice(0, MAX_OPTIONS)
      .map((option: unknown, index) => optionView(record(option), index, context, verdicts?.[index] ?? null)),
    bazaar: {
      declared: isRecord(bazaar),
      type: kind,
      method: kind === "http" ? (text(input["method"], 16)?.toUpperCase() ?? "GET") : null,
      toolName: kind === "mcp" ? text(input["toolName"], 128) : null,
    },
  };
}

function optionView(
  option: Record<string, unknown>,
  index: number,
  context: DecodeContext,
  verdict: Verdict,
): OptionView {
  const asset = typeof option["asset"] === "string" ? untrustedReason(option["asset"], 64) : "";
  const facts = context.assetFacts(asset);
  const amount = typeof option["amount"] === "string" ? untrustedReason(option["amount"], 48) : "";
  const atomic = parseAtomic(amount);
  const extra = record(option["extra"]);
  const facilitatorAddress = strkey(extra["facilitatorAddress"]);
  const timeout = option["maxTimeoutSeconds"];
  return {
    index,
    scheme: text(option["scheme"], 32) ?? "",
    network: text(option["network"], 64) ?? "",
    asset,
    symbol: facts?.symbol ?? null,
    decimals: facts?.decimals ?? null,
    amount,
    decimal: atomic !== undefined && facts !== undefined ? toDecimal(atomic, facts.decimals) : null,
    payTo: typeof option["payTo"] === "string" ? untrustedReason(option["payTo"], 69) : "",
    maxTimeoutSeconds: typeof timeout === "number" && Number.isFinite(timeout) ? timeout : 0,
    feesSponsored: typeof extra["areFeesSponsored"] === "boolean" ? extra["areFeesSponsored"] : null,
    facilitatorAddress,
    facilitatorAddressAdvertised:
      facilitatorAddress === null ? null : (context.advertised?.(facilitatorAddress) ?? null),
    verdict,
  };
}

/** Decodes a `PAYMENT-REQUIRED` header; undefined when it is absent or malformed. */
export function requiredFromHeader(header: string | null, context: DecodeContext): RequiredView | undefined {
  if (header === null || header === "") return undefined;
  try {
    return requiredView(decodePaymentRequiredHeader(header), context);
  } catch {
    return undefined;
  }
}

/** A settlement response (`PAYMENT-RESPONSE` or MCP meta); undefined when malformed. */
export function settleView(value: unknown, from: SettleView["from"]): SettleView | undefined {
  if (!isRecord(value) || typeof value["success"] !== "boolean") return undefined;
  const transaction = value["transaction"];
  const amount = value["amount"];
  return {
    from,
    success: value["success"],
    transaction: typeof transaction === "string" && HASH.test(transaction) ? transaction.toLowerCase() : null,
    network: text(value["network"], 64),
    payer: strkey(value["payer"]),
    amount: typeof amount === "string" && parseAtomic(amount) !== undefined ? amount : null,
    errorReason: text(value["errorReason"], 100),
    errorMessage: text(value["errorMessage"], MAX_REASON),
  };
}

/** Decodes a `PAYMENT-RESPONSE` header; undefined when absent or malformed. */
export function settleFromHeader(header: string | null): SettleView | undefined {
  if (header === null || header === "") return undefined;
  try {
    return settleView(decodePaymentResponseHeader(header), "payment-response");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------
// MCP messages

/** A JSON-RPC request the page sent to an MCP seller, by method; the payment's content is left out. */
export interface JsonRpcRequestInfo {
  readonly id: string | number | null;
  readonly view: McpRequestView;
}

/** Reads a request body as a JSON-RPC message (the first of a batch); undefined for anything else. */
export function mcpRequestOf(body: string | Uint8Array | null | undefined): JsonRpcRequestInfo | undefined {
  if (body === null || body === undefined) return undefined;
  const raw = typeof body === "string" ? body : new TextDecoder().decode(body);
  if (raw.length > 262_144) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  const message = Array.isArray(parsed) ? (parsed[0] as unknown) : parsed;
  if (!isRecord(message) || message["jsonrpc"] !== "2.0" || typeof message["method"] !== "string") {
    return undefined;
  }
  const params = record(message["params"]);
  const id = message["id"];
  return {
    id: typeof id === "string" || typeof id === "number" ? id : null,
    view: {
      method: untrustedReason(message["method"], 128),
      toolName: message["method"] === "tools/call" ? text(params["name"], 128) : null,
      hasPayment: record(params["_meta"])[MCP_PAYMENT_META_KEY] !== undefined,
    },
  };
}

function paymentRequiredShape(value: unknown): boolean {
  return isRecord(value) && "x402Version" in value && Array.isArray(value["accepts"]);
}

/** A JSON-RPC answer of an MCP seller; undefined when the message is no answer. */
export function mcpResponseView(message: unknown, context: DecodeContext): McpResponseView | undefined {
  if (!isRecord(message) || message["jsonrpc"] !== "2.0") return undefined;
  if (isRecord(message["error"])) {
    const error = message["error"];
    const code = typeof error["code"] === "number" ? error["code"] : null;
    const data = record(error["data"]);
    const payload =
      code !== null && PAYMENT_REQUIRED_CODES.has(code)
        ? paymentRequiredShape(data)
          ? data
          : paymentRequiredShape(data["x402"])
            ? data["x402"]
            : undefined
        : undefined;
    return {
      isError: true,
      errorCode: code,
      errorMessage: text(error["message"], MAX_REASON),
      required: payload === undefined ? null : (requiredView(payload, context) ?? null),
      settle: null,
    };
  }
  if (!isRecord(message["result"])) return undefined;
  const result = message["result"];
  const isError = result["isError"] === true;
  let payload: unknown;
  if (isError) {
    if (paymentRequiredShape(result["structuredContent"])) payload = result["structuredContent"];
    else {
      const [first] = Array.isArray(result["content"]) ? (result["content"] as unknown[]) : [];
      const firstText = record(first)["text"];
      if (typeof firstText === "string" && firstText.length <= 65_536) {
        try {
          const parsed = JSON.parse(firstText) as unknown;
          if (paymentRequiredShape(parsed)) payload = parsed;
        } catch {
          payload = undefined;
        }
      }
    }
  }
  const settled = record(result["_meta"])[MCP_PAYMENT_RESPONSE_META_KEY];
  return {
    isError,
    errorCode: null,
    errorMessage: null,
    required: payload === undefined ? null : (requiredView(payload, context) ?? null),
    settle: settled === undefined ? null : (settleView(settled, "mcp-meta") ?? null),
  };
}

// ---------------------------------------------------------------------------------------------------
// Authorizations

export interface AuthorizationContext {
  /** The signing account. */
  readonly address: string;
  readonly network: string;
  /** Settlement contracts whose `settle` authorizations are decoded as upto terms. */
  readonly uptoContracts: readonly string[];
  /** The latest ledger known when signing, if any. */
  readonly latestLedger: number | null;
}

/**
 * The public facts of a Soroban authorization preimage: the signed call and its terms, the nonce and
 * the expiry. Undefined for anything that is not an exact transfer or an upto settlement.
 */
export function authorizationView(
  preimageBase64: string,
  context: AuthorizationContext,
): AuthorizationView | undefined {
  const preimage = decodeAuthorizationPreimage(preimageBase64);
  if (preimage === undefined) return undefined;
  const call = decodeContractCall(preimage.invocation);
  if (call === undefined) return undefined;
  const expirationLedger = preimage.signatureExpirationLedger;
  const latest = context.latestLedger;
  const common = {
    network: context.network,
    address: preimage.address ?? context.address,
    credential: preimage.credential,
    nonce: preimage.nonce.toString(),
    expirationLedger,
    latestLedger: latest,
    expiresInSeconds: latest === null ? null : Math.max(0, (expirationLedger - latest) * LEDGER_SECONDS),
  };
  if (call.fn === "transfer" && call.subInvocations.length === 0) {
    const transfer = decodeSacTransferArgs(call.args);
    if (transfer === undefined) return undefined;
    return {
      ...common,
      scheme: "exact",
      transfer: {
        contract: call.contract,
        from: transfer.from,
        to: transfer.to,
        amount: transfer.amount.toString(),
      },
    };
  }
  if (call.fn === "settle" && context.uptoContracts.includes(call.contract)) {
    const [argument] = call.args;
    const terms = argument === undefined ? undefined : termsFromScVal(argument);
    if (terms === undefined) return undefined;
    return {
      ...common,
      scheme: "upto",
      contract: call.contract,
      terms: {
        recipient: terms.recipient,
        token: terms.token,
        maxAmount: terms.maxAmount.toString(),
        validAfterLedger: terms.validAfterLedger,
        expirationLedger: terms.expirationLedger,
        facilitator: terms.facilitator,
      },
      approve: approveOf(call),
    };
  }
  return undefined;
}

/** The `approve(from, spender, amount, expiration_ledger)` child of an upto settlement. */
function approveOf(call: ContractCall): Extract<AuthorizationView, { scheme: "upto" }>["approve"] {
  const [child] = call.subInvocations;
  const approve = child === undefined ? undefined : decodeContractCall(child);
  if (approve?.fn !== "approve" || approve.args.length !== 4) return null;
  const [from, spender, amount, expiration] = approve.args;
  try {
    const value = amount === undefined ? undefined : (scValToNative(amount) as unknown);
    const ledger = expiration === undefined ? undefined : (scValToNative(expiration) as unknown);
    const owner = accountOrContractOf(from);
    const allowed = accountOrContractOf(spender);
    if (
      owner === undefined ||
      allowed === undefined ||
      typeof value !== "bigint" ||
      typeof ledger !== "number"
    ) {
      return null;
    }
    return {
      token: approve.contract,
      from: owner,
      spender: allowed,
      amount: value.toString(),
      expirationLedger: ledger,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Bazaar and chain

/** A search hit as a listing view; `price` is the first option within the policy, else the first. */
export function listingView(
  hit: SearchHit,
  facts: {
    readonly network: string;
    readonly version: number;
    readonly state: ListingView["state"];
    readonly rank: number | null;
    /** The buyer's policy, to say which rule refuses a listing it cannot pay. */
    readonly judge?: Pick<HitContext, "policy" | "adapters">;
  },
): ListingView {
  const price = hit.prices.find((candidate) => candidate.withinPolicy) ?? hit.prices[0];
  return {
    id: hit.listingId ?? "",
    resource: hit.resource,
    type: hit.type === "mcp" ? "mcp" : "http",
    method: hit.method,
    toolName: hit.toolName,
    description: hit.seller.description,
    serviceName: hit.seller.serviceName,
    owner: hit.owner ?? "",
    network: facts.network,
    trust: hit.trust,
    state: facts.state,
    version: facts.version,
    settlements: hit.settlements,
    price:
      price === undefined
        ? null
        : {
            scheme: price.scheme,
            amount: price.atomic,
            decimal: price.amount,
            symbol: price.asset === price.assetContract ? null : price.asset,
          },
    callable: hit.callable && hit.withinPolicy,
    notPayable: facts.judge === undefined ? null : listingVerdict(hit, facts.judge),
    rank: facts.rank,
    input: listingInput(hit),
  };
}

/** Longest example a listing view keeps, as JSON text. */
const EXAMPLE_MAX_CHARS = 2_000;
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

/** What a call to a listing fills in, from the seller's metadata: names checked, the example bounded. */
function listingInput(hit: SearchHit): NonNullable<ListingView["input"]> {
  const names = (values: readonly unknown[]): string[] =>
    values.filter((value): value is string => typeof value === "string" && NAME.test(value)).slice(0, 16);
  const pathParams = names(hit.input.pathParams);
  const schema = hit.input.schema;
  const schemaRequired =
    hit.type === "mcp" && isRecord(schema) && Array.isArray(schema["required"])
      ? names(schema["required"])
      : [];
  return {
    pathParams,
    example: boundedExample(hit.input.example),
    required: [...new Set([...pathParams, ...schemaRequired])],
  };
}

/** A seller's example as plain JSON with secrets and control characters removed; null past the bound. */
function boundedExample(value: unknown): JsonValue | null {
  if (!isRecord(value)) return null;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (text.length > EXAMPLE_MAX_CHARS) return null;
  const clean = untrustedReason(text, EXAMPLE_MAX_CHARS);
  try {
    return JSON.parse(clean) as JsonValue;
  } catch {
    return null;
  }
}

/**
 * Why the buyer cannot pay a listing, as the code and reason the payment would be refused with;
 * null when it can. The listing's URL is judged first, then its first price on this network, by the
 * same rules the buyer applies before signing.
 */
export function listingVerdict(
  hit: SearchHit,
  judge: Pick<HitContext, "policy" | "adapters">,
): { readonly code: string; readonly reason: string } | null {
  if (!hit.callable) {
    return {
      code: "listing_not_payable",
      reason: untrustedReason(hit.notCallableReason ?? "The resource URL cannot be called.", MAX_REASON),
    };
  }
  if (hit.withinPolicy) return null;
  const { policy, adapters } = judge;
  const price = hit.prices[0];
  if (price === undefined) {
    return {
      code: "payment_network_not_permitted",
      reason: `The listing has no price on ${policy.network}.`,
    };
  }
  const known = policy.assets.find((asset) => asset.contract === price.assetContract);
  if (known === undefined) {
    return {
      code: "payment_asset_not_permitted",
      reason: `It is priced in ${untrustedReason(price.asset, 64)}, which your policy does not list.`,
    };
  }
  if (
    !policy.schemes.includes(price.scheme as (typeof policy.schemes)[number]) ||
    !adapters.some((adapter) => adapter.scheme === price.scheme)
  ) {
    return {
      code: "payment_scheme_not_permitted",
      reason: `It asks for the ${untrustedReason(price.scheme, 32)} scheme, which your policy does not allow.`,
    };
  }
  if (price.scheme === "exact" && !price.feesSponsored) {
    return {
      code: "payment_fees_not_sponsored",
      reason: "Its network fees are not sponsored by the facilitator, and your wallet holds no XLM for them.",
    };
  }
  const atomic = parseAtomic(price.atomic);
  if (atomic === undefined || atomic <= 0n) {
    return { code: "payment_amount_not_permitted", reason: "Its price is not a positive amount." };
  }
  if (known.perCall !== undefined && atomic > known.perCall) {
    return {
      code: "payment_per_call_cap_exceeded",
      reason: `Its price, ${toDecimal(atomic, known.decimals)} ${known.symbol}, is above the per-call ceiling of ${toDecimal(known.perCall, known.decimals)} ${known.symbol}.`,
    };
  }
  return { code: "payment_no_acceptable_option", reason: "None of its prices is within your policy." };
}

/** One entry of a listing's version history. */
export function versionView(version: ListingVersion): VersionView {
  const extra = version as Record<string, unknown>;
  return {
    version: version.version,
    createdAt: version.createdAt,
    cause: untrustedReason(version.cause, 64),
    transaction:
      version.transaction !== undefined && HASH.test(version.transaction)
        ? version.transaction.toLowerCase()
        : null,
    owner: version.owner,
    trust: version.trust,
    state: untrustedReason(version.state, 32),
    reason: text(extra["reason"], MAX_REASON),
  };
}

/** A transaction report as a view, with the settlement contract's event when there was one. */
export function txView(report: TransactionReport, uptoSettled: TxView["uptoSettled"]): TxView {
  return {
    hash: report.hash,
    network: report.network,
    status: report.status,
    ledger: report.ledger,
    closedAt: report.closedAt,
    feeBump: report.feeBump,
    feeSourceAdvertised: report.facilitator?.attributed ?? null,
    transfers: report.transfers.map((transfer) => ({
      contract: transfer.contract,
      symbol: transfer.symbol ?? null,
      from: transfer.from,
      to: transfer.to,
      amount: transfer.amount.atomic,
      decimal: transfer.amount.decimal ?? null,
    })),
    x402Shape: report.x402.shape,
    nonces: report.authorizations.map((authorization) => authorization.nonce),
    uptoSettled,
    explorerUrl: report.explorerUrl,
  };
}
