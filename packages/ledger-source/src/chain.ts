import { createHash } from "node:crypto";
import { xdr } from "@stellar/stellar-sdk";
import { LedgerSourceError } from "./errors.ts";

/** A ledger whose header, transaction set and results agree with its own hash. */
export interface VerifiedLedger {
  readonly ledger: number;
  readonly hash: string;
  readonly previousHash: string;
  readonly closedAt: string;
}

/** A ledger hash known from a source independent of the one being read (e.g. Horizon or a manifest). */
export interface Anchor {
  readonly ledger: number;
  readonly hash: string;
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * Checks one ledger against itself: the ledger hash is the SHA-256 of its header, the header's
 * transaction set hash is the SHA-256 of the transaction set, and its result hash is the SHA-256 of the
 * results in application order. Envelopes and results are therefore bound to the hash chain. Metas are
 * not hashed by the header, but a contract call's result commits to its events and return value
 * (`InvokeHostFunctionResult.success`), which the classifier checks (`assertEventsBound` in
 * `@rail402.dev/x402-index`). Version 0 ledgers (before protocol 20) are refused.
 */
export function verifyLedger(meta: xdr.LedgerCloseMeta): VerifiedLedger {
  if (meta.switch() !== 1 && meta.switch() !== 2) {
    throw new LedgerSourceError(
      "object_undecodable",
      `LedgerCloseMeta version ${String(meta.switch())} is not supported`,
    );
  }
  const value = meta.switch() === 1 ? meta.v1() : meta.v2();
  const entry = value.ledgerHeader();
  const header = entry.header();
  const ledger = header.ledgerSeq();
  const hash = entry.hash().toString("hex");
  if (sha256(header.toXDR()) !== hash) {
    throw new LedgerSourceError(
      "ledger_hash_invalid",
      `ledger ${String(ledger)}: the header does not hash to the ledger hash`,
    );
  }
  if (sha256(value.txSet().toXDR()) !== header.scpValue().txSetHash().toString("hex")) {
    throw new LedgerSourceError(
      "tx_set_hash_mismatch",
      `ledger ${String(ledger)}: the transaction set does not match the header`,
    );
  }
  const results = new xdr.TransactionResultSet({
    results: value.txProcessing().map((entry) => entry.result()),
  });
  if (sha256(results.toXDR()) !== header.txSetResultHash().toString("hex")) {
    throw new LedgerSourceError(
      "result_set_hash_mismatch",
      `ledger ${String(ledger)}: the results do not match the header`,
    );
  }
  return {
    ledger,
    hash,
    previousHash: header.previousLedgerHash().toString("hex"),
    closedAt: new Date(Number(header.scpValue().closeTime().toString()) * 1000).toISOString(),
  };
}

/**
 * Checks that `ledgers` follow `start` (when given) and each other without a gap, each one's previous
 * hash being the hash of the ledger before it. Throws at the first break: the indexer stops there.
 */
export function verifyHashChain(ledgers: readonly VerifiedLedger[], start?: Anchor): void {
  let last = start;
  for (const ledger of ledgers) {
    if (last !== undefined) link(last, ledger);
    last = ledger;
  }
}

function link(previous: Anchor, next: VerifiedLedger): void {
  if (next.ledger !== previous.ledger + 1) {
    throw new LedgerSourceError(
      "ledger_gap",
      `ledger ${String(next.ledger)} does not follow ${String(previous.ledger)}`,
    );
  }
  if (next.previousHash !== previous.hash) {
    throw new LedgerSourceError(
      "ledger_hash_mismatch",
      `ledger ${String(next.ledger)}: its previous hash ${next.previousHash.slice(0, 12)}… is not ledger ${String(previous.ledger)}'s hash ${previous.hash.slice(0, 12)}…`,
    );
  }
}

/** A running chain: appends verified ledgers one by one and remembers the last. */
export class HashChain {
  #last: Anchor | undefined;
  readonly #anchors: ReadonlyMap<number, string>;

  /** `start` is the last ledger already verified; `anchors` are independently known hashes. */
  constructor(start?: Anchor, anchors: readonly Anchor[] = []) {
    this.#last = start;
    this.#anchors = new Map(anchors.map((anchor) => [anchor.ledger, anchor.hash]));
    if (start !== undefined) this.#checkAnchor(start);
  }

  get last(): Anchor | undefined {
    return this.#last;
  }

  append(ledger: VerifiedLedger): void {
    const last = this.#last;
    if (
      last !== undefined &&
      ledger.ledger === last.ledger + 1 &&
      this.#anchors.get(last.ledger) === last.hash &&
      ledger.previousHash !== last.hash
    ) {
      throw new LedgerSourceError(
        "anchor_mismatch",
        `ledger ${String(ledger.ledger)}: its previous hash ${ledger.previousHash} differs from the anchor ${last.hash} for ledger ${String(last.ledger)}`,
      );
    }
    if (last !== undefined) link(last, ledger);
    this.#checkAnchor(ledger);
    this.#last = { ledger: ledger.ledger, hash: ledger.hash };
  }

  #checkAnchor(ledger: Anchor): void {
    const expected = this.#anchors.get(ledger.ledger);
    if (expected !== undefined && expected !== ledger.hash) {
      throw new LedgerSourceError(
        "anchor_mismatch",
        `ledger ${String(ledger.ledger)}: hash ${ledger.hash} differs from the anchor ${expected}`,
      );
    }
  }
}
