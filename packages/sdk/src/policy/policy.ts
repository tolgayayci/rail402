import { StrKey } from "@stellar/stellar-sdk";
import { PUBNET, USDC, baseAccount, type AssetFacts, type StellarNetwork } from "@rail402.dev/stellar";
import { UPTO_DEPLOYMENTS } from "@rail402.dev/upto";
import { paymentError, type PaymentError } from "../codes.ts";
import { isValidDecimals, toAtomic, toDecimal, type Money } from "../money.ts";

/** How far a Bazaar listing's content is trusted, weakest first. */
export type Trust = "settled" | "origin_verified" | "domain_verified";
export const TRUST_LEVELS: readonly Trust[] = ["settled", "origin_verified", "domain_verified"];

export type SchemeName = "exact" | "upto";
export const SCHEME_NAMES: readonly SchemeName[] = ["exact", "upto"];

export interface PolicyAssetInput {
  /** "USDC" (Circle USDC on the configured network) or a SEP-41 token contract (C…). */
  readonly asset: string;
  /** Symbol shown for a custom token; it must equal the token's own `symbol()`. */
  readonly symbol?: string;
  /** Required for a custom token, and verified against the token's own `decimals()`. */
  readonly decimals?: number;
  /** Operator ceiling for one call, as a decimal ("0.10"). A caller's cap above it is clamped. */
  readonly perCall?: string;
  /** Most a budget window may spend, as a decimal ("1.00"). */
  readonly sessionTotal?: string;
}

/** What an operator allows a buyer to pay. Everything not listed is refused. */
export interface SpendingPolicyInput {
  readonly assets?: readonly PolicyAssetInput[];
  /**
   * Default: exact and upto where the network has a canonical upto settlement contract (testnet),
   * otherwise exact only.
   */
  readonly schemes?: readonly SchemeName[];
  /** G…, C… or M… addresses; muxed addresses are compared by their base account. */
  readonly recipients?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
  /** Longest authorization window accepted, in seconds. Default 300. */
  readonly maxAuthorizationSeconds?: number;
  /** Only pay resources selected from a Bazaar listing. Default false on testnet, true on pubnet. */
  readonly requireCatalogListing?: boolean;
  /** Lowest listing trust paid. Default `settled` on testnet; origin/domain verified on pubnet. */
  readonly minTrust?: { readonly http?: Trust; readonly mcp?: Trust };
  /**
   * Pinned upto settlement contracts (C…); an authorization for any other contract is refused.
   * Default: the network's canonical deployment, when it has one.
   */
  readonly uptoContracts?: readonly string[];
  /**
   * Settlement authorities (`extra.facilitatorAddress`, G… or C…) allowed to settle upto payments.
   * Default: any authority other than the payer and the recipient, bound exactly to the selected option.
   */
  readonly uptoFacilitators?: readonly string[];
}

export interface PolicyAsset {
  /** The token's symbol ("USDC"). */
  readonly symbol: string;
  readonly contract: string;
  readonly decimals: number;
  /** Operator per-call ceiling in base units; undefined only in a policy resolved without caps. */
  readonly perCall: bigint | undefined;
  /** Budget window total in base units; undefined only in a policy resolved without caps. */
  readonly sessionTotal: bigint | undefined;
}

export interface ResolvedPolicy {
  readonly network: StellarNetwork;
  readonly assets: readonly PolicyAsset[];
  readonly schemes: readonly SchemeName[];
  /** Base accounts. `allow` undefined means any recipient not denied. */
  readonly recipients: {
    readonly allow: ReadonlySet<string> | undefined;
    readonly deny: ReadonlySet<string>;
  };
  readonly maxAuthorizationSeconds: number;
  readonly requireCatalogListing: boolean;
  readonly minTrust: { readonly http: Trust; readonly mcp: Trust };
  readonly uptoContracts: readonly string[];
  /** Undefined: any authority other than the payer and the recipient. */
  readonly uptoFacilitators: ReadonlySet<string> | undefined;
}

