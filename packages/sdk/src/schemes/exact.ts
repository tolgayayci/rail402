import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { StrKey, type rpc } from "@stellar/stellar-sdk";
import {
  consumedAuthorization,
  decodeSacTransferArgs,
  inspectExactTransaction,
  networkPassphrase,
} from "@rail402.dev/stellar";
import { parseAtomic } from "../money.ts";
import { policyAsset } from "../policy/policy.ts";
import { feesSponsored, type SpendIntent, type StellarSchemeAdapter } from "./adapter.ts";

/**
 * The x402 `exact` scheme: one SEP-41 `transfer(payer, payTo, amount)` authorized with no
 * sub-invocations, settled by the facilitator with fees sponsored. The upstream @x402/stellar client
 * builds and simulates the payment; this adapter only decides what may be signed.
 */
export function exactScheme(): StellarSchemeAdapter {
  return {
    scheme: "exact",

    createClient: (signer, rpc) => new ExactStellarScheme(signer, { url: rpc.url }),

    inspect(call, { policy, preimage }) {
      if (call.fn !== "transfer" || call.subInvocations.length !== 0) return undefined;
      const asset = policyAsset(policy, call.contract);
      if (asset?.contract !== call.contract) return undefined;
      const transfer = decodeSacTransferArgs(call.args);
      if (transfer === undefined) return undefined;
      return {
        scheme: "exact",
        network: policy.network,
        contract: call.contract,
        asset: call.contract,
        payer: transfer.from,
        recipient: transfer.to,
        maxAmount: transfer.amount,
        nonce: preimage.nonce,
        expirationLedger: preimage.signatureExpirationLedger,
        credential: preimage.credential,
      };
    },

    reserveAmount: (requirements) => parseAtomic(requirements.amount),

    checkRequirements(requirements) {
      if (!feesSponsored(requirements)) return { code: "payment_fees_not_sponsored" };
      // The exact verifier cannot match a muxed transfer's CAP-67 event to payTo: nothing would settle.
      if (StrKey.isValidMed25519PublicKey(requirements.payTo)) {
        return {
          code: "payment_recipient_not_permitted",
          reason: "An exact payment goes to a G… or C… address; muxed (M…) recipients are refused.",
        };
      }
      return undefined;
    },

    checkPayload(payload, intent) {
      const inspection = inspectExactTransaction(payload["transaction"], networkPassphrase(intent.network));
      if (!inspection.ok) return `the payment transaction is malformed (${inspection.code}).`;
      const { transfer } = inspection;
      if (transfer.asset !== intent.asset) return "the transaction pays a different asset.";
      if (transfer.from !== intent.payer) return "the transaction pays from a different account.";
      if (transfer.to !== intent.recipient) return "the transaction pays a different recipient.";
      if (transfer.amount !== intent.maxAmount) return "the transaction pays a different amount.";
      if (transfer.hasUnsupportedPreconditions) return "the transaction carries unexpected preconditions.";
      const [entry, ...others] = transfer.authorizations;
      if (entry === undefined || others.length > 0 || transfer.otherCredentials > 0) {
        return "the transaction must carry exactly one address authorization.";
      }
      if (entry.address !== intent.payer || !entry.signed || !entry.matchesOperation) {
        return "the transaction's authorization is not the payer's signed authorization of this transfer.";
      }
      if (entry.nonce !== intent.nonce || entry.signatureExpirationLedger !== intent.expirationLedger) {
        return "the transaction's authorization differs from the one that was signed.";
      }
      if (entry.subInvocations !== 0) return "the transaction's authorization has sub-invocations.";
      return undefined;
    },

    settledAmount(transaction, intent) {
      return exactSettledAmount(transaction, intent);
    },
  };
}

/**
 * What an `exact` settlement moved under this authorization, or undefined when the transaction did not
 * use it: the transaction must carry the payer's entry with the signed nonce and the host must have
 * consumed that nonce. The entry is then exactly the signed `transfer(payer, recipient, amount)` with
 * nothing beneath it, so the amount moved, whether the transfer was the transaction's own call or was
 * made from inside another contract. A transfer of the same amount made with another authorization
 * proves nothing.
 */
export function exactSettledAmount(
  transaction: rpc.Api.GetSuccessfulTransactionResponse,
  intent: Pick<SpendIntent, "payer" | "nonce" | "maxAmount">,
): bigint | undefined {
  return consumedAuthorization(transaction, intent.payer, intent.nonce) === undefined
    ? undefined
    : intent.maxAmount;
}
