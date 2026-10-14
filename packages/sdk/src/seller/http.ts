import type { RouteConfig } from "@x402/core/http";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { HttpMethod } from "../flow/types.ts";
import { sellerError } from "./codes.ts";
import {
  checkDescription,
  checkMetadata,
  checkOutput,
  checkPayment,
  type OutputDeclaration,
  type ServiceMetadata,
} from "./common.ts";
import { compileParams, isParamSpec, type CompiledParams, type ParamSpec } from "./params.ts";
import type { PaymentOption } from "./price.ts";

const QUERY_METHODS = new Set<HttpMethod>(["GET", "HEAD", "DELETE"]);
const BODY_METHODS = new Set<HttpMethod>(["POST", "PUT", "PATCH"]);
const MAX_PATH_LENGTH = 512;
const PATH_PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)$/;
const LITERAL_SEGMENT = /^[A-Za-z0-9._~!$&'()+,;=@%-]*$/;

export interface HttpRouteSpec extends ServiceMetadata {
  readonly method: HttpMethod;
  /** An Express-style path; `:name` segments are path parameters ("/forecast/:city"). */
  readonly path: string;
  /** What the resource returns, 1-1000 characters: the listing's description. */
  readonly description: string;
  readonly payment: PaymentOption | readonly PaymentOption[];
  /** Query parameters (GET, HEAD, DELETE). A required one needs an example. */
  readonly query?: Record<string, ParamSpec>;
  /** One declaration per `:name` segment, each a string or enum; path parameters are always required. */
  readonly pathParams?: Record<string, ParamSpec>;
  /** The request body (POST, PUT, PATCH). A required field needs an example. */
  readonly body?: {
    readonly type: "json" | "form-data" | "text";
    readonly params: Record<string, ParamSpec>;
  };
  readonly output?: OutputDeclaration;
}

/** A paid HTTP route with Bazaar discovery metadata, ready for the stock x402 middleware. */
export interface HttpRouteDeclaration {
  readonly kind: "http";
  /** The middleware route key, "GET /forecast/:city". */
  readonly key: string;
  readonly method: HttpMethod;
  readonly path: string;
  /** The path with each parameter replaced by its example, e.g. "/forecast/Ankara". */
  readonly examplePath: string;
  readonly options: readonly PaymentOption[];
  /**
   * The route configuration for `paymentMiddleware({ [route.key]: route.config }, server)` of
   * `@x402/express`, `@x402/hono` or `@x402/next`. The resource server must register
   * `bazaarResourceServerExtension` so the method and route template are filled in per request.
   */
  readonly config: RouteConfig;
}

/**
 * Declares a paid HTTP route with discovery metadata the Rail402 catalog accepts as is: every
 * parameter described, examples that satisfy their schemas, no `$ref`, no field the catalog would
 * drop. Throws `seller_param_description_required` or `seller_declaration_invalid` otherwise.
 */
export function httpRoute(spec: HttpRouteSpec): HttpRouteDeclaration {
  const method = typeof spec.method === "string" ? (spec.method.toUpperCase() as HttpMethod) : undefined;
  if (method === undefined || (!QUERY_METHODS.has(method) && !BODY_METHODS.has(method))) {
    throw invalid("method", "must be GET, HEAD, DELETE, POST, PUT or PATCH");
  }
  const description = checkDescription(spec.description);
  const metadata = checkMetadata(spec);
  const options = checkPayment(spec.payment);
  const output = checkOutput(spec.output);
  const { names, path } = parsePath(spec.path);
  const pathParams = compilePathParams(spec.pathParams, names);

  if (QUERY_METHODS.has(method) && spec.body !== undefined) {
    throw invalid("body", `${method} requests carry no body; declare query parameters instead`);
  }
  if (BODY_METHODS.has(method) && spec.query !== undefined) {
    // Upstream's body declaration has no place for query parameters.
    throw invalid("query", `${method} routes declare their input as a body`);
  }

  let extension: Record<string, unknown>;
  if (QUERY_METHODS.has(method)) {
    const query = compileParams(spec.query, "query");
    requireExamples(query);
    extension = declareDiscoveryExtension({
      input: { ...query.example },
      inputSchema: { ...query.schema },
      ...(pathParams === undefined ? {} : { pathParamsSchema: { ...pathParams.schema } }),
      ...(output === undefined ? {} : { output }),
    });
  } else {
    const bodyType = spec.body?.type ?? "json";
    if (!["json", "form-data", "text"].includes(bodyType)) {
      throw invalid("body.type", 'must be "json", "form-data" or "text"');
    }
    const body = compileParams(spec.body?.params, "body");
    requireExamples(body);
    extension = declareDiscoveryExtension({
      bodyType,
      input: { ...body.example },
      inputSchema: { ...body.schema },
      ...(pathParams === undefined ? {} : { pathParamsSchema: { ...pathParams.schema } }),
      ...(output === undefined ? {} : { output }),
    });
  }

  const examplePath = path
    .split("/")
    .map((segment) => {
      const name = PATH_PARAM.exec(segment)?.[1];
      if (name === undefined) return segment;
      const example = pathParams?.example[name];
      return encodeURIComponent(typeof example === "string" ? example : name);
    })
    .join("/");

  const config: RouteConfig = {
    accepts: options.map(copyOption),
    description,
    mimeType: metadata.mimeType ?? "application/json",
    ...(metadata.serviceName === undefined ? {} : { serviceName: metadata.serviceName }),
    ...(metadata.tags === undefined ? {} : { tags: metadata.tags }),
    ...(metadata.iconUrl === undefined ? {} : { iconUrl: metadata.iconUrl }),
    extensions: extension,
  };
  return Object.freeze({
    kind: "http",
    key: `${method} ${path}`,
    method,
    path,
    examplePath,
    options: Object.freeze(options),
    config,
  });
}

export function isHttpRouteDeclaration(value: unknown): value is HttpRouteDeclaration {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "http" &&
    typeof (value as { key?: unknown }).key === "string"
  );
}

