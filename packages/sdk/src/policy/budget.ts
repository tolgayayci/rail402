import { paymentError } from "../codes.ts";
import { toDecimal } from "../money.ts";
import { effectiveCaps, type SpendLedger, type WindowCaps, type WindowSpec } from "./ledger.ts";
import type { ResolvedPolicy } from "./policy.ts";

/** Default budget window: named "default", 24 hours, renewing when it expires. */
export const DEFAULT_SESSION = { name: "default", ttlMs: 24 * 60 * 60 * 1_000 } as const;

export interface SessionOptions {
  readonly name?: string | undefined;
  readonly ttlMs?: number | undefined;
  /** Default true for the default session. */
  readonly autoRenew?: boolean | undefined;
  /** Default true: the window is created on first use. */
  readonly autoCreate?: boolean | undefined;
}

/** The window spec for a payer under a policy. Every policy asset needs caps. */
export function windowSpecFor(
  policy: ResolvedPolicy,
  payer: string,
  session: SessionOptions = {},
): WindowSpec {
  const caps: Record<string, WindowCaps[string]> = {};
  for (const asset of policy.assets) {
    if (asset.perCall === undefined || asset.sessionTotal === undefined) {
      throw paymentError("payment_policy_invalid", {
        reason: `No per-call ceiling or session total is configured for ${asset.symbol}.`,
      });
    }
    caps[asset.contract] = { perCall: asset.perCall, total: asset.sessionTotal, decimals: asset.decimals };
  }
  return {
    network: policy.network,
    payer,
    name: session.name ?? DEFAULT_SESSION.name,
    ttlMs: session.ttlMs ?? DEFAULT_SESSION.ttlMs,
    caps,
    autoRenew: session.autoRenew ?? true,
    autoCreate: session.autoCreate ?? true,
  };
}

export interface AssetBudget {
  readonly asset: string;
  readonly contract: string;
  readonly decimals: number;
  /** Decimal amounts in whole units of the asset. */
  readonly perCallCap: string;
  readonly sessionCap: string;
  readonly spent: string;
  readonly pending: string;
  readonly remaining: string;
}

export interface BudgetSnapshot {
  readonly session: string;
  readonly window: string;
  readonly network: string;
  readonly payer: string;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly autoRenew: boolean;
  readonly assets: readonly AssetBudget[];
  /** Reservations the RPC can no longer prove either way; they stay pending. */
  readonly awaitingProof: number;
  /** Reported settlements the chain did not confirm. */
  readonly falseClaims: number;
}

/**
 * The budget as it stands, per asset: spent, pending and remaining under the caps that apply (the
 * lower of the window's and the configuration's). Opens or renews the window if needed.
 */
export function budgetSnapshot(
  ledger: SpendLedger,
  spec: WindowSpec,
  policy: ResolvedPolicy,
  now = Date.now(),
): BudgetSnapshot {
  const window = ledger.window(spec, now);
  const usage = ledger.usage(window.id);
  const assets: AssetBudget[] = [];
  for (const asset of policy.assets) {
    const caps = effectiveCaps(window, spec, asset.contract);
    if (caps === undefined) continue;
    const { spent, pending } = usage.assets.get(asset.contract) ?? { spent: 0n, pending: 0n };
    const left = caps.total - spent - pending;
    const format = (value: bigint) => toDecimal(value, asset.decimals);
    assets.push({
      asset: asset.symbol,
      contract: asset.contract,
      decimals: asset.decimals,
      perCallCap: format(caps.perCall),
      sessionCap: format(caps.total),
      spent: format(spent),
      pending: format(pending),
      remaining: format(left > 0n ? left : 0n),
    });
  }
  return {
    session: window.name,
    window: window.id,
    network: window.network,
    payer: window.payer,
    startedAt: new Date(window.startedAt).toISOString(),
    expiresAt: new Date(window.expiresAt).toISOString(),
    autoRenew: window.autoRenew,
    assets,
    awaitingProof: usage.awaitingProof,
    falseClaims: usage.falseClaims,
  };
}

/** Budget left in the window for one asset, in base units. */
export function remainingBudget(
  ledger: SpendLedger,
  spec: WindowSpec,
  asset: string,
  now = Date.now(),
): bigint | undefined {
  const window = ledger.window(spec, now);
  const caps = effectiveCaps(window, spec, asset);
  if (caps === undefined) return undefined;
  const { spent, pending } = ledger.usage(window.id).assets.get(asset) ?? { spent: 0n, pending: 0n };
  const left = caps.total - spent - pending;
  return left > 0n ? left : 0n;
}
