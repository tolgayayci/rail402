import type { HTTPRequestContext } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { SchemaSandbox, bazaarCodes, extractCandidate, type BazaarCode } from "@rail402.dev/bazaar";
import { isStellarNetwork, type StellarNetwork } from "@rail402.dev/stellar";
import type { HttpMethod } from "../flow/types.ts";
import { sellerCodes, sellerError, type SellerCode } from "./codes.ts";
import { isHttpRouteDeclaration, type HttpRouteDeclaration } from "./http.ts";
import { isMcpToolDeclaration, type McpToolDeclaration } from "./mcp.ts";
import type { PaymentOption } from "./price.ts";

export interface ValidateListingOptions {
  /** The network whose payment option is cataloged. */
  readonly network: StellarNetwork;
  /**
   * The URL a buyer pays for an HTTP route, such as "https://api.example.com/forecast/Ankara". Without
   * it, the route's example path on https://example.com stands in.
   */
  readonly concreteUrl?: string;
  /** The method of a live PaymentRequired whose discovery metadata does not name one. */
  readonly method?: HttpMethod;
  /** Accept loopback URLs, as a Rail402 configured for local development does. */
  readonly allowLoopback?: boolean;
  /** A schema sandbox to reuse; one is started and closed per call otherwise. */
  readonly sandbox?: SchemaSandbox;
}

export interface LintFinding {
  readonly code: SellerCode;
  /** Where in the discovery metadata, e.g. "input.queryParams.city". */
  readonly path: string;
  readonly reason: string;
}

export interface ListingPreview {
  readonly resource: string;
  readonly type: "http" | "mcp";
  readonly method?: string;
  readonly toolName?: string;
  readonly routeTemplate?: string;
  readonly payTo: string;
  readonly asset: string;
  /** Base units. */
  readonly amount: string;
}

export interface ValidationReport {
  /** The Rail402 catalog would list this resource after a settlement. */
  readonly catalogable: boolean;
  /** Why not, when not catalogable: a `bazaar_*` code of the catalog, or a seller code. */
  readonly code?: BazaarCode | SellerCode;
  readonly reason?: string;
  /** Metadata fields the catalog would leave out. */
  readonly dropped: readonly string[];
  /** Advice that does not stop cataloging. */
  readonly lint: readonly LintFinding[];
  readonly preview?: ListingPreview;
}

const EXAMPLE_ORIGIN = "https://example.com";
const DEFAULT_TIMEOUT_SECONDS = 300;

/**
 * Checks discovery metadata with the Rail402 catalog's own code: the same extraction, schema sandbox
 * and soft-drop rules a settlement goes through. Input is a declaration from `httpRoute` or `mcpTool`,
 * or a live PaymentRequired (as a seller's 402 carries it).
 */
export async function validateListing(
  input: HttpRouteDeclaration | McpToolDeclaration | PaymentRequired,
  options: ValidateListingOptions,
): Promise<ValidationReport> {
  if (!isStellarNetwork(options.network)) throw sellerError("seller_network_unsupported");
  const required = paymentRequiredOf(input, options);
  const accepted = required.accepts.find((option) => option.network === options.network);
  if (accepted === undefined) {
    return {
      catalogable: false,
      code: "seller_network_unsupported",
      reason: `No payment option is on ${options.network}.`,
      dropped: [],
      lint: [],
    };
  }
  const extensions = required.extensions ?? {};
  const lint = lintExtension(extensions["bazaar"]);
  const payload: PaymentPayload = {
    x402Version: required.x402Version,
    resource: required.resource,
    accepted,
    payload: {},
    extensions,
  };

  const sandbox = options.sandbox ?? new SchemaSandbox();
  try {
    const extraction = await extractCandidate(
      // As an origin check does it: no payer and no transaction, the content is the seller's own.
      { payload, requirements: accepted, payer: "", transaction: "" },
      { sandbox, allowLoopback: options.allowLoopback === true },
    );
    if (extraction.kind === "absent") {
      return {
        catalogable: false,
        code: "seller_discovery_missing",
        reason: sellerCodes.seller_discovery_missing.reason,
        dropped: [],
        lint,
      };
    }
    if (extraction.kind === "rejected") {
      return {
        catalogable: false,
        code: extraction.code,
        reason: extraction.reason === "" ? bazaarCodes[extraction.code].reason : extraction.reason,
        dropped: [],
        lint,
      };
    }
    const { identity, content, dropped } = extraction.candidate;
    const [option] = content.accepts;
    return {
      catalogable: true,
      dropped,
      lint,
      preview: {
        resource: identity.resource,
        type: identity.kind,
        ...(identity.kind === "http" ? { method: identity.method } : { toolName: identity.toolName }),
        ...(content.bazaar.routeTemplate === undefined
          ? {}
          : { routeTemplate: content.bazaar.routeTemplate }),
        payTo: option?.payTo ?? accepted.payTo,
        asset: option?.asset ?? accepted.asset,
        amount: option?.amount ?? accepted.amount,
      },
    };
  } finally {
    if (options.sandbox === undefined) await sandbox.close();
  }
}

