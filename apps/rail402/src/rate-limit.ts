/** Per-client request limiting. `take` returns 0 when allowed, else seconds until a retry can succeed. */
export interface ClientRateLimiter {
  readonly enabled: boolean;
  take(key: string): number | Promise<number>;
  sweep(): void | Promise<void>;
}

/**
 * Token-bucket rate limiter for a single process (STORE=memory). With Postgres, the shared
 * PostgresRateLimiter applies one limit across every replica instead.
 */
export class RateLimiter implements ClientRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.capacity = perMinute;
    this.refillPerMs = perMinute / 60_000;
    this.now = now;
  }

  get enabled(): boolean {
    return this.capacity > 0;
  }

  /** Takes one token for `key`. Returns 0 when allowed, otherwise the seconds until a token frees up. */
  take(key: string): number {
    if (!this.enabled) return 0;
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs);
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / this.refillPerMs / 1_000);
  }

  /** Drops buckets that have refilled completely, bounding memory. */
  sweep(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs >= this.capacity)
        this.buckets.delete(key);
    }
  }
}
