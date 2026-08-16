import { X402Error } from "@rail402.dev/errors";
import { CanaryRun, type CanaryReport } from "./report.js";
import { callFacilitator, decodeExtensionResponses, reasonOf, stockBuyer } from "./payment.js";
import { requireBazaarFacilitator } from "./supported.js";
import { KNOWN_QUERY, startSyntheticSeller, type SyntheticSeller } from "./seller.js";
import { NETWORK, prepareFixtures, sleep } from "./testnet.js";
import { assetCodeFor } from "./discovery-loop.js";

/**
 * The docs-to-discoverable DX measurement.
 *
 * > "docs → paid, discoverable endpoint appearing in the Bazaar in well under an hour. Maintain a
 * > scripted walkthrough that measures this; treat regressions as bugs."
 *
 * So: measure it, per phase, on a live network, and publish the number. The discovery-loop canary
 * asserts the same path is *correct*; this one asserts it is *fast*, and records where the time
 * goes so a regression names its own phase.
 *
 * ## What this honestly does and does not measure
 *
 * **Measures:** wall-clock for every step between deciding to sell something and being findable —
 * account setup, asset issuance, trustlines, starting a paywalled endpoint, the first settled
 * payment, cataloging, and appearing in natural-language search.
 *
 * **Does not measure:** a human reading documentation and typing code. That is unmeasurable from a
 * script, and quoting a machine time as if it were the developer's time would be exactly the kind
 * of overclaim this project keeps catching in others. What stands in for it is `SELLER_SURFACE`
 * below — the actual integration cost, counted in things a person must write and do.
 *
 * The honest headline is therefore: **machine time, plus a declared and countable integration
 * surface.** Both are reported; neither is dressed up as the other.
 */

const AMOUNT = "2500000";

/**
 * The seller's real integration cost, counted rather than asserted.
 *
 * Every number here is checked against the working example in CI (`dx.test.ts`), so this cannot
 * quietly become marketing while the code grows.
 */
export const SELLER_SURFACE = {
  /** Manual steps outside the code: registration forms, dashboards, API-key requests, approvals. */
  manualSteps: 0,
  /** Accounts a seller must create with a third party before they can be listed. */
  thirdPartyAccounts: 0,
  /** Config keys required to become discoverable, beyond what a paywall already needs. */
  extraConfigForDiscovery: 1,
  /** The one key: `extensions: describeEndpoint({...})` on the route. */
  extraConfigName: "extensions",
  note:
    "Cataloging is triggered by the first settled payment. There is no registration endpoint, no " +
    "dashboard and no API key on the discovery path — which is why this count is zero rather than small.",
} as const;

export interface TimeToDiscoverableOptions {
  readonly facilitatorUrl: string;
  readonly runId: string;
  readonly log?: (line: string) => void;
}

interface DiscoveryResource {
  resource: string;
}

/** Public target. Anything approaching this is a failure worth waking up for. */
const TARGET_SECONDS = 3600;
/** Our own bar, an order of magnitude tighter, so regressions surface long before the public target. */
const REGRESSION_SECONDS = 300;

