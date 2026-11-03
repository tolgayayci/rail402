import { zstdDecompressSync } from "node:zlib";
import { xdr } from "@stellar/stellar-sdk";
import { LedgerSourceError } from "./errors.ts";
import { request, type Fetch } from "./http.ts";
import type { FetchedLedger, LedgerSource, SourcedLedger } from "./source.ts";

/** The public data lake: anonymous HTTPS, no account, one object per ledger. */
export const DATA_LAKE_BASE_URL =
  "https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/";
export const DATA_LAKE_HOST = "aws-public-blockchain.s3.us-east-2.amazonaws.com";

/** The layout the reader supports, as each folder's `.config.json` declares it. */
export const LEDGERS_PER_BATCH = 1;
export const BATCHES_PER_PARTITION = 64_000;

export interface DataLakeOptions {
  /** `pubnet`, or a testnet reset folder such as `testnet/2025-12-18`. */
  readonly folder: string;
  readonly passphrase: string;
  readonly baseUrl?: string;
  /** Hosts the base URL may name. Defaults to the public data lake's host only. */
  readonly allowedHosts?: readonly string[];
  readonly fetch?: Fetch;
  /** Largest compressed object, in bytes (default 16 MiB; pubnet ledgers are about 0.25 MiB). */
  readonly maxObjectBytes?: number;
  /** Largest decompressed ledger, in bytes (default 128 MiB; pubnet ledgers are about 2 MiB). */
  readonly maxLedgerBytes?: number;
  readonly timeoutMs?: number;
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const hex = (value: number) => (0xffffffff - value).toString(16).toUpperCase().padStart(8, "0");

/** The object key of a ledger inside a folder: `<partition>/<hex>--<sequence>.xdr.zst`. */
export function lakeObjectPath(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 0xffffffff) {
    throw new LedgerSourceError("source_config_invalid", `ledger ${String(sequence)} is out of range`);
  }
  const start = Math.floor(sequence / BATCHES_PER_PARTITION) * BATCHES_PER_PARTITION;
  const end = start + BATCHES_PER_PARTITION - 1;
  return `${hex(start)}--${String(start)}-${String(end)}/${hex(sequence)}--${String(sequence)}.xdr.zst`;
}

/** The first ledger of the partition holding `sequence`. */
export function partitionStart(sequence: number): number {
  return Math.floor(sequence / BATCHES_PER_PARTITION) * BATCHES_PER_PARTITION;
}

/** Reads one ledger per request from the public data lake (`LedgerCloseMetaBatch`, zstd). */
export class DataLakeSource implements LedgerSource {
  readonly name = "lake" as const;
  readonly #options: DataLakeOptions;
  readonly #base: URL;
  #checked = false;

  constructor(options: DataLakeOptions) {
    if (!/^(pubnet|testnet\/\d{4}-\d{2}-\d{2})$/.test(options.folder)) {
      throw new LedgerSourceError("source_config_invalid", `unexpected data lake folder "${options.folder}"`);
    }
    const base = new URL(options.baseUrl ?? DATA_LAKE_BASE_URL);
    const hosts = options.allowedHosts ?? [DATA_LAKE_HOST];
    if (
      base.protocol !== "https:" ||
      !hosts.includes(base.host) ||
      base.username !== "" ||
      base.search !== ""
    ) {
      throw new LedgerSourceError(
        "source_config_invalid",
        `the data lake URL must be https on ${hosts.join(", ")}`,
      );
    }
    this.#options = options;
    this.#base = new URL(`${base.pathname.replace(/\/?$/, "/")}${options.folder}/`, base);
  }

