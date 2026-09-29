import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { baseAccount } from "@rail402.dev/stellar";
import {
  isValidRouteTemplate,
  sanitizeResourceServiceMetadata,
  validateDiscoveryExtensionSpec,
} from "@x402/extensions/bazaar";
import type { BazaarCode } from "./codes.ts";
import type { SchemaSandbox } from "./schema-sandbox.ts";
import type { Candidate, ListingContent, PaymentOption, ResourceKind } from "./types.ts";
import { canonicalizeUrl, isSafeTemplate, normalizePercentEncoding, templateMatchesPath } from "./url.ts";

// Re-exported: search and the Postgres store resolve payTo filters with it.
export { baseAccount };

export const MAX_DESCRIPTION_LENGTH = 1_000;
export const MAX_TOOL_NAME_LENGTH = 128;
const MAX_EXTRA_BYTES = 2_048;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}(?:\s*;.{0,128})?$/i;
const TOOL_NAME = /^[\x21-\x7e]+$/;
/** The extension keys the discovery `extensions` filter accepts. */
const EXTENSION_KEY = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_EXTENSIONS = 16;

export interface ExtractOptions {
  readonly sandbox: SchemaSandbox;
  /** Accept loopback resource URLs (conformance runs on a local network only). */
  readonly allowLoopback: boolean;
}

export type Extraction =
  /** The payment carries no bazaar extension: nothing to catalog, nothing to report. */
  | { readonly kind: "absent" }
  | { readonly kind: "rejected"; readonly code: BazaarCode; readonly reason: string }
  | { readonly kind: "candidate"; readonly candidate: Candidate };

export interface SettledPayment {
  readonly payload: PaymentPayload;
  readonly requirements: PaymentRequirements;
  readonly payer: string;
  readonly transaction: string;
}

/**
 * Turns a settled payment into a catalog candidate. Everything read from the payload is untrusted —
 * the buyer echoes it — so each field is validated, canonicalised or soft-dropped here, and only the
 * validated bazaar extension (never arbitrary client extensions) reaches the catalog.
 */