/** Defaults for a testnet buyer: 0.10 USDC per call and 1.00 USDC per budget window. */
export const TESTNET_DEFAULT_CAPS = { perCall: "0.10", sessionTotal: "1.00" } as const;

/** The facilitator's own maximum `maxTimeoutSeconds`, used as the default authorization window. */
export const DEFAULT_MAX_AUTHORIZATION_SECONDS = 300;
/** Upper bound on a configured authorization window. */
export const MAX_AUTHORIZATION_SECONDS = 3_600;

export interface ResolvePolicyOptions {
  /**
   * Whether every asset needs a per-call ceiling and a session total. True whenever a signer is
   * configured: a buyer that can pay never runs without caps. Testnet USDC gets defaults; any other
   * asset, and every pubnet asset, must be configured.
   */
  readonly requireCaps: boolean;
  /** Reads a token's decimals on chain; required when the policy names a custom token. */
  readonly describe?: (contract: string) => Promise<AssetFacts | undefined>;
}

/**
 * Validates a spending policy and fills in the network's defaults. Custom token decimals are read
 * on chain and must match the configured value; decimals are never guessed or taken from a seller.
 */
export async function resolvePolicy(
  network: StellarNetwork,
  input: SpendingPolicyInput = {},
  options: ResolvePolicyOptions,
): Promise<ResolvedPolicy> {
  const pubnet = network === PUBNET;
  const assetInputs = input.assets ?? [{ asset: "USDC" }];
  if (assetInputs.length === 0) throw invalid("the policy must allow at least one asset.");

  const assets: PolicyAsset[] = [];
  for (const assetInput of assetInputs) {
    const asset = await resolveAsset(network, assetInput, options);
    if (assets.some((known) => known.contract === asset.contract)) {
      throw invalid(`asset ${asset.contract} is listed more than once.`);
    }
    if (assets.some((known) => known.symbol === asset.symbol)) {
      throw invalid(`two policy assets share the symbol "${asset.symbol}"; give one a distinct symbol.`);
    }
    assets.push(asset);
  }

  const canonicalUpto = UPTO_DEPLOYMENTS[network]?.address;
  const uptoContracts = input.uptoContracts ?? (canonicalUpto === undefined ? [] : [canonicalUpto]);
  for (const contract of uptoContracts) {
    if (!StrKey.isValidContract(contract)) throw invalid("uptoContracts must be C… contract addresses.");
  }
  const schemes = input.schemes ?? (uptoContracts.length > 0 ? ["exact", "upto"] : ["exact"]);
  if (schemes.length === 0 || schemes.some((scheme) => !SCHEME_NAMES.includes(scheme))) {
    throw invalid(`schemes must be a non-empty list of ${SCHEME_NAMES.join(", ")}.`);
  }
  if (schemes.includes("upto") && uptoContracts.length === 0) {
    throw invalid(`upto needs a pinned settlement contract (uptoContracts) on ${network}.`);
  }
  let uptoFacilitators: Set<string> | undefined;
  if (input.uptoFacilitators !== undefined) {
    uptoFacilitators = new Set();
    for (const address of input.uptoFacilitators) {
      if (!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address)) {
        throw invalid("uptoFacilitators must be G… or C… addresses.");
      }
      uptoFacilitators.add(address);
    }
    if (uptoFacilitators.size === 0)
      throw invalid("uptoFacilitators, when set, must name at least one address.");
  }

  const maxAuthorizationSeconds = input.maxAuthorizationSeconds ?? DEFAULT_MAX_AUTHORIZATION_SECONDS;
  if (
    !Number.isInteger(maxAuthorizationSeconds) ||
    maxAuthorizationSeconds < 1 ||
    maxAuthorizationSeconds > MAX_AUTHORIZATION_SECONDS
  ) {
    throw invalid(`maxAuthorizationSeconds must be an integer from 1 to ${MAX_AUTHORIZATION_SECONDS}.`);
  }

  const minTrust = {
    http: input.minTrust?.http ?? (pubnet ? "origin_verified" : "settled"),
    mcp: input.minTrust?.mcp ?? (pubnet ? "domain_verified" : "settled"),
  } as const;
  if (!TRUST_LEVELS.includes(minTrust.http) || !TRUST_LEVELS.includes(minTrust.mcp)) {
    throw invalid(`minTrust must be one of ${TRUST_LEVELS.join(", ")}.`);
  }

  return {
    network,
    assets,
    schemes: [...new Set(schemes)],
    recipients: {
      allow: input.recipients?.allow === undefined ? undefined : baseSet(input.recipients.allow, "allow"),
      deny: baseSet(input.recipients?.deny ?? [], "deny"),
    },
    maxAuthorizationSeconds,
    requireCatalogListing: input.requireCatalogListing ?? pubnet,
    minTrust,
    uptoContracts: [...new Set(uptoContracts)],
    uptoFacilitators,
  };
}

