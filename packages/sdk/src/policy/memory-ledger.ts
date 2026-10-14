import type { StellarNetwork } from "@rail402.dev/stellar";
import type { ReleaseReason } from "../events.ts";
import {
  RELEASE_FROM,
  TRANSITIONS,
  UNFINISHED_STATES,
  checkReservation,
  idempotencyConflict,
  keyReusable,
  planWindow,
  usageOf,
  validateSpec,
  type BudgetWindow,
  type Reservation,
  type ReservationRequest,
  type ReservationState,
  type Settlement,
  type SignedProof,
  type SpendLedger,
  type WindowSpec,
  type WindowUsage,
} from "./ledger.ts";

/**
 * A budget ledger held in memory: the SDK's default. It is safe for concurrent payments inside one
 * process (every check-and-reserve runs synchronously) and is lost when the process exits, so
 * long-running agents that restart should use the SQLite ledger instead.
 */
export class MemorySpendLedger implements SpendLedger {
  protected readonly windows = new Map<string, BudgetWindow>();
  protected readonly reservations = new Map<string, Reservation>();

  window(spec: WindowSpec, now = Date.now()): BudgetWindow {
    validateSpec(spec);
    const open = this.openWindow(spec);
    const plan = planWindow(open, spec, now);
    if (plan.action === "use") return plan.window;
    if (plan.end !== undefined) this.windows.set(plan.end.id, { ...plan.end, endedAt: now });
    return this.create(spec, now);
  }

  startWindow(spec: WindowSpec, now = Date.now()): BudgetWindow {
    validateSpec(spec);
    const open = this.openWindow(spec);
    if (open !== undefined) this.windows.set(open.id, { ...open, endedAt: now });
    return this.create(spec, now);
  }

  endWindow(windowId: string, now = Date.now()): boolean {
    const window = this.windows.get(windowId);
    if (window === undefined || window.endedAt !== undefined) return false;
    this.windows.set(windowId, { ...window, endedAt: now });
    return true;
  }

