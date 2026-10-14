import type { PaymentRequirements } from "@x402/core/types";
import {
  I128_MAX,
  baseAccount,
  decodeAuthorizationPreimage,
  decodeContractCall,
  maxAcceptableExpiration,
  networkIdFor,
  networkPassphrase,
  sameBytes,
  type AuthorizationPreimage,
  type StellarNetwork,
} from "@rail402.dev/stellar";
import { paymentError, type AgentCode, type PaymentError } from "../codes.ts";
import { parseAtomic, toDecimal } from "../money.ts";
import type { SpendIntent, StellarSchemeAdapter } from "../schemes/adapter.ts";
import { facilitatorRefusal } from "./facilitator.ts";
import {
  describeCap,
  policyAsset,
  recipientPermitted,
  type EffectiveCap,
  type ResolvedPolicy,
  type SchemeName,
} from "./policy.ts";

/**
 * The payment one call selected, armed into its signing guard. The guard signs only an authorization
 * that pays exactly this: same scheme, asset, recipient and amount.
 */
export interface SpendExpectation {
  readonly scheme: SchemeName;
  readonly network: StellarNetwork;
  /** Token contract (C…). */
  readonly asset: string;
  /** Recipient exactly as the seller sent it; an M… address stays M…. */
  readonly payTo: string;
  /** The price for exact, the authorized maximum for upto, in base units. */
  readonly amount: bigint;
  readonly maxTimeoutSeconds: number;
  /** The call's effective per-call cap in base units. */
  readonly effectiveCap: bigint;
  /** upto: the settlement authority the selected option names; the signed terms must bind it. */
  readonly facilitator?: string | undefined;
}

export interface DecideContext {
  readonly network: StellarNetwork;
  readonly policy: ResolvedPolicy;
  readonly adapters: readonly StellarSchemeAdapter[];
  readonly signerAddress: string;
  /** The `address` and `networkPassphrase` the signing library passed along, when it did. */
  readonly requested?: {
    readonly address?: string | undefined;
    readonly networkPassphrase?: string | undefined;
  };
  /** The latest ledger, read just before deciding. */
  readonly latestLedger: number;
  /** Absent in policy-only mode, which cannot bind the signature to a selected option. */
  readonly expectation?: SpendExpectation | undefined;
}

export type SpendDecision =
  | {
      readonly ok: true;
      readonly intent: SpendIntent;
      readonly adapter: StellarSchemeAdapter;
      readonly preimage: AuthorizationPreimage;
    }
  | { readonly ok: false; readonly code: AgentCode; readonly reason: string };

const refuse = (code: AgentCode, reason: string): SpendDecision => ({ ok: false, code, reason });

/**
 * Decides whether the exact bytes a signer was handed may be signed. Pure: no I/O and no clock; the
 * latest ledger is passed in. Checks run in a fixed order and the first failure wins.
 */
