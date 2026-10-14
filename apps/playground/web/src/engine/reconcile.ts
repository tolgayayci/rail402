/**
 * The background reconciliation loop. While payments wait for chain proof and no run is active, the
 * engine asks the buyer to reconcile every 20 seconds, when the page regains focus, and once at start.
 * Proofs and releases arrive as SDK events and are reported on the runs they belong to.
 */

export const RECONCILE_INTERVAL_MS = 20_000;

export interface Timers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const SYSTEM_TIMERS: Timers = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => {
    globalThis.clearInterval(handle as number | undefined);
  },
};

export interface ReconcileLoopOptions {
  /** One reconciliation round (and whatever refresh goes with it). */
  readonly tick: () => Promise<void>;
  /** Whether a round should run now. */
  readonly due: () => boolean;
  readonly intervalMs?: number;
  readonly timers?: Timers;
  /** Where `focus` and `visibilitychange` are observed; default the page's window. */
  readonly focus?: EventTarget | undefined;
}

export class ReconcileLoop {
  readonly #options: ReconcileLoopOptions;
  #handle: unknown;
  #running = false;
  readonly #onFocus = () => {
    void this.poke();
  };

  constructor(options: ReconcileLoopOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#handle !== undefined) return;
    const timers = this.#options.timers ?? SYSTEM_TIMERS;
    this.#handle = timers.setInterval(this.#onFocus, this.#options.intervalMs ?? RECONCILE_INTERVAL_MS);
    const focus = this.#options.focus ?? (globalThis as { window?: EventTarget }).window;
    focus?.addEventListener("focus", this.#onFocus);
    focus?.addEventListener("visibilitychange", this.#onFocus);
    void this.poke();
  }

  stop(): void {
    if (this.#handle === undefined) return;
    (this.#options.timers ?? SYSTEM_TIMERS).clearInterval(this.#handle);
    this.#handle = undefined;
    const focus = this.#options.focus ?? (globalThis as { window?: EventTarget }).window;
    focus?.removeEventListener("focus", this.#onFocus);
    focus?.removeEventListener("visibilitychange", this.#onFocus);
  }

  /** Runs one round now when one is due and none is running. */
  async poke(): Promise<void> {
    if (this.#running || !this.#options.due()) return;
    this.#running = true;
    try {
      await this.#options.tick();
    } catch {
      // The tick reports its own errors; the loop keeps going.
    } finally {
      this.#running = false;
    }
  }
}
