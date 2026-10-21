/**
 * Lab events: everything the page learns about a run, as a closed union. Swimlane rows, the inspector
 * and the outcome card are projected from these events only.
 *
 * Every field is enumerated. None can hold transaction or authorization XDR, a signature, a
 * preimage, a header value, a payment payload or a key: views carry decoded, public facts. Tool
 * arguments and results pass through the SDK's JSON sanitizer and payment scrub before they get here.
 *
 * Amounts named `amount`, `max`, `price` or `cap` are base units as decimal strings unless the field
 * says `decimal`. Times are milliseconds since the run started unless stated.
 */
import type { SellerTrace } from "../../../src/shared/trace.ts";
import type { CheckId, ExperimentId, ScenarioId } from "../../../src/shared/lab.ts";

export type { CheckId, ExperimentId, ScenarioId, SellerTrace };

/** Who a fact comes from: your own wire or signer, the seller, a chain read, or a Bazaar read. */
export type Source = "you" | "seller" | "chain" | "bazaar";

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** The rail402-mcp tools the scripted agent calls. */
export type ToolName = "search_stellar_resources" | "pay_and_call" | "get_budget";

/** Catalog trust levels, lowest first. */
export type Trust = "settled" | "origin_verified" | "domain_verified";

/**
 * A payment trace event exactly as `@rail402.dev/sdk` emits it (`PaymentEvent`). Mirrored here so the
 * page never imports the SDK; a type test keeps the two identical.
 */
export type SdkPaymentEvent =
  | { readonly type: "probe"; readonly callId: string; readonly resource: string }
  | { readonly type: "quote"; readonly callId: string; readonly options: number; readonly acceptable: number }
  | { readonly type: "refused"; readonly callId: string | undefined; readonly code: string }
  | {
      readonly type: "reserved";
      readonly callId: string;
      readonly reservation: string;
      readonly asset: string;
      readonly amount: string;
    }
  | {
      readonly type: "signed";
      readonly callId: string;
      readonly reservation: string;
      readonly nonce: string;
      readonly expirationLedger: number;
    }
  | { readonly type: "sent"; readonly callId: string; readonly reservation: string }
  | {
      readonly type: "settled";
      readonly callId: string;
      readonly reservation: string;
      readonly transaction: string | null;
      readonly amount: string;
    }
  | {
      readonly type: "unresolved";
      readonly callId: string;
      readonly reservation: string;
      readonly code: string;
    }
  | {
      readonly type: "released";
      readonly callId: string;
      readonly reservation: string;
      readonly reason: "not_signed" | "expired_unused" | "claim_false" | "forced" | "settled_below_cap";
      readonly amount: string;
    }
  | {
      readonly type: "unprovable";
      readonly callId: string;
      readonly reservation: string;
      readonly amount: string;
    }
  | {
      readonly type: "window";
      readonly session: string;
      readonly window: string;
      readonly expiresAt: string;
    };

/** One payment option of a 402, decoded, with the buyer's verdict on it. */
export interface OptionView {
  readonly index: number;
  readonly scheme: string;
  readonly network: string;
  /** The asset contract (`C…`). */
  readonly asset: string;
  readonly symbol: string | null;
  readonly decimals: number | null;
  /** Base units: the price (exact) or the cap (upto). */
  readonly amount: string;
  /** The same amount in whole units, when the decimals are known. */
  readonly decimal: string | null;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  /** `extra.areFeesSponsored`. */
  readonly feesSponsored: boolean | null;
  /** `extra.facilitatorAddress` (upto: the only account allowed to settle). */
  readonly facilitatorAddress: string | null;
  /** Whether that address is one of the facilitator's advertised signers; null when unchecked. */
  readonly facilitatorAddressAdvertised: boolean | null;
  /** The buyer's policy verdict; null when the option was not judged. */
  readonly verdict: {
    readonly acceptable: boolean;
    readonly code: string | null;
    readonly reason: string | null;
  } | null;
}

