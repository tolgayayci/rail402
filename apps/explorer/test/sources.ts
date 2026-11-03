import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { xdr } from "@stellar/stellar-sdk";
import type { FetchedLedger, LedgerSource, SourcedLedger } from "@rail402.dev/ledger-source";
import { BETA_LEDGERS, ledgerMeta, sealResult } from "../../../packages/x402-index/test/helpers.ts";

/** The committed testnet ledger slice, shared with the indexing rules' tests. */
export const FIXTURE_LEDGERS = new URL(
  "../../../packages/x402-index/test/fixtures/ledgers/testnet/",
  import.meta.url,
);

export const FIXTURE_SLICE: readonly number[] = readdirSync(FIXTURE_LEDGERS)
  .map((name) => Number(name.replace(".xdr.zst", "")))
  .sort((a, b) => a - b);

export function fixtureMeta(sequence: number): xdr.LedgerCloseMeta {
  const raw = zstdDecompressSync(readFileSync(new URL(`${String(sequence)}.xdr.zst`, FIXTURE_LEDGERS)));
  const [meta] = xdr.LedgerCloseMetaBatch.fromXDR(raw).ledgerCloseMeta();
  if (meta === undefined) throw new Error("empty batch");
  return meta;
}

/** A ledger source that holds a set of fixture ledgers; `held` can grow to simulate new ledgers. */
export class FixtureSource implements LedgerSource {
  readonly name = "fixture";
  readonly held: Set<number>;
  readonly reads: number[] = [];
  /** Answers a different ledger's data for a sequence, to simulate tampering. */
  readonly swap = new Map<number, number>();

  constructor(held: Iterable<number>) {
    this.held = new Set(held);
  }

  getLedger(sequence: number): Promise<SourcedLedger | undefined> {
    this.reads.push(sequence);
    if (!this.held.has(sequence)) return Promise.resolve(undefined);
    const served = this.swap.get(sequence) ?? sequence;
    return Promise.resolve({
      sequence,
      meta: fixtureMeta(served),
      source: "lake",
      uri: `fixture:${String(served)}`,
    });
  }

  /** The ledger as a byte source fetches it: decoded only when asked. */
  async fetchLedger(sequence: number): Promise<FetchedLedger | undefined> {
    return fetched(await this.getLedger(sequence));
  }

  latestLedger(): Promise<number> {
    return Promise.resolve(Math.max(...this.held));
  }
}

/** A ledger handed out as fetched, with its size as the bytes held. */
export function fetched(ledger: SourcedLedger | undefined): FetchedLedger | undefined {
  if (ledger === undefined) return undefined;
  return { sequence: ledger.sequence, bytes: ledger.meta.toXDR().byteLength, decode: () => ledger };
}

/** A source that serves the given ledgers by sequence. */
export class MetaSource implements LedgerSource {
  readonly name = "meta";
  readonly #ledgers: ReadonlyMap<number, xdr.LedgerCloseMeta>;

  constructor(ledgers: ReadonlyMap<number, xdr.LedgerCloseMeta>) {
    this.#ledgers = ledgers;
  }

  getLedger(sequence: number): Promise<SourcedLedger | undefined> {
    const meta = this.#ledgers.get(sequence);
    return Promise.resolve(
      meta === undefined ? undefined : { sequence, meta, source: "lake", uri: `meta:${String(sequence)}` },
    );
  }

  async fetchLedger(sequence: number): Promise<FetchedLedger | undefined> {
    return fetched(await this.getLedger(sequence));
  }

  latestLedger(): Promise<number> {
    return Promise.resolve(Math.max(...this.#ledgers.keys()));
  }
}

/** The beta settlement in testnet ledger 3,953,878 (fixtures/ledgers/testnet-beta). */
export const BETA_SETTLEMENT = "b38c1addac90858868b2b59e68740d26540c393d8733de1349df1dde6358c92f";

/**
 * Testnet ledger 3,953,878 as a hostile token would have made it: the beta settlement's transfer event
 * carries CAP-67 data `{ amount, to_muxed_id: "a\0" }`. The result, the result set hash and the ledger
 * hash are recomputed, so the ledger verifies as a real one would: only the rules stand in the way.
 */
export function poisonedBetaLedger(): xdr.LedgerCloseMeta {
  const meta = ledgerMeta(3_953_878, BETA_LEDGERS);
  const value = meta.switch() === 1 ? meta.v1() : meta.v2();
  for (const entry of value.txProcessing()) {
    if (entry.result().transactionHash().toString("hex") !== BETA_SETTLEMENT) continue;
    const txMeta = entry.txApplyProcessing();
    for (const event of txMeta.v4().operations()[0]?.events() ?? []) {
      const body = event.body().v0();
      const [topic] = body.topics();
      if (topic?.switch() !== xdr.ScValType.scvSymbol() || topic.sym().toString() !== "transfer") continue;
      body.data(
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: body.data() }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("to_muxed_id"),
            val: xdr.ScVal.scvString("a\u0000"),
          }),
        ]),
      );
    }
    const sealed = sealResult(entry.result().result().toXDR("base64"), txMeta);
    entry.result().result(xdr.TransactionResult.fromXDR(sealed, "base64"));
  }
  const entry = value.ledgerHeader();
  const header = entry.header();
  const results = new xdr.TransactionResultSet({
    results: value.txProcessing().map((item) => item.result()),
  });
  header.txSetResultHash(createHash("sha256").update(results.toXDR()).digest());
  entry.hash(createHash("sha256").update(header.toXDR()).digest());
  return meta;
}
