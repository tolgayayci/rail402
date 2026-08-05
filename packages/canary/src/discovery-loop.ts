import { X402Error } from "@x402-stellar/errors";
import { CanaryRun, type CanaryReport } from "./report.js";
import { callFacilitator, decodeExtensionResponses, reasonOf, stockBuyer } from "./payment.js";
import { requireBazaarFacilitator } from "./supported.js";
import {
  KNOWN_QUERY,
  PARAMETER_DESCRIPTION,
  startSyntheticSeller,
  type SyntheticSeller,
} from "./seller.js";
import { NETWORK, prepareFixtures, sleep } from "./testnet.js";

/**
 * C-2 — the discovery-loop canary.
 *
 * One property, end to end, re-proven on a live network: **a seller who does nothing but declare
 * discovery metadata becomes findable by an agent that has never heard of them.** Concretely, after
 * a real settled testnet payment carrying the discovery extension:
 *
 *   1. the facilitator reported the cataloging outcome in `EXTENSION-RESPONSES`;
 *   2. the resource appears in `GET /discovery/resources`;
 *   3. the seller's per-parameter descriptions survived cataloging;
 *   4. the resource ranks for a natural-language query that shares no token with its URL.
 *
 * Unit tests cannot cover this. Every one of those four steps can pass in isolation while the loop
 * is broken — cataloging silently no-ops on a double-wrapped extension, the retriever indexes
 * `info.input` and drops every description, a refactor moves ingest behind a queue that never
 * drains. Each failure leaves browse working and the test suite green.
 *
 * We also publish **indexing lag** (settlement → first appearance), which is the number that turns
 * "discovery works" from a claim into a measurement. Cataloging is settlement-gated and in-process,
 * so the honest expectation is single-digit milliseconds; the value of publishing it is that the
 * day it is not, everyone can see.
 */

const AMOUNT = "2500000"; // 0.25 units at 7 decimals — atomic units, never a float.
const INDEXING_DEADLINE_MS = 30_000;
const INDEXING_POLL_MS = 250;
/** How deep in the ranked results the resource may sit before we call retrieval broken. */
const RANK_CEILING = 10;

export interface DiscoveryLoopOptions {
  readonly facilitatorUrl: string;
  readonly runId: string;
  readonly log?: (line: string) => void;
}

interface DiscoveryResource {
  resource: string;
  description?: string;
  extensions?: Record<string, unknown>;
  quality?: { totalSettlements: number; uniquePayers: number };
}

