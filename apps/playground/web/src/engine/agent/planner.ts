/**
 * The scripted agent: the real rail402-mcp tools (`createTools`) over the page's buyer, driven by a
 * fixed plan instead of a language model. It always searches the Bazaar, picks the first result that
 * passes a stated rule (the demo seller's own tool, so no other seller can take over the demo's
 * payments), checks its budget, and pays the pick. Every tool call and result is reported as it
 * happens; the MCP traffic of the paid call shows up as the transport's own events.
 */
import type { ToolBuyer, ToolName } from "@rail402.dev/mcp/tools";
import { meetsTrust, untrustedReason, type SearchHit, type SearchPage } from "@rail402.dev/sdk/browser";
import { AGENT_PLANNER_LABEL, SCENARIO_DEFAULTS } from "../../../../src/shared/lab.ts";
import { codedError, layerOfCode, toJsonValue } from "../errors.ts";
import { DELIVERY_BODY_LIMIT, type DeliveryView, type ListingView, type Trust } from "../events.ts";
import {
  readBalance,
  reportBalance,
  reportTransaction,
  type Outcome,
  type RunContext,
} from "../scenarios/context.ts";

/** How the page labels this agent. */
export const PLANNER_LABEL = AGENT_PLANNER_LABEL;

/** The plan: what to search for, which tool to pick, and what to pay it with. */
export interface AgentPlan {
  readonly query: string;
  readonly type: "http" | "mcp";
  readonly maxPrice: { readonly amount: string; readonly asset: string };
  readonly toolName: string;
  readonly minimumTrust: Trust;
  readonly arguments: Readonly<Record<string, string | number>>;
  readonly spendingCap: { readonly amount: string; readonly asset: string };
  /** The host the pick must be served from: the demo seller's. */
  readonly sellerHost: string;
}

/** The pick rule, as the page shows it. */
export const PICK_RULE =
  "The first result that is callable, within the spending policy, at least origin-verified, offers the hourly_forecast tool and is served by the demo seller.";

/** The default plan with the run's cap, the configured asset and the demo seller. */
export function defaultPlan(
  cap: string,
  symbol: string,
  params: Readonly<Record<string, string | number>> | undefined,
  demoSellerUrl: string,
): AgentPlan {
  const defaults = SCENARIO_DEFAULTS.agent;
  const args: Record<string, string | number> = { ...defaults.arguments };
  for (const name of Object.keys(defaults.arguments)) {
    const value = params?.[name];
    if (typeof value === "string" || typeof value === "number") args[name] = value;
  }
  return {
    query: defaults.query,
    type: defaults.type,
    maxPrice: { amount: defaults.maxPrice.amount, asset: symbol },
    toolName: defaults.toolName,
    minimumTrust: defaults.minimumTrust,
    arguments: args,
    spendingCap: { amount: cap, asset: symbol },
    sellerHost: new URL(demoSellerUrl).hostname,
  };
}

/**
 * The pick: the first hit that is listed, callable, within policy, trusted enough, the right tool, and
 * served from the plan's seller host. Anyone can list a tool of the same name; only the demo seller's
 * is the demo.
 */
