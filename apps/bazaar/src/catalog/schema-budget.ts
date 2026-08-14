/**
 * Budget a client-supplied JSON Schema before it reaches the stock validator.
 *
 * `validateDiscoveryExtension` (from `@x402/extensions`) validates the extension's `info` against
 * its own declared `schema` by compiling that schema with Ajv, which builds the validator with
 * `new Function(...)`. A hostile client controls the schema, so an unbounded schema carrying a
 * catastrophic-backtracking `pattern` (the classic `^(a+)+$`) turns automatic cataloging into a
 * ReDoS: on a single-threaded Node host one crafted listing wedges `/verify`, `/settle`, `/health`
 * and discovery process-wide, and cataloging is reachable by anyone who can get a payment to verify.
 *
 * This bounds the schema BEFORE compilation, and does it without eval: a serialised-size cap, a
 * nesting-depth cap, and a refusal of the regex-bearing keywords (`pattern`, `patternProperties`).
 * A discovery schema describes an endpoint's parameters so an agent can read them; it never needs a
 * regex to do that, and a seller's own endpoint keeps whatever validation it likes. The stock
 * validator still runs afterwards on everything that passes here, so our accept/reject verdicts stay
 * identical to every other facilitator's on every non-pathological schema.
 */

export interface SchemaBudget {
  /** Reject a schema whose JSON serialisation exceeds this many bytes. */
  readonly maxBytes: number;
  /** Reject a schema nested deeper than this. */
  readonly maxDepth: number;
}

/** Generous enough that only a pathological schema trips it; a real discovery schema is well under. */
export const DEFAULT_SCHEMA_BUDGET: SchemaBudget = { maxBytes: 32_768, maxDepth: 20 };

/** Keywords whose value Ajv compiles into a regular expression. These are the ReDoS surface. */
const REGEX_KEYWORDS = new Set(["pattern", "patternProperties"]);

export type SchemaBudgetResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * `{ ok: true }` for an absent schema (nothing to compile) or one within budget; `{ ok: false, reason }`
 * for a schema that is too large, too deeply nested, or carries a regex keyword. Never throws, and
 * never executes a `pattern` value — a forbidden keyword is refused on its presence, not by running it.
 */
export function budgetClientSchema(
  schema: unknown,
  budget: SchemaBudget = DEFAULT_SCHEMA_BUDGET,
): SchemaBudgetResult {
  if (schema === undefined || schema === null) return { ok: true };

  const serialized = safeStringify(schema);
  if (serialized === undefined) return { ok: false, reason: "schema is not a JSON value" };
  if (serialized.length > budget.maxBytes) {
    return { ok: false, reason: `schema is ${serialized.length} bytes, over the ${budget.maxBytes}-byte limit` };
  }

  return walk(schema, 0, budget);
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function walk(node: unknown, depth: number, budget: SchemaBudget): SchemaBudgetResult {
  if (depth > budget.maxDepth) {
    return { ok: false, reason: `schema nests deeper than the ${budget.maxDepth}-level limit` };
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = walk(item, depth + 1, budget);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (REGEX_KEYWORDS.has(key)) {
        return {
          ok: false,
          reason: `schema uses "${key}"; a catalog schema may not carry a regular expression, which a crafted value could make validation unbounded on`,
        };
      }
      // bazaar.md "Schema Validation" (@ 2026-08-04): `$ref` and `$id` values must be same-document
      // JSON Pointer fragments (starting with `#`); external references (`http(s)://`, `file://`, or
      // any other absolute/relative URI) are not allowed. An external `$ref` makes Ajv resolve — or
      // attempt to fetch — a remote schema, and an external `$id` rebases resolution; both are a
      // schema-injection / SSRF surface on a free, unauthenticated cataloging path. Refuse before the
      // stock validator (Ajv) ever compiles it.
      if ((key === "$ref" || key === "$id") && typeof value === "string" && !value.startsWith("#")) {
        return {
          ok: false,
          reason: `schema "${key}" is ${JSON.stringify(value)}; $ref and $id must be same-document fragments starting with "#", never an external URI`,
        };
      }
      const r = walk(value, depth + 1, budget);
      if (!r.ok) return r;
    }
  }
  return { ok: true };
}
