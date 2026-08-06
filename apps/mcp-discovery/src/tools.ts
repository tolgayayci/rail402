import { z } from "zod";
import { createError, type ErrorCode } from "@x402-stellar/errors";

/**
 * The two agent-facing tools, defined independently of any transport so they can be unit-tested
 * without standing up an MCP server.
 *
 * Two properties drive every decision here:
 *
 *  - **Structured, deterministic inputs and outputs.** Strict schemas both ways. An agent should
 *    never have to parse prose to find out what happened.
 *  - **Machine-readable error codes with a non-null reason on every rejection**, so an agent can
 *    reason about failure instead of pattern-matching English.
 */

// ── Schemas ──────────────────────────────────────────────────────────────────

export const SearchInputSchema = z.object({
  query: z.string().min(1).describe("Natural-language description of the capability you need."),
  network: z.string().optional().describe('CAIP-2 network filter, e.g. "stellar:testnet".'),
  type: z.enum(["http", "mcp"]).optional().describe("Restrict to HTTP endpoints or MCP tools."),
  maxPrice: z
    .string()
    .optional()
    .describe("Atomic-unit ceiling. Resources priced above this are excluded before you see them."),
  limit: z.number().int().min(1).max(50).default(10),
});

export const PayInputSchema = z.object({
  resource: z.string().url().describe("Resource URL exactly as returned by the search tool."),
  /**
   * Supplying this switches the whole call to MCP: the resource URL is treated as an MCP endpoint
   * and the named tool is invoked over the streamable-HTTP transport, with payment carried in
   * `_meta` per `@x402/mcp`. It used to be accepted and silently ignored, so an agent that found an
   * MCP tool through search could not actually call it.
   */
  toolName: z
    .string()
    .optional()
    .describe(
      "For an MCP resource, the tool to invoke — exactly as returned by the search tool. Supplying it makes this an MCP tool call rather than an HTTP request.",
    ),
  toolArguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("MCP only. Arguments for the tool, matching its published inputSchema."),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
  queryParams: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  /**
   * Required, deliberately. The requirement: the paid-call tool "must surface price and require an
   * explicit budget/limit parameter; never silently pay an unbounded amount". Giving this a default
   * would hand an agent an unbounded spender by omission — the single most dangerous thing this
   * tool could do.
   */
  maxAmount: z
    .string()
    .regex(/^\d+$/, "maxAmount must be a non-negative integer in atomic units")
    .describe("REQUIRED. Maximum you authorize for this single call, in atomic token units."),
  network: z.string().optional().describe("Restrict payment to this CAIP-2 network."),
  /**
   * Closes the discovery loop ("searches that never convert to a paid call",
   * "click/selection data from the MCP server").
   *
   * Optional, and never load-bearing: an omitted, stale or forged token changes nothing about the
   * payment. It only tells the Bazaar which search led to this call, which is the strongest
   * relevance judgment obtainable — somebody backed it with money. Because it is caller-reported it
   * feeds the human-reviewed judgment set only, never live ranking.
   */
  searchToken: z
    .string()
    .optional()
    .describe(
      "Optional. The `meta.searchToken` from the search response that led you here, so the Bazaar can learn which results agents actually pay for. Never affects the payment.",
    ),
});

/** Every tool result is this shape, success or failure. Agents branch on `ok`, then on `error.code`. */
export interface ToolResult<T> {
  ok: boolean;
  data?: T;
  error?: { code: ErrorCode; reason: string; retryable: boolean; details?: Record<string, unknown> };
}

export function fail<T>(
  code: ErrorCode,
  opts: { reason?: string; details?: Record<string, unknown> } = {},
): ToolResult<T> {
  const e = createError(code, opts);
  return {
    ok: false,
    error: {
      code: e.code,
      reason: e.reason,
      retryable: e.retryable,
      ...(e.details === undefined ? {} : { details: e.details as Record<string, unknown> }),
    },
  };
}

export const succeed = <T>(data: T): ToolResult<T> => ({ ok: true, data });

// ── Output schemas (§3.3: strict, structured outputs) ────────────────────────
//
// Every tool returns the `ToolResult` envelope `{ ok, data?, error? }`. Declaring it as the tool's
// `outputSchema` hands an agent a machine-readable result instead of prose it must parse, and lets
// the MCP SDK return `structuredContent` alongside the text block. `data` and `error` are BOTH
// optional so this ONE schema validates a success (`ok:true` + `data`) and a failure (`ok:false` +
// `error`). The SDK skips output validation on `isError` results (server/mcp.js `validateToolOutput`),
// but a single envelope that accepts both is the honest description of what the tool returns.

