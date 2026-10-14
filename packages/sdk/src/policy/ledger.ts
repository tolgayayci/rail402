import type { StellarNetwork } from "@rail402.dev/stellar";
import { paymentError } from "../codes.ts";
import type { ReleaseReason } from "../events.ts";
import { minBigInt, toDecimal } from "../money.ts";
import type { SchemeName } from "./policy.ts";

/**
 * The budget ledger: every payment reserves its amount in a budget window before its authorization is
 * signed, and the reservation moves through these states:
 *
 *   reserved ──signed──▶ signed ──sent──▶ transmitted ──settlement reported──▶ settled (unverified)
 *   reserved ──refused or signing failed──▶ released (not_signed)          only while no signature exists
 *   signed | transmitted ──any failure──▶ unresolved
 *   unresolved | settled ──a transaction consumed its authorization──▶ settled (verified)
 *   unresolved ──expired, and no transaction consumed it──▶ released (expired_unused)
 *   settled, unverified ──expired, and no transaction consumed it──▶ released (claim_false)
 *   any of these ──expired, and the RPC no longer holds its ledgers──▶ settled (unprovable, whole amount)
 *
 * Once a signature exists, budget returns only on proof from the chain, never on a seller's report: a
 * reported hash is a claim that counts as spent, and it can neither settle nor hide another payment.
 * Amounts are base units; they are summed as bigint and never converted between assets.
 */

export type ReservationState = "reserved" | "signed" | "transmitted" | "unresolved" | "settled" | "released";

/** Caps of one asset in a window, in base units. */
export interface WindowCap {
  readonly perCall: bigint;
  readonly total: bigint;
  readonly decimals: number;
}

/** Caps per token contract. */
export type WindowCaps = Readonly<Record<string, WindowCap>>;

/** Identifies a budget window and how to create it. */
export interface WindowSpec {
  readonly network: StellarNetwork;
  readonly payer: string;
  readonly name: string;
  readonly ttlMs: number;
  /** The caps currently configured. The caps that apply are the lower of these and the window's own. */
  readonly caps: WindowCaps;
  /** Start a fresh window when this one expires. */
  readonly autoRenew: boolean;
  /** Create the window when none is open. False for sessions that must be started explicitly. */
  readonly autoCreate: boolean;
}

export interface BudgetWindow {
  readonly id: string;
  readonly network: StellarNetwork;
  readonly payer: string;
  readonly name: string;
  readonly startedAt: number;
  readonly expiresAt: number;
  readonly endedAt: number | undefined;
  /** Caps stored when the window was created. A configuration change never raises them. */
  readonly caps: WindowCaps;
  readonly autoRenew: boolean;
}

export interface ReservationRequest {
  readonly callId: string;
  readonly scheme: SchemeName;
  /** Token contract. */
  readonly asset: string;
  readonly payTo: string;
  /** The paid resource, for the operator's records (URL, or URL plus tool name). */
  readonly resource: string;
  readonly amount: bigint;
  readonly idempotencyKey?: string | undefined;
}

