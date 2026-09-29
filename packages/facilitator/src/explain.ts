import { rpc, type xdr } from "@stellar/stellar-sdk";
import {
  classifyTransferFailure,
  hostErrors,
  type Classification,
  type ExactTransfer,
} from "@rail402.dev/stellar";

/**
 * Re-simulates a rejected payment in enforcing auth mode to name its on-chain cause. Upstream reports
 * every simulation failure as `invalid_exact_stellar_payload_simulation_failed`; this recovers the
 * specific reason (replayed nonce, bad signature, missing trustline, insufficient funds, …).
 * Returns `undefined` when the payment now simulates cleanly.
 */
export async function explainSimulation(
  server: rpc.Server,
  transfer: ExactTransfer,
): Promise<Classification | undefined> {
  const simulation = await server.simulateTransaction(transfer.transaction, undefined, "enforce");
  if (rpc.Api.isSimulationError(simulation)) {
    return classifyTransferFailure(hostErrors(simulation.events), transfer);
  }
  if (rpc.Api.isSimulationRestore(simulation)) {
    return {
      code: "invalid_exact_stellar_payload_archived_state",
      reason: "Ledger state the transfer reads is archived; restore it before paying.",
    };
  }
  return undefined;
}

/** Names the cause of a transaction that was included in a ledger but failed. */
export function explainFailedTransaction(
  response: rpc.Api.GetFailedTransactionResponse,
  transfer: { readonly asset: string; readonly from: string; readonly to: string },
): Classification {
  const errors = hostErrors(response.diagnosticEventsXdr ?? []);
  if (errors.length > 0) {
    const classified = classifyTransferFailure(errors, transfer);
    if (classified.code !== "invalid_exact_stellar_payload_simulation_failed") return classified;
  }
  return {
    code: "invalid_transaction_state",
    reason: `The settlement transaction was included in ledger ${response.ledger} but failed (${resultCode(response.resultXdr)}).`,
  };
}

/** The top-level result code of a transaction result, e.g. `txFeeBumpInnerFailed`. */
export function resultCode(result: xdr.TransactionResult | undefined): string {
  if (result === undefined) return "no result";
  const outer = result.result();
  const name = outer.switch().name;
  if (name === "txFeeBumpInnerSuccess" || name === "txFeeBumpInnerFailed") {
    const inner = outer.innerResultPair().result().result().switch().name;
    return `${name}: ${inner}`;
  }
  return name;
}
