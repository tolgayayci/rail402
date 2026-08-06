import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import {
  PayInputSchema,
  SearchInputSchema,
  SEARCH_TOOL_DESCRIPTION,
  PAY_TOOL_DESCRIPTION,
  BudgetExceededError,
  budgetSelector,
  fail,
  isPayableResourceUrl,
  succeed,
  selectPayable,
  toToolCall,
  SearchOutputSchema,
  PayOutputSchema,
  readAssetIdentity,
  readTrustlinePreflight,
  formatAtomicAmount,
  type AssetIdentity,
  type TrustlinePreflight,
  type PricedOption,
  type ToolResult,
} from "./tools.js";

/**
 * MCP server exposing the Stellar Bazaar to an agent runtime.
 *
 * Two tools: a resource search tool and a paid-call proxy that wraps the
 * discover -> pay -> retry loop. The proxy is built on the stock `@x402/fetch` client, so the
 * payment path an agent takes here is byte-identical to the one a human developer would write.
 */

export interface McpConfig {
  readonly bazaarUrl: string;
  readonly stellarSecret?: string;
  readonly network: string;
  /** Absolute ceiling an operator can impose regardless of what the agent requests. */
  readonly maxAmountCeiling?: string;
  /**
   * Permit `pay_and_call` to fetch loopback, private and IP-literal hosts.
   *
   * Off by default, because this server fetches caller-supplied URLs and returns the body. Local
   * development and the bundled examples run a seller on `localhost` and need it; a hosted
   * deployment must never set it. See `isPayableResourceUrl`.
   */
  readonly allowPrivateHosts?: boolean;
}

interface DiscoveryResource {
  resource: string;
  type: "http" | "mcp";
  description?: string;
  serviceName?: string;
  tags?: string[];
  accepts: PricedOption[];
  extensions?: Record<string, unknown>;
  quality?: { totalSettlements: number; uniquePayers: number };
}