export interface Reservation {
  readonly id: string;
  readonly windowId: string;
  readonly callId: string;
  readonly scheme: SchemeName;
  readonly asset: string;
  readonly payTo: string;
  readonly resource: string;
  readonly amount: bigint;
  readonly settledAmount: bigint | undefined;
  /** Whether the settlement was confirmed from the chain rather than reported by a seller. */
  readonly verified: boolean;
  readonly state: ReservationState;
  readonly releaseReason: ReleaseReason | undefined;
  readonly nonce: bigint | undefined;
  readonly expirationLedger: number | undefined;
  readonly signedAtLedger: number | undefined;
  readonly transaction: string | undefined;
  readonly idempotencyKey: string | undefined;
  /** Sanitized call result stored for idempotent replays. */
  readonly result: string | undefined;
  /** The RPC no longer holds the ledgers needed to prove what happened. */
  readonly awaitingProof: boolean;
  /**
   * The authorization expired and its outcome can no longer be proven either way: the reservation is
   * counted as spent at its whole amount and no longer reconciled.
   */
  readonly unprovable: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SignedProof {
  readonly nonce: bigint;
  readonly expirationLedger: number;
  /** The latest ledger when the authorization was signed: where the search for its transfer starts. */
  readonly signedAtLedger: number;
}

export interface Settlement {
  readonly transaction: string | null;
  readonly settledAmount: bigint;
  readonly verified: boolean;
}

/** Spent and pending base units of one asset in a window. */
export interface AssetUsage {
  readonly spent: bigint;
  readonly pending: bigint;
}

export interface WindowUsage {
  readonly assets: ReadonlyMap<string, AssetUsage>;
  readonly awaitingProof: number;
  /** Reservations released because a reported settlement had no transfer on chain. */
  readonly falseClaims: number;
}

/**
 * Durable budget state shared by every payment of one payer. Methods are synchronous so that the
 * signing guard can decide and reserve in one tick, with no other payment interleaving. Transition
 * methods return false when the reservation is not in a state the transition applies to (for example,
 * another process already reconciled it).
 */
export interface SpendLedger {
  /** The window that applies now: the open one, a renewed one, or a new one. */
  window(spec: WindowSpec, now?: number): BudgetWindow;
  /** Ends any open window of this name and starts a new one with the spec's caps. */
  startWindow(spec: WindowSpec, now?: number): BudgetWindow;
  endWindow(windowId: string, now?: number): boolean;
  listWindows(network: StellarNetwork, payer: string): BudgetWindow[];
  /**
   * Checks the per-call and session caps and records the reservation, atomically. Refuses with
   * `payment_per_call_cap_exceeded`, `payment_session_cap_exceeded`, `payment_session_expired`,
   * `payment_asset_not_permitted` or `payment_in_progress`.
   */
  reserve(spec: WindowSpec, request: ReservationRequest, now?: number): Reservation;
  markSigned(id: string, proof: SignedProof, now?: number): boolean;
  markTransmitted(id: string, now?: number): boolean;
  markUnresolved(id: string, now?: number): boolean;
  /** Records a settlement. An unverified claim never replaces a settlement verified on chain. */
  settle(id: string, settlement: Settlement, now?: number): boolean;
  /**
   * Counts an expired reservation whose outcome the chain can no longer prove as spent at its whole
   * amount, and stops reconciling it. Never applies to a verified settlement.
   */
  markUnprovable(id: string, now?: number): boolean;
  release(id: string, reason: ReleaseReason, now?: number): boolean;
  setAwaitingProof(id: string, awaiting: boolean, now?: number): boolean;
  storeResult(id: string, result: string, now?: number): boolean;
  get(id: string): Reservation | undefined;
  findByIdempotencyKey(windowId: string, key: string): Reservation | undefined;
  /** Reservations that still need signing, settlement or proof, across every window of the payer. */
  unfinished(network: StellarNetwork, payer: string): Reservation[];
  usage(windowId: string): WindowUsage;
  close(): void;
}

/** Where each transition may start. */
export const TRANSITIONS = {
  markSigned: ["reserved"],
  markTransmitted: ["signed"],
  markUnresolved: ["signed", "transmitted"],
  settle: ["signed", "transmitted", "unresolved", "settled"],
  markUnprovable: ["signed", "transmitted", "unresolved", "settled"],
} as const satisfies Record<string, readonly ReservationState[]>;

export const RELEASE_FROM: Readonly<Record<ReleaseReason, readonly ReservationState[]>> = {
  not_signed: ["reserved"],
  expired_unused: ["signed", "transmitted", "unresolved"],
  claim_false: ["settled"],
  forced: ["reserved", "signed", "transmitted", "unresolved", "settled"],
};

export const UNFINISHED_STATES: readonly ReservationState[] = [
  "reserved",
  "signed",
  "transmitted",
  "unresolved",
];

/** What `window()` must do with the currently open window, if any. */
export type WindowPlan =
  | { readonly action: "use"; readonly window: BudgetWindow }
  | { readonly action: "create"; readonly end: BudgetWindow | undefined };

export function planWindow(open: BudgetWindow | undefined, spec: WindowSpec, now: number): WindowPlan {
  if (open !== undefined && now < open.expiresAt) return { action: "use", window: open };
  if (open !== undefined && !open.autoRenew) {
    throw paymentError("payment_session_expired", {
      reason: `The budget session "${spec.name}" ended at ${new Date(open.expiresAt).toISOString()} and does not renew.`,
    });
  }
  if (open === undefined && !spec.autoCreate) {
    throw paymentError("payment_session_expired", {
      reason: `No budget session named "${spec.name}" is active; start one first.`,
    });
  }
  return { action: "create", end: open };
}

export function validateSpec(spec: WindowSpec): void {
  if (!Number.isSafeInteger(spec.ttlMs) || spec.ttlMs <= 0)
    throw new RangeError("ttlMs must be a positive integer");
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(spec.name)) {
    throw paymentError("payment_policy_invalid", {
      reason: "A session name is 1-64 letters, digits, dots, dashes or underscores.",
    });
  }
}

/** The caps that apply in a window: the lower of the window's stored caps and the current configuration. */
export function effectiveCaps(window: BudgetWindow, spec: WindowSpec, asset: string): WindowCap | undefined {
  const configured = spec.caps[asset];
  if (configured === undefined) return undefined;
  const stored = window.caps[asset];
  if (stored === undefined) return configured;
  return {
    perCall: minBigInt(stored.perCall, configured.perCall),
    total: minBigInt(stored.total, configured.total),
    decimals: configured.decimals,
  };
}

