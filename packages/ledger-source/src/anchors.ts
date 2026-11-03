import { LedgerSourceError } from "./errors.ts";
import { request, type Fetch } from "./http.ts";

/** Where independently known ledger hashes come from, to anchor a chain read from another source. */
export interface AnchorSource {
  readonly name: string;
  /** The hash of `sequence` (64 lowercase hex). Throws `LedgerSourceError` when it cannot tell. */
  ledgerHash(sequence: number): Promise<string>;
  /**
   * The hashes of several ledgers in as few requests as the source allows; a ledger it cannot tell yet
   * is left out of the map. Optional: without it each ledger is asked for alone.
   */
  ledgerHashes?(sequences: readonly number[]): Promise<Map<number, string>>;
}

/** Ledgers per Horizon `/ledgers` page (its maximum). */
const HORIZON_PAGE = 200;

export interface HorizonAnchorOptions {
  /** A Horizon server with full history (https), e.g. https://horizon.stellar.org. */
  readonly url: string;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * Ledger hashes from Horizon's `/ledgers/{sequence}`: a server and an index independent of the data
 * lake and of RPC, so a source that forges or swaps ledgers cannot also forge the anchors. Pinned to
 * one https host, no redirects, a small response cap.
 */
export class HorizonAnchors implements AnchorSource {
  readonly name: string;
  readonly #options: HorizonAnchorOptions;
  readonly #base: URL;

  constructor(options: HorizonAnchorOptions) {
    const base = new URL(options.url);
    if (base.protocol !== "https:" || base.username !== "" || base.password !== "" || base.search !== "") {
      throw new LedgerSourceError(
        "source_config_invalid",
        "the anchor Horizon URL must be https without credentials or a query",
      );
    }
    if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
    this.#base = base;
    this.#options = options;
    this.name = `horizon:${base.host}`;
  }

  /**
   * Hashes of many ledgers through Horizon's `/ledgers` pages: each run of ledgers that fits one page of
   * 200 consecutive ledgers costs one request instead of one per ledger. Every record must be a ledger of
   * the run with a well-formed hash; ledgers Horizon does not answer for are left out.
   */
  async ledgerHashes(sequences: readonly number[]): Promise<Map<number, string>> {
    const sorted = [...new Set(sequences)].filter(
      (sequence) => Number.isSafeInteger(sequence) && sequence > 1,
    );
    sorted.sort((a, b) => a - b);
    const wanted = new Set(sorted);
    const found = new Map<number, string>();
    let index = 0;
    while (index < sorted.length) {
      const start = sorted[index] ?? 0;
      let end = start;
      while (index < sorted.length && (sorted[index] ?? 0) - start < HORIZON_PAGE)
        end = sorted[index++] ?? end;
      const url = new URL("ledgers", this.#base);
      // A ledger's paging token is its sequence shifted left by 32 bits; the page starts after the cursor.
      url.searchParams.set("cursor", String(BigInt(start - 1) << 32n));
      url.searchParams.set("order", "asc");
      url.searchParams.set("limit", String(end - start + 1));
      const response = await request(url, {
        maxBytes: 4 * 1024 * 1024,
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
        ...(this.#options.attempts === undefined ? {} : { attempts: this.#options.attempts }),
        ...(this.#options.sleep === undefined ? {} : { sleep: this.#options.sleep }),
      });
      if (response.status === 404) continue;
      let records: unknown;
      try {
        records = (JSON.parse(response.body.toString("utf8")) as { _embedded?: { records?: unknown } })
          ._embedded?.records;
      } catch {
        throw new LedgerSourceError("anchor_unavailable", `${url.host}: the ledgers page is not JSON`);
      }
      if (!Array.isArray(records)) {
        throw new LedgerSourceError("anchor_unavailable", `${url.host}: the ledgers page has no records`);
      }
      for (const record of records as { sequence?: unknown; hash?: unknown }[]) {
        if (
          typeof record.sequence !== "number" ||
          record.sequence < start ||
          record.sequence > end ||
          typeof record.hash !== "string" ||
          !HASH.test(record.hash)
        ) {
          throw new LedgerSourceError(
            "anchor_unavailable",
            `${url.host}: a ledgers page record is not a ledger of ${String(start)}-${String(end)} with a hash`,
          );
        }
        if (wanted.has(record.sequence)) found.set(record.sequence, record.hash);
      }
    }
    return found;
  }

  async ledgerHash(sequence: number): Promise<string> {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new LedgerSourceError("source_config_invalid", `ledger ${String(sequence)} is out of range`);
    }
    const url = new URL(`ledgers/${String(sequence)}`, this.#base);
    const response = await request(url, {
      maxBytes: 64 * 1024,
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
      ...(this.#options.attempts === undefined ? {} : { attempts: this.#options.attempts }),
      ...(this.#options.sleep === undefined ? {} : { sleep: this.#options.sleep }),
    });
    if (response.status === 404) {
      throw new LedgerSourceError(
        "anchor_unavailable",
        `${url.host} does not hold ledger ${String(sequence)}; use a Horizon with full history`,
      );
    }
    let body: { sequence?: unknown; hash?: unknown };
    try {
      body = JSON.parse(response.body.toString("utf8")) as typeof body;
    } catch {
      throw new LedgerSourceError("anchor_unavailable", `${url.host}: the ledger answer is not JSON`);
    }
    if (body.sequence !== sequence || typeof body.hash !== "string" || !HASH.test(body.hash)) {
      throw new LedgerSourceError(
        "anchor_unavailable",
        `${url.host}: the answer for ledger ${String(sequence)} has no matching sequence and hash`,
      );
    }
    return body.hash;
  }
}
