import { rpc, type xdr } from "@stellar/stellar-sdk";
import {
  AssetDirectory,
  classifyTransferFailure,
  classifyUptoFailure,
  hostErrors,
  type AssetKind,
  recordedUptoSettlement,
  type Classification,
  type ExactTransfer,
  type UptoResponseCode,
} from "@rail402.dev/stellar";
import type { SettlementRecord } from "./ledger.ts";

/** The named cause of a failed settlement, whatever its scheme. */
export interface FailureCause {
  readonly code: Classification["code"] | UptoResponseCode;
  readonly reason: string;
}

/**
 * Re-simulates a rejected payment in enforcing auth mode to name its on-chain cause. Upstream reports
 * every simulation failure as `invalid_exact_stellar_payload_simulation_failed`; this recovers the
 * specific reason (replayed nonce, bad signature, missing trustline, insufficient funds, …).
 * `assetKind` says whether the token is a Stellar Asset Contract, whose error numbers are known; a
 * custom SEP-41 token's own errors are told apart only by reading the payer's balance, so a balance
 * below the amount is `insufficient_funds` and anything else is `token_rejected`.
 * Returns `undefined` when the payment now simulates cleanly.
 */
export async function explainSimulation(
  server: rpc.Server,
  transfer: ExactTransfer,
  assetKind?: AssetKind,
): Promise<Classification | undefined> {
  const simulation = await server.simulateTransaction(transfer.transaction, undefined, "enforce");
  if (rpc.Api.isSimulationError(simulation)) {
    const classified = classifyTransferFailure(hostErrors(simulation.events), {
      ...contextOf(transfer),
      assetKind,
    });
    if (assetKind === "sac" || !BALANCE_CHECKED.has(classified.code)) return classified;
    const balance = await new AssetDirectory(server, transfer.transaction.networkPassphrase)
      .balance(transfer.asset, transfer.from)
      .catch(() => undefined);
    if (balance !== undefined && balance < transfer.amount) {
      return {
        code: "insufficient_funds",
        reason: `The payer holds ${balance.toString()} base units of this token, less than the amount ${transfer.amount.toString()}.`,
      };
    }
    return classified;
  }
  if (rpc.Api.isSimulationRestore(simulation)) {
    return {
      code: "invalid_exact_stellar_payload_archived_state",
      reason: "Ledger state the transfer reads is archived; restore it before paying.",
    };
  }
  return undefined;
}

/** Outcomes a custom token's balance can explain: its own error, or a failure the host did not name. */
const BALANCE_CHECKED = new Set<Classification["code"]>([
  "invalid_exact_stellar_payload_token_rejected",
  "invalid_exact_stellar_payload_simulation_failed",
]);

function contextOf(transfer: { readonly asset: string; readonly from: string; readonly to: string }) {
  return { asset: transfer.asset, from: transfer.from, to: transfer.to };
}

/** Names the cause of a transaction that was included in a ledger but failed. */
export function explainFailedTransaction(
  response: rpc.Api.GetFailedTransactionResponse,
  transfer: { readonly asset: string; readonly from: string; readonly to: string },
  assetKind?: AssetKind,
): Classification {
  const errors = hostErrors(response.diagnosticEventsXdr ?? []);
  if (errors.length > 0) {
    const classified = classifyTransferFailure(errors, { ...contextOf(transfer), assetKind });
    if (classified.code !== "invalid_exact_stellar_payload_simulation_failed") return classified;
  }
  return {
    code: "invalid_transaction_state",
    reason: `The settlement transaction was included in ledger ${response.ledger} but failed (${resultCode(response.resultXdr)}).`,
  };
}

/**
 * Names the cause of an `upto` settlement transaction that was included but failed, from its
 * diagnostic events and the settlement recorded in its envelope. A failure the events do not name is
 * `settle_upto_stellar_transaction_failed`, with the ledger and result code.
 */
export function explainFailedUptoTransaction(
  response: rpc.Api.GetFailedTransactionResponse,
  record: SettlementRecord,
  context: { readonly passphrase: string; readonly facilitatorAddresses: ReadonlySet<string> },
): FailureCause {
  const unnamed: FailureCause = {
    code: "settle_upto_stellar_transaction_failed",
    reason: `The settlement transaction was included in ledger ${response.ledger} but failed (${resultCode(response.resultXdr)}); no funds moved.`,
  };
  const settlement =
    record.envelopeXdr === undefined
      ? undefined
      : recordedUptoSettlement(record.envelopeXdr, context.passphrase);
  const errors = hostErrors(response.diagnosticEventsXdr ?? []);
  if (settlement === undefined || errors.length === 0) return unnamed;
  const classified = classifyUptoFailure(errors, {
    contract: settlement.contract,
    token: settlement.terms.token,
    payer: settlement.payer,
    recipient: settlement.terms.recipient,
    authority: settlement.terms.facilitator,
    facilitatorAddresses: context.facilitatorAddresses,
  });
  return classified.code === "invalid_upto_stellar_payload_simulation_failed" ? unnamed : classified;
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
