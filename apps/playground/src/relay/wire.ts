/** Body handling of relay calls: a bounded request body in, a tracked seller body out. */

export type BodyRead =
  | { readonly ok: true; readonly body: Uint8Array | undefined }
  | { readonly ok: false; readonly reason: "too_large" | "aborted" };

/**
 * Reads a request body of at most `limit` bytes. A declared or actual size over the limit stops the
 * read; an empty body is undefined. A read that fails (the client went away mid-body, or the server's
 * request timeout cut a slow upload) is `aborted`, never thrown.
 */
export async function readBody(request: Request, limit: number): Promise<BodyRead> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) return { ok: false, reason: "too_large" };
  if (request.body === null) return { ok: true, body: undefined };
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let next: Awaited<ReturnType<typeof reader.read>>;
    try {
      next = await reader.read();
    } catch {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "aborted" };
    }
    const { done, value } = next;
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  if (size === 0) return { ok: true, body: undefined };
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}

/** How a tracked body ended: completely, with an error (cut by a limit, a timeout or the seller), or cancelled by the client. */
export type BodyEnd =
  | { readonly kind: "complete" }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "cancelled" };

/** The error a tracked body ends with when it was not read to its end before its deadline. */
export class BodyDeadlineError extends Error {
  override readonly name = "BodyDeadlineError";
}

/**
 * Passes a body through unchanged, reporting each chunk's size and, exactly once, how it ended. A
 * cancel from the reader (the client went away) cancels the source, which closes the upstream
 * connection. When `deadlineMs` passes before the body ended (a reader that stopped reading), the
 * source is cancelled and the body ends with a BodyDeadlineError, so whatever it holds is released.
 */
export function trackBody(
  source: ReadableStream<Uint8Array>,
  onChunk: (bytes: number) => void,
  onEnd: (end: BodyEnd) => void,
  deadlineMs?: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = (value: BodyEnd) => {
    if (ended) return;
    ended = true;
    if (timer !== undefined) clearTimeout(timer);
    onEnd(value);
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        if (deadlineMs === undefined) return;
        timer = setTimeout(() => {
          if (ended) return;
          const error = new BodyDeadlineError("The relayed body was not read before its deadline.");
          end({ kind: "error", error });
          controller.error(error);
          void reader.cancel(error).catch(() => undefined);
        }, deadlineMs);
        timer.unref();
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            end({ kind: "complete" });
            controller.close();
            return;
          }
          onChunk(value.byteLength);
          controller.enqueue(value);
        } catch (error) {
          end({ kind: "error", error });
          controller.error(error);
        }
      },
      async cancel(reason) {
        end({ kind: "cancelled" });
        await reader.cancel(reason).catch(() => undefined);
      },
    },
    { highWaterMark: 0 },
  );
}
