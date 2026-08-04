import { Hono } from "hono";
import { createError } from "@x402-stellar/errors";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { CatalogStore } from "./catalog/store.js";
import type { DomainVerifier } from "./catalog/domain.js";
import { ingest } from "./catalog/ingest.js";
import { entryKey, type DiscoveryFilters } from "./catalog/types.js";

/**
 * Bazaar HTTP surface.
 *
 * `GET /discovery/resources` and `GET /discovery/search` follow the extension spec
 * (`specs/extensions/bazaar.md` @ 3df52239) and, more importantly, follow what stock SDK clients
 * actually parse — the two endpoints differ in array key and pagination style, and getting that
 * backwards breaks `withBazaar()` silently.
 */

export interface BazaarDeps {
  readonly store: CatalogStore;
  readonly startedAt: number;
}

/** Read the seven spec-defined filters. Unknown query params are ignored, not rejected. */
function filtersFrom(url: URL): DiscoveryFilters {
  const get = (k: string) => url.searchParams.get(k) ?? undefined;
  const f: DiscoveryFilters = {};
  const type = get("type");
  const payTo = get("payTo");
  const scheme = get("scheme");
  const network = get("network");
  const extensions = get("extensions");
  if (type !== undefined) f.type = type;
  if (payTo !== undefined) f.payTo = payTo;
  if (scheme !== undefined) f.scheme = scheme;
  if (network !== undefined) f.network = network;
  if (extensions !== undefined) f.extensions = extensions;
  return f;
}

function numberParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function createBazaarApp({ store, startedAt }: BazaarDeps) {
  const app = new Hono();

  app.get("/health", c =>
    c.json({
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      cataloged: store.size,
    }),
  );

  app.get("/discovery/resources", c => {
    const url = new URL(c.req.url);
    return c.json(
      store.list(filtersFrom(url), numberParam(url, "limit"), numberParam(url, "offset")),
    );
  });

  app.get("/discovery/search", c => {
    const url = new URL(c.req.url);
    const query = url.searchParams.get("query");
    if (!query || !query.trim()) {
      return c.json(
        createError("invalid_payload", {
          reason: "The `query` parameter is required and must be a non-empty search string.",
        }),
        400,
      );
    }
    return c.json(
      store.search(
        query,
        filtersFrom(url),
        numberParam(url, "limit"),
        url.searchParams.get("cursor") ?? undefined,
      ),
    );
  });

  /**
   * Report that a paid call followed a search — the conversion half of the signal loop.
   *
   * Not a spec endpoint. It is namespaced under `/discovery/` because that is what it belongs to,
   * and it is additive: no stock client calls it, and nothing breaks if nobody ever does.
   *
   * Always answers 202, even for an unknown or expired token. The caller has already paid; this is
   * telemetry, and there is no useful action an agent could take on a rejection. `attributed` says
   * whether it landed, for anyone who cares to look.
   */
  app.post("/discovery/conversion", async c => {
    const body = (await c.req.json().catch(() => ({}))) as {
      searchToken?: unknown;
      resource?: unknown;
      toolName?: unknown;
    };
    const token = typeof body.searchToken === "string" ? body.searchToken : undefined;
    const resource = typeof body.resource === "string" ? body.resource : undefined;
    const toolName = typeof body.toolName === "string" ? body.toolName : undefined;

    if (!resource) {
      return c.json(
        createError("invalid_payload", {
          reason: "A conversion report must name the `resource` that was paid for.",
        }),
        400,
      );
    }
    // Match the key the search recorded. MCP resources are keyed on (url, toolName) because one
    // endpoint multiplexes many tools — dropping the tool name here would silently record every
    // MCP conversion as "paid for something this search did not return".
    return c.json(
      { attributed: store.recordConversion(token, entryKey(canonical(resource), toolName)) },
      202,
    );
  });

  app.notFound(c =>
    c.json(
      createError("invalid_payload", {
        reason: `No such endpoint: ${c.req.method} ${new URL(c.req.url).pathname}. This service serves /discovery/resources, /discovery/search and /health.`,
      }),
      404,
    ),
  );

  return app;
}

/**
 * Build the `EXTENSION-RESPONSES` header value.
 *
 * Base64-encoded JSON keyed by extension name. The SDK never emits this header — it only reads it
 * (`httpFacilitatorClient.logExtensionResponsesHeader`), logging an allowlist of
 * `status`, `rejectedReason`, `reason` and `code`. So we emit `rejectedReason` for spec compliance
 * and `code` alongside it, which the stock logger will surface and an agent can branch on.
 */