async function resolveAsset(
  network: StellarNetwork,
  input: PolicyAssetInput,
  options: ResolvePolicyOptions,
): Promise<PolicyAsset> {
  const usdc = USDC[network];
  const isUsdc = input.asset === usdc.symbol || input.asset === usdc.contract;
  let symbol: string;
  let contract: string;
  let decimals: number;
  if (isUsdc) {
    if (input.decimals !== undefined && input.decimals !== usdc.decimals) {
      throw invalid(`USDC has ${usdc.decimals} decimals, not ${input.decimals}.`);
    }
    if (input.symbol !== undefined && input.symbol !== usdc.symbol) {
      throw invalid(`USDC's symbol is ${usdc.symbol}.`);
    }
    ({ symbol, contract, decimals } = usdc);
  } else {
    if (!StrKey.isValidContract(input.asset)) {
      throw invalid(`asset "${input.asset}" must be USDC or a SEP-41 token contract address (C…).`);
    }
    contract = input.asset;
    if (input.decimals === undefined || !isValidDecimals(input.decimals)) {
      throw invalid(`asset ${contract} needs its decimals (an integer from 0 to 38).`);
    }
    decimals = input.decimals;
    if (options.describe === undefined) {
      throw invalid(`the decimals of asset ${contract} cannot be verified without an RPC connection.`);
    }
    let facts: AssetFacts | undefined;
    try {
      facts = await options.describe(contract);
    } catch {
      facts = undefined;
    }
    if (facts === undefined) {
      throw invalid(`asset ${contract} could not be read on chain as a SEP-41 token.`);
    }
    if (facts.decimals !== decimals) {
      throw invalid(`asset ${contract} has ${facts.decimals} decimals on chain, not ${decimals}.`);
    }
    if (input.symbol !== undefined && input.symbol !== facts.symbol) {
      throw invalid(`asset ${contract} has the symbol "${facts.symbol}" on chain, not "${input.symbol}".`);
    }
    symbol = facts.symbol;
  }

  const defaults = network !== PUBNET && isUsdc ? TESTNET_DEFAULT_CAPS : undefined;
  const perCallText = input.perCall ?? defaults?.perCall;
  const totalText = input.sessionTotal ?? defaults?.sessionTotal;
  if (options.requireCaps && (perCallText === undefined || totalText === undefined)) {
    throw invalid(
      `asset ${symbol} needs a per-call ceiling and a session total before anything can be paid.`,
    );
  }
  const perCall =
    perCallText === undefined ? undefined : positive(perCallText, decimals, `${symbol} perCall`);
  const sessionTotal =
    totalText === undefined ? undefined : positive(totalText, decimals, `${symbol} sessionTotal`);
  if (perCall !== undefined && sessionTotal !== undefined && perCall > sessionTotal) {
    throw invalid(`the ${symbol} per-call ceiling is larger than its session total.`);
  }
  return { symbol, contract, decimals, perCall, sessionTotal };
}