const ToolErrorSchema = z.object({
  code: z.string().describe("Machine-readable error code from the shared registry."),
  reason: z.string().describe("Non-null human-legible explanation. Never empty."),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const AssetIdentitySchema = z.object({
  code: z.string().describe('Asset code, e.g. "USDC".'),
  issuer: z.string().nullable().describe("Classic issuer G-address, or null for native XLM."),
  decimals: z.number().int().describe("Atomic units per whole unit, as a power of ten."),
  identity: z
    .literal("derived")
    .describe(
      "The catalog independently DERIVED this contract address from the canonical (code, issuer) for this network, so it is provably that asset rather than a look-alike claiming the name.",
    ),
});

const TrustlineSchema = z.object({
  state: z
    .enum(["ok", "missing", "unauthorized", "unknown"])
    .describe(
      "Whether the payee can receive this asset. `missing` or `unauthorized` means a payment here will fail on-ledger — prefer another seller. `unknown` means the catalog could not find out.",
    ),
  checkedAt: z.string().describe("ISO timestamp of the check. A pre-flight, not a guarantee."),
  reason: z.string().optional().describe("Why the state is not `ok`, and what would fix it."),
});

const PriceSchema = z.object({
  amount: z.string().describe("Price in ATOMIC units — this is what maxAmount is denominated in."),
  asset: z.string().describe("Stellar Asset Contract address of the payment token."),
  network: z.string(),
  scheme: z.string(),
  feesSponsored: z.boolean().describe("True when the facilitator sponsors the network fee (gasless)."),
  assetIdentity: AssetIdentitySchema.optional().describe(
    "Present only when the catalog can prove what this token is. Absent means unvouched-for, not fake.",
  ),
  amountDecimal: z
    .string()
    .optional()
    .describe(
      'The same price in whole units, e.g. "0.1000000" USDC. Present only alongside assetIdentity, since decimals are needed to compute it. Display only — maxAmount is still atomic.',
    ),
  payToTrustline: TrustlineSchema.optional().describe(
    "Stellar-specific: whether the payee has an authorized trustline for this asset. Absent when the question does not apply (native XLM, a contract payee, an unidentifiable asset), which is not a negative signal.",
  ),
});

const SearchHitSchema = z.object({
  resource: z.string(),
  type: z.string(),
  toolName: z.string().optional(),
  description: z.string().optional(),
  serviceName: z.string().optional(),
  tags: z.array(z.string()).optional(),
  price: PriceSchema.optional(),
  inputSchema: z.unknown().optional(),
  usage: z.object({ settlements: z.number(), uniquePayers: z.number() }).optional(),
});

export const SearchOutputSchema = z.object({
  ok: z.boolean(),
  data: z
    .object({
      results: z.array(SearchHitSchema),
      count: z.number(),
      searchToken: z.string().optional(),
    })
    .optional(),
  error: ToolErrorSchema.optional(),
});

export const PayOutputSchema = z.object({
  ok: z.boolean(),
  data: z
    .object({
      transport: z
        .enum(["http", "mcp"])
        .describe("Which protocol the call went out over, decided by whether you supplied toolName."),
      // Present for HTTP only. An MCP tool call has no HTTP status of its own, and reporting a
      // synthetic 200 would be inventing a field the transport does not have — an agent that
      // branches on it would be branching on a fiction.
      status: z.number().optional().describe("HTTP status. Absent for MCP tool calls."),
      body: z.unknown().describe("Response body, or the MCP tool's content blocks."),
      toolName: z.string().optional().describe("MCP only. The tool that was invoked."),
      isError: z
        .boolean()
        .optional()
        .describe(
          "MCP only. The tool reported a domain-level failure. The call and any payment still succeeded — this is the tool saying no, not the protocol failing.",
        ),
      paid: z
        .object({
          amount: z.string(),
          asset: z.string(),
          network: z.string(),
          transaction: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  error: ToolErrorSchema.optional(),
});

/**
 * Render a `ToolResult` as an MCP `CallToolResult`.
 *
 * Returns BOTH `structuredContent` (the machine-readable envelope, validated against the tool's
 * `outputSchema` by the SDK on success) and a serialized `content` text block, which the MCP spec
 * asks servers to include for backward compatibility. `isError` is set on failure so the model sees
 * the call failed and can self-correct, rather than receiving a protocol-level success with the
 * failure buried in prose — the shape these tools returned before §3.3 structured output.
 */
export function toToolCall<T>(result: ToolResult<T>): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result as unknown as Record<string, unknown>,
    isError: !result.ok,
  };
}

// ── Price handling ───────────────────────────────────────────────────────────

/**
 * Amounts are bigint end to end. A budget check done in floating point is a bug
 * waiting to overspend: `Number("9007199254740993")` silently loses precision, and this is the
 * comparison that decides whether real money moves.
 */
export function withinBudget(price: string, maxAmount: string): boolean {
  try {
    return BigInt(price) <= BigInt(maxAmount);
  } catch {
    return false;
  }
}

export interface PricedOption {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

// ── Stellar asset identity ───────────────────────────────────────────────────
//
// Re-exported from the buyer-side helper package rather than reimplemented. Both agent-facing
// surfaces — `searchBazaar` there and `search_stellar_resources` here — need the same defensive
// parse of the same catalog field, and a second copy of a defensive parse is a copy that will
// eventually stop rejecting something the first one still rejects.
export {
  readAssetIdentity,
  readTrustlinePreflight,
  formatAtomicAmount,
  type AssetIdentity,
  type TrustlinePreflight,
} from "@x402-stellar/agent-helpers";

/**
 * Pick the cheapest option the agent can actually pay: a Stellar network, within budget.
 *
 * Returning the cheapest rather than the first is the agent-friendly choice — a seller listing the
 * same resource on several networks should not charge more by accident of ordering.
 */
export function selectPayable(
  accepts: readonly PricedOption[],
  maxAmount: string,
  network?: string,
): { chosen?: PricedOption; cheapestRejected?: PricedOption } {
  const stellar = accepts.filter(
    a => a.network.startsWith("stellar:") && (!network || a.network === network),
  );
  if (stellar.length === 0) return {};

  const sorted = [...stellar].sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
  const affordable = sorted.filter(a => withinBudget(a.amount, maxAmount));

  if (affordable.length > 0) return { chosen: affordable[0]! };
  return { cheapestRejected: sorted[0]! };
}

// ── Where this server is willing to send a request ───────────────────────────

/** Hostnames that name an infrastructure endpoint rather than a paid service. */
const REFUSED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "kubernetes.default.svc",
]);
/** Suffixes reserved for internal resolution. Never a public paid API. */
const REFUSED_SUFFIXES = [".internal", ".local", ".localdomain", ".cluster.local"];
const LOOPBACK_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
/** `http://2852039166/` and `http://0x7f000001/` are both 127.0.0.1 to a resolver. */
const ALL_DIGITS = /^\d+$/;
const HEX_LITERAL = /^0x[0-9a-f]+$/i;

/**
 * Decide whether this server will fetch a caller-supplied resource URL.
 *
 * `pay_and_call` takes a URL from the agent, fetches it, and returns the body — which makes it a
 * read primitive pointed at whatever the MCP server's network position can reach. Before this check
 * it would fetch `http://169.254.169.254/latest/meta-data/…` and hand the response straight back
 * In an agent runtime "the caller" includes anything that can get a tool
 * call into the conversation, so this is not hypothetical.
 *
 * ## Why this is written out rather than reusing the SDK's `isValidIconUrl`
 *
 * That helper happens to encode nearly this policy, and reuse is the house rule everywhere else in
 * this codebase. Not here. It exists to decide whether a *decorative image link* is acceptable, and
 * upstream is free to relax it on those grounds — at which point our SSRF boundary would widen
 * silently, with no diff in this repository and no test failing. A security control should not be a
 * side effect of somebody else's product decision about favicons. It is fifteen lines; we own them.
 *
 * ## The policy
 *
 * http(s) only · no credentials in the URL · no IPv6 literal · no IPv4 literal in any encoding
 * (dotted, decimal or hex) · no loopback name · no internal-resolution suffix · no known metadata
 * hostname. Rejecting every IP literal rather than enumerating private ranges is deliberate: it
 * covers 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, CGNAT and anything else in one rule that
 * cannot be wrong, and a public paid service advertises a hostname anyway.
 *
 * ## Residual, stated rather than papered over
 *
 * A public DNS name that resolves to a private address still passes, and this runs before the
 * socket, so DNS rebinding is not closed. Closing it needs resolve-then-pin at the connection
 * layer.
 *
 * @param raw - the caller-supplied resource URL
 * @param allowPrivateHosts - operator opt-in for local development, where the seller genuinely is
 *   on localhost. Off by default; a hosted deployment must never turn it on. Even then the
 *   metadata and internal-suffix rules still apply — the escape hatch is for a local seller, not
 *   for reaching an instance metadata service.
 */
export function isPayableResourceUrl(raw: string, allowPrivateHosts = false): boolean {
  let parsed: URL;
  try {
    // WHATWG URL parsing normalises IDN to punycode and percent-decodes the host for us, so the
    // checks below see the same string a resolver would.
    parsed = new URL(raw);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "") return false;
  if (REFUSED_HOSTNAMES.has(hostname)) return false;
  if (REFUSED_SUFFIXES.some(suffix => hostname.endsWith(suffix))) return false;

  // These stay enforced even under the opt-in.
  if (allowPrivateHosts) return true;

  if (parsed.host.startsWith("[")) return false; // IPv6 literal
  if (IPV4_LITERAL.test(hostname)) return false;
  if (ALL_DIGITS.test(hostname)) return false;
  if (HEX_LITERAL.test(hostname)) return false;
  if (LOOPBACK_HOSTNAMES.has(hostname)) return false;

  return true;
}

// ── Budget enforcement ───────────────────────────────────────────────────────

/**
 * Thrown by the payment-requirements selector when nothing on offer fits the budget.
 *
 * Carries the cheapest option we refused, so the agent is told the real price rather than just
 * "no". Distinguishable by class so `payAndCall` can map it to `mcp_budget_exceeded` instead of
 * the generic upstream-error bucket.
 */
export class BudgetExceededError extends Error {
  constructor(
    readonly cheapest: PricedOption | undefined,
    readonly budget: string,
  ) {
    super(
      cheapest
        ? `Resource costs ${cheapest.amount} atomic units of ${cheapest.asset} on ${cheapest.network}, exceeding the authorized maximum of ${budget}.`
        : `No payment option on a supported Stellar network was offered within the authorized maximum of ${budget}.`,
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * A payment-requirements selector that refuses to select anything above the budget.
 *
 * **This is the enforcement point, and it has to be.** The unpaid probe in `payAndCall` reads a
 * price, but the payment is made by a *second* request whose 402 challenge can say something
 * different — a surge-priced, mispriced or simply hostile server quotes cheap on the probe and
 * expensive on the paid call. Checking only the probe let the tool pass its own budget gate on one
 * quote and then pay another, while its description promised it "will never
 * spend more than maxAmount".
 *
 * `x402Client` runs this selector after policies and immediately before the payload is created, so
 * throwing here means nothing is ever signed.
 */
export function budgetSelector(
  budget: string,
  network?: string,
  /**
   * Called with the refusal before it is thrown.
   *
   * Necessary because `wrapFetchWithPayment` rethrows without `cause` and without the class, so a
   * caller downstream of it cannot recover what was refused — only reconstruct a lossy copy from
   * the message. Reporting the real price and the real budget requires capturing them here.
   */
  onRefusal?: (refusal: BudgetExceededError) => void,
) {
  return (_x402Version: number, requirements: readonly PricedOption[]): PricedOption => {
    const { chosen, cheapestRejected } = selectPayable(requirements, budget, network);
    if (!chosen) {
      const error = new BudgetExceededError(cheapestRejected, budget);
      onRefusal?.(error);
      throw error;
    }
    return chosen;
  };
}

// ── Tool descriptions ────────────────────────────────────────────────────────

export const SEARCH_TOOL_DESCRIPTION = `Search the Stellar Bazaar for paid APIs and MCP tools by natural-language description.

Returns matching resources with their price, network and input schema so you can decide what to
call. Nothing is paid for by this tool. Use it before pay_and_call to discover a resource you have
no prior integration with.

Prices are in ATOMIC units, which is also what pay_and_call's maxAmount takes. Where the catalog can
prove what the payment token is, the result additionally carries price.assetIdentity (the asset code,
issuer and decimals, DERIVED from the token contract rather than claimed by the seller) and
price.amountDecimal, the same price in whole units. A missing assetIdentity means the catalog does not
vouch for that token, not that the token is fake.`;

export const PAY_TOOL_DESCRIPTION = `Call a paid Stellar x402 resource, settling payment automatically.

Handles the full discover -> pay -> retry loop: requests the resource, reads the 402 challenge,
signs a Stellar authorization entry, settles through the facilitator, and returns the resource body.

You MUST supply maxAmount, an explicit ceiling in atomic token units for this single call. If the
resource costs more, NO payment is made and the price is returned so you can decide. The ceiling is
re-applied to the price quoted at the moment of payment, not only to the price seen beforehand, so a
resource that changes its price between the two is refused rather than paid. This tool never spends
anything without a maxAmount and never spends more than one.

Supply toolName to call an MCP TOOL instead of an HTTP endpoint: the resource URL is then treated as
an MCP endpoint, the tool is invoked over streamable HTTP with payment carried in the MCP _meta
fields, and toolArguments carries its arguments. The same maxAmount ceiling applies, enforced at the
same point — nothing is signed above it.

Only publicly reachable http(s) hosts can be called. Loopback, private and IP-literal addresses are
refused.`;
