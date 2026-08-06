import { identifyStellarAsset } from "./stellar-assets.js";

/**
 * Trustline pre-flight — can the party being paid actually *receive* what this listing is priced in?
 *
 * ## Why a catalog should answer this at all
 *
 * Stellar's defining onboarding hazard: an account cannot hold a SEP-41 asset until it has
 * established a trustline to it, and a payment to an account without one fails on-ledger. The facilitator
 * already detects the failure and returns its own error code — but that is a *post-mortem*. It tells
 * a buyer why their money did not move, after they signed. A catalog that knows the seller cannot
 * receive USDC and lists them anyway is inviting exactly that round trip.
 *
 * So this is the discovery-time half: the listing carries what the seller's payTo looks like from
 * the outside, and an agent can prefer a listing that will settle over one that will not. No EVM or
 * SVM catalog has an equivalent, because no EVM or SVM catalog has this failure mode.
 *
 * ## Conditional, and the conditions are the interesting part
 *
 * The check runs ONLY when all three hold, and is omitted entirely otherwise — silence rather than a
 * guess:
 *
 *  1. **The asset has a derived identity** (`stellar-assets.ts`). A SAC address is a one-way hash of
 *     (code, issuer, passphrase), so given only `C…` there is no way to recover which classic asset
 *     to look for. Deriving the identity is what makes the question askable — which is why this and
 *     `extra.stellar.asset` are one feature, not two.
 *  2. **The asset is a classic issued asset.** Native XLM needs no trustline; asserting a state for
 *     it would be noise that an agent might act on.
 *  3. **The payTo is a classic `G…` account.** A contract payee holds SAC balances in contract
 *     storage, where the trustline concept does not apply at all — reporting `missing` for one would
 *     be actively wrong, and would defame a perfectly functional seller.
 *
 * ## It is advisory, and it NEVER gates cataloging
 *
 * Same posture as SEP-1 domain verification, for the same reason. Refusing to list a seller because
 * Horizon was briefly unreachable would be a worse failure than the one being prevented, and would
 * hand anyone a denial-of-listing lever. It also never runs on the settlement path: the entry is
 * written immediately, the check resolves afterwards, and a slow Horizon delays only itself.
 *
 * A stale `ok` is possible by construction — a seller can remove a trustline a second after we
 * looked. `checkedAt` travels with the verdict so an agent can judge for itself; this is a
 * pre-flight, not a guarantee, and the facilitator's settle-time error remains the authority.
 */

/**
 * What a buyer needs to know about the payee's ability to receive.
 *
 * `unknown` is a real answer, not a placeholder: it means we asked and could not find out (Horizon
 * unreachable, a malformed response). It is deliberately distinct from omitting the field, which
 * means the question did not apply.
 */
export type TrustlineState = "ok" | "missing" | "unauthorized" | "unknown";

export interface TrustlineVerdict {
  state: TrustlineState;
  /** ISO timestamp of the check. A pre-flight's value is inseparable from its age. */
  checkedAt: string;
  /**
   * Non-null for every state except `ok` (no rejection without a legible reason,
   * and an agent that sees `missing` with no explanation cannot tell a seller what to fix).
   */
  reason?: string;
}

/** Horizon endpoints by CAIP-2 network. Only networks we actually serve are checkable. */
export const DEFAULT_HORIZON_URLS: Readonly<Record<string, string>> = {
  "stellar:testnet": "https://horizon-testnet.stellar.org",
};

/** A payee's account is not our critical path; it gets very little patience. */
const FETCH_TIMEOUT_MS = 4_000;
/** Trustlines are stable, but revocable — so `ok` is cached, not trusted forever. */
const OK_TTL_MS = 10 * 60 * 1000;
/** A seller who adds the missing trustline should not be stuck with a stale verdict. */
const PROBLEM_TTL_MS = 2 * 60 * 1000;
/** An infrastructure failure should be retried soon; caching it long would spread the outage. */
const UNKNOWN_TTL_MS = 30 * 1000;

/** Horizon's balance rows. Only the fields this decision reads are modelled. */
interface HorizonBalance {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  limit?: string;
  is_authorized?: boolean;
}

interface CacheEntry {
  verdict: TrustlineVerdict;
  expiresAt: number;
}

export interface TrustlineTarget {
  code: string;
  issuer: string;
  horizonUrl: string;
}

/**
 * Decide whether the trustline question applies here, and to what.
 *
 * Exported because the answer is the feature's whole shape — the three conditions above — and a
 * caller deciding whether to schedule a check needs the same answer the checker would give.
 */
export function trustlineTarget(
  network: string,
  asset: string,
  payTo: string,
  horizonUrls: Readonly<Record<string, string>> = DEFAULT_HORIZON_URLS,
): TrustlineTarget | undefined {
  const horizonUrl = horizonUrls[network];
  if (!horizonUrl) return undefined;
  // A `G…` classic account. Contract payees (`C…`) hold SAC balances in contract storage, where
  // trustlines do not exist — the check is meaningless, not merely unavailable.
  if (!/^G[A-Z2-7]{55}$/.test(payTo)) return undefined;
  const identity = identifyStellarAsset(network, asset);
  // No derived identity means we cannot know which classic asset the SAC stands for, and a SAC
  // address cannot be reversed. A null issuer is native XLM, which needs no trustline.
  if (!identity || identity.issuer === null) return undefined;
  return { code: identity.code, issuer: identity.issuer, horizonUrl };
}

