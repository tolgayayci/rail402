import { isValidIconUrl, isValidServiceName, sanitizeTags } from "@x402/extensions/bazaar";
import type { StellarNetwork } from "@rail402.dev/stellar";
import { sellerError } from "./codes.ts";
import { referenceIn, type JsonSchemaObject } from "./params.ts";
import type { PaymentOption } from "./price.ts";

/** The longest listing description the Rail402 catalog keeps. */
export const MAX_DESCRIPTION_LENGTH = 1_000;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}(?:\s*;.{0,128})?$/i;
const MAX_OUTPUT_BYTES = 16_384;

/** Resource metadata shared by routes and tools; each field is checked the way the catalog checks it. */
export interface ServiceMetadata {
  readonly mimeType?: string;
  readonly serviceName?: string;
  /** At most 5 distinct tags of 1-32 printable ASCII characters. */
  readonly tags?: readonly string[];
  readonly iconUrl?: string;
}

export interface OutputDeclaration {
  /** A JSON object the resource returns: it becomes the listing's output example. */
  readonly example: Record<string, unknown>;
  /** A self-contained JSON Schema (no `$ref`) the example satisfies. */
  readonly schema?: Record<string, unknown>;
}

export function checkDescription(value: unknown, path = "description"): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text === "" || text.length > MAX_DESCRIPTION_LENGTH || hasControl(text)) {
    throw sellerError(
      "seller_declaration_invalid",
      `${path} must be 1-${String(MAX_DESCRIPTION_LENGTH)} characters without control characters.`,
      { path },
    );
  }
  return text;
}

/** Metadata the catalog would soft-drop is refused here, so what is declared is what is listed. */
export function checkMetadata(metadata: ServiceMetadata): {
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
} {
  const { mimeType, serviceName, tags, iconUrl } = metadata;
  if (mimeType !== undefined && (typeof mimeType !== "string" || !MIME_TYPE.test(mimeType))) {
    throw invalid("mimeType", "is not a media type such as application/json");
  }
  if (serviceName !== undefined && !isValidServiceName(serviceName)) {
    throw invalid("serviceName", "must be 1-32 printable ASCII characters");
  }
  let cleanTags: string[] | undefined;
  if (tags !== undefined) {
    cleanTags = sanitizeTags(tags);
    if (!Array.isArray(tags) || cleanTags?.length !== tags.length) {
      throw invalid("tags", "must be at most 5 distinct tags of 1-32 printable ASCII characters");
    }
  }
  if (iconUrl !== undefined && !isValidIconUrl(iconUrl)) {
    throw invalid("iconUrl", "must be a public http(s) URL to an image");
  }
  return {
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(serviceName === undefined ? {} : { serviceName }),
    ...(cleanTags === undefined ? {} : { tags: cleanTags }),
    ...(iconUrl === undefined ? {} : { iconUrl }),
  };
}

/** One option or several, each built with `exact()` or `upto()`. */
export function checkPayment(payment: unknown): PaymentOption[] {
  const options = Array.isArray(payment) ? [...(payment as unknown[])] : [payment];
  if (options.length === 0 || options.length > 8) {
    throw invalid("payment", "needs 1-8 payment options");
  }
  for (const option of options) {
    if (
      option === null ||
      typeof option !== "object" ||
      typeof (option as PaymentOption).scheme !== "string" ||
      typeof (option as PaymentOption).price !== "object"
    ) {
      throw invalid("payment", "options must be built with exact() or upto()");
    }
  }
  return options as PaymentOption[];
}

export function networksOf(options: readonly PaymentOption[]): Set<StellarNetwork> {
  return new Set(options.map((option) => option.network));
}

export function checkOutput(output: unknown): OutputDeclaration | undefined {
  if (output === undefined) return undefined;
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    throw invalid("output", "must be { example, schema? }");
  }
  const { example, schema } = output as { example?: unknown; schema?: unknown };
  if (example === null || typeof example !== "object" || Array.isArray(example)) {
    // Upstream's discovery schema types the output example as an object.
    throw invalid("output.example", "must be a JSON object");
  }
  if (schema !== undefined) {
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
      throw invalid("output.schema", "must be a JSON Schema object");
    }
    const reference = referenceIn(schema);
    if (reference !== undefined) {
      throw invalid("output.schema", `must be self-contained; it uses ${reference}`);
    }
  }
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify({ example, schema }), "utf8");
  } catch {
    throw invalid("output", "must be JSON");
  }
  if (size > MAX_OUTPUT_BYTES) {
    throw invalid("output", `must serialize to at most ${String(MAX_OUTPUT_BYTES)} bytes`);
  }
  return {
    example: example as Record<string, unknown>,
    ...(schema === undefined ? {} : { schema: schema as Record<string, unknown> }),
  };
}

export type { JsonSchemaObject };

function hasControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return true;
  }
  return false;
}

function invalid(path: string, problem: string) {
  return sellerError("seller_declaration_invalid", `${path} ${problem}.`, { path });
}
