import type { PaymentRequired } from "@x402/core/types";
import { agentCodes, isPaymentError, paymentError } from "../codes.ts";
import type { Money } from "../money.ts";
import { parseAtomic, toDecimal } from "../money.ts";
import { remainingBudget } from "../policy/budget.ts";
import { checkOption, selectOption, type ListingBinding, type OptionContext } from "../policy/decide.ts";
import { I128_MAX } from "@rail402.dev/stellar";
import { effectiveCap, policyAsset, type EffectiveCap } from "../policy/policy.ts";
import { upstreamMessage, type FlowContext } from "./common.ts";
import { feesSponsored } from "../schemes/adapter.ts";
import type { QuoteOption } from "./types.ts";

type Judged = {
  readonly options: QuoteOption[];
  readonly chosen: number | null;
  readonly refused: { code: string; reason: string } | null;
};

/**
 * Judges every option of a seller's 402 as `pay` would, without signing anything. Without a cap each
 * option is measured against its asset's operator ceiling. An option the policy cannot even judge is
 * `payment_requirements_invalid`.
 */
export function judgeOptions(
  context: FlowContext,
  required: PaymentRequired,
  maxAmount: Money | undefined,
  listing: ListingBinding | undefined,
): Judged {
  try {
    return judge(context, required, maxAmount, listing);
  } catch (error) {
    if (isPaymentError(error)) throw error;
    throw paymentError("payment_requirements_invalid", {
      reason: `The seller's payment options could not be judged: ${upstreamMessage(error)}`,
    });
  }
}

function judge(
  context: FlowContext,
  required: PaymentRequired,
  maxAmount: Money | undefined,
  listing: ListingBinding | undefined,
): Judged {
  const payer = context.signer?.address ?? "";
  const cap = maxAmount === undefined ? undefined : effectiveCap(context.policy, maxAmount);
  const base = (optionCap: EffectiveCap): OptionContext => ({
    network: context.network,
    policy: context.policy,
    adapters: context.adapters,
    payer,
    cap: optionCap,
    listing,
    remaining:
      context.spec === undefined
        ? undefined
        : (asset) => remainingBudget(context.ledger, context.spec as NonNullable<typeof context.spec>, asset),
  });
  const ceilingCap = (asset: string): EffectiveCap | undefined => {
    const known = policyAsset(context.policy, asset);
    if (known?.contract !== asset) return undefined;
    const ceiling = known.perCall ?? I128_MAX;
    return { asset: known, requested: ceiling, ceiling: known.perCall, cap: ceiling };
  };

  const options = required.accepts.map((option, index): QuoteOption => {
    const optionCap = cap ?? ceilingCap(option.asset) ?? effectiveCapFallback(context);
    const verdict = checkOption(option, index, base(optionCap));
    const known = policyAsset(context.policy, option.asset);
    const decimals = known?.contract === option.asset ? known.decimals : undefined;
    const atomic = parseAtomic(option.amount);
    return {
      index,
      scheme: option.scheme,
      network: option.network,
      asset: decimals === undefined ? option.asset : (known?.symbol ?? option.asset),
      assetContract: option.asset,
      amount: atomic !== undefined && decimals !== undefined ? toDecimal(atomic, decimals) : null,
      atomic: option.amount,
      payTo: option.payTo,
      maxTimeoutSeconds: option.maxTimeoutSeconds,
      feesSponsored: feesSponsored(option),
      acceptable: verdict.refused === undefined,
      refused:
        verdict.refused === undefined
          ? null
          : {
              code: verdict.refused.code,
              reason: verdict.refused.reason ?? agentCodes[verdict.refused.code].reason,
            },
    };
  });

  if (cap === undefined) {
    const acceptable = options.filter((option) => option.acceptable);
    const cheapest = acceptable.sort((a, b) => {
      const x = BigInt(a.atomic);
      const y = BigInt(b.atomic);
      return x < y ? -1 : x > y ? 1 : a.index - b.index;
    })[0];
    return {
      options,
      chosen: cheapest?.index ?? null,
      refused:
        cheapest === undefined
          ? { code: "payment_no_acceptable_option", reason: agentCodes.payment_no_acceptable_option.reason }
          : null,
    };
  }
  try {
    const selection = selectOption(required.accepts, base(cap));
    return { options, chosen: selection.chosen.index, refused: null };
  } catch (error) {
    if (!isPaymentError(error)) throw error;
    return { options, chosen: null, refused: { code: error.code, reason: error.reason } };
  }
}

/** A cap no option can use: for options priced in an asset outside the policy. */
function effectiveCapFallback(context: FlowContext): EffectiveCap {
  const [first] = context.policy.assets;
  if (first === undefined) throw new RangeError("a resolved policy has at least one asset");
  const ceiling = first.perCall ?? I128_MAX;
  return { asset: first, requested: ceiling, ceiling: first.perCall, cap: ceiling };
}
