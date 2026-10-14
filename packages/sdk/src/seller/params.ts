import { z } from "zod";
import { sellerError } from "./codes.ts";

/**
 * Parameter declarations for paid routes and tools. One declaration yields both the JSON Schema that
 * goes into the Bazaar metadata and the zod type an MCP server validates arguments with, so the two
 * never drift. Schemas are self-contained: no `$ref`, no `$id`.
 */

/** A JSON Schema object as the helpers produce it. */
export type JsonSchemaObject = Readonly<Record<string, unknown>>;

export interface ParamOptions<T> {
  /** What the parameter means, 1-300 characters. Required at every depth. */
  readonly description: string;
  /** Optional unless set (JSON Schema's default). A required HTTP parameter needs an `example`. */
  readonly required?: boolean;
  /** A valid value: it becomes the example input in the Bazaar listing. */
  readonly example?: T;
}

export interface StringParamOptions extends ParamOptions<string> {
  readonly minLength?: number;
  readonly maxLength?: number;
  /** An ECMAScript regular expression (without delimiters) the whole value must match. */
  readonly pattern?: string;
  /** A JSON Schema format annotation ("date", "uri", …); informative, not enforced. */
  readonly format?: string;
}

export interface NumberParamOptions extends ParamOptions<number> {
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface ArrayParamOptions extends ParamOptions<unknown[]> {
  readonly maxItems?: number;
}

type ParamNode =
  | ({ readonly kind: "string" } & StringParamOptions)
  | ({ readonly kind: "number" | "integer" } & NumberParamOptions)
  | ({ readonly kind: "boolean" } & ParamOptions<boolean>)
  | ({ readonly kind: "enum"; readonly values: readonly string[] } & ParamOptions<string>)
  | ({ readonly kind: "array"; readonly items: ParamSpec } & ArrayParamOptions)
  | ({
      readonly kind: "object";
      readonly properties: Readonly<Record<string, ParamSpec>>;
    } & ParamOptions<object>);

const NODE: unique symbol = Symbol("rail402.param");

/** A declared parameter. Build it with `param.*`; a raw JSON Schema is not accepted. */
export interface ParamSpec {
  readonly [NODE]: ParamNode;
}

function spec(node: ParamNode): ParamSpec {
  return Object.freeze({ [NODE]: Object.freeze({ ...node }) });
}

export const param = {
  string: (options: StringParamOptions): ParamSpec => spec({ kind: "string", ...options }),
  number: (options: NumberParamOptions): ParamSpec => spec({ kind: "number", ...options }),
  integer: (options: NumberParamOptions): ParamSpec => spec({ kind: "integer", ...options }),
  boolean: (options: ParamOptions<boolean>): ParamSpec => spec({ kind: "boolean", ...options }),
  enum: <T extends string>(values: readonly T[], options: ParamOptions<T>): ParamSpec =>
    spec({ kind: "enum", values: [...values], ...options }),
  array: (items: ParamSpec, options: ArrayParamOptions): ParamSpec =>
    spec({ kind: "array", items, ...options }),
  /** Nested properties need descriptions too. */
  object: (properties: Record<string, ParamSpec>, options: ParamOptions<object>): ParamSpec =>
    spec({ kind: "object", properties: { ...properties }, ...options }),
};

export function isParamSpec(value: unknown): value is ParamSpec {
  return value !== null && typeof value === "object" && NODE in value;
}

export const MAX_PARAM_DESCRIPTION_LENGTH = 300;
const MAX_PARAMS = 64;
const MAX_DEPTH = 8;
const MAX_ENUM_VALUES = 100;
const MAX_PATTERN_LENGTH = 512;
const PARAM_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const FORMAT = /^[a-z][a-z0-9-]{0,31}$/;

/** One compiled parameter. */
export interface CompiledParam {
  readonly schema: JsonSchemaObject;
  readonly zod: z.ZodType;
  readonly required: boolean;
  /** The declared example, or one composed from an object's properties; undefined when there is none. */
  readonly example: unknown;
}

/** A compiled parameter map: an object schema, its zod shape, and the example input. */
export interface CompiledParams {
  readonly schema: JsonSchemaObject;
  readonly properties: Readonly<Record<string, JsonSchemaObject>>;
  readonly required: readonly string[];
  readonly zodShape: Readonly<Record<string, z.ZodType>>;
  /** Examples of the parameters that have one. */
  readonly example: Readonly<Record<string, unknown>>;
  /** Required parameters without an example, by path. */
  readonly missingExamples: readonly string[];
}

/**
 * Compiles a parameter map under `path` ("query", "body", "arguments"). Throws
 * `seller_param_description_required` or `seller_declaration_invalid` naming the parameter's path.
 */
export function compileParams(params: unknown, path: string): CompiledParams {
  if (params === undefined) params = {};
  if (params === null || typeof params !== "object" || Array.isArray(params) || isParamSpec(params)) {
    throw invalid(path, "must be a map of parameter names to param.* declarations");
  }
  const entries = Object.entries(params as Record<string, unknown>);
  if (entries.length > MAX_PARAMS) {
    throw invalid(path, `declares more than ${String(MAX_PARAMS)} parameters`);
  }
  const properties: Record<string, JsonSchemaObject> = {};
  const zodShape: Record<string, z.ZodType> = {};
  const example: Record<string, unknown> = {};
  const required: string[] = [];
  const missingExamples: string[] = [];
  for (const [name, value] of entries) {
    const at = `${path}.${name}`;
    if (!PARAM_NAME.test(name)) {
      throw invalid(at, "parameter names are 1-64 letters, digits, dots, dashes or underscores");
    }
    const compiled = compileParam(value, at, 1);
    properties[name] = compiled.schema;
    zodShape[name] = compiled.required ? compiled.zod : compiled.zod.optional();
    if (compiled.required) required.push(name);
    if (compiled.example !== undefined) example[name] = compiled.example;
    else if (compiled.required) missingExamples.push(at);
  }
  return {
    schema: objectSchema(properties, required),
    properties,
    required,
    zodShape,
    example,
    missingExamples,
  };
}

function objectSchema(
  properties: Record<string, JsonSchemaObject>,
  required: readonly string[],
  description?: string,
): JsonSchemaObject {
  return {
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required: [...required] }),
    additionalProperties: false,
    ...(description === undefined ? {} : { description }),
  };
}