export function decideSpend(preimageBase64: string, context: DecideContext): SpendDecision {
  const { policy, expectation, signerAddress } = context;

  // 1. Only Soroban authorization preimages (V1 or CAP-71 V2) are ever signed.
  const preimage = decodeAuthorizationPreimage(preimageBase64);
  if (preimage === undefined) {
    return refuse(
      "payment_authorization_rejected",
      "The signer was asked to sign something other than a Soroban authorization preimage.",
    );
  }

  // 2. The network the signature is valid on.
  if (
    !sameBytes(preimage.networkId, networkIdFor(context.network)) ||
    (context.requested?.networkPassphrase !== undefined &&
      context.requested.networkPassphrase !== networkPassphrase(context.network))
  ) {
    return refuse(
      "payment_network_not_permitted",
      `The authorization is for a network other than ${context.network}.`,
    );
  }

  // 3. The address the signature is for.
  if (preimage.credential === "address_v2" && preimage.address !== signerAddress) {
    return refuse("payment_authorization_rejected", "The authorization is bound to a different address.");
  }
  if (context.requested?.address !== undefined && context.requested.address !== signerAddress) {
    return refuse("payment_authorization_rejected", "The signature was requested for a different address.");
  }

  // 4. A call shape one of the enabled schemes fully understands; anything else fails closed.
  const call = decodeContractCall(preimage.invocation);
  if (call === undefined) {
    return refuse("payment_authorization_rejected", "The authorization does not invoke a contract function.");
  }
  let intent: SpendIntent | undefined;
  let adapter: StellarSchemeAdapter | undefined;
  for (const candidate of context.adapters) {
    if (!policy.schemes.includes(candidate.scheme)) continue;
    intent = candidate.inspect(call, { policy, preimage, signerAddress });
    if (intent !== undefined) {
      adapter = candidate;
      break;
    }
  }
  if (intent === undefined || adapter === undefined) {
    return refuse(
      "payment_authorization_rejected",
      `The authorization's call (${call.fn}) is not a payment shape any enabled scheme signs.`,
    );
  }

  // 5. The money leaves the signer's own account.
  if (intent.payer !== signerAddress) {
    return refuse(
      "payment_authorization_rejected",
      "The authorization pays from an account other than the signer.",
    );
  }

  // 6. The armed expectation, compared exactly. A lower amount is refused too: it means tampering.
  if (expectation !== undefined) {
    if (intent.scheme !== expectation.scheme) {
      return refuse(
        "payment_authorization_rejected",
        "The authorization uses a different scheme than selected.",
      );
    }
    if (intent.asset !== expectation.asset) {
      return refuse(
        "payment_authorization_rejected",
        "The authorization pays a different asset than selected.",
      );
    }
    if (intent.recipient !== expectation.payTo) {
      return refuse(
        "payment_authorization_rejected",
        "The authorization pays a different recipient than selected.",
      );
    }
    if (intent.maxAmount !== expectation.amount) {
      return refuse(
        "payment_authorization_rejected",
        "The authorization's amount differs from the selected price.",
      );
    }
    if (intent.facilitator !== expectation.facilitator) {
      return refuse(
        "payment_authorization_rejected",
        "The authorization names a different settlement authority than selected.",
      );
    }
  }

  // 7. The policy, again, for defence in depth.
  const asset = policyAsset(policy, intent.asset);
  if (asset?.contract !== intent.asset) {
    return refuse(
      "payment_asset_not_permitted",
      "The authorization pays an asset outside the spending policy.",
    );
  }
  if (!recipientPermitted(policy, intent.recipient, signerAddress)) {
    return refuse(
      "payment_recipient_not_permitted",
      "The authorization pays a recipient the spending policy does not allow.",
    );
  }
  if (intent.facilitator !== undefined) {
    const refusal = facilitatorRefusal(policy, intent.facilitator, intent.recipient, signerAddress);
    if (refusal !== undefined) return refuse("payment_facilitator_not_permitted", refusal);
  }
  if (intent.maxAmount <= 0n || intent.maxAmount > I128_MAX) {
    return refuse("payment_amount_not_permitted", "The authorization's amount is out of range.");
  }
  const cap = expectation?.effectiveCap ?? asset.perCall;
  if (cap === undefined) {
    return refuse("payment_policy_invalid", `No per-call ceiling is configured for ${asset.symbol}.`);
  }
  if (intent.maxAmount > cap) {
    return refuse(
      "payment_per_call_cap_exceeded",
      `The authorization would pay ${toDecimal(intent.maxAmount, asset.decimals)} ${asset.symbol}, above the per-call cap of ${toDecimal(cap, asset.decimals)}.`,
    );
  }

  // 8. The authorization expires soon enough.
  const timeout = Math.min(
    expectation?.maxTimeoutSeconds ?? policy.maxAuthorizationSeconds,
    policy.maxAuthorizationSeconds,
  );
  const latest = context.latestLedger;
  const expiration = preimage.signatureExpirationLedger;
  if (expiration <= latest || expiration > maxAcceptableExpiration(latest, timeout)) {
    return refuse(
      "payment_authorization_window_not_permitted",
      `The authorization expires at ledger ${expiration}; it must be after ${latest} and no later than ${maxAcceptableExpiration(latest, timeout)}.`,
    );
  }

  return { ok: true, intent, adapter, preimage };
}

