import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { createError, type ErrorCode } from "@x402-stellar/errors";

/**
 * Buyer/agent-side helpers: find a Stellar service you have never seen before, and pay for it.
 *
 * The definition of success is that an agent can **discover → pay** a service with no
 * pre-existing integration. Two things make that safe rather than reckless, and both are enforced
 * here rather than left to the caller:
 *
 * 1. **A spend cap is mandatory.** `maxAmount` has no default. A default would hand an agent an
 *    unbounded spender by omission, which is the worst failure this library could enable.
 * 2. **The price is read before any money moves.** We probe unpaid, compare against the cap, and
 *    only then enter the payment flow. Paying first and checking afterwards is not a budget.
 *
 * Everything is built on the stock `@x402/*` client, so the payment path is identical to one a
 * developer would write by hand — these helpers add safety and ergonomics, not a private protocol.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface BazaarResource {
  resource: string;
  type: "http" | "mcp";
  toolName?: string;
  description?: string;
  serviceName?: string;
  tags?: string[];
  /** Cheapest Stellar option, or undefined if none is payable on Stellar. */
  price?: { amount: string; asset: string; network: string; scheme: string };
  inputSchema?: unknown;
  usage?: { settlements: number; uniquePayers: number };
}

export interface Result<T> {
  ok: boolean;
  data?: T;
  error?: { code: ErrorCode; reason: string; retryable: boolean; details?: Record<string, unknown> };
}

const fail = <T>(code: ErrorCode, opts: { reason?: string; details?: Record<string, unknown> } = {}): Result<T> => {
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
};
const ok = <T>(data: T): Result<T> => ({ ok: true, data });

