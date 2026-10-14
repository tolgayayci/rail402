/** Reading fields out of sanitized JSON (tool arguments and results) without trusting its shape. */
import type { JsonValue } from "../engine/events.ts";

type Key = string | number;

/** The value at a path, or undefined when any step is missing or of the wrong kind. */
export function at(value: JsonValue | undefined, ...path: readonly Key[]): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const key of path) {
    if (current === undefined || current === null || typeof current !== "object") return undefined;
    if (typeof key === "number") {
      if (!Array.isArray(current)) return undefined;
      current = (current as readonly JsonValue[])[key];
    } else {
      if (Array.isArray(current)) return undefined;
      current = (current as { readonly [key: string]: JsonValue })[key];
    }
  }
  return current;
}

export function str(value: JsonValue | undefined, ...path: readonly Key[]): string | undefined {
  const found = at(value, ...path);
  return typeof found === "string" ? found : undefined;
}

export function num(value: JsonValue | undefined, ...path: readonly Key[]): number | undefined {
  const found = at(value, ...path);
  return typeof found === "number" ? found : undefined;
}

export function bool(value: JsonValue | undefined, ...path: readonly Key[]): boolean | undefined {
  const found = at(value, ...path);
  return typeof found === "boolean" ? found : undefined;
}

export function list(value: JsonValue | undefined, ...path: readonly Key[]): readonly JsonValue[] {
  const found = at(value, ...path);
  return Array.isArray(found) ? (found as readonly JsonValue[]) : [];
}

/** `city: "Izmir", hours: 6`: the top-level entries of an object, for a one-line summary. */
export function inline(value: JsonValue | undefined, max = 80): string {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value))
    return value === undefined ? "" : JSON.stringify(value);
  const text = Object.entries(value as { readonly [key: string]: JsonValue })
    .map(([key, item]) => `${key}: ${JSON.stringify(item)}`)
    .join(", ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