/** A decoded `PAYMENT-REQUIRED` header (or an MCP tool's payment-required error). */
export interface RequiredView {
  readonly x402Version: number;
  readonly resource: {
    readonly url: string;
    readonly description: string | null;
    readonly mimeType: string | null;
  };
  /** The seller's `error` field, such as a facilitator's refusal code after a failed verification. */
  readonly error: string | null;
  readonly options: readonly OptionView[];
  /** Whether the seller declared Bazaar discovery metadata, and what it describes. */
  readonly bazaar: {
    readonly declared: boolean;
    readonly type: "http" | "mcp" | null;
    readonly method: string | null;
    readonly toolName: string | null;
  };
}

/** A decoded settlement response (`PAYMENT-RESPONSE` or MCP `_meta["x402/payment-response"]`). */
export interface SettleView {
  readonly from: "payment-response" | "mcp-meta";
  readonly success: boolean;
  readonly transaction: string | null;
  readonly network: string | null;
  readonly payer: string | null;
  /** Base units actually settled, when reported. */
  readonly amount: string | null;
  readonly errorReason: string | null;
  readonly errorMessage: string | null;
}

/** What a Playground lab seller reports in `Rail402-Trace`. */
export type SellerTraceView = SellerTrace;

/** One JSON-RPC message sent to an MCP seller, by method. */
export interface McpRequestView {
  readonly method: string;
  readonly toolName: string | null;
  /** Whether `_meta["x402/payment"]` was attached; its content is never recorded. */
  readonly hasPayment: boolean;
}

/** One JSON-RPC answer from an MCP seller. */
export interface McpResponseView {
  readonly isError: boolean;
  /** JSON-RPC error code, when the answer was an error. */
  readonly errorCode: number | null;
  readonly errorMessage: string | null;
  /** Payment requirements carried by a payment-required error. */
  readonly required: RequiredView | null;
  /** The decoded `_meta["x402/payment-response"]`. */
  readonly settle: SettleView | null;
}

/** Fields every authorization the signer saw carries. */
interface AuthorizationCommon {
  readonly network: string;
  /** The signing account. */
  readonly address: string;
  readonly credential: "address" | "address_v2";
  readonly nonce: string;
  readonly expirationLedger: number;
  /** The latest ledger when it was signed, and the seconds left at about 5 s per ledger. */
  readonly latestLedger: number | null;
  readonly expiresInSeconds: number | null;
}

/** A payment authorization, decoded by the signer tap after the guard approved it. */
export type AuthorizationView =
  | (AuthorizationCommon & {
      readonly scheme: "exact";
      /** `transfer(from → to, amount)` on the asset contract. */
      readonly transfer: {
        readonly contract: string;
        readonly from: string;
        readonly to: string;
        readonly amount: string;
      };
    })
  | (AuthorizationCommon & {
      readonly scheme: "upto";
      /** The settlement contract's `settle`, with the signed terms. */
      readonly contract: string;
      readonly terms: {
        readonly recipient: string;
        readonly token: string;
        /** The cap, in base units. */
        readonly maxAmount: string;
        readonly validAfterLedger: number;
        readonly expirationLedger: number;
        /** The only account allowed to settle. */
        readonly facilitator: string;
      };
      /** The `approve` sub-invocation that lets the contract move up to the cap. */
      readonly approve: {
        readonly token: string;
        readonly from: string;
        readonly spender: string;
        readonly amount: string;
        readonly expirationLedger: number;
      } | null;
    });