  /** The URL of a ledger's object, for manifests and error messages. */
  objectUrl(sequence: number): URL {
    return new URL(lakeObjectPath(sequence), this.#base);
  }

  /**
   * Checks the folder's `.config.json` once: the network passphrase, zstd and the one-ledger-per-object,
   * 64,000-objects-per-partition layout this reader computes paths for.
   */
  async checkConfig(): Promise<void> {
    if (this.#checked) return;
    const url = new URL(".config.json", this.#base);
    const result = await request(url, this.#http(64 * 1024));
    if (result.status === 404)
      throw new LedgerSourceError("lake_config_mismatch", `${url.href} does not exist`);
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(result.body.toString("utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new LedgerSourceError("lake_config_mismatch", `${url.href} is not JSON`, { cause: error });
    }
    const expected: Record<string, unknown> = {
      networkPassphrase: this.#options.passphrase,
      compression: "zstd",
      ledgersPerBatch: LEDGERS_PER_BATCH,
      batchesPerPartition: BATCHES_PER_PARTITION,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (config[key] !== value) {
        throw new LedgerSourceError(
          "lake_config_mismatch",
          `${url.href}: ${key} is ${JSON.stringify(config[key])}, expected ${JSON.stringify(value)}`,
        );
      }
    }
    this.#checked = true;
  }

  /** One ledger, or `undefined` when its object is not written yet (the head of the lake). */
  async getLedger(sequence: number): Promise<SourcedLedger | undefined> {
    return (await this.fetchLedger(sequence))?.decode();
  }

  /**
   * One ledger's compressed object, decoded only when asked (see `FetchedLedger`), or `undefined` when
   * the object is not written yet.
   */
  async fetchLedger(sequence: number): Promise<FetchedLedger | undefined> {
    await this.checkConfig();
    const url = this.objectUrl(sequence);
    const result = await request(url, this.#http(this.#options.maxObjectBytes ?? 16 * 1024 * 1024));
    if (result.status === 404) return undefined;
    const body = result.body;
    const maxLedgerBytes = this.#options.maxLedgerBytes;
    return {
      sequence,
      bytes: body.byteLength,
      decode: () => ({
        sequence,
        meta: decodeLakeObject(body, sequence, maxLedgerBytes),
        source: "lake",
        uri: url.href,
      }),
    };
  }

  /**
   * The newest ledger the lake holds, at or after `from` (which must exist): doubles the step until an
   * object is missing, then bisects. About 2·log2(lag) requests.
   */
  async latestLedger(from: number): Promise<number> {
    await this.checkConfig();
    const exists = async (sequence: number) => {
      const result = await request(this.objectUrl(sequence), this.#http(0), { method: "HEAD" });
      return result.status === 200;
    };
    return gallop(from, exists);
  }

  #http(maxBytes: number) {
    return {
      maxBytes,
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      ...(this.#options.timeoutMs === undefined ? {} : { timeoutMs: this.#options.timeoutMs }),
      ...(this.#options.attempts === undefined ? {} : { attempts: this.#options.attempts }),
      ...(this.#options.sleep === undefined ? {} : { sleep: this.#options.sleep }),
    };
  }
}

/** The largest `n ≥ from` with `exists(n)`, given `exists(from)` and that existence is a prefix. */
export async function gallop(from: number, exists: (sequence: number) => Promise<boolean>): Promise<number> {
  let low = from;
  let step = 1;
  let high = from + step;
  while (await exists(high)) {
    low = high;
    step *= 2;
    high = low + step;
  }
  // exists(low) and not exists(high)
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (await exists(middle)) low = middle;
    else high = middle;
  }
  return low;
}

/** Decompresses and decodes a data lake object, checking it holds exactly the expected ledger. */
export function decodeLakeObject(
  body: Buffer,
  sequence: number,
  maxLedgerBytes = 128 * 1024 * 1024,
): xdr.LedgerCloseMeta {
  let raw: Buffer;
  try {
    raw = zstdDecompressSync(body, { maxOutputLength: maxLedgerBytes });
  } catch (error) {
    const tooLarge =
      error instanceof RangeError || (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE";
    throw new LedgerSourceError(
      tooLarge ? "object_too_large" : "object_undecodable",
      `ledger ${String(sequence)}: ${tooLarge ? `decompresses beyond ${String(maxLedgerBytes)} bytes` : "not zstd"}`,
      { cause: error },
    );
  }
  let batch: xdr.LedgerCloseMetaBatch;
  try {
    batch = xdr.LedgerCloseMetaBatch.fromXDR(raw);
  } catch (error) {
    throw new LedgerSourceError(
      "object_undecodable",
      `ledger ${String(sequence)}: not a LedgerCloseMetaBatch`,
      { cause: error },
    );
  }
  const metas = batch.ledgerCloseMeta();
  const [meta] = metas;
  if (
    batch.startSequence() !== sequence ||
    batch.endSequence() !== sequence ||
    metas.length !== 1 ||
    meta === undefined
  ) {
    throw new LedgerSourceError(
      "ledger_mismatch",
      `the object for ledger ${String(sequence)} holds ${String(batch.startSequence())}-${String(batch.endSequence())}`,
    );
  }
  if (headerSequence(meta) !== sequence) {
    throw new LedgerSourceError(
      "ledger_mismatch",
      `the object for ledger ${String(sequence)} holds ledger ${String(headerSequence(meta))}`,
    );
  }
  return meta;
}

/** The sequence a ledger's own header names. */
export function headerSequence(meta: xdr.LedgerCloseMeta): number {
  switch (meta.switch()) {
    case 0:
      return meta.v0().ledgerHeader().header().ledgerSeq();
    case 1:
      return meta.v1().ledgerHeader().header().ledgerSeq();
    case 2:
      return meta.v2().ledgerHeader().header().ledgerSeq();
    default:
      throw new LedgerSourceError("object_undecodable", `LedgerCloseMeta version ${String(meta.switch())}`);
  }
}