export async function runDiscoveryLoop(options: DiscoveryLoopOptions): Promise<CanaryReport> {
  const run = new CanaryRun(
    "discovery-loop",
    NETWORK,
    options.facilitatorUrl,
    options.log ?? (line => console.error(line)),
  );
  let seller: SyntheticSeller | undefined;

  try {
    // ── Is there anything to test? ──────────────────────────────────────────
    // First, because the stock resource server synchronises with the facilitator the moment the
    // middleware is created, and that sync is a floating promise: against a dead facilitator it
    // rejects outside every try/catch and takes the process down with a stack trace instead of a
    // coded report. Checking here turns "unreachable" into a named failure, which is also the more
    // useful diagnosis — a canary that cannot reach its target has proven nothing either way.
    await run.step("facilitator-reachable", async () => {
      const extensions = await requireBazaarFacilitator(options.facilitatorUrl);
      return { detail: `/supported advertises ${extensions.join(", ")}` };
    });

    // ── Fixtures ────────────────────────────────────────────────────────────
    const fixtures = await run.step("testnet-fixtures", async () => {
      const f = await prepareFixtures(assetCodeFor(options.runId));
      return { detail: `asset ${f.assetCode} · buyer ${short(f.buyer.publicKey())}`, f };
    });

    seller = (
      await run.step("seller-online", async () => {
        const s = await startSyntheticSeller({
          facilitatorUrl: options.facilitatorUrl,
          network: NETWORK,
          payTo: fixtures.f.seller.publicKey(),
          asset: fixtures.f.assetContractId,
          amount: AMOUNT,
          runId: options.runId,
        });
        return { detail: s.catalogKey, s };
      })
    ).s;

    // `@x402/core` + `@x402/stellar` as published — the buyer is stock all the way down.
    const buyer = stockBuyer(fixtures.f.buyer.secret());

    const payment = await run.step("payload-built", async () => {
      const built = await buyer.pay(seller!.resourceUrl);
      if (!built.payload.extensions?.["bazaar"]) {
        throw new X402Error("canary_setup_failed", {
          reason:
            "The stock client produced a payment payload with no bazaar extension, so nothing would be cataloged. The seller's declaration did not reach the payload.",
        });
      }
      return { detail: "stock client, discovery extension present", ...built };
    });

    // ── verify / settle ─────────────────────────────────────────────────────
    await run.step("verify", async () => {
      const { body } = await callFacilitator(
        options.facilitatorUrl,
        "/verify",
        payment.payload,
        payment.accepted,
      );
      if (body["isValid"] !== true) {
        throw new X402Error("canary_settlement_failed", {
          reason: `Verification rejected the canary's own payment: ${reasonOf(body)}`,
          details: { response: body },
        });
      }
      return { detail: "isValid: true" };
    });

    // Hybrid cataloging: after VERIFY — and before any settlement — the resource must
    // ALREADY be discoverable, provisionally. Before the hybrid trigger it appeared only after settle,
    // so this step is what proves the verify-time half on a live network rather than only in a unit
    // test. A provisional listing carries no rank and no ownership; settlement below confirms it.
    await run.step("provisional-at-verify", async () => {
      const found = (
        await listResources(options.facilitatorUrl, {
          payTo: fixtures.f.seller.publicKey(),
          network: NETWORK,
          type: "http",
        })
      ).find(r => r.resource === seller!.catalogKey);
      if (!found) {
        throw new X402Error("canary_resource_not_indexed", {
          reason: `${seller!.catalogKey} verified but did not appear provisionally in GET /discovery/resources before settlement (hybrid cataloging).`,
          details: { resource: seller!.catalogKey, phase: "post-verify-pre-settle" },
        });
      }
      // Provisional entries must not carry a settlement signal yet — settlement is what earns rank.
      const settlements = found.quality?.totalSettlements ?? 0;
      if (settlements !== 0) {
        throw new X402Error("canary_resource_not_indexed", {
          reason: `The provisional listing already shows ${settlements} settlement(s) before settling — a verify-time entry must carry zero ranking signal.`,
          details: { resource: seller!.catalogKey, totalSettlements: settlements },
        });
      }
      return { detail: "discoverable provisionally after verify, before settle (0 signals)" };
    });

    const settled = await run.step("settle", async () => {
      const { body, headers } = await callFacilitator(
        options.facilitatorUrl,
        "/settle",
        payment.payload,
        payment.accepted,
      );
      // Stamp the clock the instant the settle response lands: indexing lag is measured from here,
      // so anything counted before this point would flatter the number.
      const settledAt = Date.now();
      if (body["success"] !== true) {
        throw new X402Error("canary_settlement_failed", {
          reason: `Settlement failed: ${reasonOf(body)}`,
          details: { response: body },
        });
      }
      const transaction = typeof body["transaction"] === "string" ? body["transaction"] : "";
      run.observe("transaction", transaction);
      run.observe("amount", AMOUNT);
      run.observe("asset", fixtures.f.assetContractId);
      return {
        detail: `tx ${short(transaction)}`,
        settledAt,
        extensionResponses: headers.get("extension-responses"),
      };
    });

    // ── The four assertions ─────────────────────────────────────────────────
    await run.step("cataloging-reported", async () => {
      const verdict = decodeExtensionResponses(settled.extensionResponses);
      if (verdict?.status !== "success") {
        throw new X402Error("canary_extension_response_missing", {
          reason: verdict
            ? `The facilitator reported cataloging as "${verdict.status}"${verdict.rejectedReason ? `: ${verdict.rejectedReason}` : ""}.`
            : "The settle response carried no readable EXTENSION-RESPONSES header, so a seller has no way to tell whether their listing landed.",
          ...(verdict === undefined ? {} : { details: { verdict } }),
        });
      }
      run.observe("extensionResponses", verdict);
      return { detail: 'bazaar status "success"' };
    });

    const indexed = await run.step("indexed", async () => {
      const deadline = settled.settledAt + INDEXING_DEADLINE_MS;
      let polls = 0;
      for (;;) {
        polls += 1;
        // Filter by payTo: it narrows the poll to this run's listing on a shared catalog, and it
        // exercises one of the seven spec filters on live data at the same time.
        const found = (
          await listResources(options.facilitatorUrl, {
            payTo: fixtures.f.seller.publicKey(),
            network: NETWORK,
            type: "http",
          })
        ).find(r => r.resource === seller!.catalogKey);

        if (found) {
          const lagMs = Date.now() - settled.settledAt;
          run.observe("indexingLagMs", lagMs);
          run.observe("indexingPolls", polls);
          return { detail: `appeared after ${lagMs}ms (${polls} poll(s))`, found };
        }
        if (Date.now() >= deadline) {
          throw new X402Error("canary_resource_not_indexed", {
            reason: `${seller!.catalogKey} settled successfully but never appeared in GET /discovery/resources within ${INDEXING_DEADLINE_MS}ms.`,
            details: { resource: seller!.catalogKey, deadlineMs: INDEXING_DEADLINE_MS, polls },
          });
        }
        await sleep(INDEXING_POLL_MS);
      }
    });

    await run.step("parameter-descriptions", async () => {
      if (!JSON.stringify(indexed.found.extensions ?? {}).includes(PARAMETER_DESCRIPTION)) {
        throw new X402Error("canary_parameter_descriptions_lost", {
          reason:
            "The cataloged listing does not carry the seller's per-parameter description, so an agent reading the catalog cannot tell what the endpoint's parameters mean.",
          details: { resource: indexed.found.resource, expected: PARAMETER_DESCRIPTION },
        });
      }
      return { detail: "seller's parameter prose survived cataloging" };
    });

    await run.step("ranked", async () => {
      const results = await searchResources(options.facilitatorUrl, KNOWN_QUERY);
      const rank = results.findIndex(r => r.resource === seller!.catalogKey) + 1;
      if (rank === 0 || rank > RANK_CEILING) {
        throw new X402Error("canary_resource_not_ranked", {
          reason:
            rank === 0
              ? `A natural-language search for "${KNOWN_QUERY}" returned ${results.length} result(s), none of them the resource just cataloged.`
              : `The resource ranked ${rank} for "${KNOWN_QUERY}", below the ceiling of ${RANK_CEILING}.`,
          details: { query: KNOWN_QUERY, rank, resultCount: results.length },
        });
      }
      run.observe("searchQuery", KNOWN_QUERY);
      run.observe("searchRank", rank);
      run.observe("searchResultCount", results.length);
      return { detail: `rank ${rank} of ${results.length} for "${KNOWN_QUERY}"` };
    });

    run.observe("resource", seller.catalogKey);
    return run.finish();
  } catch (error) {
    run.observe("resource", seller?.catalogKey ?? null);
    return run.finish(error);
  } finally {
    await seller?.close();
  }
}

async function listResources(
  base: string,
  filters: Record<string, string>,
): Promise<DiscoveryResource[]> {
  const url = new URL("/discovery/resources", base);
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
  const response = await fetch(url);
  const body = (await response.json()) as { items?: DiscoveryResource[] };
  // `items` on list, `resources` on search. The asymmetry is real and load-bearing — reading the
  // wrong key here would make a working catalog look empty.
  return body.items ?? [];
}

async function searchResources(base: string, query: string): Promise<DiscoveryResource[]> {
  const url = new URL("/discovery/search", base);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", String(RANK_CEILING));
  const response = await fetch(url);
  const body = (await response.json()) as { resources?: DiscoveryResource[] };
  return body.resources ?? [];
}

/**
 * Derive a valid Stellar asset code from the run id.
 *
 * Codes are 1–12 alphanumerics; a run id is a timestamp-ish slug that would otherwise be rejected
 * by the SDK with an error about the *asset*, sending anyone debugging it in the wrong direction.
 */
export function assetCodeFor(runId: string): string {
  const suffix = runId.replace(/[^a-zA-Z0-9]/g, "").slice(-6).toUpperCase() || "0";
  return `CNRY${suffix}`.slice(0, 12);
}

function short(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}
