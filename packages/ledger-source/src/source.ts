import type { xdr } from "@stellar/stellar-sdk";

/** One ledger and where it came from. */
export interface SourcedLedger {
  readonly sequence: number;
  readonly meta: xdr.LedgerCloseMeta;
  readonly source: "lake" | "rpc";
  /** The object URL, or the RPC endpoint and method. */
  readonly uri: string;
}

/**
 * A ledger read but not decoded yet. Decoded XDR objects take several times the memory of the bytes
 * they come from (a busy testnet ledger: about 0.3 MiB of base64, 2.5 MiB decoded), so a reader holds
 * fetched ledgers and decodes each one only when it is processed, then lets it go.
 */
export interface FetchedLedger {
  readonly sequence: number;
  /** The raw bytes held until `decode` (a compressed lake object, or a ledger's base64 XDR). */
  readonly bytes: number;
  /** Decodes and checks the ledger; throws a `LedgerSourceError` when it does not decode. */
  decode(): SourcedLedger;
}

export interface LedgerSource {
  readonly name: string;
  /** The ledger, or `undefined` when the source does not hold it yet. */
  getLedger(sequence: number): Promise<SourcedLedger | undefined>;
  /** The newest ledger the source holds; `from` is a ledger it is known to hold. */
  latestLedger(from: number): Promise<number>;
}
