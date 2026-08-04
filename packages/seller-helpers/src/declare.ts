import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

/**
 * Seller-side discovery declaration.
 *
 * The goal: helpers that let a resource server "declare discovery metadata correctly,
 * including per parameter descriptions that make an endpoint legible to an agent, with minimal
 * boilerplate". Two words there carry the weight:
 *
 * - **correctly** — the raw SDK helper is easy to misuse. It returns a `{ bazaar: … }` object that
 *   IS the extensions map; wrapping it in another `bazaar` key nests it twice and the facilitator
 *   silently refuses to catalog the listing. That mistake cost a debugging cycle here, and the
 *   shape of the API is what invites it. `describeEndpoint` returns a branded type so the wrong
 *   usage does not compile.
 *
 * - **per parameter descriptions** — an agent choosing between two weather APIs has nothing to go
 *   on but text. A parameter called `q` with no description is invisible to search and useless to
 *   an agent. So this helper takes descriptions as a **required** part of each parameter rather
 *   than an optional extra, and refuses to build a declaration without them.
 */

/** A single input parameter, described well enough for an agent to fill it in unaided. */
export interface ParamSpec {
  /** What this parameter is, in a sentence. Required — an undescribed parameter is unusable. */
  description: string;
  /** JSON Schema type. Defaults to "string". */
  type?: "string" | "number" | "integer" | "boolean" | "object" | "array";
  /** Whether the caller must supply it. Defaults to true. */
  required?: boolean;
  /** A realistic example. Used verbatim in the 402 challenge, so make it real. */
  example?: unknown;
  /** Closed set of permitted values, if any. */
  enum?: readonly string[];
}

export interface DescribeEndpointConfig {
  /** Input parameters, keyed by name. */
  params: Record<string, ParamSpec>;
  /** An example of what the endpoint returns. Strongly recommended — agents use it to plan. */
  outputExample?: unknown;
  /** For POST/PUT/PATCH: how the body is encoded. Presence switches to body-method shape. */
  bodyType?: "json" | "form-data" | "text";
}

export interface DescribeToolConfig {
  /** MCP tool name, matching what `tools/call` receives. */
  toolName: string;
  /** What the tool does. Required: this is the primary ranking signal for MCP resources. */
  description: string;
  params: Record<string, ParamSpec>;
  outputExample?: unknown;
  transport?: "streamable-http" | "sse";
}

/**
 * Branded so it cannot be double-wrapped.
 *
 * `extensions: describeEndpoint(...)` compiles; `extensions: { bazaar: describeEndpoint(...) }`
 * does not. That is the entire point — the failure it prevents is silent at runtime.
 */
export type DiscoveryExtensions = Record<string, unknown> & {
  readonly __x402StellarDiscovery: unique symbol;
};

function buildSchema(params: Record<string, ParamSpec>): {
  properties: Record<string, unknown>;
  required: string[];
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, spec] of Object.entries(params)) {
    if (!spec.description || !spec.description.trim()) {
      throw new Error(
        `Parameter "${name}" has no description. An agent choosing between services has only this ` +
          `text to go on, and an undescribed parameter is invisible to Bazaar search. Describe it ` +
          `in a sentence — e.g. { description: "Ticker symbol such as AAPL" }.`,
      );
    }
    properties[name] = {
      type: spec.type ?? "string",
      description: spec.description,
      ...(spec.enum ? { enum: [...spec.enum] } : {}),
    };
    if (spec.required !== false) required.push(name);
  }
  return { properties, required };
}

const examplesFrom = (params: Record<string, ParamSpec>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(params)) {
    if (spec.example !== undefined) out[name] = spec.example;
  }
  return out;
};

/**
 * Describe an HTTP endpoint for the Bazaar.
 *
 * Drop the result straight into a route's `extensions`. The HTTP method and any dynamic-route
 * template are filled in by `bazaarResourceServerExtension` at request time — do not set them here.
 *
 * @example
 * ```ts
 * extensions: describeEndpoint({
 *   params: {
 *     symbol: { description: "Ticker symbol to price, such as XLM or BTC.", example: "XLM" },
 *     currency: { description: "ISO 4217 code to quote in.", required: false, example: "USD" },
 *   },
 *   outputExample: { symbol: "XLM", price: 0.1234, currency: "USD" },
 * })
 * ```
 */
export function describeEndpoint(config: DescribeEndpointConfig): DiscoveryExtensions {
  const { properties, required } = buildSchema(config.params);
  const inputSchema = { type: "object" as const, properties, ...(required.length ? { required } : {}) };

  const base = {
    input: examplesFrom(config.params),
    inputSchema,
    ...(config.outputExample === undefined ? {} : { output: { example: config.outputExample } }),
  };

  const declared = config.bodyType
    ? declareDiscoveryExtension({ ...base, bodyType: config.bodyType })
    : declareDiscoveryExtension(base);

  return declared as unknown as DiscoveryExtensions;
}

/**
 * Describe an MCP tool for the Bazaar.
 *
 * MCP resources are keyed on the tuple (`resource.url`, `input.toolName`), because one MCP endpoint
 * multiplexes many tools — so `toolName` is identity, not decoration. Worth doing well: zero MCP
 * tools are cataloged anywhere in the ecosystem today, so a described tool has no competition.
 */
export function describeTool(config: DescribeToolConfig): DiscoveryExtensions {
  if (!config.description?.trim()) {
    throw new Error(
      `MCP tool "${config.toolName}" has no description. For MCP resources the description is the ` +
        `primary thing search ranks on — without it the tool is effectively undiscoverable.`,
    );
  }
  const { properties, required } = buildSchema(config.params);

  return declareDiscoveryExtension({
    toolName: config.toolName,
    description: config.description,
    ...(config.transport ? { transport: config.transport } : {}),
    inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
    example: examplesFrom(config.params),
    ...(config.outputExample === undefined ? {} : { output: { example: config.outputExample } }),
  }) as unknown as DiscoveryExtensions;
}
