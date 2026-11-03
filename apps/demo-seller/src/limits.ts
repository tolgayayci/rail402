/**
 * Limits on the payments the seller asks its facilitator about. A payment that has the right shape,
 * which anyone can copy from a 402, makes the seller call the facilitator, and the facilitator limits
 * the seller like any other caller, by its address. So the seller bounds those calls itself: per
 * client, and for all clients together at well under the facilitator's limit for one address.
 * Anonymous traffic then cannot use up the facilitator budget that the seller's buyers, and services
 * sharing its address, depend on.
 *
 * The count is taken in the resource servers' `beforeVerify` hook: after a payment was decoded and
 * matched to a paid route or tool, and before the facilitator is asked, in either payment flow. A
 * request that carries no payment, a header that does not decode, or a payment for a route or tool
 * that is not paid is never counted. A payment over a limit is refused with `rate_limited`, the code
 * the facilitator answers with when it limits a caller, and HTTP requests also get `Retry-After`.
 *
 * In-memory token buckets for one process; a restart refills them. A client is its address as Express
 * resolves it (`trust proxy`): an IPv4 address, or the /56 network of an IPv6 address.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isIPv4, isIPv6 } from "node:net";
import type { RequestHandler, Response } from "express";
import type { BeforeVerifyHook } from "@x402/core/server";

export interface PaidLimits {
  /** Payments from one client the seller asks the facilitator about per minute; also its burst. */
  readonly perClient: number;
  /** Payments from all clients together per minute; also their burst. */
  readonly global: number;
}

/**
 * The limits when none are configured. A payment costs the facilitator a verification and, when it is
 * valid, a settlement, so 120 a minute stay well under Rail402's default of 600 requests a minute for
 * one address.
 */
export const DEFAULT_PAID_LIMITS: PaidLimits = Object.freeze({ perClient: 60, global: 120 });

/** Clients held in memory; past this, the least recently seen one is forgotten. */
export const MAX_CLIENTS = 10_000;

/** The code a payment over a limit is refused with. */
export const RATE_LIMITED = "rate_limited";

/** The one key of the bucket every client shares. */
const ALL = "*";

/** The key every client address that is not an IP address shares, never one each. */
const UNPARSED = "unparsed";

type Clock = () => number;

/** What `beforeVerify` needs from the request a payment arrived with. */
interface RequestScope {
  readonly address: string;
  readonly response: Response;
}

/**
 * Token buckets under string keys, refilled at `perMinute` up to `perMinute` tokens, holding at most
 * `max` keys: the least recently used is dropped first. A dropped key starts again with a full bucket,
 * so the cap only matters for the per-client buckets, which the shared one bounds anyway.
 */
class Buckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly perMinute: number;
  private readonly max: number;
  private readonly now: Clock;

  constructor(perMinute: number, max: number, now: Clock) {
    this.perMinute = perMinute;
    this.max = max;
    this.now = now;
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Whole seconds until `key` holds a token; 0 when it does now. */
  wait(key: string): number {
    const missing = 1 - this.tokens(key, this.now());
    return missing <= 0 ? 0 : Math.max(1, Math.ceil((missing * 60) / this.perMinute));
  }

  take(key: string): void {
    const now = this.now();
    const tokens = this.tokens(key, now);
    // Deleted first, so the key moves to the end: the map stays in order of last use.
    this.buckets.delete(key);
    this.buckets.set(key, { tokens: tokens - 1, at: now });
    if (this.buckets.size > this.max) {
      const oldest = this.buckets.keys().next();
      if (oldest.done !== true) this.buckets.delete(oldest.value);
    }
  }

  private tokens(key: string, now: number): number {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return this.perMinute;
    return Math.min(this.perMinute, bucket.tokens + ((now - bucket.at) * this.perMinute) / 60_000);
  }
}

/**
 * The seller's limits. Mount `track` before the payment middleware and the MCP endpoint, and register
 * `beforeVerify` on every resource server:
 *
 * ```ts
 * const limits = new PaidRequestLimits(DEFAULT_PAID_LIMITS);
 * resourceServer.onBeforeVerify(limits.beforeVerify);
 * app.use(limits.track);
 * ```
 */
export class PaidRequestLimits {
  private readonly scope = new AsyncLocalStorage<RequestScope>();
  private readonly clientBuckets: Buckets;
  private readonly all: Buckets;

  constructor(limits: PaidLimits, now: Clock = Date.now) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new RangeError(`${name} must be a positive integer`);
    }
    this.clientBuckets = new Buckets(limits.perClient, MAX_CLIENTS, now);
    this.all = new Buckets(limits.global, 1, now);
  }

  /** Clients held in memory. */
  get clients(): number {
    return this.clientBuckets.size;
  }

  /**
   * Takes one payment from the client at `address` out of its own limit and the shared one. Returns 0
   * when it may go ahead, otherwise the seconds until it could.
   */
  admit(address: string): number {
    const client = clientKey(address);
    const wait = Math.max(this.clientBuckets.wait(client), this.all.wait(ALL));
    if (wait > 0) return wait;
    this.clientBuckets.take(client);
    this.all.take(ALL);
    return 0;
  }

  /** Express middleware: remembers which client each request comes from, for `beforeVerify`. */
  readonly track: RequestHandler = (req, res, next) => {
    this.scope.run({ address: req.ip ?? "", response: res }, next);
  };

  /** A resource server's hook: counts the payment, or refuses it with `rate_limited`. */
  readonly beforeVerify: BeforeVerifyHook = (context) => {
    const scope = this.scope.getStore();
    const wait = this.admit(scope?.address ?? "");
    if (wait === 0) return Promise.resolve();
    // An HTTP payment is answered on this request; a tool call's answer is a JSON-RPC result.
    const http = isRecord(context.transportContext) && "request" in context.transportContext;
    if (http && scope !== undefined && !scope.response.headersSent) {
      scope.response.setHeader("retry-after", String(wait));
    }
    return Promise.resolve({
      abort: true as const,
      reason: RATE_LIMITED,
      message: `Too many paid requests; retry in ${String(wait)} seconds.`,
    });
  };
}

/**
 * The key a client address is limited under: an IPv4 address, also when it is written as IPv6
 * (mapped, compatible or NAT64), or else the /56 network of an IPv6 address, the block one subscriber
 * is usually given. Anything else shares one key.
 */
function clientKey(address: string): string {
  const bare = address.trim().replace(/%.*$/, "");
  if (isIPv4(bare)) return bare;
  if (!isIPv6(bare)) return UNPARSED;
  const groups = ipv6Groups(bare);
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, , g5 = 0, g6 = 0, g7 = 0] = groups;
  const mapped = zeros(0, 5) && (g5 === 0xffff || g5 === 0);
  const nat64 = g0 === 0x64 && g1 === 0xff9b && zeros(2, 6);
  if (mapped || nat64) return [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join(".");
  return `${[g0, g1, g2, g3 & 0xff00].map((group) => group.toString(16)).join(":")}::/56`;
}

/** The eight 16-bit groups of an IPv6 address. */
function ipv6Groups(address: string): number[] {
  // The URL parser writes an IPv6 host in canonical form: lowercase hex groups, an embedded IPv4
  // address as two of them, and at most one `::`.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head = "", tail] = canonical.split("::");
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => parseInt(group, 16)));
  const front = parse(head);
  const back = tail === undefined ? [] : parse(tail);
  return [...front, ...Array<number>(Math.max(0, 8 - front.length - back.length)).fill(0), ...back];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
