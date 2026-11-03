import type { Buffer } from "buffer";
import { xdr } from "@stellar/stellar-sdk";
import { UnsupportedMetaError } from "@rail402.dev/stellar";
import { verifySacAsset } from "./asset.ts";
import { attributeSettlement } from "./attribution.ts";
import { instanceWasmHashes, operationEvents } from "./events.ts";
import { assertEventsBound } from "./integrity.ts";
import { exactRule } from "./rules/exact.ts";
import { operationSource, type RuleFacts, type RuleOutcome } from "./rules/common.ts";
import { uptoRule } from "./rules/upto.ts";
import { unstorableFields } from "./storable.ts";
import { readEnvelope, type OperationView } from "./transaction.ts";
import {
  RULES_VERSION,
  type Classification,
  type ClassifyContext,
  type SettlementRow,
  type TransactionInput,
} from "./types.ts";
import { decodeXdr, envelopeHashes, leadingVersion, networkId } from "./xdr.ts";

const MALFORMED: Classification = { kind: "excluded", reason: "malformed" };
const NONE: Classification = { kind: "none" };

/** A transaction with its parts decoded: from a ledger, or from base64 input. */
export interface DecodedTransaction {
  readonly envelope: xdr.TransactionEnvelope;
  readonly result: xdr.TransactionResult;
  readonly meta: xdr.TransactionMeta;
  readonly ledger: number;
  readonly txIndex: number;
  readonly closedAt: string;
}

/**
 * Classifies one transaction under rules v2. Never throws on hostile envelopes: base64 that does not
 * decode is `excluded: malformed`, and an envelope whose accounts or addresses do not read is `none`,
 * as in `classifyLedger`. It throws in two cases, so that an indexer stops instead of skipping: a
 * transaction meta version this package does not know (`UnsupportedMetaError`), and a successful
 * candidate whose events do not hash to its result (`EventIntegrityError`).
 */
export function classifyTransaction(input: TransactionInput, ctx: ClassifyContext): Classification {
  const version = leadingVersion(input.metaXdr);
  if (version !== undefined && (version < 0 || version > 4)) throw new UnsupportedMetaError(version);
  const envelope = decodeXdr(xdr.TransactionEnvelope, input.envelopeXdr);
  const result = decodeXdr(xdr.TransactionResult, input.resultXdr);
  const meta = decodeXdr(xdr.TransactionMeta, input.metaXdr);
  if (envelope === undefined || result === undefined || meta === undefined) return MALFORMED;
  if (!Number.isSafeInteger(input.ledger) || input.ledger < 1 || !Number.isSafeInteger(input.txIndex)) {
    return MALFORMED;
  }
  return classifyDecoded(
    { envelope, result, meta, ledger: input.ledger, txIndex: input.txIndex, closedAt: input.closedAt },
    ctx,
    networkId(ctx.passphrase),
  );
}

/** The first invokeHostFunction contract call that could be an x402 settlement, with its index. */
export function candidateOperation(
  operations: readonly OperationView[],
): { readonly operation: OperationView; readonly index: number } | undefined {
  const index = operations.findIndex((operation) => operation.invocation !== null);
  const operation = operations[index];
  if (operation?.invocation === null || operation === undefined) return undefined;
  const { fn, args } = operation.invocation;
  return (fn === "transfer" && args.length === 3) || fn === "settle" ? { operation, index } : undefined;
}

