import { isIPv4, isIPv6 } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { ServerContext } from "./http.ts";

/**
 * In-memory abuse limits for one server process: token buckets, in-flight gates and a daily byte
 * budget. The Playground runs as one replica and keeps no state, so a restart resets them; that is
 * acceptable for limits whose purpose is to stop bursts, not to bill.
 */

export type Clock = () => number;

/**
 * Token buckets under string keys. `take` returns 0 when a token was taken, otherwise the whole
 * seconds until one frees up (for `Retry-After`).
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: Clock;

  /**
   * @param perMinute - Sustained rate.
   * @param burst - Bucket size; the per-minute rate when omitted.
   */
  constructor(perMinute: number, burst: number = perMinute, now: Clock = Date.now) {
    this.capacity = Math.max(1, burst);
    this.refillPerMs = perMinute / 60_000;
    this.now = now;
  }

  /** Seconds until `key` could take a token, without taking one; 0 when it can now. */
  peek(key: string): number {
    const tokens = this.tokensOf(key, this.now());
    return tokens >= 1 ? 0 : this.wait(tokens);
  }

  take(key: string): number {
    const now = this.now();
    const tokens = this.tokensOf(key, now);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedAt: now });
      return this.wait(tokens);
    }
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return 0;
  }

  /** Returns a token taken by `take`, for a request refused by a later check before any work. */
  refund(key: string): void {
    const bucket = this.buckets.get(key);
    if (bucket !== undefined) bucket.tokens = Math.min(this.capacity, bucket.tokens + 1);
  }

  /** Drops buckets that have refilled completely, bounding memory. */
  sweep(): void {
    const now = this.now();
    for (const key of [...this.buckets.keys()]) {
      if (this.tokensOf(key, now) >= this.capacity) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  private tokensOf(key: string, now: number): number {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return this.capacity;
    return Math.min(this.capacity, bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs);
  }

  private wait(tokens: number): number {
    return Math.max(1, Math.ceil((1 - tokens) / this.refillPerMs / 1_000));
  }
}

/** Counts work in flight under string keys, up to a limit per key. */
export class Gate {
  private readonly counts = new Map<string, number>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Takes a slot; returns its release (idempotent), or undefined when the key is full. */
  enter(key: string): (() => void) | undefined {
    const count = this.counts.get(key) ?? 0;
    if (count >= this.limit) return undefined;
    this.counts.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.counts.get(key) ?? 1) - 1;
      if (left <= 0) this.counts.delete(key);
      else this.counts.set(key, left);
    };
  }

  inFlight(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

const DAY_MS = 86_400_000;

/** Bytes per key per UTC day. */
export class DailyBudget {
  private used = new Map<string, number>();
  private day: number;
  private readonly limit: number;
  private readonly now: Clock;

  constructor(limit: number, now: Clock = Date.now) {
    this.limit = limit;
    this.now = now;
    this.day = Math.floor(now() / DAY_MS);
  }

  /** 0 while `key` has budget left, else the seconds until the next UTC day. */
  check(key: string): number {
    this.roll();
    if ((this.used.get(key) ?? 0) < this.limit) return 0;
    return Math.max(1, Math.ceil(((this.day + 1) * DAY_MS - this.now()) / 1_000));
  }

  add(key: string, bytes: number): void {
    this.roll();
    this.used.set(key, (this.used.get(key) ?? 0) + bytes);
  }

  private roll(): void {
    const day = Math.floor(this.now() / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.used = new Map();
    }
  }
}

/** The key one bucket is shared under by every client. */
export const GLOBAL = "*";

/** The key every address that cannot be parsed shares: one bucket for all of them, never one each. */
export const UNPARSED = "unparsed";

/**
 * The most of a global pool one network may hold: an eighth, or the per-client limit when that is
 * larger. A network is an IPv4 address or an IPv6 /48, so a client holding many IPv6 prefixes cannot
 * use up a pool every other visitor shares.
 */
export const FAIR_SHARE_DIVISOR = 8;

/** A network's share of a global pool of `global`, never below the per-client limit `perClient`. */
export function fairShare(global: number, perClient: number): number {
  return Math.max(1, Math.min(global, Math.max(perClient, Math.floor(global / FAIR_SHARE_DIVISOR))));
}

/**
 * A global rate shared by every client, of which each network may take at most its fair share.
 * `take` returns 0 when a token was taken from both, otherwise the seconds until one frees up.
 */
export class SharedRate {
  private readonly global: RateLimiter;
  private readonly network: RateLimiter;

  constructor(perMinute: number, perClient: number, now: Clock = Date.now) {
    const share = fairShare(perMinute, perClient);
    this.global = new RateLimiter(perMinute, perMinute, now);
    this.network = new RateLimiter(share, share, now);
  }

  take(network: string): number {
    const own = this.network.take(network);
    if (own > 0) return own;
    const all = this.global.take(GLOBAL);
    if (all > 0) {
      this.network.refund(network);
      return all;
    }
    return 0;
  }

  refund(network: string): void {
    this.network.refund(network);
    this.global.refund(GLOBAL);
  }

  sweep(): void {
    this.network.sweep();
    this.global.sweep();
  }
}

/**
 * Rates under string keys (destination hosts) shared by every client, of which each network may take
 * at most its fair share per key. A host's budget then cannot be used up from one network.
 */
export class KeyedSharedRate {
  private readonly all: RateLimiter;
  private readonly perNetwork: RateLimiter;

  constructor(perMinute: number, perClient: number, now: Clock = Date.now) {
    const share = fairShare(perMinute, perClient);
    this.all = new RateLimiter(perMinute, perMinute, now);
    this.perNetwork = new RateLimiter(share, share, now);
  }

  take(key: string, network: string): number {
    const own = this.perNetwork.take(`${key} ${network}`);
    if (own > 0) return own;
    const all = this.all.take(key);
    if (all > 0) {
      this.perNetwork.refund(`${key} ${network}`);
      return all;
    }
    return 0;
  }

  refund(key: string, network: string): void {
    this.perNetwork.refund(`${key} ${network}`);
    this.all.refund(key);
  }

  sweep(): void {
    this.perNetwork.sweep();
    this.all.sweep();
  }
}

/** Global in-flight slots, of which each network may hold at most its fair share. */
export class SharedGate {
  private readonly global: Gate;
  private readonly network: Gate;

  constructor(limit: number, perClient: number) {
    this.global = new Gate(limit);
    this.network = new Gate(fairShare(limit, perClient));
  }

  /** Takes a slot; returns its release (idempotent), or undefined when the network or the pool is full. */
  enter(network: string): (() => void) | undefined {
    const own = this.network.enter(network);
    if (own === undefined) return undefined;
    const all = this.global.enter(GLOBAL);
    if (all === undefined) {
      own();
      return undefined;
    }
    return () => {
      all();
      own();
    };
  }

  inFlight(): number {
    return this.global.inFlight(GLOBAL);
  }
}

/**
 * A client address without brackets, zone or port: `1.2.3.4:5678` and `[2001:db8::1]:443` (as some
 * proxies forward them) are the addresses they name. Undefined when it is not an IP address.
 */
function bareAddress(address: string): string | undefined {
  let text = address.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketed !== null) text = bracketed[1] ?? "";
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(text)) text = text.slice(0, text.lastIndexOf(":"));
  text = text.replace(/%.*$/, "");
  if (isIPv4(text) || isIPv6(text)) return text;
  return undefined;
}

