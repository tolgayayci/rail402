import { stemmer } from "stemmer";
import type { Listing } from "@rail402.dev/bazaar";

/**
 * English stopwords and conversational filler ("how much", "please"), plus words that appear in
 * almost every x402 listing and so carry no signal ("api", "endpoint", "x402", "request"). Payment
 * words stay: in a payments ecosystem "payment", "remittance" and "invoice" name what a service does.
 * Compared after stemming, so every inflection of a stopword is dropped alike.
 */
const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have i if in into is it its of on or that the their them " +
    "then there these they this to was were what when where which while who will with you your can do " +
    "does did get give me my need want find show some any all about via per how much many please those " +
    "than api endpoint service x402 request"
  )
    .split(" ")
    .map((word) => stemmer(word)),
);

/** Splits camelCase and PascalCase boundaries before lower-casing: "getWeather" → "get Weather". */
function splitCase(text: string): string {
  return text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2");
}

/** Normalised, stopword-free, stemmed tokens. Identifiers like `get_weather_v2` split into words. */
export function tokenize(text: string): string[] {
  const words = splitCase(text.normalize("NFKC"))
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u);
  const tokens: string[] = [];
  for (const word of words) {
    if (word === "" || (word.length === 1 && !/\p{N}/u.test(word))) continue;
    const token = /^\p{N}+$/u.test(word) ? word : stemmer(word);
    if (!STOPWORDS.has(token)) tokens.push(token);
  }
  return tokens;
}

export type Field = "name" | "tags" | "description" | "schema" | "host";

/** Relative importance of each field in the lexical score (BM25F field weights). */
export const FIELD_WEIGHTS: Readonly<Record<Field, number>> = {
  name: 3,
  tags: 2,
  description: 1.5,
  schema: 1,
  host: 0.5,
};

export interface SearchDocument {
  readonly id: string;
  readonly fields: Readonly<Record<Field, readonly string[]>>;
  /** The text embedded for semantic search. */
  readonly embeddingText: string;
}

const HOST_NOISE = new Set(["www", "api", "com", "org", "net", "io", "dev", "app", "xyz", "co", "ai"]);

/** Builds the searchable representation of a listing. Only listing content is used, never payment data. */
export function toDocument(listing: Listing): SearchDocument {
  const { content } = listing;
  const input = (content.bazaar.info["input"] ?? {}) as Record<string, unknown>;
  const output = (content.bazaar.info["output"] ?? {}) as Record<string, unknown>;

  let pathWords = "";
  let host = "";
  try {
    const url = new URL(content.resource);
    pathWords = url.pathname
      .split("/")
      .filter((segment) => segment !== "" && !segment.startsWith(":") && !/^v\d+$/i.test(segment))
      .join(" ");
    host = url.hostname
      .split(".")
      .filter((label) => !HOST_NOISE.has(label))
      .join(" ");
  } catch {
    // Unparseable resources contribute no path or host words.
  }

  const name = [content.serviceName ?? "", content.toolName ?? "", pathWords].join(" ");
  const tags = (content.tags ?? []).join(" ");
  const description = [
    content.description ?? "",
    typeof input["description"] === "string" ? input["description"] : "",
  ].join(" ");
  const parameters = schemaWords(input, output);
  const prose = schemaProse(content.bazaar.schema);
  const schema = [...parameters, ...prose].join(" ");

  const embeddingParts = [
    content.serviceName,
    content.toolName === undefined ? pathWords : content.toolName.replace(/[_-]+/g, " "),
    content.description,
    typeof input["description"] === "string" ? input["description"] : undefined,
    tags === "" ? undefined : `Tags: ${tags}`,
    parameters.length === 0 ? undefined : `Inputs: ${parameters.join(" ")}`,
    prose.length === 0 ? undefined : prose.join(". "),
  ].filter((part): part is string => part !== undefined && part.trim() !== "");

  return {
    id: listing.id,
    fields: {
      name: tokenize(name),
      tags: tokenize(tags),
      description: tokenize(description),
      schema: tokenize(schema),
      host: tokenize(host),
    },
    embeddingText: embeddingParts.join(". ").slice(0, 1_000),
  };
}

/** Parameter names and their descriptions from the discovery info: what an agent would pass. */
function schemaWords(input: Record<string, unknown>, output: Record<string, unknown>): string[] {
  const words: string[] = [];
  const collect = (value: unknown, depth: number) => {
    if (depth > 4 || value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "properties" && child !== null && typeof child === "object") {
        for (const [property, definition] of Object.entries(child as Record<string, unknown>)) {
          words.push(property);
          const description = (definition as Record<string, unknown> | null)?.["description"];
          if (typeof description === "string") words.push(description);
          collect(definition, depth + 1);
        }
      }
    }
  };
  for (const key of ["queryParams", "body", "pathParams"]) {
    const example = input[key];
    if (example !== null && typeof example === "object") words.push(...Object.keys(example));
  }
  collect(input["inputSchema"], 0);
  const outputExample = output["example"];
  if (outputExample !== null && typeof outputExample === "object" && !Array.isArray(outputExample)) {
    words.push(...Object.keys(outputExample));
  }
  return words;
}

/**
 * Descriptions and titles from the bazaar extension's JSON Schema. HTTP sellers describe their
 * parameters there rather than in `info`, so without it their parameter prose would be lost. Prose
 * only: property names and enums are already covered or are noise.
 */
function schemaProse(schema: Readonly<Record<string, unknown>>): string[] {
  const prose: string[] = [];
  const seen = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (depth > 8 || value === null || typeof value !== "object" || prose.length >= 64) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "description" || key === "title") && typeof child === "string") {
        const text = child.trim();
        if (text !== "" && !seen.has(text)) {
          seen.add(text);
          prose.push(text.slice(0, 300));
        }
      } else if (key !== "enum" && key !== "const" && key !== "examples" && key !== "default") {
        walk(child, depth + 1);
      }
    }
  };
  walk(schema, 0);
  return prose;
}