export function createMcpServer(config: McpConfig) {
  const server = new McpServer({ name: "x402-stellar-discovery", version: "0.1.0" });

  // ── search ────────────────────────────────────────────────────────────────
  server.registerTool(
    "search_stellar_resources",
    {
      title: "Search the Stellar Bazaar",
      description: SEARCH_TOOL_DESCRIPTION,
      inputSchema: SearchInputSchema.shape,
      outputSchema: SearchOutputSchema.shape,
      // Hints only — the spec is explicit that clients MUST treat annotations as untrusted, so they
      // are never a control (the budget cap in pay_and_call is). Search reads and never spends.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async args => toToolCall(await searchResources(config, args)),
  );

  // ── paid call ─────────────────────────────────────────────────────────────
  server.registerTool(
    "pay_and_call",
    {
      title: "Call a paid Stellar resource",
      description: PAY_TOOL_DESCRIPTION,
      inputSchema: PayInputSchema.shape,
      outputSchema: PayOutputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async args => toToolCall(await payAndCall(config, args)),
  );

  return server;
}

// ── implementations (exported for direct testing) ────────────────────────────

export interface SearchHit {
  resource: string;
  type: string;
  toolName?: string;
  description?: string;
  serviceName?: string;
  tags?: string[];
  price:
    | {
        amount: string;
        asset: string;
        network: string;
        scheme: string;
        feesSponsored: boolean;
        assetIdentity?: AssetIdentity;
        amountDecimal?: string;
        payToTrustline?: TrustlinePreflight;
      }
    | undefined;
  inputSchema?: unknown;
  usage?: { settlements: number; uniquePayers: number };
}

export async function searchResources(
  config: McpConfig,
  args: {
    query: string;
    network?: string | undefined;
    type?: string | undefined;
    maxPrice?: string | undefined;
    limit?: number | undefined;
  },
): Promise<ToolResult<{ results: SearchHit[]; count: number; searchToken?: string }>> {
  const url = new URL("/discovery/search", config.bazaarUrl);
  url.searchParams.set("query", args.query);
  url.searchParams.set("limit", String(args.limit ?? 10));
  if (args.network) url.searchParams.set("network", args.network);
  if (args.type) url.searchParams.set("type", args.type);

  let payload: { resources?: DiscoveryResource[]; meta?: { searchToken?: string } };
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return fail("mcp_upstream_error", {
        reason: `The Bazaar returned HTTP ${res.status} for this search. The catalog may be unavailable.`,
        details: { status: res.status },
      });
    }
    payload = (await res.json()) as {
      resources?: DiscoveryResource[];
      meta?: { searchToken?: string };
    };
  } catch (error) {
    return fail("mcp_upstream_error", {
      reason: `Could not reach the Bazaar at ${config.bazaarUrl}: ${error instanceof Error ? error.message : "unknown error"}.`,
    });
  }

  const results: SearchHit[] = (payload.resources ?? [])
    .map(r => {
      const stellar = r.accepts?.filter(a => a.network.startsWith("stellar:")) ?? [];
      const cheapest = [...stellar].sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1))[0];
      const bazaar = r.extensions?.["bazaar"] as
        | { info?: { input?: { toolName?: string; inputSchema?: unknown } } }
        | undefined;
      // The catalog's own derivation of what this token is, when it has one. An agent otherwise sees
      // only a `C…` contract address and has no way to tell canonical USDC from a look-alike — nor
      // any way to know the decimal scale, which is what makes "1000000" and "0.1000000" the same
      // number. Both are surfaced together because neither is usable without the other.
      const identity = cheapest ? readAssetIdentity(cheapest.extra) : undefined;
      const amountDecimal = identity ? formatAtomicAmount(cheapest!.amount, identity.decimals) : undefined;
      // Stellar's defining onboarding hazard, answered before the agent commits: a payee without an
      // authorized trustline cannot receive the asset, and the payment fails on-ledger. Knowing that
      // at search time turns a wasted signature into a choice of a different seller.
      const payToTrustline = cheapest ? readTrustlinePreflight(cheapest.extra) : undefined;

      const hit: SearchHit = {
        resource: r.resource,
        type: r.type,
        price: cheapest
          ? {
              amount: cheapest.amount,
              asset: cheapest.asset,
              network: cheapest.network,
              scheme: cheapest.scheme,
              // Surface fee sponsorship so an agent knows the call is gasless before it commits — it
              // was being dropped with the rest of `extra` (B3). Reflects what the listing declares.
              feesSponsored: cheapest.extra?.["areFeesSponsored"] === true,
              ...(identity === undefined ? {} : { assetIdentity: identity }),
              ...(amountDecimal === undefined ? {} : { amountDecimal }),
              ...(payToTrustline === undefined ? {} : { payToTrustline }),
            }
          : undefined,
      };
      if (bazaar?.info?.input?.toolName) hit.toolName = bazaar.info.input.toolName;
      if (r.description) hit.description = r.description;
      if (r.serviceName) hit.serviceName = r.serviceName;
      if (r.tags) hit.tags = r.tags;
      if (bazaar?.info?.input?.inputSchema) hit.inputSchema = bazaar.info.input.inputSchema;
      if (r.quality) {
        hit.usage = { settlements: r.quality.totalSettlements, uniquePayers: r.quality.uniquePayers };
      }
      return hit;
    })
    // Price filtering happens here rather than being left to the agent: showing a resource an agent
    // cannot afford invites it to try, fail, and burn a round trip.
    .filter(hit => !args.maxPrice || !hit.price || BigInt(hit.price.amount) <= BigInt(args.maxPrice));

  // Hand the token back so the agent can cite it on pay_and_call. Present only if the Bazaar issued
  // one; a catalog that does not do signal collection simply omits it and nothing changes.
  return succeed({
    results,
    count: results.length,
    ...(payload.meta?.searchToken ? { searchToken: payload.meta.searchToken } : {}),
  });
}

export interface PayResult {
  status: number;
  body: unknown;
  paid: { amount: string; asset: string; network: string; transaction?: string } | undefined;
}

