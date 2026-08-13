import {
  extractDiscoveryInfo,
  isValidRouteTemplate,
  sanitizeResourceServiceMetadata,
  validateDiscoveryExtension,
  validateDiscoveryExtensionSpec,
} from "@x402/extensions/bazaar";
import { createError, type ErrorCode, type X402ErrorPayload } from "@rail402/errors";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { DomainVerdict } from "./domain.js";
import { identifyStellarAsset } from "./stellar-assets.js";
import type { TrustlineVerdict } from "./trustline.js";
import type { CatalogAccepts, CatalogEntry, ResourceType } from "./types.js";
import { budgetClientSchema } from "./schema-budget.js";

/**
 * Automatic cataloging — the facilitator is a trust boundary.
 *
 * Clients echo the `resource` block from `PaymentRequired` into `PaymentPayload`, so a hostile
 * client can attempt to poison the catalog with forged service metadata, a crafted `routeTemplate`,
 * or a listing that impersonates another seller. Everything a client controls is validated here.
 *
 * ## Reuse over reimplementation
 *
 * `isValidRouteTemplate`, `sanitizeResourceServiceMetadata` and `validateDiscoveryExtension` come
 * from `@x402/extensions` unchanged. Reimplementing them would guarantee eventual divergence from
 * every other facilitator, and the spec explicitly requires all SDK copies to stay in sync. We add
 * the checks the SDK does *not* perform, and we guard the crash path it leaves open.
 *
 * ## When cataloging happens
 *
 * Only after a payment **settles successfully**. The spec is silent on the trigger (see
 * and leaves storage "an implementation detail". Settlement-gated cataloging
 * makes every listing cost a real on-chain payment, which is the strongest anti-spam property
 * available to us and the reason our ranking signals are hard to forge.
 */

export type CatalogOutcome =
  | { status: "success"; entry: CatalogEntry }
  | { status: "rejected"; error: X402ErrorPayload<ErrorCode> };

const reject = (code: ErrorCode, reason?: string, details?: Record<string, unknown>): CatalogOutcome => ({
  status: "rejected",
  error: createError(code, {
    ...(reason === undefined ? {} : { reason }),
    ...(details === undefined ? {} : { details }),
  }),
});

/**
 * CAIP-2 is `namespace:reference` — 3–8 lowercase alphanumerics, then up to 32 reference chars.
 *
 * Note this is a *syntax* check only, and syntax alone is insufficient. The live CDP catalog
 * contains `aws:base`, which passes this regex perfectly well while naming a network that does not
 * exist. That is why `allowedNetworks` below exists.
 */
const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

export interface IngestInput {
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirements: PaymentRequirements;
  /**
   * Resolve whatever entry currently occupies the key this payload will be written to.
   *
   * A **resolver, not a value**, and that is the whole point. The catalog key is not
   * `origin + pathname`: the SDK's `extractDiscoveryInfo` canonicalises to
   * `origin + routeTemplate` whenever the payload carries a valid template. A caller cannot know
   * that key before extraction, so a caller that pre-fetches an entry keyed on the concrete path
   * hands us the wrong entry — or, far worse, `undefined` — and the ownership check below silently
   * does not run.
   *
   * That was a live listing-takeover vulnerability: declaring a victim's
   * origin plus `routeTemplate: "/their-path"` produced a lookup miss on `/some-other-path`, skipped
   * ownership entirely, and overwrote the victim's entry — after which the victim was locked out of
   * their own listing by the very check that was meant to protect them. It also meant no templated
   * listing ever accumulated settlements or merged payment options (§F2), because every write
   * looked like the first one.
   *
   * So the lookup happens **here**, against the key we are about to write, and nowhere else.
   */
  readonly lookup?: ((resource: string, toolName?: string) => CatalogEntry | undefined) | undefined;
  /**
   * The cached SEP-1 verdict for (this resource's domain, this payTo), if one is already known.
   *
   * Synchronous and optional by design. Verification is an HTTP request to a third party and this
   * function runs inside a settlement response, so it may never wait on one — it consults what is
   * already known and the caller schedules a refresh afterwards.
   */
  readonly domainVerdict?: DomainVerdict | undefined;
  /**
   * The cached trustline verdict for (this listing's network, asset, payTo), if one is known.
   *
   * Synchronous and optional for the same reason as `domainVerdict`: the check is an HTTP request to
   * Horizon and this function runs inside a settlement response. It consults what is already known
   * and the caller schedules a refresh afterwards. **It never affects the outcome** — a listing whose
   * payee cannot receive the asset is still cataloged, with the problem stated on it (`trustline.ts`).
   *
   * The caller must resolve it for THIS (network, asset, payTo); ingest only attaches what it is
   * handed, and a verdict about some other triple would be a lie published under this listing.
   */
  readonly trustlineVerdict?: TrustlineVerdict | undefined;
  readonly now: string;
  /**
   * Networks this Bazaar will catalog. Because cataloging is gated on settlement by our own
   * facilitator, the network is always one we actually serve — so we can bound the catalog to
   * real, settleable networks rather than merely well-formed ones. Omit to accept any syntactically
   * valid CAIP-2 identifier.
   */
  readonly allowedNetworks?: readonly string[] | undefined;
}

