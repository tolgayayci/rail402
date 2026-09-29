import { Worker } from "node:worker_threads";
import { WORKER_READY, type SchemaTask, type SchemaTaskResult } from "./schema-worker.ts";

/** How long a new worker may take to load its validator before validations are refused. */
const WORKER_START_MS = 10_000;

export type SchemaVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "bazaar_schema_invalid"
        | "bazaar_schema_external_reference"
        | "bazaar_schema_too_large"
        | "bazaar_schema_timeout"
        | "bazaar_info_invalid";
      readonly reason: string;
    };

export interface SchemaSandboxOptions {
  /** Time budget for one validation, including schema compilation. */
  readonly timeoutMs?: number;
  /** Largest serialized `schema` or `info`, in bytes. */
  readonly maxBytes?: number;
  /** Deepest nesting of objects and arrays in `schema` or `info`. */
  readonly maxDepth?: number;
  /** Validations allowed to wait for the worker; more are refused at once instead of queuing. */
  readonly maxQueued?: number;
}

/**
 * Validates untrusted bazaar schemas off the main thread. Before anything is compiled, the schema
 * is checked for external references (never resolved, per the bazaar spec) and for size and depth
 * budgets. Compilation and validation run in a worker that is terminated and replaced if it exceeds
 * its time budget.
 */
export class SchemaSandbox {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxDepth: number;
  private worker: { readonly thread: Worker; readonly ready: Promise<boolean> } | undefined;
  private nextId = 0;
  private readonly pending = new Map<number, (result: SchemaTaskResult) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private readonly maxQueued: number;

  constructor(options: SchemaSandboxOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 250;
    this.maxBytes = options.maxBytes ?? 32 * 1024;
    this.maxDepth = options.maxDepth ?? 32;
    this.maxQueued = options.maxQueued ?? 16;
  }

  validate(schema: unknown, info: unknown): Promise<SchemaVerdict> {
    const precheck = this.precheck(schema, info);
    if (precheck !== undefined) return Promise.resolve(precheck);
    // One task at a time per worker keeps the time budget meaningful; a bounded queue keeps a flood
    // of slow schemas from delaying every other seller's validation.
    if (this.queued >= this.maxQueued) {
      return Promise.resolve({
        ok: false,
        code: "bazaar_schema_timeout",
        reason: "Schema validation is busy; the resource is cataloged on a later settlement.",
      });
    }
    this.queued++;
    const run = this.queue
      .then(() => this.run(schema, info))
      .finally(() => {
        this.queued--;
      });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Starts the worker and waits until its validator is loaded; returns false if it could not start.
   * Call it at startup so the first seller's validation does not wait for it.
   */
  warm(): Promise<boolean> {
    return this.ensureWorker().ready;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    await worker?.thread.terminate();
  }

  private precheck(schema: unknown, info: unknown): SchemaVerdict | undefined {
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
      return {
        ok: false,
        code: "bazaar_schema_invalid",
        reason: "The bazaar `schema` must be a JSON object.",
      };
    }
    for (const [label, value] of [
      ["schema", schema],
      ["info", info],
    ] as const) {
      let serialized: string;
      try {
        serialized = JSON.stringify(value);
      } catch {
        return {
          ok: false,
          code: "bazaar_schema_too_large",
          reason: `The bazaar \`${label}\` is not serializable.`,
        };
      }
      if (Buffer.byteLength(serialized) > this.maxBytes) {
        return {
          ok: false,
          code: "bazaar_schema_too_large",
          reason: `The bazaar \`${label}\` exceeds ${String(this.maxBytes)} bytes.`,
        };
      }
      if (depth(value) > this.maxDepth) {
        return {
          ok: false,
          code: "bazaar_schema_too_large",
          reason: `The bazaar \`${label}\` nests deeper than ${String(this.maxDepth)} levels.`,
        };
      }
    }
    const external = externalReference(schema);
    if (external !== undefined) {
      return {
        ok: false,
        code: "bazaar_schema_external_reference",
        reason: `The bazaar \`schema\` references "${external.slice(0, 100)}"; only same-document references (#…) are allowed.`,
      };
    }
    return undefined;
  }

