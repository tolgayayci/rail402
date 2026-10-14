import { z } from "zod";
import { isStellarNetwork, type StellarNetwork } from "@rail402.dev/stellar";
import { paymentError, type PaymentError } from "../codes.ts";
import type { ReleaseReason } from "../events.ts";
import {
  UNFINISHED_STATES,
  carriedPending,
  type BudgetWindow,
  type Reservation,
  type ReservationRequest,
  type Settlement,
  type SignedProof,
  type SpendLedger,
  type WindowSpec,
  type WindowUsage,
} from "./ledger.ts";
import { MemorySpendLedger } from "./memory-ledger.ts";

/** A synchronous string store; the browser's `localStorage` and `sessionStorage` fit. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StorageLedgerOptions {
  /** Names the stored record (`<prefix>:v1`): one ledger per prefix, for example per payer. */
  readonly prefix: string;
}

/** Ended windows whose payments are all resolved are dropped this long after they ended. */
export const STORAGE_LEDGER_RETENTION_MS = 7 * 24 * 3_600_000;

const VERSION = 1;

/**
 * A budget ledger persisted in a synchronous key-value store, for pages where the SQLite ledger does
 * not exist: the browser's `localStorage`. It keeps the memory ledger's rules and writes its whole
 * state after every change, so a reload neither resets the budget nor forgets a payment awaiting
 * proof. Amounts are stored as decimal strings.
 *
 * - Before every operation the stored record is read again, so a change made through another
 *   instance (another tab, or a reset) is seen. Two instances must not run payments at the same time;
 *   a page holds one per payer (for example under a Web Lock).
 * - A change that cannot be saved (the store is full or blocked) is undone and refused with
 *   `payment_ledger_unavailable`.
 * - A stored record that cannot be read is never discarded silently: every operation is refused with
 *   `payment_ledger_unavailable` until `reset()` deletes it.
 * - Windows that ended more than `STORAGE_LEDGER_RETENTION_MS` before the latest change, and whose
 *   payments are all resolved, are dropped so the record stays bounded.
 */
export class StorageSpendLedger implements SpendLedger {
  readonly #store: KeyValueStore;
  readonly #key: string;
  #state = new LedgerState();
  /** The record as last read or written; null when nothing is stored. */
  #persisted: string | null = null;
  #corrupt = false;

  constructor(store: KeyValueStore, options: StorageLedgerOptions) {
    if (typeof options.prefix !== "string" || options.prefix.trim() === "") {
      throw new TypeError("a storage ledger needs a non-empty prefix");
    }
    this.#store = store;
    this.#key = `${options.prefix}:v${String(VERSION)}`;
  }

  /** The store key holding the record. */
  get key(): string {
    return this.#key;
  }

  /** Whether the stored record could not be read; operations are refused until `reset()`. */
  get corrupt(): boolean {
    this.#sync(false);
    return this.#corrupt;
  }

  /** Deletes the stored record and starts empty. Budget and pending payments are forgotten. */
  reset(): void {
    try {
      this.#store.removeItem(this.#key);
    } catch {
      throw unavailable("The budget ledger could not be cleared from browser storage.");
    }
    this.#state = new LedgerState();
    this.#persisted = null;
    this.#corrupt = false;
  }

  window(spec: WindowSpec, now?: number): BudgetWindow {
    return this.#change((state) => state.window(spec, now));
  }

  startWindow(spec: WindowSpec, now?: number): BudgetWindow {
    return this.#change((state) => state.startWindow(spec, now));
  }

  endWindow(windowId: string, now?: number): boolean {
    return this.#change((state) => state.endWindow(windowId, now));
  }

  listWindows(network: StellarNetwork, payer: string): BudgetWindow[] {
    return this.#read((state) => state.listWindows(network, payer));
  }

  reserve(spec: WindowSpec, request: ReservationRequest, now?: number): Reservation {
    return this.#change((state) => state.reserve(spec, request, now));
  }

  markSigned(id: string, proof: SignedProof, now?: number): boolean {
    return this.#change((state) => state.markSigned(id, proof, now));
  }

  markTransmitted(id: string, now?: number): boolean {
    return this.#change((state) => state.markTransmitted(id, now));
  }