/** A settled transaction read back from the chain. */
export interface TxView {
  readonly hash: string;
  readonly network: string;
  readonly status: "SUCCESS" | "FAILED";
  readonly ledger: number;
  readonly closedAt: string;
  /** The fee bump that sponsored the payment, when there was one. */
  readonly feeBump: {
    readonly outerHash: string;
    readonly innerHash: string;
    readonly feeSource: string;
    /** Stroops. */
    readonly feeCharged: string;
  } | null;
  /** Whether the fee source is one of the facilitator's advertised `/supported` signers. */
  readonly feeSourceAdvertised: boolean | null;
  readonly transfers: readonly {
    readonly contract: string;
    readonly symbol: string | null;
    readonly from: string;
    readonly to: string;
    readonly amount: string;
    readonly decimal: string | null;
  }[];
  readonly x402Shape: "exact" | "upto" | "unknown";
  /** The nonces of the authorizations the transaction consumed. */
  readonly nonces: readonly string[];
  /** The settlement contract's `upto_settled` event, for an upto payment. */
  readonly uptoSettled: { readonly amount: string; readonly maxAmount: string | null } | null;
  readonly explorerUrl: string;
}

/** A Bazaar listing, as search, list or a listing read shows it. */
export interface ListingView {
  readonly id: string;
  readonly resource: string;
  readonly type: "http" | "mcp";
  readonly method: string | null;
  readonly toolName: string | null;
  readonly description: string | null;
  readonly serviceName: string | null;
  readonly owner: string;
  readonly network: string;
  readonly trust: Trust;
  readonly state: "pending" | "published" | "quarantined" | null;
  readonly version: number;
  readonly settlements: number;
  readonly price: {
    readonly scheme: string;
    readonly amount: string;
    readonly decimal: string | null;
    readonly symbol: string | null;
  } | null;
  /** Whether this buyer can pay it now under its policy and transport. */
  readonly callable: boolean | null;
  /** When it cannot: the code and reason the payment would be refused with. */
  readonly notPayable?: { readonly code: string; readonly reason: string } | null;
  /** Search rank (1-based), for search results. */
  readonly rank: number | null;
  /** What a call fills in, from the seller's metadata (untrusted, cleaned and bounded). */
  readonly input?: { readonly fields: readonly ListingField[] };
}

/**
 * One value a call to a listing gives: a path or query parameter, a JSON body field (HTTP), or a tool
 * argument (MCP). Descriptions and examples are the seller's words, cleaned and bounded.
 */
export interface ListingField {
  readonly name: string;
  readonly in: "path" | "query" | "body" | "argument";
  readonly kind: "string" | "integer" | "number" | "boolean";
  readonly required: boolean;
  readonly description: string | null;
  /** The seller's example value, as text. */
  readonly example: string | null;
  /** The values the schema allows, when it lists them. */
  readonly options: readonly string[] | null;
}

/** What the buyer's SDK concluded about a paid call's settlement. */
export interface ReceiptView {
  /** `unknown`: a payment was sent but no settlement was reported. */
  readonly status: "settled" | "unknown";
  readonly scheme: "exact" | "upto";
  /** The transaction the seller reported, lowercase hex; not proof by itself. */
  readonly transaction: string | null;
  /** Base units settled, as far as the buyer can tell. */
  readonly settled: string | null;
  readonly payTo: string;
  readonly payer: string;
  /**
   * Whether the SDK proved the settlement on chain: the transaction succeeded and consumed this very
   * authorization's nonce, moving the amount to `payTo`.
   */
  readonly verifiedOnChain: boolean;
}

/** Most characters of a delivered body the page keeps. */
export const DELIVERY_BODY_LIMIT = 4_096;

/**
 * What a call delivered, as the buyer's SDK returned it: the response body (seller content, untrusted,
 * shown as text only; payment material the seller echoed is already removed) and the receipt.
 */
export interface DeliveryView {
  readonly target: "http" | "mcp";
  /** The HTTP status; null for an MCP tool result. */
  readonly status: number | null;
  /** Whether an MCP tool answered with an error result. */
  readonly isError: boolean;
  readonly contentType: string | null;
  /** The body as text, at most DELIVERY_BODY_LIMIT characters; null when there was none. */
  readonly body: string | null;
  /** Whether the body was cut, here or by the SDK's response limit. */
  readonly truncated: boolean;
  /** Null when nothing was paid. */
  readonly receipt: ReceiptView | null;
}