export function encodeExtensionResponses(
  bazaar:
    | { status: "success" | "processing" }
    | { status: "rejected"; rejectedReason: string; code: string },
): string {
  return Buffer.from(JSON.stringify({ bazaar }), "utf8").toString("base64");
}

/**
 * Catalog a settled payment and produce the header value reporting the outcome.
 *
 * Cataloging is gated on successful settlement, so a seller learns the result on the `/settle`
 * response. A rejection always carries a machine-readable code AND a non-null human reason, which
 * is what lets a seller find out "whether a listing landed and why not".
 */
export function catalogSettledPayment(
  store: CatalogStore,
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  payer: string | undefined,
  now: string = new Date().toISOString(),
  allowedNetworks?: readonly string[],
  /**
   * SEP-1 verifier. Optional so tests and the evaluation harness stay offline and deterministic.
   *
   * Consulted synchronously for what it ALREADY knows, then asked to refresh in the background.
   * Never awaited: this runs inside a settlement response, and a seller's web server must not be
   * able to add latency to somebody's payment — or, by hanging, to withhold their receipt.
   */
  verifier?: DomainVerifier,
): string | undefined {
  if (!paymentPayload.extensions?.["bazaar"]) return undefined;

  // Hand `ingest` a resolver rather than a pre-fetched entry. It knows the canonical key — which is
  // origin + routeTemplate when the payload carries a valid template — and we do not. Looking the
  // incumbent up here, from `resource.url`'s concrete path, is how the ownership check came to be
  // skipped for every templated payload.
  const resourceUrl = paymentPayload.resource?.url;
  const payTo = paymentRequirements.payTo;
  const known =
    verifier && typeof resourceUrl === "string" ? verifier.cached(resourceUrl, payTo) : undefined;

  const outcome = ingest({
    paymentPayload,
    paymentRequirements,
    lookup: (resource, toolName) => store.get(resource, toolName),
    ...(known === undefined ? {} : { domainVerdict: known }),
    now,
    allowedNetworks,
  });

  // Refresh in the background, whatever the outcome above. A rejected ownership challenge is
  // exactly when we most want a fresh verdict: the seller has just been told to publish a
  // stellar.toml, and the next attempt should find the answer already cached.
  if (verifier && typeof resourceUrl === "string") {
    void verifier
      .verify(resourceUrl, payTo)
      .then(verdict => store.setDomainVerified(resourceUrl, payTo, verdict.verified))
      .catch(() => {
        /* verification is advisory; a failure must never surface as a settlement problem */
      });
  }

  if (outcome.status === "rejected") {
    return encodeExtensionResponses({
      status: "rejected",
      rejectedReason: outcome.error.reason,
      code: outcome.error.code,
    });
  }

  store.upsert(outcome.entry, payer);
  return encodeExtensionResponses({ status: "success" });
}

/**
 * Dry-run cataloging for the `/verify` response.
 *
 * Returns the `EXTENSION-RESPONSES` value a seller should see *before* paying: `processing` when
 * the listing would be accepted, or `rejected` carrying the same code and reason settle would give.
 *
 * Deliberately touches no store, no network and no ledger. Ownership and SEP-1 verification are
 * settle-time concerns — they depend on who actually paid — so `processing` promises only that the
 * metadata itself is well-formed. Promising more at verify would be guessing, and a seller who
 * acts on a guess is worse off than one who waited.
 *
 * That decision was recorded when cataloging was designed; only the settle half was ever
 * built, so sellers had to spend a real payment to discover a typo.
 */
export function previewCataloging(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
  allowedNetworks?: readonly string[],
): string | undefined {
  if (!paymentPayload.extensions?.["bazaar"]) return undefined;

  const outcome = ingest({
    paymentPayload,
    paymentRequirements,
    // No lookup: at verify nobody has paid yet, so there is no owner to compare against.
    now: new Date().toISOString(),
    allowedNetworks,
  });

  return outcome.status === "rejected"
    ? encodeExtensionResponses({
        status: "rejected",
        rejectedReason: outcome.error.reason,
        code: outcome.error.code,
      })
    : encodeExtensionResponses({ status: "processing" });
}

/**
 * Normalise a caller-reported resource string: origin + pathname, query and hash stripped.
 *
 * ⚠️ This is NOT the catalog key derivation. The catalog key is whatever
 * `extractDiscoveryInfo` produces, which is `origin + routeTemplate` when the payload carries a
 * valid template. Using this function to look up a catalog entry is the §F1 vulnerability; it is
 * only safe here, where the caller is echoing back a `resource` string search already gave them.
 */
function canonical(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}
