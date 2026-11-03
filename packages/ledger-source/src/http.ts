import { LedgerSourceError } from "./errors.ts";

export type Fetch = typeof fetch;

export interface HttpOptions {
  readonly fetch?: Fetch;
  /** Per request, including the body. */
  readonly timeoutMs?: number;
  /** Largest body accepted, in bytes. */
  readonly maxBytes: number;
  /** Attempts for retryable failures (timeouts, 429, 5xx, transport errors). */
  readonly attempts?: number;
  /** Base delay between attempts; doubles each time. A server's `Retry-After` replaces it. */
  readonly backoffMs?: number;
  /**
   * The longest `Retry-After` waited for (default 60 s). A longer one (a daily request cap, for example)
   * stops at once with a retryable error that carries it, so the caller can pause instead of hammering.
   */
  readonly maxRetryAfterSeconds?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type HttpResult = { readonly status: 200; readonly body: Buffer } | { readonly status: 404 };

export interface RequestInit {
  readonly method?: "GET" | "HEAD" | "POST";
  readonly json?: unknown;
  /**
   * Extra request headers, e.g. `Authorization`. Their values never appear in errors: a failure names the
   * host and the status only.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * GET (or POST with a JSON body) with no redirects, a time limit, a body size cap enforced while
 * reading, and retries for transient failures, after the server's `Retry-After` when it sends one (and
 * never one longer than `maxRetryAfterSeconds`). A 404 is an answer, not an error: the caller decides
 * what a missing object means.
 */
export async function request(url: URL, options: HttpOptions, init: RequestInit = {}): Promise<HttpResult> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const maxWait = options.maxRetryAfterSeconds ?? 60;
  let last: LedgerSourceError | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      const wait = last?.retryAfterSeconds;
      await (options.sleep ?? defaultSleep)(
        wait === undefined ? (options.backoffMs ?? 250) * 2 ** (attempt - 1) : wait * 1000,
      );
    }
    try {
      return await once(url, options, init);
    } catch (error) {
      if (!(error instanceof LedgerSourceError) || !error.retryable) throw error;
      if (error.retryAfterSeconds !== undefined && error.retryAfterSeconds > maxWait) {
        throw new LedgerSourceError(
          "http_status",
          `${error.message}; it asks to wait ${String(error.retryAfterSeconds)} s, so stopping instead`,
          { retryable: true, retryAfterSeconds: error.retryAfterSeconds, cause: error },
        );
      }
      last = error;
    }
  }
  throw last ?? new LedgerSourceError("http_failed", `${url.host}: no attempt made`);
}

/** A `Retry-After` header in seconds (the delta form), or undefined. */
export function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

async function once(url: URL, options: HttpOptions, init: RequestInit): Promise<HttpResult> {
  const signal = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: init.method ?? "GET",
      redirect: "manual",
      signal,
      headers: {
        ...init.headers,
        ...(init.json === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
    });
  } catch (error) {
    throw transportError(url, error);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new LedgerSourceError(
      "http_redirect_refused",
      `${url.host} answered ${String(response.status)}; redirects are refused`,
    );
  }
  if (response.status === 404) {
    await response.body?.cancel();
    return { status: 404 };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    const retryable = response.status === 429 || response.status >= 500;
    const wait = retryable ? retryAfter(response) : undefined;
    throw new LedgerSourceError("http_status", `${url.host} answered ${String(response.status)}`, {
      retryable,
      ...(wait === undefined ? {} : { retryAfterSeconds: wait }),
    });
  }
  if (init.method === "HEAD") {
    await response.body?.cancel();
    return { status: 200, body: Buffer.alloc(0) };
  }
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    await response.body?.cancel();
    throw tooLarge(url, options.maxBytes);
  }
  try {
    return { status: 200, body: await readCapped(response, url, options.maxBytes) };
  } catch (error) {
    if (error instanceof LedgerSourceError) throw error;
    throw transportError(url, error);
  }
}

/** Reads a response body, failing with `object_too_large` as soon as it exceeds `maxBytes`. */
export async function readCapped(response: Response, url: URL, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge(url, maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

const tooLarge = (url: URL, maxBytes: number) =>
  new LedgerSourceError(
    "object_too_large",
    `${url.host}: the response is larger than ${String(maxBytes)} bytes`,
  );

function transportError(url: URL, error: unknown): LedgerSourceError {
  const timeout =
    error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
  return new LedgerSourceError(
    timeout ? "http_timeout" : "http_failed",
    `${url.host}: ${timeout ? "timed out" : error instanceof Error ? error.message : String(error)}`,
    { retryable: true, cause: error },
  );
}
