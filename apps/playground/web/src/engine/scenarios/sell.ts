/**
 * Sell and get listed: the page buys from the Playground's sandbox seller (which stands in for the
 * visitor's own API), the seller settles with the Bazaar extension, and Rail402 catalogs the route.
 * The run then reads the listing, its origin check (first-hand when this payment created or changed
 * the listing: polled until a check newer than the payment's catalog version is recorded and the
 * listing is out of `pending`), and finds it with a natural-language search. Like every paid run, it
 * ends ok only once the chain proves the payment.
 */
import { LAB_PATHS, SCENARIO_DEFAULTS, sellPath } from "../../../../src/shared/lab.ts";
import type { LabEvent, ListingView, SellerTraceView, VersionView } from "../events.ts";
import { outcomeOf, payHttp, type Outcome, type RunContext } from "./context.ts";

/** How often, and how long, a new listing's origin check is polled. */
export const ORIGIN_POLL_MS = 2_000;
export const ORIGIN_POLL_LIMIT_MS = 120_000;

/** The bazaar part of the last seller trace this run received. */
export function lastBazaarTrace(events: readonly LabEvent[]): SellerTraceView["bazaar"] | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.kind === "http" && event.phase === "response" && event.trace?.bazaar !== undefined) {
      return event.trace.bazaar;
    }
  }
  return undefined;
}

export async function runSell(
  context: RunContext,
  params?: Readonly<Record<string, string | number>>,
): Promise<Outcome> {
  const { config, run, catalog } = context;
  if (!config.lab.enabled || config.lab.payTo === null) {
    return {
      status: "refused",
      code: "playground_feature_disabled",
      reason: "The lab sellers are turned off on this Playground.",
    };
  }
  const city =
    typeof params?.["city"] === "string" ? params["city"].slice(0, 64) : SCENARIO_DEFAULTS.sell.city;
  const paid = await payHttp(context, new URL(sellPath(city), config.urls.public).href);
  if (!paid.ok) return outcomeOf(paid.error);

  const trace = lastBazaarTrace(run.events);
  if (trace?.status === "rejected") {
    // Paid, but the Bazaar will not list the route (a loopback PUBLIC_URL against a hosted Bazaar,
    // for one): waiting would not help, so the run ends on the catalog's own code and reason.
    return {
      status: "refused",
      code: trace.code,
      reason: `Paid, but the Bazaar refused to list this route: ${trace.reason ?? trace.code}`,
    };
  }
  const template = new URL(LAB_PATHS.sell, config.urls.public).href;
  let listingId = trace?.listingId;
  if (listingId === undefined) {
    const listed = await catalog.list({ payTo: config.lab.payTo, type: "http" }, run.signal);
    listingId = listed.views.find((view) => view.resource === template)?.id;
  }
  if (listingId === undefined) {
    return {
      status: "info",
      ...(trace === undefined ? {} : { code: trace.code }),
      reason: "Paid; the Bazaar has not listed the route yet.",
    };
  }

  let listing = (await catalog.listing(listingId, run.signal)).view;
  run.emit({ kind: "bazaar", phase: "listing", listing });
  let versions = await catalog.versions(listingId, run.signal);
  // A payment that created or changed the listing starts a new origin check: wait for it first-hand.
  // A changed listing stays published meanwhile, so the wait is for the check itself.
  const firstHand = trace !== undefined && trace.code !== "recorded";
  if (firstHand) {
    const since = trace.version ?? 0;
    for (
      let waited = 0;
      (listing.state === "pending" || !checkedSince(versions, since)) && waited < ORIGIN_POLL_LIMIT_MS;
      waited += ORIGIN_POLL_MS
    ) {
      await context.sleep(ORIGIN_POLL_MS);
      if (run.signal.aborted) throw run.signal.reason;
      listing = (await catalog.listing(listingId, run.signal)).view;
      versions = await catalog.versions(listingId, run.signal);
    }
    run.emit({ kind: "bazaar", phase: "listing", listing });
  }
  run.emit({ kind: "bazaar", phase: "versions", listingId, versions });

  const query = SCENARIO_DEFAULTS.sell.searchQuery;
  const filters = { type: "http" as const };
  const found = await catalog.search(query, filters, run.signal);
  run.emit({
    kind: "bazaar",
    phase: "search",
    query,
    filters,
    count: found.views.length,
    method: found.page.method ?? null,
    partialResults: found.page.partialResults,
    top: found.views.slice(0, 10),
  });
  const ranked: ListingView | undefined = found.views.find((view) => view.id === listingId);
  const payment = paid.result.payment;
  if (paid.result.paid && (payment?.status !== "settled" || !payment.verifiedOnChain)) {
    return {
      status: "info",
      code: "payment_settlement_unconfirmed",
      reason: `Cataloged (${listing.state ?? "not published"}), but the payment is not proven on chain yet; the hold stays in your budget until it is.`,
    };
  }
  if (listing.state !== "published") {
    return {
      status: "info",
      reason: `Paid and cataloged; the listing is ${listing.state ?? "not published"} for now.`,
    };
  }
  return {
    status: "ok",
    reason:
      ranked === undefined
        ? `Listed · ${listing.trust}; search did not return it this time.`
        : `Listed · ${listing.trust}; search ranks it #${String(ranked.rank ?? 0)}.`,
  };
}

/** Whether an origin check newer than catalog version `since` is in a listing's history. */
function checkedSince(versions: readonly VersionView[], since: number): boolean {
  return versions.some((version) => version.cause === "origin_verification" && version.version > since);
}
