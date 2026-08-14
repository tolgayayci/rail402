import {
  Address,
  StrKey,
  encodeMuxedAccountToAddress,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

/**
 * Horizon-record → classifier-input adapter (Tier 2 backfill).
 *
 * Transactions older than the RPC retention window (~7 days) exist only on Horizon, which serves
 * the raw `envelope_xdr` instead of RPC's decoded JSON. This module decodes exactly the fields
 * `classifyTransaction` reads and re-encodes them in the RPC JSON shapes the classifier (and its
 * real-capture fixtures) are built on: `{address}`, `{i128:"…"}`, `{u32:…}`, the literal string
 * `"source_account"` for source credentials, `"void"` for empty optionals.
 *
 * What it deliberately does NOT decode: result metadata (events). The classifier only used events
 * for the SEP-11 asset string, muxed ids and the net fee — for backfilled rows the asset string is
 * absent, and the fee comes from Horizon's own `fee_charged` (verified equal to the fee-event
 * computation on tx feb9bedb…: both 23,086).
 */

export interface HorizonTxRecord {
  readonly hash: string;
  readonly ledger: number;
  readonly created_at: string;
  readonly successful: boolean;
  readonly envelope_xdr: string;
  readonly fee_charged?: string | number;
  readonly paging_token?: string;
}

function muxedToAddress(account: xdr.MuxedAccount): string {
  return account.switch() === xdr.CryptoKeyType.keyTypeEd25519()
    ? StrKey.encodeEd25519PublicKey(account.ed25519())
    : encodeMuxedAccountToAddress(account);
}

/** ScVal → the RPC JSON encoding, for the kinds the classifier reads. Unknown kinds become `{}`,
 * which the classifier treats as unreadable and skips — never a throw. */
function scValToRpcJson(value: xdr.ScVal): unknown {
  switch (value.switch()) {
    case xdr.ScValType.scvAddress():
      return { address: Address.fromScVal(value).toString() };
    case xdr.ScValType.scvI128():
      return { i128: (scValToNative(value) as bigint).toString() };
    case xdr.ScValType.scvU128():
      return { u128: (scValToNative(value) as bigint).toString() };
    case xdr.ScValType.scvU32():
      return { u32: value.u32() };
    case xdr.ScValType.scvI32():
      return { i32: value.i32() };
    case xdr.ScValType.scvU64():
      return { u64: value.u64().toString() };
    case xdr.ScValType.scvI64():
      return { i64: value.i64().toString() };
    case xdr.ScValType.scvBytes():
      return { bytes: value.bytes().toString("base64") };
    case xdr.ScValType.scvString():
      return { string: value.str().toString() };
    case xdr.ScValType.scvSymbol():
      return { symbol: value.sym().toString() };
    case xdr.ScValType.scvBool():
      return { bool: value.b() };
    case xdr.ScValType.scvVoid():
      return "void";
    default:
      return {};
  }
}

function memoToRpcJson(memo: xdr.Memo): unknown {
  switch (memo.switch()) {
    case xdr.MemoType.memoText():
      return { text: memo.text().toString() };
    case xdr.MemoType.memoId():
      return { id: memo.id().toString() };
    case xdr.MemoType.memoNone():
      return "none";
    default:
      return "none";
  }
}

function operationToRpcJson(op: xdr.Operation): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const source = op.sourceAccount();
  if (source) out["source_account"] = muxedToAddress(source);
  if (op.body().switch() !== xdr.OperationType.invokeHostFunction()) {
    out["body"] = { other: op.body().switch().name };
    return out;
  }
  const ihf = op.body().invokeHostFunctionOp();
  const hostFunction: Record<string, unknown> = {};
  if (ihf.hostFunction().switch() === xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    const invoke = ihf.hostFunction().invokeContract();
    hostFunction["invoke_contract"] = {
      contract_address: Address.fromScAddress(invoke.contractAddress()).toString(),
      function_name: invoke.functionName().toString(),
      args: invoke.args().map(scValToRpcJson),
    };
  }
  const auth = ihf.auth().map(entry => {
    const credentials = entry.credentials();
    if (credentials.switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
      const address = credentials.address();
      return {
        credentials: {
          address: {
            address: Address.fromScAddress(address.address()).toString(),
            nonce: address.nonce().toString(),
            signature_expiration_ledger: address.signatureExpirationLedger(),
          },
        },
      };
    }
    return { credentials: "source_account" };
  });
  out["body"] = { invoke_host_function: { host_function: hostFunction, auth } };
  return out;
}

function txBodyToRpcJson(tx: xdr.Transaction): Record<string, unknown> {
  return {
    source_account: muxedToAddress(tx.sourceAccount()),
    memo: memoToRpcJson(tx.memo()),
    operations: tx.operations().map(operationToRpcJson),
  };
}

/**
 * Adapt one Horizon transaction record into a `classifyTransaction` input. Returns undefined for
 * anything undecodable (legacy v0 envelopes, malformed XDR) — a backfill row we cannot read is
 * skipped, never a crash.
 */
export function adaptHorizonRecord(record: HorizonTxRecord): Record<string, unknown> | undefined {
  // The WHOLE decode is guarded, not just fromXDR: the SDK's typed accessors (v1().tx(),
  // feeSource(), …) also throw on a shape they reject, and this function promises "never a crash".
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(record.envelope_xdr, "base64");
    let envelopeJson: Record<string, unknown>;
    switch (envelope.switch()) {
      case xdr.EnvelopeType.envelopeTypeTx():
        envelopeJson = { tx: { tx: txBodyToRpcJson(envelope.v1().tx()) } };
        break;
      case xdr.EnvelopeType.envelopeTypeTxFeeBump(): {
        const bump = envelope.feeBump().tx();
        envelopeJson = {
          tx_fee_bump: {
            tx: {
              fee_source: muxedToAddress(bump.feeSource()),
              inner_tx: { tx: { tx: txBodyToRpcJson(bump.innerTx().v1().tx()) } },
            },
          },
        };
        break;
      }
      default:
        // v0 envelopes predate Soroban and cannot carry an x402 settlement.
        return undefined;
    }
    const createdMs = Date.parse(record.created_at);
    if (!Number.isFinite(createdMs)) return undefined;
    return {
      status: record.successful ? "SUCCESS" : "FAILED",
      txHash: record.hash,
      ledger: record.ledger,
      createdAt: String(Math.floor(createdMs / 1000)),
      envelopeJson,
    };
  } catch {
    return undefined;
  }
}