/** The shape of a payment option, as it appears in a 402 challenge and in the catalog. */
interface PricedOption {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  /** Carried so this structurally satisfies `PaymentRequirements` where the selector is installed. */
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/**
 * Pick the cheapest option that is on a supported Stellar network AND within budget.
 *
 * Shared by the unpaid probe and by the selector below, so both answer the question the same way.
 * Comparisons are bigint: `Number("9007199254740993")` rounds down, and a float compare would
 * authorize an overspend by one atomic unit at the top of the range.
 */
function selectPayable(
  offered: readonly PricedOption[],
  budget: string,
  network?: string,
): { chosen?: PricedOption; cheapestRejected?: PricedOption } {
  const stellar = offered.filter(
    a => a.network.startsWith("stellar:") && (!network || a.network === network),
  );
  if (stellar.length === 0) return {};
  const sorted = [...stellar].sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
  const chosen = sorted.find(a => BigInt(a.amount) <= BigInt(budget));
  return chosen ? { chosen } : { cheapestRejected: sorted[0]! };
}

/** Thrown by the selector when nothing on offer fits the budget. Carries the price we refused. */
class BudgetExceededError extends Error {
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
 * **This is the enforcement point, and it has to be.** The unpaid probe in `payAndFetch` reads a
 * price, but the money is paid by a *second* request whose 402 challenge can say something else —
 * a surge-priced, mispriced or simply hostile seller quotes cheap on the probe and expensive on the
 * paid call. Checking only the probe let this helper pass its own budget gate on one quote and then
 * sign another, while its documentation promised a mandatory spend cap.
 *
 * The identical defect was found and fixed in the MCP server; it survived
 * here because the package's own tests used a checksum-invalid secret, so `createEd25519Signer`
 * threw before the payment path was ever reached and no test could observe the gap.
 *
 * `x402Client` runs this selector immediately before the payload is created, so throwing here
 * means nothing is ever signed.
 */
function budgetSelector(budget: string, network: string | undefined, onRefusal: (r: BudgetRefusal) => void) {
  return (_x402Version: number, requirements: readonly PricedOption[]): PricedOption => {
    const { chosen, cheapestRejected } = selectPayable(requirements, budget, network);
    if (!chosen) {
      onRefusal({ cheapest: cheapestRejected, budget });
      throw new BudgetExceededError(cheapestRejected, budget);
    }
    return chosen;
  };
}

/**
 * Why the refusal is captured rather than recovered from the thrown error.
 *
 * `wrapFetchWithPayment` rethrows a selector failure as
 * `new Error("Failed to create payment payload: " + error.message)` — no `cause`, no class
 * (`@x402/fetch` 2.20.0, `dist/esm/index.mjs:46`). So the `BudgetExceededError` does not survive
 * the boundary in any form except its message text, and walking `.cause` finds nothing.
 *
 * Matching the message would work, and the MCP server does exactly that. Recording the refusal as
 * the selector raises it is stronger: it cannot be defeated by a reworded wrapper, and it keeps the
 * refused price, which reconstructing from a string cannot.
 */
interface BudgetRefusal {
  cheapest: PricedOption | undefined;
  budget: string;
}

export interface AgentConfig {
  /** Base URL of a Bazaar (our facilitator serves discovery at its own base). */
  bazaarUrl: string;
  /** Stellar secret seed for the buying account. Omit for discovery-only use. */
  stellarSecret?: string;
  network?: string;
  /** Hard ceiling the caller cannot exceed, whatever they pass per-call. */
  maxAmountCeiling?: string;
}

// ── Discovery ────────────────────────────────────────────────────────────────

export interface SearchOptions {
  network?: string;
  type?: "http" | "mcp";
  /** Exclude anything priced above this, in atomic units. */
  maxPrice?: string;
  limit?: number;
}

/**
 * Search the Bazaar in natural language.
 *
 * Reads the search endpoint's `resources` array — note the list endpoint uses `items` instead. That
 * asymmetry is real and spec-defined, and getting it backwards is the classic way to break against
 * a conformant Bazaar.
 */
export async function searchBazaar(
  config: AgentConfig,
  query: string,
  options: SearchOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Result<BazaarResource[]>> {
  if (!query.trim()) {
    return fail("invalid_payload", { reason: "A non-empty search query is required." });
  }

  const url = new URL("/discovery/search", config.bazaarUrl);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(options.limit ?? 10));
  if (options.network ?? config.network) url.searchParams.set("network", options.network ?? config.network!);
  if (options.type) url.searchParams.set("type", options.type);

  let body: { resources?: RawResource[] };
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      return fail("mcp_upstream_error", {
        reason: `The Bazaar returned HTTP ${res.status} for this search.`,
        details: { status: res.status },
      });
    }
    body = (await res.json()) as { resources?: RawResource[] };
  } catch (error) {
    return fail("mcp_upstream_error", {
      reason: `Could not reach the Bazaar at ${config.bazaarUrl}: ${error instanceof Error ? error.message : "unknown error"}.`,
    });
  }

  const results = (body.resources ?? [])
    .map(toBazaarResource)
    .filter(r => !options.maxPrice || !r.price || BigInt(r.price.amount) <= BigInt(options.maxPrice));

  return ok(results);
}

interface RawResource {
  resource: string;
  type: "http" | "mcp";
  description?: string;
  serviceName?: string;
  tags?: string[];
  accepts?: Array<{ scheme: string; network: string; amount: string; asset: string; payTo: string }>;
  extensions?: Record<string, unknown>;
  quality?: { totalSettlements: number; uniquePayers: number };
}