export async function payAndCall(
  config: McpConfig,
  args: {
    resource: string;
    method?: string | undefined;
    queryParams?: Record<string, string> | undefined;
    body?: unknown;
    maxAmount: string;
    network?: string | undefined;
    searchToken?: string | undefined;
    /** Part of an MCP resource's identity, so a conversion can be attributed to the right tool. */
    toolName?: string | undefined;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult<PayResult>> {
  if (!config.stellarSecret) {
    return fail("mcp_resource_not_payable", {
      reason: "This MCP server has no Stellar signer configured, so it cannot make paid calls.",
    });
  }

  // Decide where we are willing to send a request BEFORE sending one. The probe below is an
  // outbound fetch of a caller-supplied URL whose body is returned to the caller, so this check
  // has to come first or it is not a check at all.
  if (!isPayableResourceUrl(args.resource, config.allowPrivateHosts ?? false)) {
    return fail("mcp_resource_host_refused", {
      details: { resource: args.resource },
    });
  }

  // An operator ceiling always wins over an agent-supplied budget.
  let budget = args.maxAmount;
  if (config.maxAmountCeiling && BigInt(budget) > BigInt(config.maxAmountCeiling)) {
    budget = config.maxAmountCeiling;
  }

  const target = new URL(args.resource);
  for (const [k, v] of Object.entries(args.queryParams ?? {})) target.searchParams.set(k, v);

  // Step 1: unpaid probe, so an over-budget resource costs one HTTP request and zero money, and so
  // the agent is told the real price it declined.
  //
  // The probe is INFORMATIONAL, not the enforcement point. Its quote is not necessarily the quote
  // the payment will be made against — `paidFetch` below issues its own request and reads its own
  // 402. Treating this comparison as the guarantee is what let a two-faced server be quoted at
  // 1,000 here and paid 1,000,000,000 there. The guarantee lives in
  // `budgetSelector`, which runs immediately before anything is signed.
  let challenge: { accepts?: PricedOption[] } | undefined;
  try {
    const probe = await fetchImpl(target, { method: args.method ?? "GET" });
    if (probe.status === 402) {
      const header = probe.headers.get("PAYMENT-REQUIRED");
      if (header) {
        challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: PricedOption[] };
      }
    } else {
      // Not paywalled at all — return it without spending anything.
      return succeed({ status: probe.status, body: await safeBody(probe), paid: undefined });
    }
  } catch (error) {
    return fail("mcp_upstream_error", {
      reason: `Could not reach ${args.resource}: ${error instanceof Error ? error.message : "unknown error"}.`,
    });
  }

  if (!challenge?.accepts?.length) {
    return fail("mcp_resource_not_payable", {
      reason: `${args.resource} returned 402 but no usable payment requirements, so it cannot be paid.`,
    });
  }

  const { chosen, cheapestRejected } = selectPayable(challenge.accepts, budget, args.network);

  if (!chosen && cheapestRejected) {
    return fail("mcp_budget_exceeded", {
      reason: `This resource costs ${cheapestRejected.amount} atomic units of ${cheapestRejected.asset} on ${cheapestRejected.network}, which exceeds your maxAmount of ${budget}. No payment was made.`,
      details: {
        price: cheapestRejected.amount,
        asset: cheapestRejected.asset,
        network: cheapestRejected.network,
        maxAmount: budget,
      },
    });
  }
  if (!chosen) {
    return fail("mcp_resource_not_payable", {
      reason: `${args.resource} offers no payment option on a Stellar network${args.network ? ` matching ${args.network}` : ""}.`,
      details: { offered: challenge.accepts.map(a => a.network) },
    });
  }

  // Step 2: pay. The stock client performs the same discover -> sign -> retry loop a developer
  // would write by hand — but with a selector that re-applies the budget to whatever the server
  // quotes on THIS request, so the ceiling binds where the money actually moves.
  // Captured as the selector raises it. `wrapFetchWithPayment` rethrows a payload-creation failure
  // as a plain `Error` with the message concatenated and no `cause`, so the BudgetExceededError
  // does not survive that boundary in any recoverable form. Reconstructing it from the message —
  // which is what the fallback in `findBudgetError` does — loses both the refused price and the
  // real budget, and published `maxAmount: "the configured maximum"` into a numeric field.
  let refusal: BudgetExceededError | undefined;
  try {
    const signer = createEd25519Signer(config.stellarSecret, chosen.network as `${string}:${string}`);
    const client = new x402Client(
      budgetSelector(budget, args.network, r => {
        refusal = r;
      }) as ConstructorParameters<typeof x402Client>[0],
    );
    client.register("stellar:*", new ExactStellarScheme(signer));
    const paidFetch = wrapFetchWithPayment(fetchImpl, client);

    const response = await paidFetch(target, { method: args.method ?? "GET" });
    const settlementHeader = response.headers.get("PAYMENT-RESPONSE");
    let transaction: string | undefined;
    if (settlementHeader) {
      try {
        const decoded = JSON.parse(Buffer.from(settlementHeader, "base64").toString("utf8")) as {
          transaction?: string;
        };
        transaction = decoded.transaction;
      } catch {
        /* a missing settlement hash must not fail an otherwise successful call */
      }
    }

    if (!response.ok) {
      return fail("mcp_upstream_error", {
        reason: `Payment settled but the resource returned HTTP ${response.status}.`,
        details: { status: response.status, transaction },
      });
    }

    // Report the conversion — the payment already succeeded, so this is pure telemetry and is
    // fire-and-forget by design. A Bazaar that is down, slow, or has never heard of signal
    // collection must not turn a settled payment into a failed tool call.
    void reportConversion(config, args.searchToken, args.resource, args.toolName);

    return succeed({
      status: response.status,
      body: await safeBody(response),
      paid: {
        amount: chosen.amount,
        asset: chosen.asset,
        network: chosen.network,
        ...(transaction === undefined ? {} : { transaction }),
      },
    });
  } catch (error) {
    // The selector refused the price quoted on the paid request. Nothing was signed and nothing was
    // spent — report it as a budget refusal, not as an upstream fault, and name the real price.
    // `wrapFetchWithPayment` wraps the cause, so check the chain rather than just the top error.
    const budgetError = refusal ?? findBudgetError(error);
    if (budgetError) {
      return fail("mcp_budget_exceeded", {
        reason: `${budgetError.message} The price quoted when the payment was attempted differed from the price quoted on the unpaid probe. No payment was made.`,
        details: {
          ...(budgetError.cheapest
            ? {
                price: budgetError.cheapest.amount,
                asset: budgetError.cheapest.asset,
                network: budgetError.cheapest.network,
              }
            : {}),
          maxAmount: budgetError.budget,
          quotedOnProbe: chosen.amount,
        },
      });
    }
    return fail("mcp_upstream_error", {
      reason: `Payment failed: ${error instanceof Error ? error.message : "unknown error"}.`,
    });
  }
}

/** Walk an error's `cause` chain for the selector's refusal, which the fetch wrapper re-wraps. */
function findBudgetError(error: unknown, depth = 0): BudgetExceededError | undefined {
  if (depth > 5) return undefined;
  if (error instanceof BudgetExceededError) return error;
  if (error instanceof Error) {
    const nested = findBudgetError(error.cause, depth + 1);
    if (nested) return nested;
    // Some wrappers stringify rather than chain; fall back to the marker in the message.
    if (error.message.includes("exceeding the authorized maximum of")) {
      return new BudgetExceededError(undefined, "the configured maximum");
    }
  }
  return undefined;
}

/**
 * Tell the Bazaar which search led to this paid call.
 *
 * Swallows every error on purpose. The payment has already settled by the time this runs; letting
 * an analytics call surface as a failure would tell an agent its payment failed when it did not,
 * which is far worse than losing one data point.
 */
async function reportConversion(
  config: McpConfig,
  searchToken: string | undefined,
  resource: string,
  toolName: string | undefined,
): Promise<void> {
  if (!searchToken) return;
  try {
    await fetch(new URL("/discovery/conversion", config.bazaarUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ searchToken, resource, ...(toolName ? { toolName } : {}) }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* telemetry is never load-bearing */
  }
}

async function safeBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
