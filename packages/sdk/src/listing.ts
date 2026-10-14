import { EgressError, effectivePort, isEgressError, type EgressPolicy } from "@rail402.dev/safe-fetch/shared";
import { utf8Length } from "./bytes.ts";
import type { StellarNetwork } from "@rail402.dev/stellar";
import { paymentError } from "./codes.ts";
import { listingOn, type DiscoveryItem } from "./discovery.ts";
import { parseAtomic, toDecimal } from "./money.ts";
import type { ListingBinding } from "./policy/decide.ts";
import { meetsTrust, policyAsset, type ResolvedPolicy, type Trust } from "./policy/policy.ts";
import { sanitizeText } from "./redact.ts";
import type { StellarSchemeAdapter } from "./schemes/adapter.ts";

/** One payment option of a listing, priced in whole units where the decimals are known. */
export interface HitPrice {
  readonly scheme: string;
  /** Decimal amount, or null when the asset's decimals are unknown. */
  readonly amount: string | null;
  readonly atomic: string;
  /** The policy symbol, the token's own symbol from the listing facts, or the contract address. */
  readonly asset: string;
  readonly assetContract: string;
  readonly decimals: number | null;
  readonly payTo: string;
  readonly feesSponsored: boolean;
  /** Whether payTo can receive the asset, as the Bazaar last read it from the chain. */
  readonly receivable: boolean | null;
  readonly maxTimeoutSeconds: number | null;
  /** The scheme and asset are enabled and the price is within the operator's per-call ceiling. */
  readonly withinPolicy: boolean;
}

/** A discovery result flattened to its listing on the buyer's network. Seller text is untrusted. */
export interface SearchHit {
  /** Pass to `payListing`; binds the payment to the listing's owner. Null when not listed on this network. */
  readonly listingId: string | null;
  readonly type: string;
  readonly resource: string;
  readonly method: string | null;
  readonly toolName: string | null;
  /** MCP only. */
  readonly transport: "streamable-http" | "sse" | null;
  /** The listing's route template when its path has parameters (`/users/:id`). */
  readonly routeTemplate: string | null;
  /** The listing owner's base account. */
  readonly owner: string | null;
  readonly trust: Trust;
  readonly settlements: number;
  readonly prices: readonly HitPrice[];
  /** Whether this client can call the resource: an http(s) URL the egress policy allows. */
  readonly callable: boolean;
  readonly notCallableReason: string | null;
  /** At least one price is within the spending policy. */
  readonly withinPolicy: boolean;
  readonly seller: {
    readonly serviceName: string | null;
    readonly description: string | null;
    readonly tags: readonly string[];
    readonly mimeType: string | null;
  };
  readonly input: {
    readonly schema: unknown;
    readonly example: unknown;
    /** Path parameter names a call must fill in (from the route template). */
    readonly pathParams: readonly string[];
  };
  readonly output: { readonly example: unknown };
  readonly lastUpdated: string;
}

export interface HitContext {
  readonly network: StellarNetwork;
  readonly policy: ResolvedPolicy;
  readonly adapters: readonly StellarSchemeAdapter[];
  readonly egress: EgressPolicy;
  /**
   * Refuses a resource URL the buyer cannot call, with an `EgressError`. Default: `checkUrlSyntax`.
   * In Node, `checkUrl` from @rail402.dev/safe-fetch also classifies the host.
   */
  readonly checkUrl?: ((url: string, egress: EgressPolicy) => unknown) | undefined;
}

const MAX_DESCRIPTION = 1_000;
const MAX_TAGS = 16;
const MAX_TAG = 64;

