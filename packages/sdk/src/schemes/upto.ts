import { StrKey, rpc, xdr } from "@stellar/stellar-sdk";
import type { PaymentRequirements } from "@x402/core/types";
import {
  UPTO_DEPLOYMENTS,
  accountOrContractOf,
  approveInvocation,
  inspectUptoAuthorization,
  termsFromScVal,
  type LedgerSecondsSource,
  type UptoTerms,
} from "@rail402.dev/upto";
import { UptoStellarScheme } from "@rail402.dev/upto/client";
import {
  consumedAuthorization,
  contractEventsOf,
  decodeContractCall,
  type StellarNetwork,
} from "@rail402.dev/stellar";
import { parseAtomic } from "../money.ts";
import { facilitatorRefusal } from "../policy/facilitator.ts";
import { policyAsset } from "../policy/policy.ts";
import { feesSponsored, type SpendIntent, type StellarSchemeAdapter } from "./adapter.ts";

/** The settlement contract's entry point and its one event. */
const SETTLE = "settle";
const SETTLED_EVENT = "upto_settled";

export interface UptoSchemeOptions {
  /**
   * The settlement contract to sign for, instead of the network's canonical deployment. Only needed
   * on a private network; the spending policy must pin the same contract (`uptoContracts`).
   */
  readonly contract?: string;
  /** Sign CAP-71 address-bound V2 credentials instead of the legacy ones (default `false`). */
  readonly authV2?: boolean;
  /** Seconds per ledger for the authorization's expiry (default: estimated from Horizon, else 5). */
  readonly ledgerSeconds?: LedgerSecondsSource;
}

/** The canonical settlement contract of a network, when one is deployed there. */
export function canonicalUptoContract(network: StellarNetwork): string | undefined {
  return UPTO_DEPLOYMENTS[network]?.address;
}

/**
 * The x402 `upto` scheme on Stellar: the buyer signs one Soroban authorization over the payment
 * terms (recipient, token, cap, expiry and settlement authority) for the pinned settlement contract,
 * and the seller's facilitator later settles any amount up to the cap. The budget reserves the cap
 * when the authorization is signed and gets the remainder back only once the chain shows what the
 * settlement moved.
 *
 * The signed tree is checked exactly: a root `settle(terms)` on a pinned contract with a single
 * `token.approve(payer, contract, cap, expiry)` child, terms that pay a policy asset to the selected
 * recipient, and an expiry equal to the signature's. Anything else fails closed.
 */
