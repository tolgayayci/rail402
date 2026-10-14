import type { PaymentRequirements, ResourceInfo } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { z } from "zod";
import { PUBNET } from "@rail402.dev/stellar";
import { sellerError } from "./codes.ts";
import {
  checkDescription,
  checkMetadata,
  checkOutput,
  checkPayment,
  networksOf,
  type OutputDeclaration,
  type ServiceMetadata,
} from "./common.ts";
import { compileParams, type JsonSchemaObject, type ParamSpec } from "./params.ts";
import type { PaymentOption } from "./price.ts";

/** Tool names a Rail402 buyer can call: MCP's recommended character set. */
const TOOL_NAME = /^[A-Za-z0-9_.\-/]{1,128}$/;
const MAX_ENDPOINT_LENGTH = 2_048;

export interface McpToolSpec extends ServiceMetadata {
  /** The public URL of the MCP server that serves the tool (https; http on testnet only). */
  readonly endpoint: string;
  readonly toolName: string;
  /** What the tool does, 1-1000 characters: the tool's and the listing's description. */
  readonly description: string;
  readonly payment: PaymentOption | readonly PaymentOption[];
  readonly arguments: Record<string, ParamSpec>;
  readonly output?: OutputDeclaration;
  readonly transport?: "streamable-http" | "sse";
}

/** A paid MCP tool with Bazaar discovery metadata. */
export interface McpToolDeclaration {
  readonly kind: "mcp";
  readonly endpoint: string;
  readonly toolName: string;
  readonly description: string;
  /** The tool's argument schema; identical to the listing's `info.input.inputSchema`. */
  readonly inputSchema: JsonSchemaObject;
  /** The same arguments as a zod shape, for `McpServer.registerTool({ inputSchema })`. */
  readonly zodShape: Readonly<Record<string, z.ZodType>>;
  readonly options: readonly PaymentOption[];
  /**
   * The parts of `@x402/mcp`'s `createPaymentWrapper` configuration the declaration fixes. Use
   * `mcpPaymentConfig` to turn the options into payment requirements.
   */
  readonly payment: {
    readonly resource: ResourceInfo;
    readonly extensions: Record<string, unknown>;
  };
}

/**
 * Declares a paid MCP tool whose discovery metadata the Rail402 catalog accepts as is. The
 * catalog keys MCP listings by endpoint and tool name, scoped to the payTo that settled.
 */
export function mcpTool(spec: McpToolSpec): McpToolDeclaration {
  const options = checkPayment(spec.payment);
  const endpoint = checkEndpoint(spec.endpoint, networksOf(options).has(PUBNET));
  if (typeof spec.toolName !== "string" || !TOOL_NAME.test(spec.toolName)) {
    throw sellerError(
      "seller_declaration_invalid",
      "toolName must be 1-128 letters, digits, dots, dashes, underscores or slashes.",
      { path: "toolName" },
    );
  }
  const description = checkDescription(spec.description);
  const metadata = checkMetadata(spec);
  const output = checkOutput(spec.output);
  const transport: unknown = spec.transport;
  if (transport !== undefined && transport !== "streamable-http" && transport !== "sse") {
    throw sellerError("seller_declaration_invalid", 'transport must be "streamable-http" or "sse".', {
      path: "transport",
    });
  }
  const args = compileParams(spec.arguments, "arguments");
  const complete = args.missingExamples.length === 0 && Object.keys(args.example).length > 0;
  const extensions = declareDiscoveryExtension({
    toolName: spec.toolName,
    description,
    ...(spec.transport === undefined ? {} : { transport: spec.transport }),
    inputSchema: { ...args.schema },
    ...(complete ? { example: { ...args.example } } : {}),
    ...(output === undefined ? {} : { output }),
  });
  const resource: ResourceInfo = {
    url: endpoint,
    description,
    mimeType: metadata.mimeType ?? "application/json",
    ...(metadata.serviceName === undefined ? {} : { serviceName: metadata.serviceName }),
    ...(metadata.tags === undefined ? {} : { tags: metadata.tags }),
    ...(metadata.iconUrl === undefined ? {} : { iconUrl: metadata.iconUrl }),
  };
  return Object.freeze({
    kind: "mcp",
    endpoint,
    toolName: spec.toolName,
    description,
    inputSchema: args.schema,
    zodShape: args.zodShape,
    options: Object.freeze(options),
    payment: { resource, extensions },
  });
}

export function isMcpToolDeclaration(value: unknown): value is McpToolDeclaration {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "mcp" &&
    typeof (value as { toolName?: unknown }).toolName === "string"
  );
}

/** The part of `x402ResourceServer` that builds payment requirements. */
export interface PaymentRequirementsBuilder {
  buildPaymentRequirements(option: PaymentOption): Promise<PaymentRequirements[]>;
}

/**
 * The configuration for `@x402/mcp`'s `createPaymentWrapper(server, config)`: the tool's options as
 * payment requirements (fee sponsorship read from the facilitator), its resource and its extensions.
 * Call it after `server.initialize()`.
 */
export async function mcpPaymentConfig(
  server: PaymentRequirementsBuilder,
  tool: McpToolDeclaration,
): Promise<{ accepts: PaymentRequirements[]; resource: ResourceInfo; extensions: Record<string, unknown> }> {
  const accepts: PaymentRequirements[] = [];
  for (const option of tool.options) {
    accepts.push(
      ...(await server.buildPaymentRequirements({
        ...option,
        price: { ...option.price },
        ...(option.extra === undefined ? {} : { extra: { ...option.extra } }),
      })),
    );
  }
  return { accepts, resource: { ...tool.payment.resource }, extensions: tool.payment.extensions };
}

function checkEndpoint(value: unknown, pubnet: boolean): string {
  const refuse = (reason?: string) => sellerError("seller_endpoint_invalid", reason, { path: "endpoint" });
  if (typeof value !== "string" || value.length > MAX_ENDPOINT_LENGTH) throw refuse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw refuse();
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw refuse();
  if (url.protocol === "http:" && pubnet) {
    throw refuse("A tool paid on pubnet must be served over https.");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") throw refuse();
  return url.href;
}