  listWindows(network: StellarNetwork, payer: string): BudgetWindow[] {
    return [...this.windows.values()]
      .filter((window) => window.network === network && window.payer === payer)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  reserve(spec: WindowSpec, request: ReservationRequest, now = Date.now()): Reservation {
    const window = this.window(spec, now);
    const key = request.idempotencyKey;
    if (key !== undefined) {
      const existing = this.findByIdempotencyKey(window.id, key);
      if (existing !== undefined) {
        if (!keyReusable(existing)) throw idempotencyConflict(existing);
        this.reservations.set(existing.id, { ...existing, idempotencyKey: undefined });
      }
    }
    checkReservation(window, spec, request, this.usage(window.id));
    const reservation: Reservation = {
      id: crypto.randomUUID(),
      windowId: window.id,
      callId: request.callId,
      scheme: request.scheme,
      asset: request.asset,
      payTo: request.payTo,
      resource: request.resource,
      amount: request.amount,
      settledAmount: undefined,
      verified: false,
      state: "reserved",
      releaseReason: undefined,
      nonce: undefined,
      expirationLedger: undefined,
      signedAtLedger: undefined,
      transaction: undefined,
      idempotencyKey: key,
      result: undefined,
      awaitingProof: false,
      unprovable: false,
      createdAt: now,
      updatedAt: now,
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  markSigned(id: string, proof: SignedProof, now = Date.now()): boolean {
    return this.update(id, TRANSITIONS.markSigned, now, {
      state: "signed",
      nonce: proof.nonce,
      expirationLedger: proof.expirationLedger,
      signedAtLedger: proof.signedAtLedger,
    });
  }

  markTransmitted(id: string, now = Date.now()): boolean {
    return this.update(id, TRANSITIONS.markTransmitted, now, { state: "transmitted" });
  }

  markUnresolved(id: string, now = Date.now()): boolean {
    return this.update(id, TRANSITIONS.markUnresolved, now, { state: "unresolved" });
  }

  settle(id: string, settlement: Settlement, now = Date.now()): boolean {
    const current = this.reservations.get(id);
    if (current === undefined || current.unprovable) return false;
    // A claim never replaces a settlement the chain confirmed.
    if (current.verified && !settlement.verified) return false;
    return this.update(id, TRANSITIONS.settle, now, {
      state: "settled",
      settledAmount: settlement.settledAmount,
      verified: settlement.verified || current.verified,
      transaction: settlement.transaction ?? current.transaction,
      awaitingProof: false,
    });
  }

  markUnprovable(id: string, now = Date.now()): boolean {
    const current = this.reservations.get(id);
    if (current === undefined || current.verified) return false;
    return this.update(id, TRANSITIONS.markUnprovable, now, {
      state: "settled",
      settledAmount: current.amount,
      unprovable: true,
      awaitingProof: false,
    });
  }

  release(id: string, reason: ReleaseReason, now = Date.now()): boolean {
    const current = this.reservations.get(id);
    if (reason === "forced" && current?.state === "settled" && current.verified) return false;
    return this.update(id, RELEASE_FROM[reason], now, {
      state: "released",
      releaseReason: reason,
      awaitingProof: false,
    });
  }

  setAwaitingProof(id: string, awaiting: boolean, now = Date.now()): boolean {
    const current = this.reservations.get(id);
    if (current === undefined) return false;
    this.reservations.set(id, { ...current, awaitingProof: awaiting, updatedAt: now });
    return true;
  }

  storeResult(id: string, result: string, now = Date.now()): boolean {
    const current = this.reservations.get(id);
    if (current === undefined) return false;
    this.reservations.set(id, { ...current, result, updatedAt: now });
    return true;
  }

  get(id: string): Reservation | undefined {
    return this.reservations.get(id);
  }

  findByIdempotencyKey(windowId: string, key: string): Reservation | undefined {
    for (const row of this.reservations.values()) {
      if (row.windowId === windowId && row.idempotencyKey === key) return row;
    }
    return undefined;
  }

  unfinished(network: StellarNetwork, payer: string): Reservation[] {
    return [...this.reservations.values()]
      .filter((row) => {
        const window = this.windows.get(row.windowId);
        if (window?.network !== network || window.payer !== payer) return false;
        return (
          UNFINISHED_STATES.includes(row.state) ||
          (row.state === "settled" && !row.verified && !row.unprovable)
        );
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  usage(windowId: string): WindowUsage {
    const window = this.windows.get(windowId);
    const rows = [...this.reservations.values()];
    const earlier = (row: Reservation) => {
      if (row.windowId === windowId || window === undefined) return false;
      const other = this.windows.get(row.windowId);
      return (
        other !== undefined &&
        other.network === window.network &&
        other.payer === window.payer &&
        other.name === window.name &&
        other.startedAt <= window.startedAt
      );
    };
    return usageOf(
      rows.filter((row) => row.windowId === windowId),
      rows.filter(earlier),
    );
  }

  close(): void {
    // Nothing to release.
  }

  private openWindow(spec: WindowSpec): BudgetWindow | undefined {
    for (const window of this.windows.values()) {
      if (
        window.endedAt === undefined &&
        window.network === spec.network &&
        window.payer === spec.payer &&
        window.name === spec.name
      ) {
        return window;
      }
    }
    return undefined;
  }

  private create(spec: WindowSpec, now: number): BudgetWindow {
    const window: BudgetWindow = {
      id: crypto.randomUUID(),
      network: spec.network,
      payer: spec.payer,
      name: spec.name,
      startedAt: now,
      expiresAt: now + spec.ttlMs,
      endedAt: undefined,
      caps: spec.caps,
      autoRenew: spec.autoRenew,
    };
    this.windows.set(window.id, window);
    return window;
  }

  private update(
    id: string,
    from: readonly ReservationState[],
    now: number,
    changes: Partial<Reservation>,
  ): boolean {
    const current = this.reservations.get(id);
    if (current === undefined || !from.includes(current.state)) return false;
    this.reservations.set(id, { ...current, ...changes, updatedAt: now });
    return true;
  }
}
