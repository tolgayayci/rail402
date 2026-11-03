import type { Buffer } from "buffer";
import { hash, xdr } from "@stellar/stellar-sdk";
import { UnsupportedMetaError } from "@rail402.dev/stellar";

/**
 * Raised when a successful contract call's events or return value do not hash to the
 * `InvokeHostFunctionResult` its transaction result records. The result is committed by the ledger
 * header (through the result set hash), so the meta was altered or belongs to another transaction.
 * The indexer must stop at this ledger, never classify or skip it.
 */
export class EventIntegrityError extends Error {
  readonly code = "events_unbound";
  constructor(message: string) {
    super(message);
    this.name = "EventIntegrityError";
  }
}

/** The operation results of a successful transaction (the inner results of a fee bump). */
function operationResults(result: xdr.TransactionResult): xdr.OperationResult[] {
  const outer = result.result();
  const code = outer.switch();
  if (code === xdr.TransactionResultCode.txSuccess()) return outer.results();
  if (code === xdr.TransactionResultCode.txFeeBumpInnerSuccess()) {
    return outer.innerResultPair().result().result().results();
  }
  throw new EventIntegrityError(`the transaction result is ${code.name}, not a success`);
}

/** The success hash an invokeHostFunction operation result records. */
function successHash(result: xdr.TransactionResult, index: number): Buffer {
  const operation = operationResults(result)[index];
  if (operation?.switch() !== xdr.OperationResultCode.opInner()) {
    throw new EventIntegrityError(`operation ${String(index)} has no inner result`);
  }
  const inner = operation.tr();
  if (inner.switch() !== xdr.OperationType.invokeHostFunction()) {
    throw new EventIntegrityError(`operation ${String(index)} is not an invokeHostFunction result`);
  }
  const outcome = inner.invokeHostFunctionResult();
  if (outcome.switch() !== xdr.InvokeHostFunctionResultCode.invokeHostFunctionSuccess()) {
    throw new EventIntegrityError(`operation ${String(index)} did not succeed`);
  }
  return outcome.success();
}

/** The return value and contract events the meta reports for operation `index`. */
function reported(
  meta: xdr.TransactionMeta,
  index: number,
): { readonly returnValue: xdr.ScVal; readonly events: xdr.ContractEvent[] } {
  switch (meta.switch()) {
    case 3: {
      // The XDR library returns undefined (not null) for an absent optional.
      const soroban = meta.v3().sorobanMeta() as xdr.SorobanTransactionMeta | null | undefined;
      if (soroban === null || soroban === undefined || index !== 0) {
        throw new EventIntegrityError(`the meta has no Soroban result for operation ${String(index)}`);
      }
      return { returnValue: soroban.returnValue(), events: soroban.events() };
    }
    case 4: {
      const v4 = meta.v4();
      const operation = v4.operations()[index];
      const returnValue = v4.sorobanMeta()?.returnValue();
      if (operation === undefined || returnValue === null || returnValue === undefined) {
        throw new EventIntegrityError(`the meta has no Soroban result for operation ${String(index)}`);
      }
      return { returnValue, events: operation.events() };
    }
    case 0:
    case 1:
    case 2:
      throw new EventIntegrityError("the meta version cannot carry Soroban events");
    default:
      throw new UnsupportedMetaError(meta.switch());
  }
}

/**
 * Checks that the events and return value the meta reports for contract call `index` are the ones the
 * result committed: `sha256(InvokeHostFunctionSuccessPreImage { returnValue, events })` must equal the
 * operation's `InvokeHostFunctionResult.success`. With a ledger's header, transaction set and results
 * verified, this binds the events the rules read to consensus. Throws `EventIntegrityError`.
 */
export function assertEventsBound(
  result: xdr.TransactionResult,
  meta: xdr.TransactionMeta,
  index: number,
): void {
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = successHash(result, index);
    const { returnValue, events } = reported(meta, index);
    actual = hash(new xdr.InvokeHostFunctionSuccessPreImage({ returnValue, events }).toXDR());
  } catch (error) {
    if (error instanceof EventIntegrityError || error instanceof UnsupportedMetaError) throw error;
    throw new EventIntegrityError(
      `the events of operation ${String(index)} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!actual.equals(expected)) {
    throw new EventIntegrityError(
      `the events of operation ${String(index)} do not hash to the result's success hash ${expected.toString("hex").slice(0, 12)}…`,
    );
  }
}