/** One entry of a listing's public version history. */
export interface VersionView {
  readonly version: number;
  readonly createdAt: string;
  /** Why the version exists, such as `settlement` or `origin_verification`. */
  readonly cause: string;
  readonly transaction: string | null;
  readonly owner: string;
  readonly trust: Trust;
  readonly state: string;
  readonly reason: string | null;
}

/** A refusal at any layer. `details` is sanitized and holds no payment material. */
export type RefusalLayer = "policy" | "guard" | "relay" | "seller" | "facilitator" | "playground";

export type WalletStep = "created" | "imported" | "friendbot" | "trustline" | "bought" | "forgotten";

/** Fields every lab event carries. */
export interface EventBase {
  readonly runId: string;
  /** Milliseconds since the run started. */
  readonly at: number;
}

export type LabEventBody =
  | {
      readonly kind: "run";
      readonly phase: "start";
      readonly scenario: ScenarioId;
      readonly variant: ExperimentId | CheckId;
      /** The per-call cap of this run, decimal; null when the run pays nothing. */
      readonly cap: string | null;
      /** What a paid URL or listing is: an HTTP resource or an MCP tool. Absent: HTTP. */
      readonly target?: "http" | "mcp";
    }
  | {
      readonly kind: "run";
      readonly phase: "end";
      readonly status: "ok" | "refused" | "error" | "info";
      readonly code?: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "http";
      readonly phase: "request";
      readonly id: string;
      readonly via: "relay" | "direct";
      readonly method: string;
      readonly url: string;
      readonly paid: boolean;
      /** Names of the request headers sent, never their values. */
      readonly headerNames: readonly string[];
      readonly bodyBytes: number;
      readonly rpc?: McpRequestView;
    }
  | {
      readonly kind: "http";
      readonly phase: "response";
      readonly id: string;
      readonly status: number;
      readonly ms: number;
      readonly required?: RequiredView;
      readonly settle?: SettleView;
      readonly trace?: SellerTraceView;
      /** `Server-Timing` metrics, in milliseconds. */
      readonly timing?: Readonly<Record<string, number>>;
      readonly rpc?: McpResponseView;
    }
  | {
      readonly kind: "http";
      readonly phase: "failed";
      readonly id: string;
      readonly code: string;
      readonly reason: string;
      readonly stage?: string;
    }
  | { readonly kind: "sdk"; readonly event: SdkPaymentEvent }
  | { readonly kind: "auth"; readonly view: AuthorizationView }
  | { readonly kind: "tool"; readonly phase: "call"; readonly name: ToolName; readonly args: JsonValue }
  | {
      readonly kind: "tool";
      readonly phase: "result";
      readonly name: ToolName;
      readonly isError: boolean;
      readonly result: JsonValue;
    }
  | { readonly kind: "delivery"; readonly view: DeliveryView }
  | { readonly kind: "chain"; readonly phase: "tx"; readonly view: TxView }
  | {
      readonly kind: "chain";
      readonly phase: "balance";
      readonly role: "payer" | "payTo";
      readonly account: string;
      readonly asset: string;
      /** Decimal balances; null when the account or trustline does not exist. */
      readonly before: string | null;
      readonly after: string | null;
    }
  | {
      readonly kind: "bazaar";
      readonly phase: "search";
      readonly query: string;
      readonly filters: JsonValue;
      readonly count: number;
      /** The ranking method the Bazaar reports, such as `hybrid`. */
      readonly method: string | null;
      readonly partialResults: boolean;
      readonly top: readonly ListingView[];
    }
  | { readonly kind: "bazaar"; readonly phase: "listing"; readonly listing: ListingView }
  | { readonly kind: "wallet"; readonly step: WalletStep; readonly transaction?: string }
  | {
      readonly kind: "refusal";
      readonly layer: RefusalLayer;
      readonly code: string;
      readonly reason: string;
      readonly details?: JsonValue;
    };

export type LabEvent = EventBase & LabEventBody;

export type LabEventKind = LabEvent["kind"];

export type LabEventListener = (event: LabEvent) => void;