/** What a seller's 402 would carry for a declaration, or the given PaymentRequired. */
function paymentRequiredOf(
  input: HttpRouteDeclaration | McpToolDeclaration | PaymentRequired,
  options: ValidateListingOptions,
): PaymentRequired {
  if (isHttpRouteDeclaration(input)) {
    const url = new URL(options.concreteUrl ?? `${EXAMPLE_ORIGIN}${input.examplePath}`);
    const { config } = input;
    const extensions = { ...config.extensions };
    // What bazaarResourceServerExtension adds per request: the method and the route template.
    extensions["bazaar"] = enrich(extensions["bazaar"], input.method, url.pathname, input.path);
    return {
      x402Version: 2,
      resource: {
        url: url.href,
        ...(config.description === undefined ? {} : { description: config.description }),
        ...(config.mimeType === undefined ? {} : { mimeType: config.mimeType }),
        ...(config.serviceName === undefined ? {} : { serviceName: config.serviceName }),
        ...(config.tags === undefined ? {} : { tags: config.tags }),
        ...(config.iconUrl === undefined ? {} : { iconUrl: config.iconUrl }),
      },
      accepts: input.options.map(requirementsOf),
      extensions,
    };
  }
  if (isMcpToolDeclaration(input)) {
    return {
      x402Version: 2,
      resource: { ...input.payment.resource },
      accepts: input.options.map(requirementsOf),
      extensions: { ...input.payment.extensions },
    };
  }
  const candidate: unknown = input;
  if (candidate === null || typeof candidate !== "object" || !Array.isArray(input.accepts)) {
    throw sellerError(
      "seller_declaration_invalid",
      "Pass an httpRoute() or mcpTool() declaration, or an x402 PaymentRequired.",
    );
  }
  const bazaar = input.extensions?.["bazaar"];
  const info = field(field(bazaar, "info"), "input");
  if (options.method !== undefined && field(info, "type") === "http" && field(info, "method") === undefined) {
    const url = new URL(input.resource.url);
    return {
      ...input,
      extensions: { ...input.extensions, bazaar: enrich(bazaar, options.method, url.pathname, undefined) },
    };
  }
  return input;
}

function enrich(
  declaration: unknown,
  method: string,
  path: string,
  routePattern: string | undefined,
): unknown {
  const context = {
    method,
    path,
    ...(routePattern === undefined ? {} : { routePattern }),
    adapter: { getPath: () => path },
  } as unknown as HTTPRequestContext;
  return bazaarResourceServerExtension.enrichDeclaration?.(declaration, context) ?? declaration;
}

function requirementsOf(option: PaymentOption): PaymentRequirements {
  return {
    scheme: option.scheme,
    network: option.network,
    asset: option.price.asset,
    amount: option.price.amount,
    payTo: option.payTo,
    maxTimeoutSeconds: option.maxTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    // What the stock server adds from a fee-sponsoring facilitator's /supported.
    extra: { ...option.price.extra, ...option.extra, areFeesSponsored: true },
  };
}

/**
 * Advice for agents' sake: parameters without descriptions (at any depth) and a missing output
 * example. Neither stops cataloging.
 */
function lintExtension(extension: unknown): LintFinding[] {
  const findings: LintFinding[] = [];
  const info = field(extension, "info");
  const input = field(info, "input");
  if (input === undefined) return findings;
  const schema = field(field(field(field(extension, "schema"), "properties"), "input"), "properties");
  if (field(input, "type") === "mcp") {
    describeProperties(field(input, "inputSchema"), "input.inputSchema", findings);
  } else {
    for (const part of ["queryParams", "body", "pathParams"]) {
      describeProperties(field(schema, part), `input.${part}`, findings);
    }
  }
  if (field(field(info, "output"), "example") === undefined) {
    findings.push({
      code: "seller_output_example_missing",
      path: "output.example",
      reason: sellerCodes.seller_output_example_missing.reason,
    });
  }
  return findings;
}

function describeProperties(schema: unknown, path: string, findings: LintFinding[], depth = 0): void {
  if (depth > 8 || findings.length >= 50) return;
  const properties = field(schema, "properties");
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [name, property] of Object.entries(properties as Record<string, unknown>)) {
      const at = `${path}.${name}`;
      const description = field(property, "description");
      if (typeof description !== "string" || description.trim() === "") {
        findings.push({
          code: "seller_param_description_missing",
          path: at,
          reason: `${at} has no description.`,
        });
      }
      describeProperties(property, at, findings, depth + 1);
    }
  }
  const items = field(schema, "items");
  if (items !== undefined) describeProperties(items, `${path}[]`, findings, depth + 1);
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
