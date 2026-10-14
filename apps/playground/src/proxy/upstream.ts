import type { Clock } from "../limits.ts";

/** A JSON answer of the facilitator or the Bazaar, as passed back to the page. */
export interface UpstreamAnswer {
  readonly status: number;
  /** The raw JSON text, passed through unchanged. */
  readonly body: string;
  readonly retryAfter: string | undefined;
}

const DEFAULT_MAX_CACHE_BYTES = 16 * 1_048_576;
const DEFAULT_MAX_CACHED_ANSWER_BYTES = 256 * 1_024;

export type UpstreamResult =
  | { readonly ok: true; readonly answer: UpstreamAnswer; readonly cached: boolean }
  | { readonly ok: false; readonly reason: string; readonly busy?: boolean };

export interface UpstreamOptions {
  readonly fetch?: typeof fetch;
  readonly now?: Clock;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxEntries?: number;
  /** Memory the cached answers may hold in total (two bytes per character); 16 MiB by default. */
  readonly maxCacheBytes?: number;
  /** Largest answer kept in the cache; larger ones are passed on but not kept. 256 KiB by default. */
  readonly maxCachedAnswerBytes?: number;
  readonly userAgent: string;
  /** Asked before each upstream fetch (cache misses only); false refuses it as busy. */
  readonly admit?: () => boolean;
}

/**
 * Fetches JSON from an operator-configured service (never a URL from the page) with a timeout, a size
 * limit and a short cache of successful answers, bounded by entries and by memory. Concurrent
 * requests for the same URL share one fetch. A non-JSON, oversized, late or unreachable answer is a
 * failure, reported without detail.
 */
export class UpstreamJson {
  private readonly cache = new Map<string, { answer: UpstreamAnswer; expires: number; bytes: number }>();
  private cachedBytes = 0;
  private readonly pending = new Map<string, Promise<UpstreamResult>>();
  private readonly fetch: typeof fetch;
  private readonly now: Clock;
  private readonly options: UpstreamOptions;

  constructor(options: UpstreamOptions) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  /**
   * The answer for `url`, from the cache when it is younger than `ttlMs`. `admit`, when given, replaces
   * the configured admission check for this request (the caller's share of the upstream budget).
   */
  async get(url: string, ttlMs: number, admit = this.options.admit): Promise<UpstreamResult> {
    const hit = this.cache.get(url);
    if (hit !== undefined && hit.expires > this.now()) return { ok: true, answer: hit.answer, cached: true };
    const running = this.pending.get(url);
    if (running !== undefined) return running;
    if (admit?.() === false) {
      return { ok: false, busy: true, reason: "Too many upstream requests; retry shortly." };
    }
    const fetched = this.load(url, ttlMs).finally(() => this.pending.delete(url));
    this.pending.set(url, fetched);
    return fetched;
  }

  private async load(url: string, ttlMs: number): Promise<UpstreamResult> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: { accept: "application/json", "user-agent": this.options.userAgent },
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      return { ok: false, reason: "The service did not answer in time or could not be reached." };
    }
    const type = response.headers.get("content-type") ?? "";
    if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(type)) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `The service answered ${String(response.status)} without JSON.` };
    }
    const body = await readText(response, this.options.maxBytes).catch(() => undefined);
    if (body === undefined) {
      return { ok: false, reason: "The service's answer was too large or could not be read." };
    }
    try {
      JSON.parse(body);
    } catch {
      return { ok: false, reason: "The service's answer is not valid JSON." };
    }
    const answer = {
      status: response.status,
      body,
      retryAfter: response.headers.get("retry-after") ?? undefined,
    };
    if (response.status === 200 && ttlMs > 0) this.remember(url, answer, ttlMs);
    return { ok: true, answer, cached: false };
  }

  /** Drops expired answers; called periodically. */
  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.cache) if (entry.expires <= now) this.forget(key);
  }

  /** Memory the cached answers hold, two bytes per character. */
  get size(): { readonly entries: number; readonly bytes: number } {
    return { entries: this.cache.size, bytes: this.cachedBytes };
  }

  private remember(url: string, answer: UpstreamAnswer, ttlMs: number): void {
    const bytes = 2 * (answer.body.length + url.length);
    if (bytes > (this.options.maxCachedAnswerBytes ?? DEFAULT_MAX_CACHED_ANSWER_BYTES)) return;
    const maxEntries = this.options.maxEntries ?? 512;
    const maxBytes = this.options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
    this.forget(url);
    if (this.cache.size >= maxEntries || this.cachedBytes + bytes > maxBytes) this.sweep();
    while (this.cache.size >= maxEntries || this.cachedBytes + bytes > maxBytes) {
      const [oldest] = this.cache.keys();
      if (oldest === undefined) break;
      this.forget(oldest);
    }
    this.cache.set(url, { answer, expires: this.now() + ttlMs, bytes });
    this.cachedBytes += bytes;
  }

  private forget(url: string): void {
    const entry = this.cache.get(url);
    if (entry === undefined) return;
    this.cache.delete(url);
    this.cachedBytes -= entry.bytes;
  }
}

/** Reads a body as UTF-8 text, failing past `limit` bytes. */
async function readText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) {
    await response.body?.cancel();
    throw new RangeError("too large");
  }
  if (response.body === null) return "";
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new RangeError("too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** A proxied JSON answer: the upstream's status and body, revalidated on every load. */
export function jsonReply(answer: UpstreamAnswer): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-cache",
  };
  if (answer.retryAfter !== undefined && /^\d{1,6}$/.test(answer.retryAfter)) {
    headers["retry-after"] = answer.retryAfter;
  }
  return new Response(answer.body, { status: answer.status, headers });
}
