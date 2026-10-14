import type { rpc } from "@stellar/stellar-sdk";
import { exactSettledAmount } from "../schemes/exact.ts";
import { uptoSettledAmount } from "../schemes/upto.ts";
import type { Reservation } from "./ledger.ts";

/**
 * What a transaction moved under one reservation's authorization, or undefined when it did not use
 * it. The proof is the payer's nonce recorded at signing: the transaction must carry the payer's entry
 * with that nonce and the host must have consumed it, so no other authorization's transfer, and no
 * seller's report, can stand in for it. A consumed authorization always counts as spent: the exact
 * price, or for upto the amount its settlement contract recorded (the whole cap when that cannot be
 * read). Throws when the transaction's meta cannot be read.
 */
export function reservationSettlement(
  transaction: rpc.Api.GetSuccessfulTransactionResponse,
  row: Reservation,
  payer: string,
): bigint | undefined {
  const nonce = row.nonce;
  if (nonce === undefined) return undefined;
  const intent = { payer, nonce, maxAmount: row.amount };
  return row.scheme === "exact"
    ? exactSettledAmount(transaction, intent)
    : uptoSettledAmount(transaction, intent);
}
