/**
 * The page's buyer wiring: the spending policy built from the operator's public caps, the persisted
 * budget ledger, and the browser buyer over the page's transports. The per-call ceiling is the
 * operator's (0.10 USDC by default) and never above the session total the user chose; the session
 * total can only go down. Pubnet is never configured: the network is the configuration's, which only
 * allows testnet.
 */
import type { PaymentRequirements } from "@x402/core/types";
import {
  checkOption,
  createBrowserBuyer,
  effectiveCap,
  exactScheme,
  toAtomic,
  uptoScheme,
  type Buyer,
  type BuyerTransport,
  type PaymentEventListener,
  type ResolvedPolicy,
  type Sep43AuthSigner,
  type SessionOptions,
  type SpendLedger,
  type SpendingPolicyInput,
  type StellarSchemeAdapter,
  explorerTemplate,
} from "@rail402.dev/sdk/browser";
import { TESTNET } from "@rail402.dev/stellar";
import type { PublicConfig } from "../../../src/shared/public-config.ts";
import { isRecord, type Verdict } from "./decode.ts";

/** The budget ledger's storage key prefix for a payer. */
export function ledgerPrefix(address: string): string {
  return `rail402.playground.ledger.v1.${address}`;
}

/** Where the session total the user lowered is kept, per payer. */
export function sessionTotalKey(address: string): string {
  return `rail402.playground.session-total.v1.${address}`;
}

export interface PolicyOptions {
  /** The session total, decimal; default the operator's. */
  readonly sessionTotal?: string;
  /** The per-call ceiling, decimal; default the operator's, never above the session total. */
  readonly perCall?: string;
  /** Recipients refused outright. */
  readonly deny?: readonly string[];
}

/** The smaller of two decimal amounts of an asset with `decimals` decimals. */
function lowerOf(a: string, b: string, decimals: number): string {
  const x = toAtomic(a, decimals);
  const y = toAtomic(b, decimals);
  if (x === undefined || y === undefined) return a;
  return x <= y ? a : b;
}

/** The spending policy for the configured asset and upto contract. */
export function policyInput(config: PublicConfig, options: PolicyOptions = {}): SpendingPolicyInput {
  const { asset, caps } = config;
  const sessionTotal = options.sessionTotal ?? caps.sessionTotal;
  const perCall = lowerOf(options.perCall ?? caps.perCallCeiling, sessionTotal, asset.decimals);
  return {
    assets: [
      { asset: asset.contract, symbol: asset.symbol, decimals: asset.decimals, perCall, sessionTotal },
    ],
    uptoContracts: [config.uptoContract],
    ...(options.deny === undefined ? {} : { recipients: { deny: options.deny } }),
  };
}

/** The scheme adapters the page pays with: exact, and upto pinned to the configured contract. */
export function schemeAdapters(config: PublicConfig): readonly StellarSchemeAdapter[] {
  return [exactScheme(), uptoScheme({ contract: config.uptoContract })];
}

/** The default budget session: 24 h (the operator's), renewed when it expires. */
export function defaultSession(config: PublicConfig): SessionOptions {
  return { name: "default", ttlMs: config.caps.sessionTtlMs, autoRenew: true };
}

/**
 * Judges each option of a payment request against the policy and a per-call cap, as the buyer will:
 * acceptable, or the code and reason it would be refused with. Nothing is signed.
 */
export function optionJudge(
  policy: ResolvedPolicy,
  adapters: readonly StellarSchemeAdapter[],
  payer: string,
  cap: { readonly amount: string; readonly asset: string },
): (required: unknown) => readonly Verdict[] | undefined {
  return (required) => {
    if (!isRecord(required) || !Array.isArray(required["accepts"])) return undefined;
    let effective;
    try {
      effective = effectiveCap(policy, cap);
    } catch {
      return undefined;
    }
    return (required["accepts"] as unknown[]).map((option, index): Verdict => {
      if (!isRecord(option)) return null;
      try {
        const verdict = checkOption(option as unknown as PaymentRequirements, index, {
          network: policy.network,
          policy,
          adapters,
          payer,
          cap: effective,
        });
        return verdict.refused === undefined
          ? { acceptable: true, code: null, reason: null }
          : {
              acceptable: false,
              code: verdict.refused.code,
              reason: verdict.refused.reason ?? null,
            };
      } catch {
        return null;
      }
    });
  };
}

export interface BuyerWiring {
  readonly config: PublicConfig;
  readonly signer: Sep43AuthSigner;
  readonly transport: BuyerTransport;
  readonly ledger: SpendLedger;
  readonly bazaarUrl: string;
  readonly facilitatorUrl: string;
  readonly onEvent: PaymentEventListener;
  readonly policy?: PolicyOptions;
  readonly session?: SessionOptions;
}

/** A browser buyer for the configured testnet over the page's transports. */
export function buildBuyer(wiring: BuyerWiring): Promise<Buyer> {
  const { config } = wiring;
  return createBrowserBuyer({
    network: TESTNET,
    signer: wiring.signer,
    rpcUrl: config.urls.rpc,
    transport: wiring.transport,
    bazaarUrl: wiring.bazaarUrl,
    facilitatorUrl: wiring.facilitatorUrl,
    policy: policyInput(config, wiring.policy),
    ledger: wiring.ledger,
    session: wiring.session ?? defaultSession(config),
    schemes: schemeAdapters(config),
    explorer: explorerTemplate(config.explorerTemplate),
    verify: "sync",
    onEvent: wiring.onEvent,
  });
}