/** The IPv4 address an IPv6 address maps, when it is `::ffff:a.b.c.d`. */
function mappedIPv4(groups: readonly number[]): string | undefined {
  if (!groups.slice(0, 5).every((group) => group === 0) || groups[5] !== 0xffff) return undefined;
  const [high = 0, low = 0] = groups.slice(6);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** The first `bits` (a multiple of 8) of an IPv6 address, as `2001:db8:1200::/40`. */
function ipv6Prefix(groups: readonly number[], bits: number): string {
  const kept = groups.map((group, index) => {
    const start = index * 16;
    if (start >= bits) return 0;
    if (start + 16 <= bits) return group;
    return group & (0xffff << (16 - (bits - start)));
  });
  const head = kept.slice(0, Math.ceil(bits / 16));
  return `${head.map((group) => group.toString(16)).join(":")}::/${String(bits)}`;
}

/**
 * The key a client address is limited under. An IPv4 address, or one mapped into IPv6, is its own
 * key. An IPv6 address is keyed by its /56, the block one subscriber is usually given. An address
 * with a port is the address; anything that is not an IP address shares one key.
 */
export function clientKey(address: string): string {
  const bare = bareAddress(address);
  if (bare === undefined) return UNPARSED;
  if (isIPv4(bare)) return bare;
  const groups = ipv6Groups(bare.toLowerCase());
  return mappedIPv4(groups) ?? ipv6Prefix(groups, 56);
}

/**
 * The network a client address belongs to, for fair shares of global pools: an IPv4 address, or an
 * IPv6 /48. Anything that is not an IP address shares one key.
 */
export function networkKey(address: string): string {
  const bare = bareAddress(address);
  if (bare === undefined) return UNPARSED;
  if (isIPv4(bare)) return bare;
  const groups = ipv6Groups(bare.toLowerCase());
  return mappedIPv4(groups) ?? ipv6Prefix(groups, 48);
}

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
  return [...front, ...Array<number>(Math.max(0, 8 - front.length - back.length)).fill(0), ...back];
}

/**
 * The client address: from X-Forwarded-For when the server sits behind `trustedHops` proxies that
 * append to it (the entry the outermost trusted proxy saw), else the socket's peer.
 */
export function clientAddress(c: ServerContext, trustedHops: number): string {
  if (trustedHops > 0) {
    const forwarded = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const address = forwarded[forwarded.length - trustedHops];
    if (address !== undefined) return address;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