export async function extractCandidate(
  payment: SettledPayment,
  options: ExtractOptions,
): Promise<Extraction> {
  const { payload, requirements } = payment;
  const extension = payload.extensions?.["bazaar"];
  if (extension === undefined) return { kind: "absent" };
  if (payload.x402Version !== 2) return reject("bazaar_unsupported_version");
  if (!isRecord(extension) || !isRecord(extension["info"]) || !isRecord(extension["schema"])) {
    return reject("bazaar_extension_malformed");
  }
  const info = extension["info"];
  const schema = extension["schema"];

  const structure = validateDiscoveryExtensionSpec(extension);
  if (!structure.valid) {
    return reject("bazaar_info_unsupported", structure.errors?.[0]);
  }
  const verdict = await options.sandbox.validate(schema, info);
  if (!verdict.ok) return reject(verdict.code, verdict.reason);

  const input = info["input"] as Record<string, unknown>;
  const kind = input["type"] as ResourceKind;
  const dropped: string[] = [];

  let method = "";
  let toolName = "";
  if (kind === "http") {
    // An extension whose schema leaves `method` optional may omit it (the schema upstream's
    // declareDiscoveryExtension produces requires it): infer it the way the spec discriminates query
    // from body methods.
    method =
      typeof input["method"] === "string"
        ? input["method"].toUpperCase()
        : input["bodyType"] === undefined
          ? "GET"
          : "POST";
  } else {
    const name = input["toolName"];
    if (typeof name !== "string" || name.length > MAX_TOOL_NAME_LENGTH || !TOOL_NAME.test(name)) {
      return reject(
        "bazaar_info_unsupported",
        `info.input.toolName must be 1-${String(MAX_TOOL_NAME_LENGTH)} printable ASCII characters.`,
      );
    }
    toolName = name;
  }

  // On pubnet a listing's resource must be served over TLS; plain http is for testnet only.
  const web = requirements.network === "stellar:pubnet" ? ["https:"] : ["https:", "http:"];
  const canonical = canonicalizeUrl(payload.resource?.url, {
    protocols: kind === "http" ? web : [...web, "mcp:"],
    allowLoopback: options.allowLoopback,
  });
  if (!canonical.ok) return reject(canonical.code, canonical.reason);
  const url = canonical.url;

  let routeTemplate: string | undefined;
  let resource = url.protocol === "mcp:" ? url.href : `${url.origin}${url.pathname}`;
  const rawTemplate = extension["routeTemplate"];
  if (kind === "http" && rawTemplate !== undefined) {
    if (
      typeof rawTemplate === "string" &&
      isValidRouteTemplate(rawTemplate) &&
      isSafeTemplate(rawTemplate) &&
      templateMatchesPath(rawTemplate, url.pathname)
    ) {
      // Normalized like the paid path, so equivalent spellings of one template are one listing.
      routeTemplate = normalizePercentEncoding(rawTemplate);
      resource = `${url.origin}${routeTemplate}`;
    } else {
      dropped.push("routeTemplate");
    }
  }

  const payTo = requirements.payTo;
  const owner = baseAccount(payTo);
  if (owner === undefined) return reject("bazaar_resource_invalid", "payTo is not a Stellar address.");
  // An origin check has no payer: the content comes from the seller's own 402 response.
  if (payment.payer !== "" && baseAccount(payment.payer) === owner) return reject("bazaar_self_payment");

  const rawResource = (payload.resource ?? {}) as unknown as Record<string, unknown>;
  const metadata = sanitizeResourceServiceMetadata(payload.resource);
  for (const field of ["serviceName", "iconUrl"] as const) {
    if (rawResource[field] !== undefined && metadata[field] === undefined) dropped.push(field);
  }
  if (Array.isArray(rawResource["tags"]) && (metadata.tags?.length ?? 0) < rawResource["tags"].length) {
    dropped.push("tags");
  }

  const description = cleanDescription(rawResource["description"]);
  if (rawResource["description"] !== undefined && description === undefined) dropped.push("description");
  const mimeType =
    typeof rawResource["mimeType"] === "string" && MIME_TYPE.test(rawResource["mimeType"])
      ? rawResource["mimeType"]
      : undefined;
  if (rawResource["mimeType"] !== undefined && mimeType === undefined) dropped.push("mimeType");

  const extensions = declaredExtensionKeys(payload.extensions ?? {}, dropped);

  const accept: PaymentOption = {
    scheme: requirements.scheme,
    network: requirements.network,
    asset: requirements.asset,
    payTo,
    amount: requirements.amount,
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    extra: boundedExtra(requirements.extra, dropped),
  };

  const content: ListingContent = {
    resource,
    kind,
    ...(kind === "http" ? { method } : { toolName }),
    ...(description === undefined ? {} : { description }),
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(metadata.serviceName === undefined ? {} : { serviceName: metadata.serviceName }),
    ...(metadata.tags === undefined || metadata.tags.length === 0 ? {} : { tags: metadata.tags }),
    ...(metadata.iconUrl === undefined ? {} : { iconUrl: metadata.iconUrl }),
    ...(extensions.length === 0 ? {} : { extensions }),
    bazaar: { info, schema, ...(routeTemplate === undefined ? {} : { routeTemplate }) },
    accepts: [accept],
  };

  return {
    kind: "candidate",
    candidate: {
      identity: {
        network: requirements.network,
        kind,
        resource,
        method,
        toolName,
        // Nothing proves who runs an MCP server (tools are never origin-checked), so every tool is
        // scoped to its owner: one seller can never claim another's tool.
        scope: kind === "mcp" ? owner : "",
      },
      concreteUrl: url.protocol === "mcp:" ? url.href : `${url.origin}${url.pathname}`,
      owner,
      payer: payment.payer,
      transaction: payment.transaction,
      content,
      dropped,
    },
  };
}

function cleanDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Strip control characters except ordinary whitespace, then collapse runs of whitespace.
  let cleaned = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || (code >= 0x7f && code < 0xa0) ? " " : char;
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (cleaned === "" || cleaned.length > MAX_DESCRIPTION_LENGTH) return undefined;
  return cleaned;
}

/**
 * The keys of the other extensions in `extensions`, sorted. Only keys are kept: a declaration's
 * payload can change with every response (a sign-in challenge), and a buyer's echo can carry its own
 * data (a payment identifier), neither of which belongs in a public catalog.
 */
function declaredExtensionKeys(extensions: Record<string, unknown>, dropped: string[]): string[] {
  const keys = Object.keys(extensions).filter((key) => key !== "bazaar");
  const valid = [...new Set(keys.filter((key) => EXTENSION_KEY.test(key)))].sort();
  if (valid.length < keys.length || valid.length > MAX_EXTENSIONS) dropped.push("extensions");
  return valid.slice(0, MAX_EXTENSIONS);
}

function boundedExtra(extra: unknown, dropped: string[]): Record<string, unknown> {
  if (!isRecord(extra)) return {};
  try {
    if (Buffer.byteLength(JSON.stringify(extra)) <= MAX_EXTRA_BYTES) return extra;
  } catch {
    // Not serializable: dropped below.
  }
  dropped.push("extra");
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function reject(code: BazaarCode, reason?: string): Extraction {
  // Upstream validation messages can quote the buyer's input verbatim.
  return { kind: "rejected", code, reason: (reason ?? "").slice(0, 300) };
}
