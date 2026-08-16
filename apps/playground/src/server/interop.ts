import { X402Error } from "@rail402.dev/errors";

/**
 * Interop check: does a catalog listing round-trip through the wire shapes STOCK x402 SDK clients
 * depend on? (Stellar is not a walled garden; reviewers point stock SDK code at the
 * deliverable.)
 *
 * The stock `withBazaar` client hard-codes global `fetch`, so running upstream's own code inside a
 * server request would mean swapping `globalThis.fetch` per request — a data race with every
 * concurrent request. Instead this makes the SAME wire requests the stock client makes (paths and
 * query-string format read from `@x402/extensions` 2.20.0) with the injected fetch, and asserts
 * the exact envelope invariants stock consumers read:
 *
 *  - LIST answers `{ x402Version, items[], pagination { limit, offset, total } }`
 *  - SEARCH answers `{ resources[] }` — the list/search key ASYMMETRY that silently breaks every
 *    stock client when gotten backwards
 *  - the entry itself carries `accepts[]` and an ISO-8601 STRING `lastUpdated` (the spec-vs-SDK
 *    divergence stock clients standardized on)
 *
 * The upstream-code-does-the-parsing version of this same assertion runs per-commit in
 * `apps/bazaar/src/parity.test.ts`; this endpoint is the live, per-listing view of it.
 */

export interface InteropCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface InteropCheckResult {
  readonly ok: boolean;
  readonly url: string;
  /** Present in the live catalog (a resource appears after its first settled payment). */
  readonly listed: boolean;
  readonly checks: readonly InteropCheck[];
  readonly reason: string;
}

const PAGE_LIMIT = 100;
const MAX_PAGES = 5;

const normalize = (u: string): string => u.replace(/\/+$/, "");

export async function checkInterop(
  rawUrl: unknown,
  cfg: { facilitatorUrl: string; fetchImpl: typeof fetch },
): Promise<InteropCheckResult> {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw new X402Error("playground_invalid_request", {
      reason: "GET /bazaar/interop-check takes ?url=<the resource URL to check>.",
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new X402Error("playground_invalid_request", { reason: `"${rawUrl}" is not a valid URL.` });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new X402Error("playground_invalid_request", {
      reason: "Only http(s) resource URLs can be checked.",
    });
  }

  const get = async (path: string): Promise<unknown> => {
    let res: Response;
    try {
      res = await cfg.fetchImpl(`${cfg.facilitatorUrl}${path}`);
    } catch (err) {
      throw new X402Error("playground_facilitator_unreachable", {
        reason: `The Bazaar at ${cfg.facilitatorUrl} could not be reached: ${err instanceof Error ? err.message : String(err)}.`,
      });
    }
    if (!res.ok) {
      throw new X402Error("playground_facilitator_unreachable", {
        reason: `The Bazaar at ${cfg.facilitatorUrl} answered HTTP ${res.status} to ${path.split("?")[0]}, so the interop check could not run.`,
      });
    }
    return res.json().catch(() => null);
  };

  const checks: InteropCheck[] = [];
  const target = normalize(rawUrl);
  let entry: Record<string, unknown> | undefined;
  let listEnvelopeOk = true;

  // Walk the catalog exactly as a stock client pages it.
  for (let page = 0; page < MAX_PAGES && !entry; page++) {
    const body = (await get(`/discovery/resources?limit=${PAGE_LIMIT}&offset=${page * PAGE_LIMIT}`)) as {
      x402Version?: unknown;
      items?: unknown;
      pagination?: { limit?: unknown; offset?: unknown; total?: unknown };
    } | null;
    const items = Array.isArray(body?.items) ? (body.items as Record<string, unknown>[]) : undefined;
    if (page === 0) {
      listEnvelopeOk =
        body?.x402Version === 2 &&
        items !== undefined &&
        typeof body.pagination?.limit === "number" &&
        typeof body.pagination?.offset === "number" &&
        typeof body.pagination?.total === "number";
      checks.push({
        name: "list-envelope",
        ok: listEnvelopeOk,
        detail: listEnvelopeOk
          ? "GET /discovery/resources answers { x402Version: 2, items[], pagination { limit, offset, total } } — what stock listResources() consumers read"
          : "the list envelope is missing items[] or numeric pagination { limit, offset, total }",
      });
    }
    if (!items) break;
    entry = items.find(i => typeof i["resource"] === "string" && normalize(i["resource"] as string) === target);
    const total = (body?.pagination?.total as number | undefined) ?? 0;
    if ((page + 1) * PAGE_LIMIT >= total) break;
  }

  const listed = entry !== undefined;

  if (entry) {
    const accepts = entry["accepts"];
    const lastUpdated = entry["lastUpdated"];
    const acceptsOk = Array.isArray(accepts) && accepts.length > 0;
    const lastUpdatedOk = typeof lastUpdated === "string" && !Number.isNaN(Date.parse(lastUpdated));
    checks.push({
      name: "entry-shape",
      ok: acceptsOk && lastUpdatedOk,
      detail:
        acceptsOk && lastUpdatedOk
          ? "the listing carries accepts[] (payable options) and an ISO-8601 string lastUpdated — the shape the stock SDK types standardized on"
          : `defects: ${[
              acceptsOk ? undefined : "accepts[] missing or empty",
              lastUpdatedOk ? undefined : `lastUpdated is ${JSON.stringify(lastUpdated)} — stock types expect an ISO-8601 string`,
            ]
              .filter(Boolean)
              .join("; ")}`,
    });
  }

  // The search side of the asymmetry — envelope only; ranking is not an interop property.
  const search = (await get(`/discovery/search?query=${encodeURIComponent(parsed.hostname)}&limit=5`)) as {
    resources?: unknown;
  } | null;
  const searchOk = Array.isArray(search?.resources);
  checks.push({
    name: "search-envelope",
    ok: searchOk,
    detail: searchOk
      ? "GET /discovery/search answers { resources[] } — the list/search key asymmetry stock clients depend on"
      : "the search envelope has no resources[] array (stock clients read `resources` here, not `items`)",
  });

  const allOk = checks.every(c => c.ok);
  const ok = listed && allOk;
  return {
    ok,
    url: rawUrl,
    listed,
    checks,
    reason: ok
      ? "This listing round-trips through the stock x402 discovery wire shapes — a stock SDK client can list it, search it, and read its payment options."
      : listed
        ? `Listed, but a wire-shape check failed: ${checks.find(c => !c.ok)?.detail ?? "see checks"}.`
        : "Not in the catalog. A resource appears after its first settled payment — pay it once (or check the URL is exactly the cataloged one) and re-run.",
  };
}