  markUnresolved(id: string, now?: number): boolean {
    return this.#change((state) => state.markUnresolved(id, now));
  }

  settle(id: string, settlement: Settlement, now?: number): boolean {
    return this.#change((state) => state.settle(id, settlement, now));
  }

  markUnprovable(id: string, now?: number): boolean {
    return this.#change((state) => state.markUnprovable(id, now));
  }

  release(id: string, reason: ReleaseReason, now?: number): boolean {
    return this.#change((state) => state.release(id, reason, now));
  }

  setAwaitingProof(id: string, awaiting: boolean, now?: number): boolean {
    return this.#change((state) => state.setAwaitingProof(id, awaiting, now));
  }

  storeResult(id: string, result: string, now?: number): boolean {
    return this.#change((state) => state.storeResult(id, result, now));
  }

  get(id: string): Reservation | undefined {
    return this.#read((state) => state.get(id));
  }

  findByIdempotencyKey(windowId: string, key: string): Reservation | undefined {
    return this.#read((state) => state.findByIdempotencyKey(windowId, key));
  }

  unfinished(network: StellarNetwork, payer: string): Reservation[] {
    return this.#read((state) => state.unfinished(network, payer));
  }

  usage(windowId: string): WindowUsage {
    return this.#read((state) => state.usage(windowId));
  }

  close(): void {
    // Every change is already saved.
  }

  #read<T>(operation: (state: LedgerState) => T): T {
    this.#sync(true);
    return operation(this.#state);
  }

  /**
   * Runs a change and saves the result. The memory ledger may change state before it refuses (a
   * window opens, then the cap check fails), so the state is saved whether or not the change threw.
   */
  #change<T>(operation: (state: LedgerState) => T): T {
    this.#sync(true);
    let result: T | undefined;
    let failure: { readonly error: unknown } | undefined;
    try {
      result = operation(this.#state);
    } catch (error) {
      failure = { error };
    }
    this.#save();
    if (failure !== undefined) throw failure.error;
    return result as T;
  }