export interface TrustlineCheckerOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly horizonUrls?: Readonly<Record<string, string>>;
}

/**
 * Caches trustline verdicts per (network, asset, payTo).
 *
 * In-memory and bounded by the catalog's own size, mirroring `DomainVerifier`: derived state that
 * can be rebuilt by asking Horizon again, so durability is not a concern.
 */
export class TrustlineChecker {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<TrustlineVerdict>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly horizonUrls: Readonly<Record<string, string>>;

  constructor(options: TrustlineCheckerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.horizonUrls = options.horizonUrls ?? DEFAULT_HORIZON_URLS;
  }

  private static key(network: string, asset: string, payTo: string): string {
    return `${network} ${asset} ${payTo}`;
  }

  /** Whether this (network, asset, payTo) is one the check applies to at all. */
  applies(network: string, asset: string, payTo: string): boolean {
    return trustlineTarget(network, asset, payTo, this.horizonUrls) !== undefined;
  }

  /** The cached verdict, if present and fresh. Synchronous — never triggers a request. */
  cached(network: string, asset: string, payTo: string): TrustlineVerdict | undefined {
    const hit = this.cache.get(TrustlineChecker.key(network, asset, payTo));
    if (!hit || hit.expiresAt <= this.now()) return undefined;
    return hit.verdict;
  }

  /**
   * Ask Horizon whether `payTo` can receive this asset.
   *
   * Concurrent checks for the same triple share one request, so a burst of settlements for one
   * seller does not become a burst of requests at Horizon.
   */
  async check(network: string, asset: string, payTo: string): Promise<TrustlineVerdict | undefined> {
    const target = trustlineTarget(network, asset, payTo, this.horizonUrls);
    if (!target) return undefined;

    const cacheKey = TrustlineChecker.key(network, asset, payTo);
    const fresh = this.cached(network, asset, payTo);
    if (fresh) return fresh;

    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const pending = this.fetchVerdict(target, payTo)
      .then(verdict => {
        const ttl =
          verdict.state === "ok"
            ? OK_TTL_MS
            : verdict.state === "unknown"
              ? UNKNOWN_TTL_MS
              : PROBLEM_TTL_MS;
        this.cache.set(cacheKey, { verdict, expiresAt: this.now() + ttl });
        return verdict;
      })
      .finally(() => this.inFlight.delete(cacheKey));

    this.inFlight.set(cacheKey, pending);
    return pending;
  }

  private async fetchVerdict(target: TrustlineTarget, payTo: string): Promise<TrustlineVerdict> {
    const checkedAt = new Date(this.now()).toISOString();
    const url = `${target.horizonUrl}/accounts/${payTo}`;
    const asset = `${target.code}:${target.issuer}`;

    let balances: HorizonBalance[];
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.status === 404) {
        // No account at all. The payment cannot land, which is the same actionable conclusion as a
        // missing trustline — and the reason says which of the two it actually is.
        return {
          state: "missing",
          checkedAt,
          reason: `Account ${payTo} does not exist on ${target.horizonUrl}, so it can hold no assets and a payment to it cannot settle.`,
        };
      }
      if (!response.ok) {
        return {
          state: "unknown",
          checkedAt,
          reason: `Horizon returned HTTP ${response.status} for ${payTo}, so whether it can receive ${asset} could not be determined.`,
        };
      }
      const body = (await response.json()) as { balances?: unknown };
      if (!Array.isArray(body.balances)) {
        return {
          state: "unknown",
          checkedAt,
          reason: `Horizon's response for ${payTo} carried no balances array, so whether it can receive ${asset} could not be determined.`,
        };
      }
      balances = body.balances as HorizonBalance[];
    } catch (error) {
      return {
        state: "unknown",
        checkedAt,
        reason: `Could not reach Horizon for ${payTo}: ${error instanceof Error ? error.message : "unknown error"}.`,
      };
    }

    const line = balances.find(
      b => b.asset_code === target.code && b.asset_issuer === target.issuer,
    );
    if (!line) {
      return {
        state: "missing",
        checkedAt,
        reason: `${payTo} has no trustline to ${asset}. A payment in this asset will fail until the account establishes one (a classic CHANGE_TRUST operation).`,
      };
    }
    // `is_authorized: false` is the issuer withholding authorization under AUTH_REQUIRED. A zero
    // limit is a different mechanism with the identical consequence — the line exists and can hold
    // nothing — so it lands in the same state, with a reason that names which one it is.
    if (line.is_authorized === false) {
      return {
        state: "unauthorized",
        checkedAt,
        reason: `${payTo} holds a trustline to ${asset} but the issuer has not authorized it, so a payment in this asset will fail until the issuer does.`,
      };
    }
    if (line.limit === "0" || line.limit === "0.0000000") {
      return {
        state: "unauthorized",
        checkedAt,
        reason: `${payTo} holds a trustline to ${asset} with a limit of 0, so it can receive none of it until the limit is raised.`,
      };
    }
    return { state: "ok", checkedAt };
  }
}