/** Flattens a discovery item to its listing on the buyer's network. */
export function toHit(item: DiscoveryItem, context: HitContext): SearchHit {
  const { network, policy } = context;
  const listing = listingOn(item, network);
  const bazaar = item.extensions["bazaar"] ?? {};
  const info = record(bazaar["info"]);
  const input = record(info["input"]);
  const output = record(info["output"]);
  const routeTemplate = typeof bazaar["routeTemplate"] === "string" ? bazaar["routeTemplate"] : null;
  const type = item.type;
  const transportText = input["transport"];
  const transport =
    type === "mcp" ? (transportText === "sse" ? "sse" : "streamable-http") : (null as SearchHit["transport"]);

  const prices: HitPrice[] = [];
  item.accepts.forEach((option, index) => {
    if (option.network !== network) return;
    const facts = item.rail402.options[index];
    if (listing !== undefined && facts !== undefined && facts.listing !== listing.id) return;
    const known = policyAsset(policy, option.asset);
    const decimals = known?.contract === option.asset ? known.decimals : (facts?.decimals ?? null);
    const atomic = parseAtomic(option.amount);
    const feesSponsored = option.extra?.["areFeesSponsored"] === true;
    const withinPolicy =
      atomic !== undefined &&
      atomic > 0n &&
      known?.contract === option.asset &&
      policy.schemes.includes(option.scheme as "exact") &&
      context.adapters.some((adapter) => adapter.scheme === option.scheme) &&
      (option.scheme !== "exact" || feesSponsored) &&
      (known.perCall === undefined || atomic <= known.perCall);
    prices.push({
      scheme: option.scheme,
      amount: atomic !== undefined && decimals !== null ? toDecimal(atomic, decimals) : null,
      atomic: option.amount,
      asset:
        known?.contract === option.asset
          ? known.symbol
          : facts?.symbol !== undefined
            ? sanitizeText(facts.symbol, 16)
            : option.asset,
      assetContract: option.asset,
      decimals,
      payTo: option.payTo,
      feesSponsored,
      receivable: facts?.receivable ?? null,
      maxTimeoutSeconds: option.maxTimeoutSeconds ?? null,
      withinPolicy,
    });
  });

  const reachability = callability(item.resource, type, context);
  return {
    listingId: listing?.id ?? null,
    type,
    resource: item.resource,
    method: item.rail402.method ?? null,
    toolName: item.rail402.toolName ?? null,
    transport,
    routeTemplate,
    owner: listing?.owner ?? null,
    trust: listing?.trust ?? item.rail402.trust,
    settlements: item.rail402.settlements,
    prices,
    callable: reachability === null,
    notCallableReason: reachability,
    withinPolicy: prices.some((price) => price.withinPolicy),
    seller: {
      serviceName: item.serviceName === undefined ? null : sanitizeText(item.serviceName, 200),
      description: item.description === undefined ? null : sanitizeText(item.description, MAX_DESCRIPTION),
      tags: (item.tags ?? []).slice(0, MAX_TAGS).map((tag) => sanitizeText(tag, MAX_TAG)),
      mimeType: item.mimeType === undefined ? null : sanitizeText(item.mimeType, 200),
    },
    input: {
      schema:
        type === "mcp" ? (input["inputSchema"] ?? null) : (record(bazaar["schema"])["properties"] ?? null),
      example: type === "mcp" ? (input["example"] ?? null) : (input["queryParams"] ?? input["body"] ?? null),
      pathParams: routeParams(routeTemplate ?? pathOf(item.resource)),
    },
    output: { example: output["example"] ?? null },
    lastUpdated: item.lastUpdated,
  };
}

/** Why a resource cannot be called, or null when it can. */
function callability(resource: string, type: string, context: HitContext): string | null {
  if (type !== "http" && type !== "mcp") return `Resources of type "${type}" cannot be called.`;
  if (type === "mcp" && !/^https?:/i.test(resource)) {
    return "The MCP endpoint is not an http(s) URL.";
  }
  try {
    (context.checkUrl ?? checkUrlSyntax)(resource, context.egress);
    return null;
  } catch (error) {
    if (isEgressError(error)) return error.reason;
    return "The resource URL cannot be called.";
  }
}

/**
 * The checks on a URL that need no network and no Node: an absolute URL within the size limit, no
 * control characters or credentials, and a scheme and port the policy allows. It does not classify
 * the host; whatever sends the request (safe-fetch, or a relay built on it) refuses private
 * destinations.
 */