/** What a listing binds a payment to. */
export interface ListingBinding {
  readonly type: "http" | "mcp";
  /** The listing owner's base account. */
  readonly owner: string;
  /**
   * The listed options, for listings whose content the catalog confirms at their origin (HTTP, and MCP
   * tools at an http(s) endpoint). The live price may not exceed the listed price for the same
   * scheme, asset and recipient. An HTTP binding without them binds nothing to pay; an MCP binding
   * without them binds the recipient alone.
   */
  readonly prices?: readonly {
    readonly scheme: string;
    readonly asset: string;
    readonly payTo: string;
    readonly amount: string;
  }[];
}

export interface OptionContext {
  readonly network: StellarNetwork;
  readonly policy: ResolvedPolicy;
  readonly adapters: readonly StellarSchemeAdapter[];
  readonly payer: string;
  readonly cap: EffectiveCap;
  readonly preferredScheme?: SchemeName | undefined;
  readonly listing?: ListingBinding | undefined;
  /** Budget left in the session for an asset (base units), or undefined when unknown. */
  readonly remaining?: ((asset: string) => bigint | undefined) | undefined;
}

export interface OptionVerdict {
  readonly index: number;
  readonly option: PaymentRequirements;
  /** Undefined when the option is acceptable. */
  readonly refused:
    | { readonly code: AgentCode; readonly reason?: string; readonly details?: Record<string, unknown> }
    | undefined;
  readonly adapter: StellarSchemeAdapter | undefined;
  /** Base units the option would reserve. */
  readonly reserve: bigint | undefined;
}

/**
 * Judges one of a seller's payment options against the policy before any RPC call or signature. The
 * guard repeats the decisive checks on the bytes it signs; this exists to refuse early and explain why.
 */
export function checkOption(
  option: PaymentRequirements,
  index: number,
  context: OptionContext,
): OptionVerdict {
  const verdict = (
    code: AgentCode,
    reason?: string,
    details?: Record<string, unknown>,
    adapter?: StellarSchemeAdapter,
    reserve?: bigint,
  ): OptionVerdict => ({
    index,
    option,
    refused: {
      code,
      ...(reason === undefined ? {} : { reason }),
      ...(details === undefined ? {} : { details }),
    },
    adapter,
    reserve,
  });
  const { policy, cap } = context;

  if (option.network !== context.network) {
    return verdict(
      "payment_network_not_permitted",
      `The option is for ${option.network}, not ${context.network}.`,
    );
  }
  const adapter = policy.schemes.includes(option.scheme as SchemeName)
    ? context.adapters.find((candidate) => candidate.scheme === option.scheme)
    : undefined;
  if (adapter === undefined) {
    return verdict("payment_scheme_not_permitted", `The ${option.scheme} scheme is not enabled.`);
  }
  const asset = policyAsset(policy, option.asset);
  if (asset?.contract !== option.asset) {
    return verdict("payment_asset_not_permitted", "The option's asset is not in the spending policy.");
  }
  if (asset.contract !== cap.asset.contract) {
    return verdict(
      "payment_asset_not_permitted",
      `The option is priced in ${asset.symbol}, but the cap is in ${cap.asset.symbol}.`,
    );
  }
  const refusal = adapter.checkRequirements?.(option, policy);
  if (refusal !== undefined) return verdict(refusal.code, refusal.reason);
  if (typeof option.payTo !== "string" || !recipientPermitted(policy, option.payTo, context.payer)) {
    return verdict("payment_recipient_not_permitted");
  }
  const reserve = adapter.reserveAmount(option);
  if (reserve === undefined || reserve <= 0n) return verdict("payment_amount_not_permitted");
  if (reserve > cap.cap) {
    return verdict(
      "payment_per_call_cap_exceeded",
      `The price is ${toDecimal(reserve, asset.decimals)} ${asset.symbol}, above the per-call cap of ${toDecimal(cap.cap, asset.decimals)}.`,
      { price: toDecimal(reserve, asset.decimals), ...describeCap(cap) },
    );
  }
  const timeout = option.maxTimeoutSeconds;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > policy.maxAuthorizationSeconds) {
    return verdict(
      "payment_authorization_window_not_permitted",
      `maxTimeoutSeconds must be from 1 to ${policy.maxAuthorizationSeconds}.`,
    );
  }
  const listing = context.listing;
  if (listing !== undefined) {
    if (baseAccount(option.payTo) !== listing.owner) {
      return verdict("payment_listing_mismatch", "The live recipient is not the listing's owner.", {
        listingOwner: listing.owner,
        livePayTo: option.payTo,
      });
    }
    if (listing.type === "http" || listing.prices !== undefined) {
      const listed = listing.prices?.find(
        (price) =>
          price.scheme === option.scheme && price.asset === option.asset && price.payTo === option.payTo,
      );
      const listedAmount = listed === undefined ? undefined : parseAtomic(listed.amount);
      if (listedAmount === undefined || listedAmount < reserve) {
        return verdict("payment_listing_mismatch", "The live price is higher than the listed price.", {
          listed: listedAmount === undefined ? null : toDecimal(listedAmount, asset.decimals),
          live: toDecimal(reserve, asset.decimals),
        });
      }
    }
  }
  const remaining = context.remaining?.(asset.contract);
  if (remaining !== undefined && reserve > remaining) {
    return verdict(
      "payment_session_cap_exceeded",
      `The price is ${toDecimal(reserve, asset.decimals)} ${asset.symbol}, but only ${toDecimal(remaining, asset.decimals)} is left in the session.`,
    );
  }
  return { index, option, refused: undefined, adapter, reserve };
}

