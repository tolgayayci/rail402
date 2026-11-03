import { xdr } from "@stellar/stellar-sdk";
import { LedgerSourceError } from "./errors.ts";
import { request, type Fetch } from "./http.ts";
import { headerSequence } from "./lake.ts";
import { checkLumeusKey, lumeusHostNetwork, type Limiter, type LumeusNetwork } from "./lumeus.ts";
import type { FetchedLedger, LedgerSource, SourcedLedger } from "./source.ts";

export interface RpcLedgerOptions {
  /** The RPC endpoint (https). */
  readonly url: string;
  readonly fetch?: Fetch;
  /** Largest response, in bytes (default 64 MiB). */
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * A Lumeus server key, sent as `Authorization: Bearer` (read it from a secret file, never from an
   * inline setting). Only a Lumeus RPC host of `network` gets it: any other URL, or a key of the other
   * network, is refused at construction. Never logged and never part of an error.
   */
  readonly apiKey?: string;
  /** The network the RPC serves; required with `apiKey`, to pair the key with the host. */
  readonly network?: LumeusNetwork;
  /** Most ledgers per `getLedgers` call (default 200). Lumeus: 100 on testnet keeps the answer far below its 64 MiB cap; 20 on mainnet. */
  readonly pageLimit?: number;
  /** Shared with the other Lumeus clients, to bound requests in flight. */
  readonly limiter?: Limiter;
}

/** The ledgers an RPC holds now. */
export interface RpcRetention {
  readonly oldestLedger: number;
  readonly latestLedger: number;
}

interface RpcLedger {
  readonly sequence: number;
  readonly metadataXdr: string;
}

interface GetLedgersResult {
  readonly ledgers: readonly RpcLedger[];
  readonly latestLedger: number;
  readonly oldestLedger: number;
}

/**
 * Reads ledgers through RPC `getLedgers`. The RPC keeps a retention window of about a week, so this
 * serves recent ledgers; older ones come from the data lake.
 */
export class RpcLedgerSource implements LedgerSource {
  readonly name = "rpc" as const;
  readonly #options: RpcLedgerOptions;
  readonly #url: URL;
  readonly #headers: Readonly<Record<string, string>>;
  #latest = 0;
  #oldest = 0;
  #id = 0;