function positive(text: string, decimals: number, label: string): bigint {
  const value = toAtomic(text, decimals);
  if (value === undefined || value <= 0n) {
    throw invalid(`${label} must be a positive decimal amount with at most ${decimals} decimals.`);
  }
  return value;
}

function baseSet(addresses: readonly string[], label: string): ReadonlySet<string> {
  const set = new Set<string>();
  for (const address of addresses) {
    const base = baseAccount(address);
    if (base === undefined) throw invalid(`recipients.${label} contains an invalid Stellar address.`);
    set.add(base);
  }
  return set;
}

function invalid(reason: string): PaymentError {
  return paymentError("payment_policy_invalid", { reason: `Invalid spending policy: ${reason}` });
}

/** The policy asset with this symbol or contract address. */
export function policyAsset(policy: ResolvedPolicy, asset: string): PolicyAsset | undefined {
  return policy.assets.find((known) => known.contract === asset || known.symbol === asset);
}

/** A caller's per-call cap after clamping to the operator's ceiling. */
export interface EffectiveCap {
  readonly asset: PolicyAsset;
  /** The cap the caller asked for, in base units. */
  readonly requested: bigint;
  readonly ceiling: bigint | undefined;
  /** min(requested, ceiling): the most this call may pay. */
  readonly cap: bigint;
}

/**
 * Resolves a caller's per-call cap. The cap is required (`payment_cap_required`); its asset defaults
 * to the policy's first asset; an unknown asset or too many decimals is `payment_cap_invalid`. A cap
 * above the operator's ceiling is clamped, not refused.
 */
export function effectiveCap(policy: ResolvedPolicy, money: Money | undefined): EffectiveCap {
  if (money === undefined || typeof money !== "object" || typeof money.amount !== "string") {
    throw paymentError("payment_cap_required");
  }
  const first = policy.assets[0];
  const asset = money.asset === undefined ? first : policyAsset(policy, money.asset);
  if (asset === undefined) {
    throw paymentError("payment_cap_invalid", {
      reason: `The cap's asset is not in the spending policy (allowed: ${policy.assets.map((a) => a.symbol).join(", ")}).`,
    });
  }
  const requested = toAtomic(money.amount, asset.decimals);
  if (requested === undefined || requested <= 0n) {
    throw paymentError("payment_cap_invalid", {
      reason: `The cap must be a positive decimal amount of ${asset.symbol} with at most ${asset.decimals} decimals.`,
    });
  }
  const cap = asset.perCall !== undefined && asset.perCall < requested ? asset.perCall : requested;
  return { asset, requested, ceiling: asset.perCall, cap };
}

/** The cap as decimals, for error details and results. */
export function describeCap(cap: EffectiveCap): { cap: string; requested: string; ceiling: string | null } {
  const { decimals } = cap.asset;
  return {
    cap: toDecimal(cap.cap, decimals),
    requested: toDecimal(cap.requested, decimals),
    ceiling: cap.ceiling === undefined ? null : toDecimal(cap.ceiling, decimals),
  };
}

/**
 * Whether a recipient may be paid: a valid G…, C… or M… address that is not the payer and passes
 * the allow and deny lists, all compared by base account.
 */
export function recipientPermitted(policy: ResolvedPolicy, payTo: string, payer: string): boolean {
  const base = baseAccount(payTo);
  if (base === undefined) return false;
  if (base === (baseAccount(payer) ?? payer)) return false;
  if (policy.recipients.deny.has(base)) return false;
  return policy.recipients.allow === undefined || policy.recipients.allow.has(base);
}

export function meetsTrust(trust: Trust, minimum: Trust): boolean {
  return TRUST_LEVELS.indexOf(trust) >= TRUST_LEVELS.indexOf(minimum);
}