function compileParam(value: unknown, path: string, depth: number): CompiledParam {
  if (!isParamSpec(value)) throw invalid(path, "must be declared with param.*");
  if (depth > MAX_DEPTH) throw invalid(path, `nests deeper than ${String(MAX_DEPTH)} levels`);
  const node = value[NODE];
  const description = checkDescription(node.description, path);
  if (node.required !== undefined && typeof node.required !== "boolean") {
    throw invalid(path, "required must be true or false");
  }
  const required = node.required === true;
  const meta = { description };
  let schema: Record<string, unknown>;
  let zod: z.ZodType;
  let composed: unknown;

  switch (node.kind) {
    case "string": {
      const { minLength, maxLength, pattern, format } = node;
      count(minLength, path, "minLength");
      count(maxLength, path, "maxLength");
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
        throw invalid(path, "minLength is greater than maxLength");
      }
      let base = z.string();
      if (minLength !== undefined) base = base.min(minLength);
      if (maxLength !== undefined) base = base.max(maxLength);
      if (pattern !== undefined) base = base.regex(compilePattern(pattern, path));
      if (format !== undefined && (typeof format !== "string" || !FORMAT.test(format))) {
        throw invalid(path, "format must be a JSON Schema format name such as date or uri");
      }
      zod = base.meta(format === undefined ? meta : { ...meta, format });
      schema = {
        type: "string",
        ...(minLength === undefined ? {} : { minLength }),
        ...(maxLength === undefined ? {} : { maxLength }),
        ...(pattern === undefined ? {} : { pattern }),
        ...(format === undefined ? {} : { format }),
        description,
      };
      break;
    }
    case "number":
    case "integer": {
      const { minimum, maximum } = node;
      const integer = node.kind === "integer";
      bound(minimum, path, "minimum", integer);
      bound(maximum, path, "maximum", integer);
      if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
        throw invalid(path, "minimum is greater than maximum");
      }
      let base = integer ? z.number().int() : z.number();
      if (minimum !== undefined) base = base.min(minimum);
      if (maximum !== undefined) base = base.max(maximum);
      zod = base.meta(meta);
      schema = {
        type: node.kind,
        ...(minimum === undefined ? {} : { minimum }),
        ...(maximum === undefined ? {} : { maximum }),
        description,
      };
      break;
    }
    case "boolean":
      zod = z.boolean().meta(meta);
      schema = { type: "boolean", description };
      break;
    case "enum": {
      const values: unknown = node.values;
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.length > MAX_ENUM_VALUES ||
        values.some((entry) => typeof entry !== "string" || entry === "") ||
        new Set(values).size !== values.length
      ) {
        throw invalid(path, `enum values must be 1-${String(MAX_ENUM_VALUES)} distinct non-empty strings`);
      }
      const strings = values as [string, ...string[]];
      zod = z.enum(strings).meta(meta);
      schema = { type: "string", enum: [...strings], description };
      break;
    }
    case "array": {
      count(node.maxItems, path, "maxItems");
      const items = compileParam(node.items, `${path}[]`, depth + 1);
      let base = z.array(items.zod);
      if (node.maxItems !== undefined) base = base.max(node.maxItems);
      zod = base.meta(meta);
      schema = {
        type: "array",
        items: items.schema,
        ...(node.maxItems === undefined ? {} : { maxItems: node.maxItems }),
        description,
      };
      break;
    }
    case "object": {
      const properties: Record<string, JsonSchemaObject> = {};
      const shape: Record<string, z.ZodType> = {};
      const requiredNames: string[] = [];
      const example: Record<string, unknown> = {};
      let complete = true;
      const entries: unknown = node.properties;
      if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
        throw invalid(path, "an object parameter needs a map of properties");
      }
      if (Object.keys(entries).length > MAX_PARAMS) {
        throw invalid(path, `declares more than ${String(MAX_PARAMS)} properties`);
      }
      for (const [name, child] of Object.entries(entries as Record<string, unknown>)) {
        const at = `${path}.${name}`;
        if (!PARAM_NAME.test(name)) {
          throw invalid(at, "property names are 1-64 letters, digits, dots, dashes or underscores");
        }
        const compiled = compileParam(child, at, depth + 1);
        properties[name] = compiled.schema;
        shape[name] = compiled.required ? compiled.zod : compiled.zod.optional();
        if (compiled.required) requiredNames.push(name);
        if (compiled.example !== undefined) example[name] = compiled.example;
        else if (compiled.required) complete = false;
      }
      zod = z.object(shape).meta(meta);
      schema = { ...objectSchema(properties, requiredNames, description) };
      composed = complete ? example : undefined;
      break;
    }
    default:
      throw invalid(path, "has an unknown parameter kind");
  }

  if (node.example !== undefined) {
    const parsed = zod.safeParse(node.example);
    if (!parsed.success) {
      throw invalid(path, `the example does not satisfy the parameter: ${firstIssue(parsed.error)}`);
    }
  }
  return { schema: Object.freeze(schema), zod, required, example: node.example ?? composed };
}