function toBazaarResource(r: RawResource): BazaarResource {
  const stellar = (r.accepts ?? []).filter(a => a.network.startsWith("stellar:"));
  const cheapest = [...stellar].sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1))[0];

  // Read the nested SDK-typed shape. Some catalogs in the wild place these fields at the top level
  // instead; tolerate that on read so cross-facilitator discovery does not silently return nothing.
  const bazaar = r.extensions?.["bazaar"] as
    | { info?: { input?: { toolName?: string; inputSchema?: unknown } } }
    | undefined;
  const flat = r as unknown as { toolName?: string; inputSchema?: unknown };

  const out: BazaarResource = { resource: r.resource, type: r.type };
  const toolName = bazaar?.info?.input?.toolName ?? flat.toolName;
  const inputSchema = bazaar?.info?.input?.inputSchema ?? flat.inputSchema;
  if (toolName) out.toolName = toolName;
  if (r.description) out.description = r.description;
  if (r.serviceName) out.serviceName = r.serviceName;
  if (r.tags) out.tags = r.tags;
  if (inputSchema) out.inputSchema = inputSchema;
  if (cheapest) {
    out.price = { amount: cheapest.amount, asset: cheapest.asset, network: cheapest.network, scheme: cheapest.scheme };
  }
  if (r.quality) out.usage = { settlements: r.quality.totalSettlements, uniquePayers: r.quality.uniquePayers };
  return out;
}

// ── Payment ──────────────────────────────────────────────────────────────────

export interface PayOptions {
  /** REQUIRED. Ceiling for this single call, in atomic units. No default, by design. */
  maxAmount: string;
  method?: string;
  queryParams?: Record<string, string>;
  network?: string;
}

export interface PaidResponse<T = unknown> {
  status: number;
  body: T;
  paid?: { amount: string; asset: string; network: string; transaction?: string };
}

/**
 * Fetch a resource, paying if it demands payment — never above `maxAmount`.
 *
 * Probes unpaid first to learn the price, so a too-expensive resource costs one HTTP request and
 * zero money. Returns `mcp_budget_exceeded` with the actual price so the caller can decide whether
 * to raise its ceiling.
 */