export function pickHit(hits: readonly SearchHit[], plan: AgentPlan): SearchHit | undefined {
  return hits.find(
    (hit) =>
      hit.listingId !== null &&
      hit.callable &&
      hit.withinPolicy &&
      meetsTrust(hit.trust, plan.minimumTrust) &&
      hit.toolName === plan.toolName &&
      hostOf(hit.resource) === plan.sellerHost,
  );
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export async function runAgent(context: RunContext, plan: AgentPlan): Promise<Outcome> {
  const { run, buyer } = context;
  let lastSearch: { readonly page: SearchPage; readonly views: readonly ListingView[] } | undefined;
  // The tools' search goes through the page's catalog, so the search is reported with its listings.
  const toolBuyer: ToolBuyer = {
    network: buyer.network,
    address: buyer.address,
    policy: buyer.policy,
    listing: (id, signal) => buyer.listing(id, signal),
    pay: (target, options) => buyer.pay(target, options),
    payListing: (listing, call, options) => buyer.payListing(listing, call, options),
    budget: () => buyer.budget(),
    reconcile: () => buyer.reconcile(),
    search: async (query, filters, signal) => {
      const found = await context.catalog.search(query, filters, signal);
      lastSearch = found;
      run.emit({
        kind: "bazaar",
        phase: "search",
        query,
        filters: toJsonValue(filters ?? {}) ?? {},
        count: found.views.length,
        method: found.page.method ?? null,
        partialResults: found.page.partialResults,
        top: found.views.slice(0, 10),
      });
      return found.page;
    },
  };
  const tools = context.tools(toolBuyer);
  const call = async (name: ToolName, args: Record<string, unknown>) => {
    run.emit({ kind: "tool", phase: "call", name, args: toJsonValue(args) ?? {} });
    const result = await tools.call(name, args, run.signal);
    run.emit({
      kind: "tool",
      phase: "result",
      name,
      isError: result.isError,
      result: toJsonValue(result.structuredContent) ?? {},
    });
    return result;
  };

  const searched = await call("search_stellar_resources", {
    query: plan.query,
    type: plan.type,
    maxPrice: plan.maxPrice,
  });
  if (searched.isError) return await toolFailure(context, searched.structuredContent);

  const pick = pickHit(lastSearch?.page.hits ?? [], plan);
  const view = lastSearch?.views.find((candidate) => candidate.id === pick?.listingId);
  if (pick?.listingId === null || pick === undefined || view === undefined) {
    const reason = `No search result passed the pick rule: ${PICK_RULE}`;
    run.emit({ kind: "refusal", layer: "playground", code: "listing_not_payable", reason });
    return { status: "refused", code: "listing_not_payable", reason };
  }
  run.emit({ kind: "bazaar", phase: "listing", listing: view });

  const budget = await call("get_budget", {});
  if (budget.isError) return await toolFailure(context, budget.structuredContent);

  const before = await readBalance(context);
  const paid = await call("pay_and_call", {
    listingId: pick.listingId,
    arguments: plan.arguments,
    spendingCap: plan.spendingCap,
    idempotencyKey: context.key,
  });
  if (paid.isError) {
    const outcome = await toolFailure(context, paid.structuredContent);
    await reportBalance(context, before);
    return outcome;
  }
  const payment = record(paid.structuredContent["payment"]);
  context.run.emit({ kind: "delivery", view: toolDelivery(paid.structuredContent, payment) });
  await reportTransaction(
    context,
    typeof payment["transaction"] === "string" ? payment["transaction"] : null,
  );
  await reportBalance(context, before);
  if (paid.structuredContent["paid"] !== true) {
    return { status: "info", reason: "The tool answered without asking for payment; nothing was paid." };
  }
  // As for every paid call: ok only once the chain proves the settlement.
  if (payment["status"] === "settled" && payment["verifiedOnChain"] === true) {
    return { status: "ok", reason: "The agent paid the tool and got its answer." };
  }
  return {
    status: "info",
    code: "payment_settlement_unconfirmed",
    reason:
      "The agent paid, but the settlement is not proven on chain yet; the hold stays in your budget until it is.",
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** What pay_and_call delivered, as a delivery view: the tool's result and the payment receipt. */
function toolDelivery(output: Record<string, unknown>, payment: Record<string, unknown>): DeliveryView {
  const response = record(output["response"]);
  const structured = response["structuredContent"];
  const content = Array.isArray(response["content"]) ? response["content"] : [];
  let body: string | null = null;
  if (structured !== undefined) {
    try {
      body = JSON.stringify(structured);
    } catch {
      body = null;
    }
  } else if (content.length > 0) {
    body = content
      .map((item) => {
        const text = record(item)["text"];
        return typeof text === "string" ? text : "";
      })
      .join("\n");
  }
  const truncated = response["truncated"] === true || (body !== null && body.length > DELIVERY_BODY_LIMIT);
  return {
    target: "mcp",
    status: null,
    isError: response["isError"] === true,
    contentType: structured === undefined ? (body === null ? null : "text/plain") : "application/json",
    // The tool's output is untrusted seller text: bounded, with secrets and control characters removed.
    body: body === null || body === "" ? null : untrustedReason(body, DELIVERY_BODY_LIMIT),
    truncated,
    receipt: receiptOf(payment),
  };
}

/** A tool output's receipt as the page's receipt view; null when it carries none. */
function receiptOf(payment: Record<string, unknown>): DeliveryView["receipt"] {
  const status = payment["status"];
  const scheme = payment["scheme"];
  if ((status !== "settled" && status !== "unknown") || (scheme !== "exact" && scheme !== "upto"))
    return null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    status,
    scheme,
    transaction: text(payment["transaction"]),
    settled: text(record(payment["settled"])["atomic"]),
    payTo: text(payment["payTo"]) ?? "",
    payer: text(payment["payer"]) ?? "",
    verifiedOnChain: payment["verifiedOnChain"] === true,
  };
}

/**
 * A tool's error result, reported as a refusal at the layer its code belongs to, with what it says
 * about the money (`paid`). A payment that left before the call failed has its receipt reported as
 * the delivery and its transaction read from the chain.
 */
async function toolFailure(context: RunContext, output: Record<string, unknown>): Promise<Outcome> {
  const error = record(output["error"]);
  const fallback = codedError(undefined);
  const code = typeof error["code"] === "string" ? error["code"] : fallback.code;
  const reason =
    typeof error["reason"] === "string" && error["reason"] !== "" ? error["reason"] : fallback.reason;
  const paid = error["paid"];
  const rawDetails = record(error["details"]);
  const details = toJsonValue({
    ...rawDetails,
    ...(typeof paid === "string" ? { paid } : {}),
  });
  const upstream = record(rawDetails["upstream"]);
  const upstreamCode = upstream["code"];
  context.run.emit({
    kind: "refusal",
    layer: layerOfCode(code, typeof upstreamCode === "string" ? upstreamCode : undefined),
    code,
    reason,
    ...(details === undefined ? {} : { details }),
  });
  const receipt = receiptOf(record(rawDetails["receipt"]));
  if (receipt !== null) {
    context.run.emit({
      kind: "delivery",
      view: {
        target: "mcp",
        status: null,
        isError: true,
        contentType: null,
        body: null,
        truncated: false,
        receipt,
      },
    });
    await reportTransaction(context, receipt.transaction);
  }
  return {
    status: paid === "none" || paid === "not_settled" || paid === undefined ? "refused" : "error",
    code,
    reason,
  };
}
