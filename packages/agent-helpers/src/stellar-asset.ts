/**
 * Reading the Bazaar's provable Stellar asset identity, buyer-side.
 *
 * On Stellar a Stellar Asset Contract address is a hash of (assetCode, issuer, networkPassphrase),
 * so "is this `C…` really USDC?" is a DERIVATION rather than a claim: an issuer using the code
 * "USDC" from a different account lands on a different contract and cannot impersonate the canonical
 * one. Our Bazaar strips whatever a client echoed into `extra.stellar` and attaches its own
 * derivation (`apps/bazaar/src/catalog/stellar-assets.ts`), which is why this is worth reading at
 * all — it is the asset assurance an EVM/SVM catalog structurally cannot offer, where the best
 * available answer is a curated token list somebody maintains by hand.
 *
 * Lives here, in the buyer-side package, because both agent-facing surfaces need exactly this parse:
 * `searchBazaar` below and the MCP server's `search_stellar_resources`. Two copies of a defensive
 * parse drift, and the copy that drifts is the one that stops rejecting something.
 */

/** The agent-facing projection of the catalog's derived asset identity. */
export interface AssetIdentity {
  code: string;
  /** Classic issuer G-address, or `null` for native XLM. */
  issuer: string | null;
  decimals: number;
  /**
   * The catalog independently derived this contract address from the canonical (code, issuer) for
   * this network. The only value emitted today, and the only one this reader accepts — see below.
   */
  identity: "derived";
}

/**
 * Read the catalog's derived asset identity off a payment option's `extra`, or `undefined`.
 *
 * Parsed defensively rather than cast: this is JSON from an HTTP response, and the trust it carries
 * is exactly the trust the caller placed in the Bazaar URL it configured. A malformed or hostile
 * shape must degrade to "no identity" — never to a crash, and never to a half-populated object an
 * agent would read as vouched-for.
 *
 * `identity` is the load-bearing field: it is the catalog asserting it *derived* this, not merely
 * copied it. Anything else — including some future value this build has never heard of — is not
 * something to hand an agent as proven. Unknown-means-unproven is the only safe direction here.
 */
export function readAssetIdentity(extra: Record<string, unknown> | undefined): AssetIdentity | undefined {
  const stellar = extra?.["stellar"];
  if (!stellar || typeof stellar !== "object") return undefined;
  const asset = (stellar as Record<string, unknown>)["asset"];
  if (!asset || typeof asset !== "object") return undefined;

  const a = asset as Record<string, unknown>;
  if (a["identity"] !== "derived") return undefined;
  const code = a["code"];
  const decimals = a["decimals"];
  const issuer = a["issuer"];
  if (typeof code !== "string" || code.length === 0) return undefined;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) return undefined;
  if (issuer !== null && typeof issuer !== "string") return undefined;

  return { code, issuer, decimals, identity: "derived" };
}

// ── Trustline pre-flight ─────────────────────────────────────────────────────

/**
 * Whether the party being paid can actually receive the asset the listing is priced in.
 *
 * Stellar's defining onboarding hazard: an account cannot hold a SEP-41 asset until it establishes a
 * trustline, and a payment to an account without one fails on-ledger. Reading this before choosing a
 * seller is the difference between picking a different one and signing a payment that cannot land.
 *
 * `unknown` means the catalog asked and could not find out. An ABSENT field means the question did
 * not apply — native XLM, a contract payee, or an asset the catalog cannot identify — and is not a
 * negative signal.
 */
export type TrustlineState = "ok" | "missing" | "unauthorized" | "unknown";

export interface TrustlinePreflight {
  state: TrustlineState;
  /** ISO timestamp of the check. This is a pre-flight, not a guarantee; its age is part of it. */
  checkedAt: string;
  /** Present for every state but `ok`, explaining what is wrong and what would fix it. */
  reason?: string;
}

/**
 * Read the catalog's trustline pre-flight off a payment option's `extra`, or `undefined`.
 *
 * Defensive for the same reason as `readAssetIdentity`: a malformed shape must read as "no answer",
 * never as `ok`. Failing open here would be the worst possible direction — it would tell an agent a
 * payment will land when nothing checked that it would.
 */
export function readTrustlinePreflight(
  extra: Record<string, unknown> | undefined,
): TrustlinePreflight | undefined {
  const stellar = extra?.["stellar"];
  if (!stellar || typeof stellar !== "object") return undefined;
  const raw = (stellar as Record<string, unknown>)["payToTrustline"];
  if (!raw || typeof raw !== "object") return undefined;

  const t = raw as Record<string, unknown>;
  const state = t["state"];
  if (state !== "ok" && state !== "missing" && state !== "unauthorized" && state !== "unknown") {
    return undefined;
  }
  const checkedAt = t["checkedAt"];
  if (typeof checkedAt !== "string" || checkedAt.length === 0) return undefined;
  const reason = t["reason"];
  return {
    state,
    checkedAt,
    ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
  };
}

/**
 * Render an atomic amount in whole units — `("1000000", 7)` -> `"0.1000000"`.
 *
 * String and bigint arithmetic only. `Number("1000000") / 1e7` is the shortcut that
 * eventually prices something wrong, and this string is read by something deciding whether to spend.
 *
 * Always emits exactly `decimals` fraction digits rather than trimming: a trimmed `"1"` is one
 * glance from being read as one atomic unit, and this value exists precisely so an agent does not
 * confuse the two scales. Returns `undefined` for anything it cannot render exactly.
 */
export function formatAtomicAmount(amount: string, decimals: number): string | undefined {
  if (!/^\d+$/.test(amount)) return undefined;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) return undefined;
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const cut = padded.length - decimals;
  return `${padded.slice(0, cut)}.${padded.slice(cut)}`;
}
