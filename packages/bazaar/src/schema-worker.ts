/**
 * Worker thread that validates a bazaar `info` against its untrusted `schema`. It runs isolated from
 * the event loop that serves payments: a pathological schema (catastrophic regex backtracking,
 * combinatorial uniqueItems, deep recursion) can only stall this thread, which the host terminates.
 */
import { createHash } from "node:crypto";
import { parentPort } from "node:worker_threads";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

export interface SchemaTask {
  readonly id: number;
  readonly schema: unknown;
  readonly info: unknown;
}

/** The id of the message a worker sends once it has loaded and warmed its validator. */
export const WORKER_READY = -1;

export type SchemaTaskResult =
  | { readonly id: number; readonly ok: true }
  | {
      readonly id: number;
      readonly ok: false;
      readonly code: "bazaar_schema_invalid" | "bazaar_info_invalid";
      readonly reason: string;
    };

const CACHE_LIMIT = 256;
const cache = new Map<string, ValidateFunction>();

function compile(schema: unknown): ValidateFunction {
  const key = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  // A fresh instance per schema: no schema can register ids that affect another seller's schema.
  const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false, addUsedSchema: false });
  const validate = ajv.compile(schema as Record<string, unknown>);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, validate);
  return validate;
}

parentPort?.on("message", (task: SchemaTask) => {
  let result: SchemaTaskResult;
  try {
    let validate: ValidateFunction;
    try {
      validate = compile(task.schema);
    } catch (error) {
      result = { id: task.id, ok: false, code: "bazaar_schema_invalid", reason: describe(error) };
      parentPort?.postMessage(result);
      return;
    }
    if (validate(task.info)) {
      result = { id: task.id, ok: true };
    } else {
      const [first] = validate.errors ?? [];
      const where =
        first?.instancePath === undefined || first.instancePath === ""
          ? "info"
          : `info${first.instancePath.replaceAll("/", ".")}`;
      result = {
        id: task.id,
        ok: false,
        code: "bazaar_info_invalid",
        reason: `${where}: ${first?.message ?? "does not match the schema"}.`,
      };
    }
  } catch (error) {
    result = { id: task.id, ok: false, code: "bazaar_schema_invalid", reason: describe(error) };
  }
  parentPort?.postMessage(result);
});

// Load and warm the validator before accepting work, so no task's time budget pays for startup.
compile({ type: "object", properties: { warm: { type: "string" } } })({ warm: "up" });
parentPort?.postMessage({ id: WORKER_READY, ok: true } satisfies SchemaTaskResult);

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `The schema could not be compiled: ${message.slice(0, 200)}`;
}