export function uptoScheme(options: UptoSchemeOptions = {}): StellarSchemeAdapter {
  if (options.contract !== undefined && !StrKey.isValidContract(options.contract)) {
    throw new TypeError("uptoScheme: contract must be a C… contract address");
  }
  const contractFor = (network: StellarNetwork): string | undefined =>
    options.contract ?? canonicalUptoContract(network);

  return {
    scheme: "upto",

    createClient: (signer, connection) =>
      new UptoStellarScheme(signer, {
        rpcConfig: { url: connection.url },
        latestLedger:
          connection.latestLedger ??
          (async () =>
            (
              await new rpc.Server(connection.url, {
                allowHttp: new URL(connection.url).protocol === "http:",
              }).getLatestLedger()
            ).sequence),
        ...(options.contract === undefined ? {} : { contracts: options.contract }),
        ...(options.authV2 === undefined ? {} : { authV2: options.authV2 }),
        ...(options.ledgerSeconds === undefined ? {} : { ledgerSeconds: options.ledgerSeconds }),
      }),

    inspect(call, { policy, preimage, signerAddress }): SpendIntent | undefined {
      if (!policy.uptoContracts.includes(call.contract)) return undefined;
      if (call.fn !== SETTLE || call.args.length !== 1) return undefined;
      const [argument] = call.args;
      const terms = argument === undefined ? undefined : termsFromScVal(argument);
      if (terms === undefined) return undefined;
      if (policyAsset(policy, terms.token)?.contract !== terms.token) return undefined;
      // Clients sign from ledger 0 and for exactly the signature's lifetime.
      if (terms.validAfterLedger !== 0) return undefined;
      if (terms.expirationLedger !== preimage.signatureExpirationLedger) return undefined;
      if (terms.maxAmount <= 0n) return undefined;
      // One child, byte for byte the approval of the cap to the pinned contract from the signer.
      const [child, ...others] = call.subInvocations;
      if (child === undefined || others.length > 0) return undefined;
      const expected = approveInvocation(call.contract, signerAddress, terms);
      if (child.toXDR("base64") !== expected.toXDR("base64")) return undefined;
      return {
        scheme: "upto",
        network: policy.network,
        contract: call.contract,
        asset: terms.token,
        payer: signerAddress,
        recipient: terms.recipient,
        maxAmount: terms.maxAmount,
        nonce: preimage.nonce,
        expirationLedger: preimage.signatureExpirationLedger,
        credential: preimage.credential,
        facilitator: terms.facilitator,
      };
    },

    reserveAmount: (requirements) => parseAtomic(requirements.amount),

    settlementAuthority: (requirements) => facilitatorOf(requirements),

    checkRequirements(requirements, policy) {
      const contract = contractFor(policy.network);
      if (contract === undefined || !policy.uptoContracts.includes(contract)) {
        return {
          code: "payment_scheme_not_permitted",
          reason:
            contract === undefined
              ? `No upto settlement contract is known for ${policy.network}; pin one to pay upto.`
              : `The upto settlement contract ${contract} is not pinned in the spending policy.`,
        };
      }
      if (!feesSponsored(requirements)) return { code: "payment_fees_not_sponsored" };
      if (
        !StrKey.isValidEd25519PublicKey(requirements.payTo) &&
        !StrKey.isValidContract(requirements.payTo)
      ) {
        return {
          code: "payment_recipient_not_permitted",
          reason: "An upto payment goes to a G… or C… address; muxed (M…) recipients are refused.",
        };
      }
      const facilitator = facilitatorOf(requirements);
      if (facilitator === undefined) {
        return {
          code: "payment_facilitator_not_permitted",
          reason: "The option names no valid settlement authority (extra.facilitatorAddress).",
        };
      }
      const refusal = facilitatorRefusal(policy, facilitator, requirements.payTo, undefined);
      return refusal === undefined
        ? undefined
        : { code: "payment_facilitator_not_permitted", reason: refusal };
    },

    checkPayload(payload, intent) {
      const keys = Object.keys(payload);
      if (keys.some((key) => key !== "authorization" && key !== "signerAuthorizations")) {
        return "the payload carries fields other than the authorization.";
      }
      const signers = payload["signerAuthorizations"];
      if (signers !== undefined && !(Array.isArray(signers) && signers.length === 0)) {
        return "the payload carries delegated signer authorizations this buyer did not sign.";
      }
      const inspected = inspectUptoAuthorization(payload["authorization"], intent.contract);
      if (!inspected.ok) return `the authorization is malformed (${inspected.rejection.code}).`;
      const { authorization } = inspected;
      if (authorization.payer !== intent.payer) return "the authorization is for a different payer.";
      if (authorization.credential !== intent.credential) return "the authorization's credential differs.";
      if (
        authorization.nonce !== intent.nonce ||
        authorization.signatureExpirationLedger !== intent.expirationLedger
      ) {
        return "the authorization differs from the one that was signed.";
      }
      const mismatch = termsMismatch(authorization.terms, intent);
      if (mismatch !== undefined) return mismatch;
      if (!authorization.treeValid) return "the authorization's approval does not match its terms.";
      return undefined;
    },

    settledAmount(transaction, intent) {
      return uptoSettledAmount(transaction, intent);
    },
  };
}