export async function runTimeToDiscoverable(
  options: TimeToDiscoverableOptions,
): Promise<CanaryReport> {
  const run = new CanaryRun(
    "time-to-discoverable",
    NETWORK,
    options.facilitatorUrl,
    options.log ?? (line => console.error(line)),
  );
  let seller: SyntheticSeller | undefined;
  const began = Date.now();
  const phases: Record<string, number> = {};

  /** Time a phase and record its duration under a stable name. */
  const phase = async <T extends { detail: string }>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const at = Date.now();
    const result = await run.step(name, fn);
    phases[name] = Date.now() - at;
    return result;
  };

  try {
    await run.step("facilitator-reachable", async () => {
      const extensions = await requireBazaarFacilitator(options.facilitatorUrl);
      return { detail: `/supported advertises ${extensions.join(", ")}` };
    });

    // ── Phase 1: a seller identity that can hold and receive an asset ────────
    const fixtures = await phase("provision-identity", async () => {
      const f = await prepareFixtures(assetCodeFor(options.runId));
      return { detail: `funded accounts, asset issued, both trustlines up`, f };
    });

    // ── Phase 2: a paywalled, self-describing endpoint ───────────────────────
    seller = (
      await phase("publish-endpoint", async () => {
        const s = await startSyntheticSeller({
          facilitatorUrl: options.facilitatorUrl,
          network: NETWORK,
          payTo: fixtures.f.seller.publicKey(),
          asset: fixtures.f.assetContractId,
          amount: AMOUNT,
          runId: options.runId,
        });
        return { detail: "stock middleware + one `extensions` key", s };
      })
    ).s;

    // ── Phase 3: the first buyer pays ───────────────────────────────────────
    const buyer = stockBuyer(fixtures.f.buyer.secret());
    const settled = await phase("first-payment", async () => {
      const payment = await buyer.pay(seller!.resourceUrl);
      const { body, headers } = await callFacilitator(
        options.facilitatorUrl,
        "/settle",
        payment.payload,
        payment.accepted,
      );
      const settledAt = Date.now();
      if (body["success"] !== true) {
        throw new X402Error("canary_settlement_failed", {
          reason: `The first payment did not settle, so nothing would be cataloged: ${reasonOf(body)}`,
        });
      }
      const verdict = decodeExtensionResponses(headers.get("extension-responses"));
      if (verdict?.status !== "success") {
        throw new X402Error("canary_extension_response_missing", {
          reason: `Payment settled but cataloging reported "${verdict?.status ?? "nothing at all"}", so the seller is not listed.`,
        });
      }
      run.observe("transaction", body["transaction"]);
      return { detail: `settled and catalogued in one round trip`, settledAt };
    });

    // ── Phase 4: visible in the catalog ─────────────────────────────────────
    await phase("appears-in-catalog", async () => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const found = (
          await listResources(options.facilitatorUrl, { payTo: fixtures.f.seller.publicKey() })
        ).some(r => r.resource === seller!.catalogKey);
        if (found) return { detail: `listed ${Date.now() - settled.settledAt}ms after settlement` };
        if (Date.now() >= deadline) {
          throw new X402Error("canary_resource_not_indexed", {
            reason: `${seller!.catalogKey} settled but never appeared in the catalog within 30s.`,
          });
        }
        await sleep(200);
      }
    });

    // ── Phase 5: findable by someone who has never heard of it ──────────────
    await phase("findable-by-search", async () => {
      const results = await searchResources(options.facilitatorUrl, KNOWN_QUERY);
      const rank = results.findIndex(r => r.resource === seller!.catalogKey) + 1;
      if (rank === 0) {
        throw new X402Error("canary_resource_not_ranked", {
          reason: `In the catalog but not returned for "${KNOWN_QUERY}" — discoverable in principle, undiscoverable in practice.`,
        });
      }
      return { detail: `rank ${rank} for a natural-language query` };
    });

    const totalMs = Date.now() - began;
    const totalSeconds = totalMs / 1000;

    run.observe("totalSeconds", Number(totalSeconds.toFixed(1)));
    run.observe("phaseMs", phases);
    run.observe("targetSeconds", TARGET_SECONDS);
    run.observe("regressionThresholdSeconds", REGRESSION_SECONDS);
    run.observe("sellerSurface", SELLER_SURFACE);
    run.observe(
      "measurementNote",
      "Machine time only. Does NOT include a human reading docs or writing code — see sellerSurface for the integration cost that stands in for it.",
    );

    if (totalSeconds > REGRESSION_SECONDS) {
      throw new X402Error("canary_dx_regression", {
        reason: `Zero to discoverable took ${totalSeconds.toFixed(1)}s, over our ${REGRESSION_SECONDS}s bar (target: under ${TARGET_SECONDS}s). Slowest phase: ${slowest(phases)}.`,
        details: { totalSeconds, phases },
      });
    }

    return run.finish();
  } catch (error) {
    run.observe("phaseMs", phases);
    return run.finish(error);
  } finally {
    await seller?.close();
  }
}

function slowest(phases: Record<string, number>): string {
  const entries = Object.entries(phases).sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? "(none)" : `${entries[0]![0]} (${entries[0]![1]}ms)`;
}

async function listResources(
  base: string,
  filters: Record<string, string>,
): Promise<DiscoveryResource[]> {
  const url = new URL("/discovery/resources", base);
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
  const body = (await (await fetch(url)).json()) as { items?: DiscoveryResource[] };
  return body.items ?? [];
}

async function searchResources(base: string, query: string): Promise<DiscoveryResource[]> {
  const url = new URL("/discovery/search", base);
  url.searchParams.set("query", query);
  const body = (await (await fetch(url)).json()) as { resources?: DiscoveryResource[] };
  return body.resources ?? [];
}