/**
 * Sums spent and pending per asset over a window's reservations. `carried` are the unfinished
 * reservations of the same session's earlier windows: an authorization signed just before a window
 * renews can still be settled after it, so its unproven amount stays pending in the new window until
 * the chain resolves it. Only their pending part counts; what they spent belongs to their own window.
 */
export function usageOf(
  reservations: Iterable<Reservation>,
  carried: Iterable<Reservation> = [],
): WindowUsage {
  const assets = new Map<string, { spent: bigint; pending: bigint }>();
  let awaitingProof = 0;
  let falseClaims = 0;
  for (const row of reservations) {
    if (row.awaitingProof) awaitingProof++;
    if (row.state === "released") {
      if (row.releaseReason === "claim_false") falseClaims++;
      continue;
    }
    const usage = assets.get(row.asset) ?? { spent: 0n, pending: 0n };
    if (row.state === "settled") {
      const settled = row.settledAmount ?? row.amount;
      usage.spent += settled;
      // An unverified upto settlement keeps its unproven remainder pending.
      if (!row.verified && row.amount > settled) usage.pending += row.amount - settled;
    } else {
      usage.pending += row.amount;
    }
    assets.set(row.asset, usage);
  }
  for (const row of carried) {
    const pending = carriedPending(row);
    if (pending <= 0n) continue;
    if (row.awaitingProof) awaitingProof++;
    const usage = assets.get(row.asset) ?? { spent: 0n, pending: 0n };
    usage.pending += pending;
    assets.set(row.asset, usage);
  }
  return { assets, awaitingProof, falseClaims };
}

/** The part of an earlier window's reservation that the chain has not resolved yet. */
export function carriedPending(row: Reservation): bigint {
  if (UNFINISHED_STATES.includes(row.state)) return row.amount;
  if (row.state === "settled" && !row.verified) {
    const settled = row.settledAmount ?? row.amount;
    return row.amount > settled ? row.amount - settled : 0n;
  }
  return 0n;
}

/**
 * Checks a reservation against the window's caps and the window's current usage. Throws the refusal;
 * returns nothing when the reservation fits.
 */
export function checkReservation(
  window: BudgetWindow,
  spec: WindowSpec,
  request: ReservationRequest,
  usage: WindowUsage,
): void {
  const caps = effectiveCaps(window, spec, request.asset);
  if (caps === undefined) {
    throw paymentError("payment_asset_not_permitted", {
      reason: "No budget is configured for this asset.",
    });
  }
  if (request.amount <= 0n) throw paymentError("payment_amount_not_permitted");
  const format = (value: bigint) => toDecimal(value, caps.decimals);
  if (request.amount > caps.perCall) {
    throw paymentError("payment_per_call_cap_exceeded", {
      reason: `The payment of ${format(request.amount)} is above the per-call cap of ${format(caps.perCall)}.`,
      details: { price: format(request.amount), cap: format(caps.perCall) },
    });
  }
  const { spent, pending } = usage.assets.get(request.asset) ?? { spent: 0n, pending: 0n };
  if (spent + pending + request.amount > caps.total) {
    const remaining = caps.total - spent - pending;
    throw paymentError("payment_session_cap_exceeded", {
      reason: `The payment of ${format(request.amount)} does not fit the session budget: ${format(remaining > 0n ? remaining : 0n)} of ${format(caps.total)} is left (${format(spent)} spent, ${format(pending)} pending).`,
      details: {
        price: format(request.amount),
        sessionCap: format(caps.total),
        spent: format(spent),
        pending: format(pending),
      },
    });
  }
}

/** Refusal for a key that is already in use in the window. */
export function idempotencyConflict(existing: Reservation) {
  let reason: string;
  if (existing.result !== undefined) {
    reason =
      "A call with this idempotency key already completed; read its stored result instead of paying again.";
  } else if (existing.state === "unresolved" || existing.state === "settled") {
    reason =
      "A call with this idempotency key sent a payment whose outcome awaits on-chain proof. Retry with the same key after its authorization expires: the retry checks the chain first, and pays again only if the earlier payment never moved money.";
  } else {
    reason = "A call with this idempotency key is still running or awaiting its outcome.";
  }
  return paymentError("payment_in_progress", { reason, callId: existing.callId });
}

/**
 * Whether a reservation that holds this idempotency key may give it up to a new call: when nothing
 * was signed, or when the chain proved that the signed authorization expired without moving money.
 */
export function keyReusable(existing: Reservation): boolean {
  if (existing.state !== "released") return false;
  switch (existing.releaseReason) {
    case "not_signed":
      return existing.result === undefined;
    case "expired_unused":
    case "claim_false":
      return true;
    case "forced":
    case undefined:
      return false;
  }
}
