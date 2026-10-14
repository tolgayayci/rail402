import type { PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import type { ClientStellarSigner } from "@x402/stellar";
import type { rpc } from "@stellar/stellar-sdk";
import type {
  AuthCredential,
  AuthorizationPreimage,
  ContractCall,
  StellarNetwork,
} from "@rail402.dev/stellar";
import type { AgentCode } from "../codes.ts";
import type { ResolvedPolicy, SchemeName } from "../policy/policy.ts";

/**
 * What one authorization would let a seller take, decoded from the exact bytes about to be signed.
 * Amounts are base units.
 */
export interface SpendIntent {
  readonly scheme: SchemeName;
  readonly network: StellarNetwork;
  /** The contract the authorization invokes: the token for exact, the settlement contract for upto. */
  readonly contract: string;
  /** The token contract the money is paid in. */
  readonly asset: string;
  readonly payer: string;
  /** The recipient exactly as authorized (an M… address stays M…). */
  readonly recipient: string;
  /** The most the authorization can move: the price for exact, the authorized maximum for upto. */
  readonly maxAmount: bigint;
  readonly nonce: bigint;
  readonly expirationLedger: number;
  readonly credential: AuthCredential;
  /** upto only: the settlement authority the terms bind, the only address that can settle them. */
  readonly facilitator?: string | undefined;
}

export interface InspectContext {
  readonly policy: ResolvedPolicy;
  readonly preimage: AuthorizationPreimage;
  readonly signerAddress: string;
}

/** Whether an option says its facilitator sponsors fees. `extra` may be missing or null on the wire. */
export function feesSponsored(requirements: Pick<PaymentRequirements, "extra">): boolean {
  const extra = requirements.extra as Readonly<Record<string, unknown>> | null | undefined;
  return extra?.["areFeesSponsored"] === true;
}

/** A refusal found while checking a seller's payment requirements. */
export interface RequirementsRefusal {
  readonly code: AgentCode;
  readonly reason?: string;
}

/**
 * How the buyer handles one x402 scheme on Stellar. The signing guard asks every adapter to inspect a
 * preimage and signs only when one recognises it; an adapter must return undefined for any shape it
 * does not fully understand, so unknown authorizations fail closed.
 */
export interface StellarSchemeAdapter {
  readonly scheme: SchemeName;
  /**
   * The upstream client for this scheme, signing through `signer`. `latestLedger` is the reading the
   * signing guard uses, for clients that derive the authorization's expiry themselves.
   */
  createClient(
    signer: ClientStellarSigner,
    rpc: { readonly url: string; readonly latestLedger?: () => Promise<number> },
  ): SchemeNetworkClient;
  /**
   * The intent of an authorization's root call, or undefined when the call is not this scheme's
   * exact shape (other function, other arguments, unexpected sub-invocations, asset outside policy).
   */
  inspect(call: ContractCall, context: InspectContext): SpendIntent | undefined;
  /**
   * Base units reserved against the budget for these requirements: the price for exact, the
   * authorized maximum for upto. Undefined when the requirements carry no valid amount.
   */
  reserveAmount(requirements: PaymentRequirements): bigint | undefined;
  /**
   * The settlement authority an option names and the signed authorization must bind (upto), or
   * undefined for schemes whose authorization binds none.
   */
  settlementAuthority?(requirements: PaymentRequirements): string | undefined;
  /** Scheme-specific requirement checks before anything is signed. */
  checkRequirements?(
    requirements: PaymentRequirements,
    policy: ResolvedPolicy,
  ): RequirementsRefusal | undefined;
  /**
   * Checks the payload the upstream client produced against the signed intent. Returns the reason
   * for a mismatch, or undefined when the payload carries exactly the authorized payment.
   */
  checkPayload(payload: Readonly<Record<string, unknown>>, intent: SpendIntent): string | undefined;
  /**
   * The amount a settlement transaction moved under this intent's authorization (at most its cap), or
   * undefined when the transaction did not consume it. May throw when the transaction cannot be read.
   */
  settledAmount?(
    transaction: rpc.Api.GetSuccessfulTransactionResponse,
    intent: SpendIntent,
  ): bigint | undefined;
}