export interface Selection {
  readonly chosen: OptionVerdict & { readonly adapter: StellarSchemeAdapter; readonly reserve: bigint };
  readonly verdicts: readonly OptionVerdict[];
}

/**
 * Picks the option to pay: among acceptable options, the preferred scheme, then the lowest reserve,
 * then exact, then the seller's order. With no acceptable option, a single option's own refusal is
 * raised; otherwise `payment_no_acceptable_option` lists every option and why it was refused.
 */
export function selectOption(options: readonly PaymentRequirements[], context: OptionContext): Selection {
  const verdicts = options.map((option, index) => checkOption(option, index, context));
  const acceptable = verdicts.filter(
    (verdict): verdict is Selection["chosen"] =>
      verdict.refused === undefined && verdict.adapter !== undefined && verdict.reserve !== undefined,
  );
  const rank = (verdict: Selection["chosen"]) =>
    [
      verdict.option.scheme === context.preferredScheme ? 0 : 1,
      verdict.reserve,
      verdict.option.scheme === "exact" ? 0 : 1,
      verdict.index,
    ] as const;
  acceptable.sort((a, b) => {
    const [a0, a1, a2, a3] = rank(a);
    const [b0, b1, b2, b3] = rank(b);
    return a0 - b0 || (a1 < b1 ? -1 : a1 > b1 ? 1 : 0) || a2 - b2 || a3 - b3;
  });
  const chosen = acceptable[0];
  if (chosen !== undefined) return { chosen, verdicts };
  throw noAcceptableOption(verdicts, context);
}

function noAcceptableOption(verdicts: readonly OptionVerdict[], context: OptionContext): PaymentError {
  const [only] = verdicts;
  if (verdicts.length === 1 && only?.refused !== undefined) {
    return paymentError(only.refused.code, { reason: only.refused.reason, details: only.refused.details });
  }
  return paymentError("payment_no_acceptable_option", {
    details: {
      offered: verdicts.map(({ option, refused }) => {
        const asset = policyAsset(context.policy, option.asset);
        const atomic = parseAtomic(option.amount);
        return {
          scheme: option.scheme,
          network: option.network,
          asset: asset?.symbol ?? option.asset,
          amount: asset !== undefined && atomic !== undefined ? toDecimal(atomic, asset.decimals) : null,
          payTo: option.payTo,
          refused: refused?.code ?? null,
        };
      }),
    },
  });
}