function checkDescription(value: unknown, path: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || text.length > MAX_PARAM_DESCRIPTION_LENGTH) {
    throw sellerError(
      "seller_param_description_required",
      `${path} needs a description of 1-${String(MAX_PARAM_DESCRIPTION_LENGTH)} characters.`,
      { path },
    );
  }
  return text;
}

function count(value: unknown, path: string, name: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalid(path, `${name} must be a non-negative integer`);
  }
}

function bound(value: unknown, path: string, name: string, integer: boolean): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) {
    throw invalid(path, `${name} must be a finite ${integer ? "integer" : "number"}`);
  }
}

function compilePattern(pattern: unknown, path: string): RegExp {
  if (typeof pattern !== "string" || pattern === "" || pattern.length > MAX_PATTERN_LENGTH) {
    throw invalid(path, `pattern must be 1-${String(MAX_PATTERN_LENGTH)} characters`);
  }
  try {
    return new RegExp(pattern, "u");
  } catch {
    throw invalid(path, "pattern is not a valid regular expression");
  }
}

function firstIssue(error: z.ZodError): string {
  const [issue] = error.issues;
  if (issue === undefined) return "invalid value";
  const where = issue.path.length === 0 ? "" : ` at ${issue.path.map(String).join(".")}`;
  return `${issue.message}${where}`;
}

function invalid(path: string, problem: string) {
  return sellerError("seller_declaration_invalid", `${path} ${problem}.`, { path });
}

/**
 * The first `$ref`-like keyword in a caller-supplied schema, or undefined. Bazaar schemas are
 * validated without resolving references, so the helpers keep them self-contained.
 */
export function referenceIn(schema: unknown, depth = 0): string | undefined {
  if (depth > 32 || schema === null || typeof schema !== "object") return undefined;
  if (Array.isArray(schema)) {
    for (const entry of schema) {
      const found = referenceIn(entry, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref" || key === "$id" || key === "$dynamicRef") return key;
    const found = referenceIn(value, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}
