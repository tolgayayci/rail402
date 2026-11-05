/** How long viewers share one read of the chain's newest ledger. */
const CACHE_MS = 4_000;
const TIMEOUT_MS = 3_000;

/**
 * The newest ledger of a network, read from its public RPC. Viewers share one read per few seconds, so
 * the RPC sees the same load however many pages are open; a failed read gives undefined, and the last
 * known ledger is not shown as if it were current.
 */
export class ChainTip {
  readonly #rpcUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #at = Number.NEGATIVE_INFINITY;
  #value: number | undefined;
  #running: Promise<number | undefined> | undefined;

  constructor(rpcUrl: string, options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.#rpcUrl = rpcUrl;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  latest(): Promise<number | undefined> {
    if (this.#now() - this.#at < CACHE_MS) return Promise.resolve(this.#value);
    this.#running ??= this.#read().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #read(): Promise<number | undefined> {
    let value: number | undefined;
    try {
      const response = await this.#fetch(this.#rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await response.json()) as { result?: { sequence?: unknown } };
      const sequence = body.result?.sequence;
      if (response.ok && typeof sequence === "number" && Number.isSafeInteger(sequence)) value = sequence;
    } catch {
      // The status answers without the chain's ledger.
    }
    this.#value = value;
    this.#at = this.#now();
    return value;
  }
}
