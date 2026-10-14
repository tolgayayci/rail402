import type { Money } from "../money.ts";
import type { BudgetSnapshot } from "../policy/budget.ts";
import type { SchemeName } from "../policy/policy.ts";
import type { Receipt } from "./receipt.ts";

export type HttpMethod = "GET" | "HEAD" | "DELETE" | "POST" | "PUT" | "PATCH";
export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "HEAD", "DELETE", "POST", "PUT", "PATCH"];

/** Query parameters; arrays repeat the parameter. */
export type QueryInput = Readonly<
  Record<string, string | number | boolean | readonly (string | number | boolean)[]>
>;

/** A resource to pay for: an HTTP endpoint, or a tool on an MCP server. */
export type PaymentTarget =
  | {
      readonly kind: "http";
      readonly url: string;
      readonly method?: HttpMethod;
      readonly query?: QueryInput;
      /** Only `accept`, `accept-language` and `x-request-id`; anything else is refused. */
      readonly headers?: Readonly<Record<string, string>>;
      /** A string is sent as text, bytes as octet-stream, anything else as JSON. */
      readonly body?: unknown;
    }
  | {
      readonly kind: "mcp";
      /** The MCP server's http(s) endpoint. */
      readonly url: string;
      readonly toolName: string;
      readonly arguments?: Readonly<Record<string, unknown>>;
      readonly transport?: "streamable-http" | "sse";
    };

/** How to call a listing selected from the Bazaar. */
export interface CallInput {
  /** Values for the listing's `:name` path parameters. */
  readonly pathParams?: Readonly<Record<string, string>>;
  readonly query?: QueryInput;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** MCP tool arguments. */
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface PayOptions {
  /** Required: the most this call may pay. Clamped to the operator's per-call ceiling. */
  readonly maxAmount: Money;
  /** A preference; the policy decides what is allowed. */
  readonly scheme?: SchemeName;
  /**
   * Repeating a call with the same key in the same budget window never pays twice: a finished call
   * returns its stored result (`replayed: true`) and a running one is refused (`payment_in_progress`).
   * A key names one call: reusing it for another resource is refused (`payment_request_invalid`).
   */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

/** An HTTP resource's answer. Seller content: untrusted data. */
export interface HttpOutcome {
  readonly kind: "http";
  readonly status: number;
  readonly contentType: string | null;
  /** Parsed JSON, for JSON content types within the inline limit. */
  readonly json?: unknown;
  /** Text (control characters removed), or a summary for binary content. */
  readonly text?: string;
  /** Bytes received. */
  readonly bytes: number;
  /** Content beyond the inline limit, or beyond the response limit, was left out. */
  readonly truncated: boolean;
}

/** An MCP tool's result. Seller content: untrusted data. */
export interface McpOutcome {
  readonly kind: "mcp";
  readonly isError: boolean;
  /** Text items; other content is summarized as text. */
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly structuredContent?: unknown;
  readonly truncated: boolean;
}

export interface CallResult {
  /** Identifies the call in events and the budget ledger. */
  readonly callId: string;
  /** False: the resource answered without asking for payment. */
  readonly paid: boolean;
  readonly payment: Receipt | null;
  readonly response: HttpOutcome | McpOutcome;
  readonly budget: BudgetSnapshot | null;
  /** True: the stored result of an earlier call with the same idempotency key; nothing was signed. */
  readonly replayed: boolean;
}

/** One of a seller's payment options, judged against the spending policy. */
export interface QuoteOption {
  readonly index: number;
  readonly scheme: string;
  readonly network: string;
  /** The policy symbol, or the contract address for an asset outside the policy. */
  readonly asset: string;
  readonly assetContract: string;
  /** Decimal amount, or null when the asset is outside the policy (decimals unknown). */
  readonly amount: string | null;
  readonly atomic: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly feesSponsored: boolean;
  readonly acceptable: boolean;
  readonly refused: { readonly code: string; readonly reason: string } | null;
}

/** What paying a resource would cost, without signing anything. */
export interface Quote {
  readonly callId: string;
  readonly resource: string;
  /** False: the resource answered without asking for payment. */
  readonly paymentRequired: boolean;
  /** The unpaid probe's status (HTTP), or 200 for an MCP tool result. */
  readonly status: number;
  readonly options: readonly QuoteOption[];
  /** The option `pay` would choose, or null when none is acceptable. */
  readonly chosen: number | null;
  /** Why nothing is acceptable, when that is the case. */
  readonly refused: { readonly code: string; readonly reason: string } | null;
  readonly warnings: readonly string[];
}
