import { isIPv4, isIPv6 } from "node:net";

/** Per-client request limiting. `take` returns 0 when allowed, else seconds until a retry can succeed. */
export interface ClientRateLimiter {
  readonly enabled: boolean;
  take(key: string): number | Promise<number>;
  sweep(): void | Promise<void>;
}

/** Limits whose size depends on the bucket: per network, per key or per address. */
export interface KeyedRateLimiter {
  /** Takes one request for `key` under `perMinute`. Returns 0 when allowed, else seconds to wait. */
  takeLimit(key: string, perMinute: number): number | Promise<number>;
  sweep(): void | Promise<void>;
}

/**
 * The service-wide limit a request meets before its body is read: `take` charges a client address at
 * `RATE_LIMIT_PER_MINUTE`, `takeLimit` an access key at the size of its own bucket.
 */
export type CallerRateLimiter = ClientRateLimiter & KeyedRateLimiter;

/** A process-local `KeyedRateLimiter`: one token bucket per key, sized by the limit it is taken with. */
export class LocalKeyedRateLimiter implements KeyedRateLimiter {
  private readonly buckets = new Map<string, RateLimiter>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  takeLimit(key: string, perMinute: number): number {
    const id = `${key}\u0000${String(perMinute)}`;
    let bucket = this.buckets.get(id);
    if (bucket === undefined) this.buckets.set(id, (bucket = new RateLimiter(perMinute, this.now)));
    return bucket.take(key);
  }

  sweep(): void {
    for (const [id, bucket] of this.buckets) {
      bucket.sweep();
      if (bucket.empty) this.buckets.delete(id);
    }
  }
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

  /** Whether no bucket is held. */
  get empty(): boolean {
    return this.buckets.size === 0;
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

/** A process-local `CallerRateLimiter`: addresses at the limit it is built with, keys at the limit given. */
export class LocalCallerRateLimiter extends RateLimiter implements KeyedRateLimiter {
  private readonly keyed: LocalKeyedRateLimiter;

  constructor(perMinute: number, now: () => number = Date.now) {
    super(perMinute, now);
    this.keyed = new LocalKeyedRateLimiter(now);
  }

  takeLimit(key: string, perMinute: number): number {
    return this.keyed.takeLimit(key, perMinute);
  }

  override sweep(): void {
    super.sweep();
    this.keyed.sweep();
  }
}

/**
 * The key a client address is rate-limited under. An IPv4 address, or an IPv4 address mapped into
 * IPv6 (`::ffff:192.0.2.1`), is its own key. An IPv6 address is keyed by its /64 prefix: one
 * subscriber usually holds a whole /64 and can rotate through it freely. Anything else is kept as is.
 */
export function rateLimitKey(address: string): string {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIPv4(bare)) return bare;
  if (!isIPv6(bare)) return address;
  const groups = ipv6Groups(bare.toLowerCase());
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high = 0, low = 0] = groups.slice(6);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address, with `::` expanded and a dotted IPv4 tail converted. */
function ipv6Groups(address: string): number[] {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => parseInt(group, 16)));
  const front = parse(head);
  const back = tail === undefined ? [] : parse(tail);
  return [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
}