export function checkUrlSyntax(input: string, egress: EgressPolicy): URL {
  const invalid = (reason: string) => new EgressError("egress_url_invalid", "url", { reason });
  if (input === "") throw invalid("The URL is empty.");
  if (utf8Length(input) > egress.limits.urlBytes) {
    throw invalid(`The URL exceeds ${String(egress.limits.urlBytes)} bytes.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input)) throw invalid("The URL contains control characters.");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalid("The URL is not an absolute URL.");
  }
  if (utf8Length(url.href) > egress.limits.urlBytes) {
    throw invalid(`The URL exceeds ${String(egress.limits.urlBytes)} bytes.`);
  }
  if (url.username !== "" || url.password !== "") throw invalid("The URL must not contain credentials.");
  if (!(egress.schemes as readonly string[]).includes(url.protocol)) {
    throw new EgressError("egress_scheme_not_allowed", "url", {
      reason: `The scheme ${url.protocol.replace(":", "")} is not allowed; allowed: ${egress.schemes
        .map((scheme) => scheme.replace(":", ""))
        .join(", ")}.`,
    });
  }
  const port = effectivePort(url);
  if (!egress.ports.includes(port)) {
    throw new EgressError("egress_port_not_allowed", "url", {
      reason: `Port ${String(port)} is not allowed; allowed: ${egress.ports.join(", ")}.`,
    });
  }
  return url;
}

/** Whether the default `searchAndPay` pick may pay this hit. */
export function payableHit(hit: SearchHit, policy: ResolvedPolicy): boolean {
  const minimum = hit.type === "mcp" ? policy.minTrust.mcp : policy.minTrust.http;
  return hit.listingId !== null && hit.callable && hit.withinPolicy && meetsTrust(hit.trust, minimum);
}

/**
 * What a listing binds the payment to: the recipient's base account always, and the listed prices,
 * which the live price may not exceed. The catalog confirms both HTTP resources and MCP tools at an
 * http(s) endpoint against their origin, so their prices are bound alike; only a tool under another
 * URL (which is never called) keeps first-seen content and binds the recipient alone.
 */
export function bindingFor(item: DiscoveryItem, network: StellarNetwork, owner: string): ListingBinding {
  const type = item.type === "mcp" ? "mcp" : "http";
  if (type === "mcp" && !/^https?:\/\//i.test(item.resource)) return { type, owner };
  return {
    type,
    owner,
    prices: item.accepts
      .filter((option) => option.network === network)
      .map((option) => ({
        scheme: option.scheme,
        asset: option.asset,
        payTo: option.payTo,
        amount: option.amount,
      })),
  };
}

const PARAM_SEGMENT = /^:([A-Za-z_][A-Za-z0-9_]*)$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

function pathOf(resource: string): string {
  return URL.canParse(resource) ? new URL(resource).pathname : "";
}

/** The `:name` parameters of a route template, in order. */
export function routeParams(template: string): string[] {
  return template
    .split("/")
    .map((segment) => PARAM_SEGMENT.exec(segment)?.[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * Fills a listing's `:name` path segments. Every parameter needs a value; a value that is empty,
 * `.` or `..` (also once percent-decoded) or has control characters is refused, since it could walk
 * the path to another resource. Values are percent-encoded.
 */
export function expandRoute(resource: string, pathParams: Readonly<Record<string, string>> = {}): string {
  const url = new URL(resource);
  const names = routeParams(url.pathname);
  for (const name of Object.keys(pathParams)) {
    if (!names.includes(name)) {
      throw paymentError("payment_request_invalid", {
        reason: `The resource has no path parameter named "${sanitizeText(name, 64)}".`,
      });
    }
  }
  if (names.length === 0) return url.href;
  url.pathname = url.pathname
    .split("/")
    .map((segment) => {
      const name = PARAM_SEGMENT.exec(segment)?.[1];
      if (name === undefined) return segment;
      const value = pathParams[name];
      if (value === undefined) {
        throw paymentError("payment_request_invalid", {
          reason: `The path parameter "${name}" is required.`,
        });
      }
      if (!safeSegment(value)) {
        throw paymentError("payment_request_invalid", {
          reason: `The path parameter "${name}" must not be empty, "." or "..", or contain control characters.`,
        });
      }
      return encodeURIComponent(value);
    })
    .join("/");
  return url.href;
}

function safeSegment(value: string): boolean {
  if (typeof value !== "string" || value === "" || CONTROL.test(value)) return false;
  let decoded = value;
  // Decode repeatedly so %252e%252e is caught as well as %2e%2e.
  for (let round = 0; round < 3; round++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }
  const trimmed = decoded.trim();
  return trimmed !== "" && trimmed !== "." && trimmed !== ".." && !CONTROL.test(decoded);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
