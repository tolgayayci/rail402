/**
 * Byte-level helpers shared by the page's transports: request sizes, a body stream cut at a limit,
 * and bounded reads of small JSON or text answers.
 */
import { EgressError } from "@rail402.dev/safe-fetch/shared";

const encoder = new TextEncoder();

/** Bytes a request body takes on the wire. */
export function bodyBytes(body: string | Uint8Array | null | undefined): number {
  if (body === null || body === undefined) return 0;
  return typeof body === "string" ? encoder.encode(body).byteLength : body.byteLength;
}

/** Bytes of request headers, as `name: value\r\n` lines, leaving out the names in `except`. */
export function headerBytes(headers: Headers, except: readonly string[] = []): number {
  let total = 0;
  headers.forEach((value, name) => {
    if (!except.includes(name.toLowerCase())) total += encoder.encode(`${name}: ${value}\r\n`).byteLength;
  });
  return total;
}

/**
 * The same stream, cut once more than `max` bytes went through: the reader then sees an
 * `egress_response_too_large` error, as safe-fetch reports an oversized body.
 */
export function limitStream(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) {
          controller.error(
            new EgressError("egress_response_too_large", "response", {
              reason: `The response body exceeds ${String(max)} bytes.`,
            }),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * Reads at most `max` bytes of a body as UTF-8 text. Undefined when the body is larger or cannot be
 * read; the rest of the stream is cancelled.
 */
export async function readText(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<string | undefined> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

/** Parses a bounded body as JSON; undefined when it is too large or not JSON. */
export async function readJson(body: ReadableStream<Uint8Array> | null, max: number): Promise<unknown> {
  const text = await readText(body, max);
  if (text === undefined || text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A signal that fires when either the caller's signal or a timeout does. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Whether a fetch failed because the caller aborted, not because of a timeout or the network. */
export function abortedByCaller(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** A copy of the bytes in a buffer of their own, as `fetch` wants a plain ArrayBuffer view. */
export function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