/** `classifyTransaction` over decoded parts. `network` is the network id (SHA-256 of the passphrase). */
export function classifyDecoded(
  tx: DecodedTransaction,
  ctx: ClassifyContext,
  network: Buffer,
): Classification {
  // Rules section 1: an envelope that does not read is a non-match, on every path.
  const view = readEnvelope(tx.envelope);
  if (view === undefined) return NONE;
  const candidate = candidateOperation(view.operations);
  if (candidate === undefined) return NONE;
  // Unknown meta versions throw here, before any decision.
  const events = operationEvents(tx.meta);
  const success = isSuccess(tx.result);
  // The events the rules read must be the ones the (consensus-bound) result committed.
  if (success) assertEventsBound(tx.result, tx.meta, candidate.index);
  let instanceWasm: Map<string, Set<string>>;
  try {
    instanceWasm = instanceWasmHashes(tx.meta);
  } catch {
    return MALFORMED;
  }
  const facts: RuleFacts = {
    view,
    operation: candidate.operation,
    operationIndex: candidate.index,
    events: success ? (events[candidate.index] ?? []) : [],
    instanceWasm,
    passphrase: ctx.passphrase,
    networkId: network,
    ledger: tx.ledger,
  };
  const invocation = candidate.operation.invocation;
  const uptoEntry =
    invocation?.fn === "settle"
      ? ctx.registry.uptoContractAt(invocation.contract, ctx.epoch, tx.ledger)
      : undefined;
  let outcome: RuleOutcome;
  try {
    outcome = invocation?.fn === "settle" ? uptoRule(facts, uptoEntry, success) : exactRule(facts, success);
  } catch {
    return MALFORMED;
  }
  if (outcome.kind === "none") return NONE;
  if (outcome.kind === "excluded") return success ? { kind: "excluded", reason: outcome.reason } : NONE;

  let hashes: { readonly hash: string; readonly innerHash: string | null };
  try {
    hashes = envelopeHashes(tx.envelope, network);
  } catch {
    return MALFORMED;
  }
  const feeCharged = feeChargedOf(tx.result);
  if (!success) {
    const row = {
      network: ctx.network,
      epoch: ctx.epoch,
      ledger: tx.ledger,
      txIndex: tx.txIndex,
      txHash: hashes.hash,
      scheme: outcome.scheme,
      resultCode: resultCodeOf(tx.result),
      feePayer: view.feePayer.base,
      feeChargedStroops: feeCharged,
    };
    // A row that could not be stored exactly as it is never leaves the classifier (section 7).
    return unstorableFields(row).length > 0 ? NONE : { kind: "failed_attempt", row };
  }
  const opSource = operationSource({ view, operation: candidate.operation }).base;
  const row: SettlementRow = {
    network: ctx.network,
    epoch: ctx.epoch,
    ledger: tx.ledger,
    txIndex: tx.txIndex,
    txHash: hashes.hash,
    innerHash: hashes.innerHash,
    closedAt: tx.closedAt,
    scheme: outcome.scheme,
    ruleId: outcome.ruleId,
    rulesVersion: RULES_VERSION,
    registryVersion: ctx.registry.registryVersion,
    asset: verifySacAsset(outcome.assetContract, outcome.assetTopic, ctx.passphrase),
    payer: outcome.payer.base,
    payerKind: outcome.payer.kind,
    payTo: outcome.payTo,
    payToMuxedId: outcome.payToMuxedId,
    amount: outcome.amount.toString(),
    maxAmount: outcome.maxAmount === null ? null : outcome.maxAmount.toString(),
    upto: outcome.upto,
    fee: {
      bump: view.feeBump,
      payer: view.feePayer.base,
      innerSource: view.innerSource.base,
      opSource,
      chargedStroops: feeCharged,
      sponsored: view.feePayer.base !== outcome.payer.base,
    },
    attribution: attributeSettlement(ctx.registry, {
      epoch: ctx.epoch,
      ledger: tx.ledger,
      ruleId: outcome.ruleId,
      upto: outcome.upto,
      fee: { payer: view.feePayer.base, innerSource: view.innerSource.base, opSource },
    }),
    checks: outcome.checks,
  };
  return unstorableFields(row).length > 0 ? MALFORMED : { kind: "settlement", row };
}

/** `txSuccess`, or `txFeeBumpInnerSuccess` for a fee bump. */
export function isSuccess(result: xdr.TransactionResult): boolean {
  const code = result.result().switch();
  return (
    code === xdr.TransactionResultCode.txSuccess() ||
    code === xdr.TransactionResultCode.txFeeBumpInnerSuccess()
  );
}

function feeChargedOf(result: xdr.TransactionResult): string {
  try {
    return result.feeCharged().toString();
  } catch {
    return "0";
  }
}

/** Outer, inner and operation result codes joined with ":", e.g. `txFeeBumpInnerFailed:txFailed:invokeHostFunctionTrapped`. */
export function resultCodeOf(result: xdr.TransactionResult): string {
  const codes: string[] = [];
  try {
    const outer = result.result();
    codes.push(outer.switch().name);
    let results: xdr.OperationResult[] | undefined;
    const code = outer.switch();
    if (
      code === xdr.TransactionResultCode.txFeeBumpInnerFailed() ||
      code === xdr.TransactionResultCode.txFeeBumpInnerSuccess()
    ) {
      const inner = outer.innerResultPair().result().result();
      codes.push(inner.switch().name);
      if (inner.switch() === xdr.TransactionResultCode.txFailed()) results = inner.results();
    } else if (code === xdr.TransactionResultCode.txFailed()) results = outer.results();
    const [first] = results ?? [];
    if (first !== undefined) {
      if (first.switch() === xdr.OperationResultCode.opInner()) {
        const tr = first.tr();
        const value = tr.value() as { switch?: () => { name: string } };
        const name = typeof value.switch === "function" ? value.switch().name : undefined;
        if (name !== undefined) codes.push(name);
      } else codes.push(first.switch().name);
    }
  } catch {
    // Keep the codes read so far.
  }
  return codes.length === 0 ? "unknown" : codes.join(":");
}
