/**
 * `Rail402-Trace`: what a Playground lab seller saw when it called the facilitator, sent back to the
 * buyer on every lab response (402s included). Outcomes only: codes, reasons, amounts, the transaction
 * hash and the Bazaar's cataloging result. It never carries a payment payload, header or signature.
 *
 * Wire form: base64url (no padding) of the JSON, version 1, at most TRACE_MAX_BYTES. Only the
 * Playground's lab sellers emit it; it is not part of any public seller API.
 *
 * Lab responses also carry `Server-Timing` with the verify and settle durations.
 */
import { z } from "zod";

export const TRACE_HEADER = "rail402-trace";
export const TRACE_VERSION = 1;
/** Largest encoded header value. */
export const TRACE_MAX_BYTES = 2_048;
/** Reasons are cut to this many characters before encoding. */
export const TRACE_REASON_MAX = 300;

/** `Server-Timing` metric names of the facilitator calls. */
export const SERVER_TIMING_METRICS = Object.freeze({ verify: "x402-verify", settle: "x402-settle" } as const);

const code = z.string().regex(/^[a-z][a-z0-9_]{0,99}$/);
const reason = z.string().max(TRACE_REASON_MAX);
const atomic = z.string().regex(/^(0|[1-9]\d{0,38})$/);
const ms = z.number().int().min(0);

export const sellerTraceSchema = z.strictObject({
  v: z.literal(TRACE_VERSION),
  /** The facilitator's `/verify` answer. */
  verify: z
    .strictObject({ isValid: z.boolean(), code: code.optional(), reason: reason.optional(), ms })
    .optional(),
  /** The facilitator's `/settle` answer, with the amount the seller asked to settle. */
  settle: z
    .strictObject({
      success: z.boolean(),
      code: code.optional(),
      reason: reason.optional(),
      transaction: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
      /** The amount settled, in base units. */
      amount: atomic.optional(),
      /** The amount the seller asked to settle (an upto override), in base units. */
      requested: atomic.optional(),
      ms,
    })
    .optional(),
  /** The Bazaar's cataloging outcome from the settle response's extension responses. */
  bazaar: z
    .strictObject({
      status: z.enum(["success", "processing", "rejected"]),
      code: code,
      listingId: z.string().max(200).optional(),
      version: z.number().int().min(0).optional(),
      reason: reason.optional(),
    })
    .optional(),
});

export type SellerTrace = z.infer<typeof sellerTraceSchema>;

/**
 * Encodes a trace for the header. Reasons are cut to TRACE_REASON_MAX; if the value is still too
 * large, reasons are dropped. Throws a RangeError when even that does not fit (it cannot with valid
 * fields).
 */
export function encodeTrace(trace: SellerTrace): string {
  const cut = mapReasons(trace, (text) => text.slice(0, TRACE_REASON_MAX));
  const full = toBase64Url(JSON.stringify(sellerTraceSchema.parse(cut)));
  if (full.length <= TRACE_MAX_BYTES) return full;
  const bare = toBase64Url(JSON.stringify(mapReasons(cut, () => undefined)));
  if (bare.length <= TRACE_MAX_BYTES) return bare;
  throw new RangeError(`the trace does not fit in ${String(TRACE_MAX_BYTES)} bytes`);
}

/** Decodes a header value; undefined when it is missing, too large or not a valid version 1 trace. */
export function decodeTrace(value: string | null | undefined): SellerTrace | undefined {
  if (value === null || value === undefined || value === "" || value.length > TRACE_MAX_BYTES)
    return undefined;
  let json: unknown;
  try {
    json = JSON.parse(fromBase64Url(value));
  } catch {
    return undefined;
  }
  const parsed = sellerTraceSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** The `Server-Timing` value for a trace's facilitator calls; empty when it made none. */
export function serverTimingOf(trace: SellerTrace): string {
  const parts: string[] = [];
  if (trace.verify !== undefined)
    parts.push(`${SERVER_TIMING_METRICS.verify};dur=${String(trace.verify.ms)}`);
  if (trace.settle !== undefined)
    parts.push(`${SERVER_TIMING_METRICS.settle};dur=${String(trace.settle.ms)}`);
  return parts.join(", ");
}

/** Reads `Server-Timing` into `{ metric: milliseconds }`; metrics without a valid `dur` are skipped. */
export function parseServerTiming(value: string | null | undefined): Record<string, number> {
  const timing: Record<string, number> = {};
  if (value === null || value === undefined) return timing;
  for (const entry of value.split(",")) {
    const [name, ...params] = entry.split(";").map((part) => part.trim());
    if (name === undefined || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) continue;
    for (const param of params) {
      const match = /^dur=(\d+(?:\.\d+)?)$/.exec(param);
      if (match?.[1] !== undefined) timing[name] = Number(match[1]);
    }
  }
  return timing;
}

function mapReasons(trace: SellerTrace, map: (reason: string) => string | undefined): SellerTrace {
  const apply = <T extends { reason?: string | undefined }>(part: T | undefined): T | undefined => {
    if (part?.reason === undefined) return part;
    const { reason, ...rest } = part;
    const mapped = map(reason);
    return (mapped === undefined ? rest : { ...rest, reason: mapped }) as T;
  };
  const verify = apply(trace.verify);
  const settle = apply(trace.settle);
  const bazaar = apply(trace.bazaar);
  return {
    v: trace.v,
    ...(verify === undefined ? {} : { verify }),
    ...(settle === undefined ? {} : { settle }),
    ...(bazaar === undefined ? {} : { bazaar }),
  };
}

/** UTF-8 text to unpadded base64url, with no Node or DOM dependency beyond `btoa`/`TextEncoder`. */
export function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The reverse of toBase64Url. Throws on characters outside the base64url alphabet. */
export function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new TypeError("not base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}
