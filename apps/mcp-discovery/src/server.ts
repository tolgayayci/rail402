import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { UptoStellarClientScheme } from "@rail402/scheme-upto-stellar";
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
  NO_REDIRECT,
  priceable,
  byAmountAscending,
  parseAmount,
  withinBudget,
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
import { callMcpTool } from "./mcp-call.js";

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
      // Soft-drop options this agent cannot price before sorting them. Catalog rows are
      // attacker-influenceable — the server is designed to point at arbitrary and federated
      // catalogs — and an unguarded `BigInt("NaN")` in a comparator escapes as a bare V8 message
      // with no code and no envelope, which is the one thing this tool must never do.
      const stellar = priceable(r.accepts).filter(a => a.network.startsWith("stellar:"));
      const cheapest = [...stellar].sort(byAmountAscending)[0];
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
    .filter(hit => !args.maxPrice || !hit.price || withinBudget(hit.price.amount, args.maxPrice));

  // Hand the token back so the agent can cite it on pay_and_call. Present only if the Bazaar issued
  // one; a catalog that does not do signal collection simply omits it and nothing changes.
  return succeed({
    results,
    count: results.length,
    ...(payload.meta?.searchToken ? { searchToken: payload.meta.searchToken } : {}),
  });
}

export interface PayResult {
  transport: "http" | "mcp";
  /** HTTP only. An MCP tool call has no HTTP status, and inventing one would be a field to mislead on. */
  status?: number;
  body: unknown;
  toolName?: string;
  isError?: boolean;
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
    /**
     * Part of an MCP resource's identity — and now also the switch that decides the transport.
     * Present: this is an MCP tool call. Absent: an HTTP request.
     */
    toolName?: string | undefined;
    toolArguments?: Record<string, unknown> | undefined;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ToolResult<PayResult>> {
  if (!config.stellarSecret) {
    return fail("mcp_resource_not_payable", {
      reason: "This MCP server has no Stellar signer configured, so it cannot make paid calls.",
    });
  }

  // An operator ceiling always wins over an agent-supplied budget. Resolved before the transport
  // branch so both paths are governed by the same number.
  let budget = args.maxAmount;
  if (config.maxAmountCeiling !== undefined) {
    // A malformed operator ceiling must fail closed and legibly, not throw a bare SyntaxError on
    // every paid call. `MAX_AMOUNT_CEILING` is read straight from the environment (`index.ts`), so
    // a typo here is a configuration mistake, not an attack — and it should read like one.
    const ceiling = parseAmount(config.maxAmountCeiling);
    if (ceiling === undefined) {
      return fail("mcp_resource_not_payable", {
        reason: `This MCP server's configured spend ceiling (${JSON.stringify(config.maxAmountCeiling)}) is not an integer number of atomic units, so no payment can be safely bounded. Nothing was called and nothing was paid.`,
        details: { maxAmountCeiling: config.maxAmountCeiling },
      });
    }
    const requested = parseAmount(budget);
    if (requested === undefined || requested > ceiling) budget = config.maxAmountCeiling;
  }

  // ── MCP tool call ─────────────────────────────────────────────────────────
  if (args.toolName) {
    // HTTP-shaped arguments alongside an MCP tool call are a mistake worth surfacing rather than
    // silently dropping: an agent that thinks it passed a query parameter and did not gets a
    // successful call with the wrong inputs, and pays for it.
    if (args.queryParams || args.body !== undefined) {
      return fail("invalid_payload", {
        reason:
          "queryParams and body are HTTP-only. An MCP tool call takes its inputs from toolArguments, matching the tool's published inputSchema. Nothing was called and nothing was paid.",
        details: { toolName: args.toolName },
      });
    }
    const result = await callMcpTool({
      resource: args.resource,
      toolName: args.toolName,
      toolArguments: args.toolArguments,
      budget,
      network: args.network,
      stellarSecret: config.stellarSecret,
      allowPrivateHosts: config.allowPrivateHosts ?? false,
    });
    // Attribute the conversion only when money actually moved, exactly as on the HTTP path — and
    // only after it did, so a Bazaar that is down cannot turn a settled payment into a failed call.
    if (result.ok && result.data?.paid) {
      void reportConversion(config, args.searchToken, args.resource, args.toolName);
    }
    return result as ToolResult<PayResult>;
  }

  // Decide where we are willing to send a request BEFORE sending one. The probe below is an
  // outbound fetch of a caller-supplied URL whose body is returned to the caller, so this check
  // has to come first or it is not a check at all.
  if (!isPayableResourceUrl(args.resource, config.allowPrivateHosts ?? false)) {
    return fail("mcp_resource_host_refused", {
      details: { resource: args.resource },
    });
  }

  const target = new URL(args.resource);
  for (const [k, v] of Object.entries(args.queryParams ?? {})) target.searchParams.set(k, v);

  const method = args.method ?? "GET";
  if (args.body !== undefined && (method === "GET" || method === "HEAD")) {
    return fail("invalid_payload", {
      reason: `A ${method} request cannot carry a body. Either drop \`body\` or use POST, PUT or PATCH. Nothing was called and nothing was paid.`,
      details: { method },
    });
  }

  // ONE request init, shared by the probe and the paid call.
  //
  // Built once on purpose. The two requests must be the same request — a probe that omits the body
  // can be priced differently, or answered differently, from the call that is actually paid for, and
  // an agent would have no way to see the divergence. `body` was previously declared on the input
  // schema and then never sent at all, so a POST was paid for and delivered empty.
  const init: RequestInit =
    args.body === undefined
      ? { method, ...NO_REDIRECT }
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args.body),
          ...NO_REDIRECT,
        };

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
    const probe = await fetchImpl(target, init);
    if (probe.status === 402) {
      const header = probe.headers.get("PAYMENT-REQUIRED");
      if (header) {
        challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: PricedOption[] };
      }
    } else {
      // Not paywalled at all — return it without spending anything.
      return succeed({ transport: "http", status: probe.status, body: await safeBody(probe), paid: undefined });
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
    // Register `upto` too, so an agent can pay an `upto` resource it discovered.
    client.register("stellar:*", new UptoStellarClientScheme(signer));
    const paidFetch = wrapFetchWithPayment(fetchImpl, client);

    const response = await paidFetch(target, init);
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
      // NOT `mcp_upstream_error`. That code is retryable, and money has already moved — the
      // settlement hash below proves it. Telling an agent to retry here buys the same resource a
      // second time. This is the classic trap (a retryable code on a non-retryable condition) recurring
      // on the surface where acting on the advice costs money rather than a round trip.
      return fail("mcp_paid_but_resource_failed", {
        reason: `Payment SETTLED (transaction ${transaction ?? "unknown"}) but the resource then returned HTTP ${response.status}. Do not retry: a retry pays again. Contact the seller with this transaction hash.`,
        details: { status: response.status, ...(transaction === undefined ? {} : { transaction }) },
      });
    }

    // Report the conversion — the payment already succeeded, so this is pure telemetry and is
    // fire-and-forget by design. A Bazaar that is down, slow, or has never heard of signal
    // collection must not turn a settled payment into a failed tool call.
    void reportConversion(config, args.searchToken, args.resource, args.toolName);

    return succeed({
      transport: "http",
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
    // Deliberately NO message-marker fallback here any more.
    //
    // It used to reconstruct `new BudgetExceededError(undefined, "the configured maximum")` — which
    // is the placeholder-string defect preserved verbatim: a sentence published into a numeric
    // `details.maxAmount` that `BigInt()` throws on, with the refused price lost. It was unreachable
    // (the `onRefusal` closure fires first and is preferred at the call site) but it was live code
    // that would republish the bug the moment the closure path changed. A refusal we cannot describe
    // accurately is better reported as an upstream failure than as a budget refusal with fabricated
    // numbers in it.
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
