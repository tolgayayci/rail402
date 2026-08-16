import { X402Error } from "@rail402.dev/errors";
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
import { startPublicHostProxy, type HostProxy } from "./host-proxy.js";

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
/**
 * Synthetic public hostname the public-seller variant declares. A documentation domain (RFC 2606),
 * so it is unmistakably a test identity, yet a legitimately public hostname the host-policy accepts.
 * The seller is still served on loopback behind ./host-proxy.ts — only the declared identity is public.
 */
const PUBLIC_SELLER_HOST = "canary-seller.example.com";
const INDEXING_DEADLINE_MS = 30_000;
const INDEXING_POLL_MS = 250;
/** How deep in the ranked results the resource may sit before we call retrieval broken. */
const RANK_CEILING = 10;

export interface DiscoveryLoopOptions {
  readonly facilitatorUrl: string;
  readonly runId: string;
  readonly log?: (line: string) => void;
  /**
   * Front the stock localhost seller with a public hostname (a cloudflared quick tunnel) so a
   * DEPLOYED facilitator will catalog it. Off by default: a production instance soft-drops loopback
   * `resource.url`s, so the plain loop only proves cataloging against a facilitator started with
   * `BAZAAR_ALLOW_PRIVATE_HOSTS=1`. Needs the `cloudflared` binary; see ./tunnel.ts.
   */
  readonly publicSeller?: boolean;
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
  let proxy: HostProxy | undefined;

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

    // The URL the buyer will fetch. In public mode it goes through a local Host-rewriting proxy so
    // the stock seller declares a PUBLIC resource identity (see ./host-proxy.ts) that a production
    // facilitator will catalog — the seller itself is unchanged, still bound to loopback.
    let buyerUrl = seller.resourceUrl;
    if (options.publicSeller) {
      const sellerPort = Number(new URL(seller.resourceUrl).port);
      const fronted = await run.step("public-host", async () => {
        const p = await startPublicHostProxy(sellerPort, PUBLIC_SELLER_HOST);
        // Keep the seller's own path and query; only route the buyer through the proxy in front of it.
        const href = new URL(seller!.resourceUrl);
        const via = new URL(p.url);
        href.protocol = via.protocol;
        href.host = via.host;
        return {
          detail: `${PUBLIC_SELLER_HOST} → 127.0.0.1:${sellerPort}`,
          p,
          href: href.toString(),
        };
      });
      proxy = fronted.p;
      buyerUrl = fronted.href;
    }

    // `@x402/core` + `@x402/stellar` as published — the buyer is stock all the way down.
    const buyer = stockBuyer(fixtures.f.buyer.secret());

    const payment = await run.step("payload-built", async () => {
      const built = await buyer.pay(buyerUrl);
      if (!built.payload.extensions?.["bazaar"]) {
        throw new X402Error("canary_setup_failed", {
          reason:
            "The stock client produced a payment payload with no bazaar extension, so nothing would be cataloged. The seller's declaration did not reach the payload.",
        });
      }
      return { detail: "stock client, discovery extension present", ...built };
    });

    // The key the facilitator will actually catalog is the resource URL in the requirements it just
    // returned — origin + path, no query. In localhost mode that equals seller.catalogKey exactly; in
    // public mode it is the tunnel-derived public URL, and deriving it from the payload keeps the
    // assertions in lockstep with whatever scheme the seller chose behind the tunnel instead of
    // guessing. Localhost mode stays byte-identical by keeping seller.catalogKey there.
    // The facilitator catalogs `paymentPayload.resource.url` (apps/bazaar/src/app.ts) — the resource
    // the seller declared in its 402 and the stock client echoed back — as origin + path.
    const declaredResourceUrl = (payment.payload as { resource?: { url?: string } }).resource?.url;
    const catalogKey = options.publicSeller
      ? catalogKeyFromResource(declaredResourceUrl, seller.catalogKey)
      : seller.catalogKey;

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
      ).find(r => r.resource === catalogKey);
      if (!found) {
        throw new X402Error("canary_resource_not_indexed", {
          reason: `${catalogKey} verified but did not appear provisionally in GET /discovery/resources before settlement (hybrid cataloging).`,
          details: { resource: catalogKey, phase: "post-verify-pre-settle" },
        });
      }
      // Provisional entries must not carry a settlement signal yet — settlement is what earns rank.
      const settlements = found.quality?.totalSettlements ?? 0;
      if (settlements !== 0) {
        throw new X402Error("canary_resource_not_indexed", {
          reason: `The provisional listing already shows ${settlements} settlement(s) before settling — a verify-time entry must carry zero ranking signal.`,
          details: { resource: catalogKey, totalSettlements: settlements },
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
        ).find(r => r.resource === catalogKey);

        if (found) {
          const lagMs = Date.now() - settled.settledAt;
          run.observe("indexingLagMs", lagMs);
          run.observe("indexingPolls", polls);
          return { detail: `appeared after ${lagMs}ms (${polls} poll(s))`, found };
        }
        if (Date.now() >= deadline) {
          throw new X402Error("canary_resource_not_indexed", {
            reason: `${catalogKey} settled successfully but never appeared in GET /discovery/resources within ${INDEXING_DEADLINE_MS}ms.`,
            details: { resource: catalogKey, deadlineMs: INDEXING_DEADLINE_MS, polls },
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
      const rank = results.findIndex(r => r.resource === catalogKey) + 1;
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

    run.observe("resource", catalogKey);
    return run.finish();
  } catch (error) {
    run.observe("resource", seller?.catalogKey ?? null);
    return run.finish(error);
  } finally {
    await proxy?.close();
    await seller?.close();
  }
}

/** Origin + path of the resource URL the payload declared — the exact key the facilitator catalogs. */
function catalogKeyFromResource(resource: string | undefined, fallback: string): string {
  if (!resource) return fallback;
  try {
    const url = new URL(resource);
    return `${url.origin}${url.pathname}`;
  } catch {
    return fallback;
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