  private async run(schema: unknown, info: unknown): Promise<SchemaVerdict> {
    const worker = this.ensureWorker();
    // The time budget starts once the validator is loaded: starting a worker is not the schema's cost.
    if (!(await worker.ready)) {
      return {
        ok: false,
        code: "bazaar_schema_timeout",
        reason: "The schema validator could not start; the resource is cataloged on a later settlement.",
      };
    }
    const id = this.nextId++;
    return new Promise<SchemaVerdict>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The worker may be stuck in the schema; replace it rather than wait.
        if (this.worker === worker) this.worker = undefined;
        void worker.thread.terminate();
        resolve({
          ok: false,
          code: "bazaar_schema_timeout",
          reason: `Validation exceeded ${String(this.timeoutMs)} ms.`,
        });
      }, this.timeoutMs);
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve(result.ok ? { ok: true } : { ok: false, code: result.code, reason: result.reason });
      });
      const task: SchemaTask = { id, schema, info };
      worker.thread.postMessage(task);
    });
  }

  private ensureWorker(): { readonly thread: Worker; readonly ready: Promise<boolean> } {
    if (this.worker !== undefined) return this.worker;
    const file = import.meta.url.endsWith(".ts") ? "./schema-worker.ts" : "./schema-worker.js";
    const thread = new Worker(new URL(file, import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let started: (value: boolean) => void = () => undefined;
    const ready = new Promise<boolean>((resolve) => {
      started = resolve;
    });
    // The thread and the startup timer keep the process alive until the worker is ready: a caller
    // awaiting warm() during startup must not see the event loop drain and the process exit.
    const startup = setTimeout(() => {
      started(false);
    }, WORKER_START_MS);
    thread.on("message", (result: SchemaTaskResult) => {
      if (result.id === WORKER_READY) {
        clearTimeout(startup);
        thread.unref();
        started(true);
        return;
      }
      const settle = this.pending.get(result.id);
      this.pending.delete(result.id);
      settle?.(result);
    });
    const failed = () => {
      clearTimeout(startup);
      started(false);
      if (this.worker?.thread === thread) this.worker = undefined;
    };
    thread.on("error", failed);
    thread.on("exit", failed);
    this.worker = { thread, ready };
    return this.worker;
  }
}

/** Keywords whose value is one subschema (JSON Schema 2020-12 and the drafts Ajv also reads). */
const SUBSCHEMA = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
];
/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LISTS = ["allOf", "anyOf", "items", "oneOf", "prefixItems"];
/** Keywords whose value maps names to subschemas. */
const SUBSCHEMA_MAPS = [
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
];

/**
 * The first `$ref`, `$id` or `$dynamicRef` that is not a same-document fragment, if any. Only schema
 * positions are walked: a property named `$id`, or a `$ref` inside `enum`, `const` or `examples`, is
 * data, not a reference.
 */
export function externalReference(schema: unknown): string | undefined {
  const stack: unknown[] = [schema];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object" || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;
    for (const key of ["$ref", "$id", "$dynamicRef", "$anchor"]) {
      if (!(key in record)) continue;
      const value = record[key];
      if (typeof value !== "string") return String(value);
      if (key !== "$anchor" && !value.startsWith("#")) return value;
    }
    for (const key of SUBSCHEMA) if (key in record) stack.push(record[key]);
    for (const key of SUBSCHEMA_LISTS) {
      const value = record[key];
      if (Array.isArray(value)) stack.push(...(value as unknown[]));
    }
    for (const key of SUBSCHEMA_MAPS) {
      const value = record[key];
      if (value !== null && typeof value === "object" && !Array.isArray(value))
        stack.push(...Object.values(value as Record<string, unknown>));
    }
  }
  return undefined;
}

function depth(value: unknown): number {
  let deepest = 0;
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [current, level] = stack.pop() as [unknown, number];
    if (level > deepest) deepest = level;
    if (current !== null && typeof current === "object") {
      for (const child of Object.values(current)) stack.push([child, level + 1]);
    }
  }
  return deepest;
}
