import { xdr } from "@stellar/stellar-sdk";
import { candidateOperation, classifyDecoded } from "./classify.ts";
import { readEnvelope } from "./transaction.ts";
import type {
  ClassifyContext,
  ExclusionReason,
  FailedAttemptRow,
  LedgerClassification,
  SettlementRow,
} from "./types.ts";
import { envelopeHashes, leadingVersion, networkId } from "./xdr.ts";

/**
 * Raised when a ledger cannot be read: it does not decode (an unknown `LedgerCloseMeta` or meta
 * version, or corrupt bytes), or its transaction set and its results disagree. The indexer must stop
 * at this ledger, never skip it.
 */
export class LedgerDecodeError extends Error {
  readonly code = "ledger_undecodable";
  constructor(message: string) {
    super(message);
    this.name = "LedgerDecodeError";
  }
}

/** The ledger header fields every consumer needs, without classifying. */
export interface LedgerHeaderView {
  readonly ledger: number;
  readonly ledgerHash: string;
  readonly previousLedgerHash: string;
  readonly closedAt: string;
  readonly protocolVersion: number;
}

/** Decodes base64 `LedgerCloseMeta`, throwing `LedgerDecodeError` when it does not decode. */
export function decodeLedgerCloseMeta(lcm: string | xdr.LedgerCloseMeta): xdr.LedgerCloseMeta {
  if (typeof lcm !== "string") return lcm;
  try {
    return xdr.LedgerCloseMeta.fromXDR(lcm, "base64");
  } catch (error) {
    const version = leadingVersion(lcm);
    throw new LedgerDecodeError(
      `LedgerCloseMeta${version === undefined ? "" : ` version ${String(version)}`} does not decode: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** The header of a decoded ledger. */
export function ledgerHeader(meta: xdr.LedgerCloseMeta): LedgerHeaderView {
  const entry = ledgerValue(meta).ledgerHeader();
  const header = entry.header();
  return {
    ledger: header.ledgerSeq(),
    ledgerHash: entry.hash().toString("hex"),
    previousLedgerHash: header.previousLedgerHash().toString("hex"),
    closedAt: new Date(Number(header.scpValue().closeTime().toString()) * 1000).toISOString(),
    protocolVersion: header.ledgerVersion(),
  };
}

type LedgerValue = xdr.LedgerCloseMetaV0 | xdr.LedgerCloseMetaV1 | xdr.LedgerCloseMetaV2;

function ledgerValue(meta: xdr.LedgerCloseMeta): LedgerValue {
  switch (meta.switch()) {
    case 0:
      return meta.v0();
    case 1:
      return meta.v1();
    case 2:
      return meta.v2();
    default:
      throw new LedgerDecodeError(`LedgerCloseMeta version ${String(meta.switch())} is not supported`);
  }
}

/** Every envelope in a ledger's transaction set, in set order. */
function envelopesOf(meta: xdr.LedgerCloseMeta): xdr.TransactionEnvelope[] {
  if (meta.switch() === 0) return meta.v0().txSet().txes();
  const set = (meta.switch() === 1 ? meta.v1() : meta.v2()).txSet();
  if (set.switch() !== 1)
    throw new LedgerDecodeError(`transaction set version ${String(set.switch())} is not supported`);
  const envelopes: xdr.TransactionEnvelope[] = [];
  for (const phase of set.v1TxSet().phases()) {
    switch (phase.switch()) {
      case 0:
        for (const component of phase.v0Components())
          envelopes.push(...component.txsMaybeDiscountedFee().txes());
        break;
      case 1:
        for (const stage of phase.parallelTxsComponent().executionStages()) {
          for (const cluster of stage) envelopes.push(...cluster);
        }
        break;
      default:
        throw new LedgerDecodeError(`transaction phase ${String(phase.switch())} is not supported`);
    }
  }
  return envelopes;
}

/**
 * Classifies every transaction of one ledger under rules v2. Only envelopes with a candidate
 * operation are hashed and matched to their results; a candidate without a result, or a result whose
 * meta version is unknown, throws (`LedgerDecodeError`, `UnsupportedMetaError`) instead of skipping.
 */
export function classifyLedger(
  lcm: string | xdr.LedgerCloseMeta,
  ctx: ClassifyContext,
): LedgerClassification {
  const meta = decodeLedgerCloseMeta(lcm);
  const header = ledgerHeader(meta);
  const value = ledgerValue(meta);
  const network = networkId(ctx.passphrase);

  const candidates = new Map<string, xdr.TransactionEnvelope>();
  for (const envelope of envelopesOf(meta)) {
    const view = readEnvelope(envelope);
    if (view === undefined || candidateOperation(view.operations) === undefined) continue;
    candidates.set(envelopeHashes(envelope, network).hash, envelope);
  }

  const rows: SettlementRow[] = [];
  const failed: FailedAttemptRow[] = [];
  const excluded: Partial<Record<ExclusionReason, number>> = {};
  const processing = value.txProcessing();
  let matched = 0;
  processing.forEach((entry, position) => {
    const hash = entry.result().transactionHash().toString("hex");
    const envelope = candidates.get(hash);
    if (envelope === undefined) return;
    matched++;
    const outcome = classifyDecoded(
      {
        envelope,
        result: entry.result().result(),
        meta: entry.txApplyProcessing(),
        ledger: header.ledger,
        txIndex: position + 1,
        closedAt: header.closedAt,
      },
      ctx,
      network,
    );
    switch (outcome.kind) {
      case "settlement":
        rows.push(outcome.row);
        break;
      case "failed_attempt":
        failed.push(outcome.row);
        break;
      case "excluded":
        excluded[outcome.reason] = (excluded[outcome.reason] ?? 0) + 1;
        break;
      case "none":
        break;
    }
  });
  if (matched !== candidates.size) {
    throw new LedgerDecodeError(
      `ledger ${String(header.ledger)}: ${String(candidates.size - matched)} transactions have no result`,
    );
  }
  return {
    ledger: header.ledger,
    ledgerHash: header.ledgerHash,
    previousLedgerHash: header.previousLedgerHash,
    closedAt: header.closedAt,
    txCount: processing.length,
    rows,
    failed,
    excluded,
  };
}