  constructor(options: RpcLedgerOptions) {
    const url = new URL(options.url);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      throw new LedgerSourceError("source_config_invalid", "the RPC URL must be https without credentials");
    }
    if (options.apiKey !== undefined) {
      const hostNetwork = lumeusHostNetwork(url.host);
      if (hostNetwork === undefined || options.network === undefined || hostNetwork !== options.network) {
        throw new LedgerSourceError(
          "source_config_invalid",
          `a Lumeus key is sent only to the Lumeus RPC host of its network, not to ${url.host}`,
        );
      }
      checkLumeusKey(options.apiKey, options.network);
    }
    this.#url = url;
    this.#options = options;
    this.#headers = options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` };
  }

  /** The RPC's retention window as `getHealth` reports it now. */
  async retention(): Promise<RpcRetention> {
    await this.#refresh();
    return { oldestLedger: this.#oldest, latestLedger: this.#latest };
  }

  async getLedger(sequence: number): Promise<SourcedLedger | undefined> {
    const [ledger] = await this.getLedgers(sequence, 1);
    return ledger;
  }

  /**
   * Up to `limit` (at most the page limit) consecutive ledgers from `start`; empty when `start` is beyond
   * the RPC's head. Each ledger's own header must name the sequence it is listed under.
   */
  async getLedgers(start: number, limit: number): Promise<SourcedLedger[]> {
    return (await this.fetchLedgers(start, limit)).map((ledger) => ledger.decode());
  }

  /**
   * Like `getLedgers`, but each ledger stays base64 XDR until it is decoded (see `FetchedLedger`): only
   * the metadata string of each ledger is kept from the answer. The listed sequences must run on from
   * `start`; decoding checks that the ledger's own header names its sequence.
   */
  async fetchLedgers(start: number, limit: number): Promise<FetchedLedger[]> {
    if (this.#latest !== 0 && start > this.#latest) await this.#refresh();
    if (this.#latest !== 0 && start > this.#latest) return [];
    if (this.#oldest !== 0 && start < this.#oldest) {
      throw new LedgerSourceError(
        "rpc_error",
        `ledger ${String(start)} is older than the RPC's retention (${String(this.#oldest)})`,
      );
    }
    const result = await this.#call<GetLedgersResult>("getLedgers", {
      startLedger: start,
      pagination: { limit: Math.min(Math.max(1, limit), this.#options.pageLimit ?? 200) },
      xdrFormat: "base64",
    }).catch(async (error: unknown) => {
      // An RPC refuses a start beyond its head; find out whether that is all it was.
      if (error instanceof LedgerSourceError && error.code === "rpc_error") {
        await this.#refresh();
        if (start > this.#latest) return undefined;
      }
      throw error;
    });
    if (result === undefined) return [];
    this.#latest = result.latestLedger;
    this.#oldest = result.oldestLedger;
    const uri = `${this.#url.origin}${this.#url.pathname}#getLedgers`;
    const ledgers: FetchedLedger[] = [];
    let expected = start;
    for (const ledger of result.ledgers) {
      if (ledger.sequence !== expected) {
        throw new LedgerSourceError(
          "ledger_mismatch",
          `getLedgers returned ${String(ledger.sequence)} where ${String(expected)} was due`,
        );
      }
      ledgers.push(fetchedRpcLedger(ledger.sequence, ledger.metadataXdr, uri));
      expected++;
    }
    return ledgers;
  }

  async latestLedger(): Promise<number> {
    await this.#refresh();
    return this.#latest;
  }

  async #refresh(): Promise<void> {
    const health = await this.#call<{ latestLedger: number; oldestLedger: number }>("getHealth", undefined);
    this.#latest = health.latestLedger;
    this.#oldest = health.oldestLedger;
  }

  async #call<T>(method: string, params: unknown): Promise<T> {
    const call = () => this.#send(method, params);
    const result = await (this.#options.limiter === undefined ? call() : this.#options.limiter.run(call));
    if (result.status === 404) throw new LedgerSourceError("http_status", `${this.#url.host} answered 404`);
    let body: { result?: T; error?: { message?: unknown } };
    try {
      body = JSON.parse(result.body.toString("utf8")) as typeof body;
    } catch (error) {
      throw new LedgerSourceError("rpc_error", `${method}: the response is not JSON`, { cause: error });
    }
    if (body.error !== undefined || body.result === undefined) {
      const message =
        typeof body.error?.message === "string" ? body.error.message.slice(0, 200) : "no result";
      throw new LedgerSourceError("rpc_error", `${method}: ${message}`);
    }
    return body.result;
  }

  #send(method: string, params: unknown) {
    return request(
      this.#url,
      {
        maxBytes: this.#options.maxBytes ?? 64 * 1024 * 1024,
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
        ...(this.#options.attempts === undefined ? {} : { attempts: this.#options.attempts }),
        ...(this.#options.sleep === undefined ? {} : { sleep: this.#options.sleep }),
      },
      {
        method: "POST",
        headers: this.#headers,
        json: { jsonrpc: "2.0", id: ++this.#id, method, ...(params === undefined ? {} : { params }) },
      },
    );
  }
}

/** One `getLedgers` entry, kept as its base64 metadata until it is decoded. */
function fetchedRpcLedger(sequence: number, metadataXdr: string, uri: string): FetchedLedger {
  if (typeof metadataXdr !== "string") {
    throw new LedgerSourceError(
      "object_undecodable",
      `getLedgers ledger ${String(sequence)} has no metadata`,
    );
  }
  return {
    sequence,
    bytes: metadataXdr.length,
    decode: () => {
      let meta: xdr.LedgerCloseMeta;
      try {
        meta = xdr.LedgerCloseMeta.fromXDR(metadataXdr, "base64");
      } catch (error) {
        throw new LedgerSourceError(
          "object_undecodable",
          `getLedgers ledger ${String(sequence)} does not decode`,
          { cause: error },
        );
      }
      if (headerSequence(meta) !== sequence) {
        throw new LedgerSourceError(
          "ledger_mismatch",
          `getLedgers listed ledger ${String(sequence)} with the meta of ledger ${String(headerSequence(meta))}`,
        );
      }
      return { sequence, meta, source: "rpc", uri };
    },
  };
}