/**
 * What an `upto` settlement moved under this authorization, or undefined when the transaction did not
 * use it. The proof is the payer's own signed entry with the signed nonce, carried by the transaction
 * and consumed by the host: once that holds the authorization is spent, whatever shape the transaction
 * has (a direct `settle` call, a call through another contract, or a batch of several settlements).
 * The amount is read from the `upto_settled` events the signed settlement contract emitted for the
 * signed terms; only that contract can emit them. When no such event can be read, or several differ,
 * the largest candidate counts, and without any the whole cap counts: the budget never under-counts.
 */
export function uptoSettledAmount(
  transaction: rpc.Api.GetSuccessfulTransactionResponse,
  intent: Pick<SpendIntent, "payer" | "nonce" | "maxAmount">,
): bigint | undefined {
  const entry = consumedAuthorization(transaction, intent.payer, intent.nonce);
  if (entry === undefined) return undefined;
  const call = decodeContractCall(entry.rootInvocation());
  const [argument] = call?.args ?? [];
  const terms = argument === undefined ? undefined : termsFromScVal(argument);
  if (call === undefined || call.fn !== SETTLE || terms === undefined) return intent.maxAmount;
  let largest: bigint | undefined;
  for (const event of contractEventsOf(transaction)) {
    if (
      event.contract !== call.contract ||
      event.topics[0]?.switch() !== xdr.ScValType.scvSymbol() ||
      event.topics[0].sym().toString() !== SETTLED_EVENT
    ) {
      continue;
    }
    const fields = mapOf(event.data);
    const amount = i128Of(fields?.get("amount"));
    if (
      fields === undefined ||
      amount === undefined ||
      accountOrContractOf(event.topics[1]) !== intent.payer ||
      accountOrContractOf(event.topics[2]) !== terms.recipient ||
      accountOrContractOf(fields.get("token")) !== terms.token ||
      accountOrContractOf(fields.get("facilitator")) !== terms.facilitator ||
      i128Of(fields.get("max_amount")) !== terms.maxAmount
    ) {
      continue;
    }
    if (largest === undefined || amount > largest) largest = amount;
  }
  if (largest === undefined || largest < 0n || largest > intent.maxAmount) return intent.maxAmount;
  return largest;
}

/** The settlement authority an option names, when it is a valid G… or C… address. */
function facilitatorOf(requirements: PaymentRequirements): string | undefined {
  const value = (requirements.extra as Record<string, unknown> | undefined)?.["facilitatorAddress"];
  return typeof value === "string" && (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))
    ? value
    : undefined;
}

function termsMismatch(terms: UptoTerms, intent: SpendIntent): string | undefined {
  if (terms.token !== intent.asset) return "the authorization pays a different asset.";
  if (terms.recipient !== intent.recipient) return "the authorization pays a different recipient.";
  if (terms.maxAmount !== intent.maxAmount) return "the authorization's cap differs.";
  if (terms.facilitator !== intent.facilitator)
    return "the authorization names a different settlement authority.";
  if (terms.expirationLedger !== intent.expirationLedger || terms.validAfterLedger !== 0) {
    return "the authorization's validity differs.";
  }
  return undefined;
}

function mapOf(value: xdr.ScVal): Map<string, xdr.ScVal> | undefined {
  if (value.switch() !== xdr.ScValType.scvMap()) return undefined;
  const fields = new Map<string, xdr.ScVal>();
  for (const entry of value.map() ?? []) {
    const key = entry.key();
    if (key.switch() === xdr.ScValType.scvSymbol()) fields.set(key.sym().toString(), entry.val());
  }
  return fields;
}

function i128Of(value: xdr.ScVal | undefined): bigint | undefined {
  if (value?.switch() !== xdr.ScValType.scvI128()) return undefined;
  const parts = value.i128();
  return (parts.hi().toBigInt() << 64n) | parts.lo().toBigInt();
}