  /** Loads the stored record when it changed since it was last read or written. */
  #sync(refuseCorrupt: boolean): void {
    let stored: string | null;
    try {
      stored = this.#store.getItem(this.#key);
    } catch {
      if (refuseCorrupt) throw unavailable("Browser storage cannot be read.");
      return;
    }
    if (stored !== this.#persisted) {
      if (stored === null) {
        this.#state = new LedgerState();
        this.#corrupt = false;
      } else {
        const state = LedgerState.decode(stored);
        this.#corrupt = state === undefined;
        this.#state = state ?? new LedgerState();
      }
      this.#persisted = stored;
    }
    if (this.#corrupt && refuseCorrupt) {
      throw unavailable(
        "The stored budget ledger cannot be read; payments stay disabled until the ledger is reset.",
      );
    }
  }

  #save(): void {
    this.#state.prune(STORAGE_LEDGER_RETENTION_MS);
    const record = this.#state.encode();
    if (record === this.#persisted) return;
    try {
      this.#store.setItem(this.#key, record);
    } catch {
      // Undo the change: what is in memory must never run ahead of what a reload would see.
      this.#state =
        this.#persisted === null
          ? new LedgerState()
          : (LedgerState.decode(this.#persisted) ?? new LedgerState());
      throw unavailable("The budget ledger could not be saved to browser storage (it may be full).");
    }
    this.#persisted = record;
  }
}

function unavailable(reason: string): PaymentError {
  return paymentError("payment_ledger_unavailable", { reason });
}

const bigintText = z
  .string()
  .regex(/^-?(?:0|[1-9][0-9]{0,77})$/)
  .transform((value) => BigInt(value));
const optional = <T extends z.ZodType>(schema: T) => schema.optional();
const time = z.number().int().nonnegative();

const windowRecord = z.strictObject({
  id: z.string().min(1),
  network: z.string().refine(isStellarNetwork),
  payer: z.string().min(1),
  name: z.string().min(1),
  startedAt: time,
  expiresAt: time,
  endedAt: optional(time),
  caps: z.record(
    z.string(),
    z.strictObject({ perCall: bigintText, total: bigintText, decimals: z.number().int().min(0).max(38) }),
  ),
  autoRenew: z.boolean(),
});

const reservationRecord = z.strictObject({
  id: z.string().min(1),
  windowId: z.string().min(1),
  callId: z.string(),
  scheme: z.enum(["exact", "upto"]),
  asset: z.string(),
  payTo: z.string(),
  resource: z.string(),
  amount: bigintText,
  settledAmount: optional(bigintText),
  verified: z.boolean(),
  state: z.enum(["reserved", "signed", "transmitted", "unresolved", "settled", "released"]),
  releaseReason: optional(z.enum(["not_signed", "expired_unused", "claim_false", "forced"])),
  nonce: optional(bigintText),
  expirationLedger: optional(z.number().int()),
  signedAtLedger: optional(z.number().int()),
  transaction: optional(z.string()),
  idempotencyKey: optional(z.string()),
  result: optional(z.string()),
  awaitingProof: z.boolean(),
  unprovable: z.boolean(),
  createdAt: time,
  updatedAt: time,
});

const ledgerRecord = z.strictObject({
  v: z.literal(VERSION),
  windows: z.array(windowRecord),
  reservations: z.array(reservationRecord),
});

/** The memory ledger's state, with a codec for storage and pruning of resolved history. */
class LedgerState extends MemorySpendLedger {
  /** The state a stored record holds, or undefined when it is not a valid record. */
  static decode(text: string): LedgerState | undefined {
    let parsed: z.infer<typeof ledgerRecord>;
    try {
      parsed = ledgerRecord.parse(JSON.parse(text));
    } catch {
      return undefined;
    }
    const state = new LedgerState();
    for (const window of parsed.windows) {
      state.windows.set(window.id, {
        ...window,
        network: window.network,
        endedAt: window.endedAt,
      });
    }
    for (const row of parsed.reservations) {
      if (!state.windows.has(row.windowId)) return undefined;
      state.reservations.set(row.id, {
        ...row,
        settledAmount: row.settledAmount,
        releaseReason: row.releaseReason,
        nonce: row.nonce,
        expirationLedger: row.expirationLedger,
        signedAtLedger: row.signedAtLedger,
        transaction: row.transaction,
        idempotencyKey: row.idempotencyKey,
        result: row.result,
      });
    }
    return state;
  }

  encode(): string {
    const text = (value: bigint | undefined) => (value === undefined ? undefined : value.toString());
    return JSON.stringify({
      v: VERSION,
      windows: [...this.windows.values()].map((window) => ({
        ...window,
        caps: Object.fromEntries(
          Object.entries(window.caps).map(([asset, cap]) => [
            asset,
            { perCall: cap.perCall.toString(), total: cap.total.toString(), decimals: cap.decimals },
          ]),
        ),
      })),
      reservations: [...this.reservations.values()].map((row) => ({
        ...row,
        amount: row.amount.toString(),
        settledAmount: text(row.settledAmount),
        nonce: text(row.nonce),
      })),
    });
  }

  /** Drops windows that ended long enough ago and hold nothing the chain has yet to resolve. */
  prune(retentionMs: number): void {
    let latest = 0;
    for (const window of this.windows.values())
      latest = Math.max(latest, window.startedAt, window.endedAt ?? 0);
    for (const row of this.reservations.values()) latest = Math.max(latest, row.updatedAt);
    const rowsOf = new Map<string, Reservation[]>();
    for (const row of this.reservations.values()) {
      const rows = rowsOf.get(row.windowId) ?? [];
      rows.push(row);
      rowsOf.set(row.windowId, rows);
    }
    for (const window of [...this.windows.values()]) {
      if (window.endedAt === undefined || latest - window.endedAt < retentionMs) continue;
      const rows = rowsOf.get(window.id) ?? [];
      const open = rows.some(
        (row) =>
          UNFINISHED_STATES.includes(row.state) ||
          (row.state === "settled" && !row.verified && !row.unprovable) ||
          carriedPending(row) > 0n ||
          row.awaitingProof,
      );
      if (open) continue;
      for (const row of rows) this.reservations.delete(row.id);
      this.windows.delete(window.id);
    }
  }
}