function copyOption(option: PaymentOption): PaymentOption {
  return {
    ...option,
    price: { ...option.price },
    ...(option.extra === undefined ? {} : { extra: { ...option.extra } }),
  };
}

function parsePath(value: unknown): { names: string[]; path: string } {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > MAX_PATH_LENGTH) {
    throw invalid("path", `must start with "/" and be at most ${String(MAX_PATH_LENGTH)} characters`);
  }
  const names: string[] = [];
  for (const segment of value.split("/").slice(1)) {
    const name = PATH_PARAM.exec(segment)?.[1];
    if (name !== undefined) {
      if (names.includes(name)) throw invalid("path", `names the parameter :${name} twice`);
      names.push(name);
      continue;
    }
    if (segment === "." || segment === ".." || !LITERAL_SEGMENT.test(segment) || segment.includes(":")) {
      throw invalid(
        "path",
        `has an unsupported segment "${segment.slice(0, 40)}"; use literal segments and whole :name parameters`,
      );
    }
  }
  return { names, path: value };
}

function compilePathParams(value: unknown, names: readonly string[]): CompiledParams | undefined {
  const raw: unknown = value ?? {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("pathParams", "must be a map of parameter names to param.* declarations");
  }
  const declared = raw as Record<string, unknown>;
  for (const name of names) {
    if (!Object.hasOwn(declared, name)) {
      throw sellerError(
        "seller_param_description_required",
        `pathParams.${name} needs a declaration with a description.`,
        { path: `pathParams.${name}` },
      );
    }
  }
  for (const name of Object.keys(declared)) {
    if (!names.includes(name)) throw invalid(`pathParams.${name}`, "is not a :name segment of the path");
  }
  if (names.length === 0) return undefined;
  const compiled = compileParams(declared, "pathParams");
  for (const name of names) {
    const entry = declared[name];
    const schema = compiled.properties[name];
    // A path parameter reaches the catalog as the string it was in the URL.
    if (!isParamSpec(entry) || schema?.["type"] !== "string") {
      throw invalid(`pathParams.${name}`, "must be param.string or param.enum");
    }
  }
  // Path parameters are always present: the route does not match without them.
  return { ...compiled, required: names, schema: { ...compiled.schema, required: [...names] } };
}

function requireExamples(compiled: CompiledParams): void {
  const [first] = compiled.missingExamples;
  if (first === undefined) return;
  throw invalid(
    first,
    "is required and needs an example: the Bazaar validates the listing's example input against its schema",
  );
}

function invalid(path: string, problem: string) {
  return sellerError("seller_declaration_invalid", `${path} ${problem}.`, { path });
}