/**
 * Validate a settled payment's discovery extension and produce a catalog entry.
 *
 * @returns a `success` outcome with the entry to upsert, or a `rejected` outcome whose error is
 *   reported back to the seller via the `EXTENSION-RESPONSES` header — always with a non-null reason.
 */
export function ingest(input: IngestInput): CatalogOutcome {
  const { paymentPayload, paymentRequirements, lookup, now, allowedNetworks } = input;

  const bazaar = paymentPayload.extensions?.["bazaar"];
  if (!bazaar || typeof bazaar !== "object") {
    return reject(
      "bazaar_info_schema_validation_failed",
      "The payment payload carries no bazaar extension, so there is nothing to catalog.",
    );
  }

  // The SDK's extractDiscoveryInfo does `new URL(resource?.url ?? "")`, which THROWS on a payload
  // that carries a bazaar extension but no resource.url — an unauthenticated remote crash path if
  // called unguarded. Check first.
  const url = paymentPayload.resource?.url;
  if (typeof url !== "string" || url.length === 0) {
    return reject("bazaar_missing_resource_url");
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      // `mcp:` deserves its own answer, because a seller reaches it by doing the obvious thing.
      //
      // `@x402/mcp`'s `createToolResourceUrl` defaults to `mcp://tool/<name>`, so a seller who wires
      // up a paid MCP tool and does not override the resource URL lands here — and "must be http(s)"
      // tells them nothing about what to put instead. Worse, the value is not merely unsupported: it
      // is unusable. `mcp:` is not a special scheme, so `new URL("mcp://tool/get_weather").origin` is
      // the STRING "null", and the spec's origin+path catalog key becomes `null/get_weather` — shared
      // by every seller offering a tool of that name, anywhere. The host is dropped entirely, so
      // `mcp://alice.example/tool/x` and `mcp://bob.example/tool/x` collide too. Cataloging it would
      // hand the first caller a permanent global claim on the name (see the ownership rules below).
      if (parsed.protocol === "mcp:") {
        return reject(
          "bazaar_mcp_resource_url_not_addressable",
          `resource.url is "${url}". Set it to the http(s) URL of your MCP endpoint — the address an agent actually connects to, e.g. "https://api.example.com/mcp" — and leave the tool name in input.toolName; MCP resources are keyed on the pair. "mcp://…" cannot be used: it has no origin under WHATWG URL parsing, so the spec's origin+path key would collapse to a literal "null" origin shared with every other seller, and no agent could connect to it either.`,
          { resourceUrl: url, derivedOrigin: parsed.origin },
        );
      }
      return reject(
        "bazaar_invalid_resource_url",
        `Resource URL must be http(s); got "${parsed.protocol}". The catalog key is the resource's origin and path, and an agent has to be able to reach it.`,
      );
    }
  } catch {
    return reject("bazaar_invalid_resource_url", `Resource URL "${url}" is not a valid absolute URL.`);
  }

  // Protocol-level shape, then info-against-its-own-schema. Both come from the SDK so our verdicts
  // match every other facilitator's.
  const specResult = validateDiscoveryExtensionSpec(bazaar as Record<string, unknown>);
  if (!specResult.valid) {
    return reject(
      "bazaar_unsupported_input_type",
      `Discovery extension failed protocol validation: ${specResult.errors?.join("; ")}`,
      { errors: specResult.errors },
    );
  }

  // Budget the client-supplied schema before the stock validator compiles it with Ajv
  // (`new Function(...)`): a crafted `pattern` like `^(a+)+$` would make cataloging a ReDoS on a
  // free, unauthenticated endpoint. Eval-free and structural; the stock validator still runs on
  // everything that passes, so verdicts stay in sync with other facilitators.
  const schemaBudget = budgetClientSchema((bazaar as Record<string, unknown>)["schema"]);
  if (!schemaBudget.ok) {
    return reject(
      "bazaar_info_schema_validation_failed",
      `The declared schema was rejected before validation: ${schemaBudget.reason}.`,
      { schemaBudget: schemaBudget.reason },
    );
  }

  const schemaResult = validateDiscoveryExtension(bazaar as never);
  if (!schemaResult.valid) {
    return reject(
      "bazaar_info_schema_validation_failed",
      `The extension's info does not validate against its own declared schema: ${schemaResult.errors?.join("; ")}`,
      { errors: schemaResult.errors },
    );
  }

  // A client-supplied routeTemplate is a catalog key, so it is attacker-controlled input. The SDK
  // helper percent-decodes before the traversal and scheme checks; an invalid value is discarded
  // and we fall back to the concrete path rather than rejecting the whole listing (soft drop).
  const rawTemplate = (bazaar as Record<string, unknown>)["routeTemplate"];
  const templateProvided = typeof rawTemplate === "string" && rawTemplate.length > 0;
  const templateValid = isValidRouteTemplate(templateProvided ? rawTemplate : undefined);

  const discovered = extractDiscoveryInfo(paymentPayload, paymentRequirements);
  if (!discovered) {
    return reject(
      "bazaar_info_schema_validation_failed",
      "The discovery extension could not be extracted from the payment payload.",
    );
  }

  const info = discovered.discoveryInfo;
  const type = info.input.type as ResourceType;

  let toolName: string | undefined;
  if (type === "mcp") {
    toolName = (info as { input: { toolName?: string } }).input.toolName;
    if (!toolName) return reject("bazaar_mcp_missing_tool_name");
  }

  // The key we are about to write. `discovered.resourceUrl` is the SDK's canonicalisation —
  // origin + routeTemplate when a valid template is present, origin + pathname otherwise — so
  // resolving the incumbent from it is what makes the ownership check below actually cover the
  // write. Never derive this key any other way; see the `lookup` doc comment.
  const resource = discovered.resourceUrl;
  const existing = lookup?.(resource, toolName);

  // Reject non-CAIP-2 networks at ingest. The largest live Bazaar contains entries with `aws:base`
  // as a network, which is exactly the kind of junk that makes a catalog untrustworthy.
  const network = paymentRequirements.network;
  if (!CAIP2_RE.test(network)) {
    return reject(
      "bazaar_network_not_caip2",
      `Network "${network}" is not a valid CAIP-2 identifier and will not be cataloged.`,
      { network },
    );
  }
  if (allowedNetworks && !allowedNetworks.includes(network)) {
    return reject(
      "bazaar_network_not_caip2",
      `Network "${network}" is well-formed but is not a network this Bazaar settles on, so it cannot be cataloged. Served networks: ${allowedNetworks.join(", ")}.`,
      { network, allowedNetworks: [...allowedNetworks] },
    );
  }

  // ── Ownership ─────────────────────────────────────────────────────────────
  //
  // A listing belongs to the payTo that settled it. Anyone may pay a seller's endpoint, but only
  // that seller's payTo can shape the listing — otherwise a hostile client could pay once and
  // rewrite a competitor's price or description.
  //
  // First-come ownership alone leaves the other half open: an attacker can settle a payment to
  // THEMSELVES while declaring somebody else's origin, claim the key first, and lock the real
  // seller out for good. SEP-1 breaks the tie on evidence rather than on
  // timing — a payTo listed in the domain's own `ACCOUNTS` is the party the domain vouches for.
  const payTo = paymentRequirements.payTo;
  const verified = input.domainVerdict?.verified === true;

  // A provisional entry (cataloged at verify, never settled) owns nothing — settlement always
  // confirms or claims it. Skipping the conflict for a provisional incumbent is what stops a free
  // `/verify` call that declared a victim's URL under an attacker payTo from locking the real seller
  // out at settle — otherwise the F1 listing-takeover would return through the verify path.
  if (existing && !existing.provisional && existing.ownerPayTo !== payTo) {
    // A domain-verified owner is never displaced, whatever the challenger claims.
    if (existing.domainVerified === true) {
      return reject(
        "bazaar_listing_ownership_conflict",
        `This resource is cataloged under payTo ${existing.ownerPayTo}, which the resource's own domain vouches for via SEP-1. A payment to ${payTo} cannot modify it.`,
        { existingOwner: existing.ownerPayTo, attemptedBy: payTo, existingDomainVerified: true },
      );
    }
    // An unverified incumbent yields to a challenger the domain does vouch for. This is what stops
    // a squatter holding a key hostage against the party that actually controls the domain.
    if (!verified) {
      return reject(
        "bazaar_listing_ownership_conflict",
        `This resource is already cataloged under payTo ${existing.ownerPayTo}; a payment to ${payTo} cannot modify it. If you control this domain, list ${payTo} in the ACCOUNTS array of its SEP-1 stellar.toml and pay again — a domain-verified seller takes precedence over an unverified one.`,
        { existingOwner: existing.ownerPayTo, attemptedBy: payTo, remedy: "sep1-accounts" },
      );
    }
  }

  // A verified challenger displacing an unverified incumbent starts the usage counters fresh: the
  // signals belonged to the previous claim, not to this one.
  const displacing = existing !== undefined && existing.ownerPayTo !== payTo;

  // Service metadata is soft-dropped per field by the SDK's sanitizer: an invalid iconUrl must not
  // discard a valid serviceName. The iconUrl rules are an SSRF defence (no IP literals, no
  // loopback, IDN-normalized, percent-decoded before the checks).
  const metadata = sanitizeResourceServiceMetadata(paymentPayload.resource ?? undefined);

  // `maxTimeoutSeconds` is REQUIRED on v2 `PaymentRequirements`, and a catalog entry's `accepts`
  // is typed as `PaymentRequirements[]` by every stock consumer. Emitting an entry without it
  // produced listings a strict SDK client would reject — a silent
  // interop break, exactly the class this catalog exists to avoid. Rejecting is the fail-closed
  // choice: inventing a plausible number would publish payment terms the seller never declared.
  const maxTimeoutSeconds = paymentRequirements.maxTimeoutSeconds;
  if (typeof maxTimeoutSeconds !== "number" || !Number.isFinite(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    return reject(
      "bazaar_unsupported_input_type",
      `The payment requirements declare no usable maxTimeoutSeconds (got ${JSON.stringify(maxTimeoutSeconds)}). It is required on x402 v2 payment requirements, and a catalog entry missing it is one stock clients will reject.`,
      { field: "maxTimeoutSeconds" },
    );
  }

  // Stellar's `exact` scheme carries fee sponsorship in `extra.areFeesSponsored`, and the stock
  // @x402/stellar client HARD-REQUIRES it: `createPaymentPayload` destructures `extra` and throws a
  // raw TypeError when `extra` is absent or null, and an Error when `areFeesSponsored` is not `true`
  // (proven by a live capture). A Stellar exact listing that drops it is
  // therefore not merely low quality — it is UNPAYABLE, and publishing it would crash the stock
  // client the instant a buyer tried. Reject it here, the same fail-closed posture as
  // `maxTimeoutSeconds` above; the live CDP Bazaar carries exactly these broken Stellar entries
  // (live captures) because it validates none of this.
  if (paymentRequirements.scheme === "exact" && network.startsWith("stellar:")) {
    const extra = paymentRequirements.extra;
    const sponsored =
      extra !== null &&
      typeof extra === "object" &&
      (extra as Record<string, unknown>)["areFeesSponsored"] === true;
    if (!sponsored) {
      return reject(
        "bazaar_stellar_fees_not_sponsored",
        `A Stellar exact listing must declare extra.areFeesSponsored === true; got extra=${JSON.stringify(
          extra ?? null,
        )}. The stock @x402/stellar client throws on a missing, null, or non-true value, so cataloging this would publish an entry no buyer can pay.`,
        { scheme: paymentRequirements.scheme, network, extra: extra ?? null },
      );
    }
  }

  // `extra.stellar` is FACILITATOR-COMPUTED, never client-echoed — soft-drop whatever the client put
  // there (it is attacker-controlled input, echoed from the resource block) and attach the
  // facilitator's own PROVABLE asset identity, derived from the SAC address. An EVM/SVM catalog can
  // only trust a curated token list here; on Stellar this is a derivation, so a scam token cannot
  // claim to be USDC (`stellar-assets.ts`).
  const clientExtra: Record<string, unknown> = { ...(paymentRequirements.extra ?? {}) };
  delete clientExtra["stellar"];
  const assetIdentity = identifyStellarAsset(network, paymentRequirements.asset);

  // Both facilitator-computed enrichments live under one `stellar` key, and they are one feature:
  // the trustline question is only askable once the asset identity is derived, because a SAC address
  // cannot be reversed into the (code, issuer) a trustline is held against (`trustline.ts`).
  const stellarExtra: Record<string, unknown> = {};
  if (assetIdentity) stellarExtra["asset"] = assetIdentity;
  if (input.trustlineVerdict) stellarExtra["payToTrustline"] = input.trustlineVerdict;

  const accepts: CatalogAccepts = {
    scheme: paymentRequirements.scheme,
    network,
    amount: paymentRequirements.amount,
    asset: paymentRequirements.asset,
    payTo,
    maxTimeoutSeconds,
    // Always present (B1): stock `PaymentRequirements.extra` is required, so an omitted extra is a
    // listing a strict consumer rejects. Client `extra.stellar` is dropped above; the facilitator's
    // own findings are added when it has any — silence, never a guess, when it has none.
    extra:
      Object.keys(stellarExtra).length > 0 ? { ...clientExtra, stellar: stellarExtra } : clientExtra,
  };

  const quality = existing && !displacing
    ? {
        ...existing.quality,
        totalSettlements: existing.quality.totalSettlements + 1,
        lastSettledAt: now,
      }
    : { totalSettlements: 1, uniquePayers: 0, lastSettledAt: now, firstSeenAt: now };

  const entry: CatalogEntry = {
    resource,
    type,
    ...(toolName === undefined ? {} : { toolName }),
    x402Version: paymentPayload.x402Version,
    // Merge payment options rather than replacing, so a seller pricing in several assets keeps them.
    accepts: mergeAccepts(displacing ? [] : (existing?.accepts ?? []), accepts),
    lastUpdated: now,
    ...(discovered.description === undefined ? {} : { description: discovered.description }),
    ...(discovered.mimeType === undefined ? {} : { mimeType: discovered.mimeType }),
    ...(metadata.serviceName === undefined ? {} : { serviceName: metadata.serviceName }),
    ...(metadata.tags === undefined ? {} : { tags: metadata.tags }),
    ...(metadata.iconUrl === undefined ? {} : { iconUrl: metadata.iconUrl }),
    ...(paymentPayload.extensions === undefined ? {} : { extensions: paymentPayload.extensions }),
    quality,
    ownerPayTo: payTo,
    ...(input.domainVerdict === undefined ? {} : { domainVerified: verified }),
  };

  // A dropped routeTemplate is worth telling the seller about — their dynamic route will be
  // cataloged per concrete path instead of collapsing to one entry — but it is not fatal.
  if (templateProvided && !templateValid) {
    entry.extensions = {
      ...(entry.extensions ?? {}),
      _bazaarWarnings: ["routeTemplate failed validation and was discarded"],
    };
  }

  return { status: "success", entry };
}

/** Replace a same-(scheme, network, asset) option, otherwise append. */
function mergeAccepts(existing: CatalogAccepts[], incoming: CatalogAccepts): CatalogAccepts[] {
  const same = (a: CatalogAccepts) =>
    a.scheme === incoming.scheme && a.network === incoming.network && a.asset === incoming.asset;
  const kept = existing.filter(a => !same(a));
  return [incoming, ...kept];
}
