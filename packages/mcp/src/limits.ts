/**
 * Per-process limits: a sliding-window rate limit per tool, and a gate that lets a fixed number of
 * paid calls run at once with a short, bounded queue behind them.
 */

export class RateLimiter {
  private readonly calls: number[] = [];
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Counts a call; false when the window already holds `limit` calls. */
  take(): boolean {
    const now = this.now();
    while (this.calls.length > 0 && (this.calls[0] ?? 0) <= now - this.windowMs) this.calls.shift();
    if (this.calls.length >= this.limit) return false;
    this.calls.push(now);
    return true;
  }
}

export class InflightGate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly concurrency: number;
  private readonly queueLimit: number;

  constructor(concurrency: number, queueLimit: number) {
    this.concurrency = concurrency;
    this.queueLimit = queueLimit;
  }

  /**
   * Waits for a slot. Resolves with a release function, or with undefined when the queue is full.
   * Rejects with the signal's reason when the caller gives up while waiting.
   */
  async acquire(signal?: AbortSignal): Promise<(() => void) | undefined> {
    signal?.throwIfAborted();
    if (this.running < this.concurrency) {
      this.running++;
      return this.releaser();
    }
    if (this.waiting.length >= this.queueLimit) return undefined;
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = this.waiting.indexOf(wake);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal?.reason as Error);
      };
      this.waiting.push(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      // The slot passes straight to the next waiter; otherwise it is freed.
      if (next === undefined) this.running--;
      else next();
    };
  }
}