export async function payAndFetch<T = unknown>(
  config: AgentConfig,
  resourceUrl: string,
  options: PayOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<PaidResponse<T>>> {
  if (!config.stellarSecret) {
    return fail("mcp_resource_not_payable", {
      reason: "No Stellar signer configured, so no payment can be made. Set `stellarSecret`.",
    });
  }
  if (!/^\d+$/.test(options.maxAmount)) {
    return fail("mcp_budget_required", {
      reason: `maxAmount must be a non-negative integer in atomic units; got "${options.maxAmount}".`,
    });
  }

  // An operator ceiling always beats a caller-supplied budget.
  let budget = options.maxAmount;
  if (config.maxAmountCeiling && BigInt(budget) > BigInt(config.maxAmountCeiling)) {
    budget = config.maxAmountCeiling;
  }

  const target = new URL(resourceUrl);
  for (const [k, v] of Object.entries(options.queryParams ?? {})) target.searchParams.set(k, v);
  const method = options.method ?? "GET";

  // Step 1 — unpaid probe. Learn the price before committing anything.
  let accepts: Array<{ scheme: string; network: string; amount: string; asset: string; payTo: string }> = [];
  try {
    const probe = await fetchImpl(target, { method });
    if (probe.status !== 402) {
      return ok({ status: probe.status, body: (await safeJson(probe)) as T });
    }
    const header = probe.headers.get("PAYMENT-REQUIRED");
    if (header) {
      accepts = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: typeof accepts })
        .accepts ?? [];
    }
  } catch (error) {
    return fail("mcp_upstream_error", {
      reason: `Could not reach ${resourceUrl}: ${error instanceof Error ? error.message : "unknown error"}.`,
    });
  }

  const wanted = options.network ?? config.network;
  const stellar = accepts.filter(a => a.network.startsWith("stellar:") && (!wanted || a.network === wanted));
  if (stellar.length === 0) {
    return fail("mcp_resource_not_payable", {
      reason: `${resourceUrl} offers no payment option on a Stellar network${wanted ? ` matching ${wanted}` : ""}.`,
      details: { offered: accepts.map(a => a.network) },
    });
  }

  const { chosen, cheapestRejected } = selectPayable(stellar, budget, wanted);
  if (!chosen) {
    const cheapest = cheapestRejected!;
    return fail("mcp_budget_exceeded", {
      reason: `This resource costs ${cheapest.amount} atomic units of ${cheapest.asset} on ${cheapest.network}, which exceeds your maxAmount of ${budget}. No payment was made.`,
      details: { price: cheapest.amount, asset: cheapest.asset, network: cheapest.network, maxAmount: budget },
    });
  }

  // Step 2 — pay, via the stock client, with the cap re-applied to whatever THIS request is
  // quoted. The probe above is informational; the selector is the guarantee.
  let refusal: BudgetRefusal | undefined;
  try {
    const signer = createEd25519Signer(config.stellarSecret, chosen.network as `${string}:${string}`);
    const client = new x402Client(
      budgetSelector(budget, wanted, r => {
        refusal = r;
      }) as ConstructorParameters<typeof x402Client>[0],
    );
    client.register("stellar:*", new ExactStellarScheme(signer));
    const paidFetch = wrapFetchWithPayment(fetchImpl, client);

    const response = await paidFetch(target, { method });
    let transaction: string | undefined;
    const settlement = response.headers.get("PAYMENT-RESPONSE");
    if (settlement) {
      try {
        transaction = (JSON.parse(Buffer.from(settlement, "base64").toString("utf8")) as { transaction?: string })
          .transaction;
      } catch {
        /* a missing hash must not fail an otherwise good call */
      }
    }

    if (!response.ok) {
      return fail("mcp_upstream_error", {
        reason: `Payment settled but the resource returned HTTP ${response.status}.`,
        details: { status: response.status, transaction },
      });
    }

    return ok({
      status: response.status,
      body: (await safeJson(response)) as T,
      paid: {
        amount: chosen.amount,
        asset: chosen.asset,
        network: chosen.network,
        ...(transaction === undefined ? {} : { transaction }),
      },
    });
  } catch (error) {
    // The selector refused the price quoted on the paid request. Nothing was signed and nothing was
    // spent — report a budget refusal, not an upstream fault, and name both prices so the caller
    // can see it was quoted one figure and charged another.
    if (refusal) {
      const { cheapest } = refusal;
      return fail("mcp_budget_exceeded", {
        reason:
          (cheapest
            ? `Resource costs ${cheapest.amount} atomic units of ${cheapest.asset} on ${cheapest.network}, exceeding the authorized maximum of ${refusal.budget}.`
            : `No payment option within the authorized maximum of ${refusal.budget} was offered.`) +
          ` The price quoted when the payment was attempted (${cheapest?.amount ?? "unknown"}) differed from the price quoted on the unpaid probe (${chosen.amount}). No payment was made.`,
        details: {
          ...(cheapest
            ? { price: cheapest.amount, asset: cheapest.asset, network: cheapest.network }
            : {}),
          maxAmount: refusal.budget,
          quotedOnProbe: chosen.amount,
        },
      });
    }
    return fail("mcp_upstream_error", {
      reason: `Payment failed: ${error instanceof Error ? error.message : "unknown error"}.`,
    });
  }
}

/**
 * The whole loop in one call: search, take the best match, pay for it.
 *
 * This is the "discover → pay a service it has never seen before" reduced to a single
 * function. The spend cap still applies, and a search that matches nothing costs nothing.
 */
export async function discoverAndPay<T = unknown>(
  config: AgentConfig,
  query: string,
  options: PayOptions & SearchOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<PaidResponse<T> & { discovered: BazaarResource }>> {
  const found = await searchBazaar(
    config,
    query,
    { ...options, maxPrice: options.maxPrice ?? options.maxAmount },
    fetchImpl,
  );
  if (!found.ok) return found as Result<never>;

  const best = found.data?.[0];
  if (!best) {
    return fail("mcp_resource_not_found", {
      reason: `No Stellar resource in the Bazaar matched "${query}" within a budget of ${options.maxAmount}.`,
      details: { query, maxAmount: options.maxAmount },
    });
  }

  const paid = await payAndFetch<T>(config, best.resource, options, fetchImpl);
  if (!paid.ok) return paid as Result<never>;
  return ok({ ...paid.data!, discovered: best });
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
