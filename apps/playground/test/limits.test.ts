import { describe, expect, it } from "vitest";
import {
  DailyBudget,
  Gate,
  RateLimiter,
  KeyedSharedRate,
  SharedGate,
  SharedRate,
  UNPARSED,
  clientKey,
  fairShare,
  networkKey,
} from "../src/limits.ts";
import { IpHasher } from "../src/log.ts";

describe("rate limiter", () => {
  it("allows a burst, then refills at the per-minute rate", () => {
    let now = 0;
    const limiter = new RateLimiter(60, 3, () => now);
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([0, 0, 0]);
    expect(limiter.take("a")).toBe(1);
    expect(limiter.take("b")).toBe(0);
    now += 1_000;
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(1);
  });

  it("reports the seconds until a token frees up", () => {
    let now = 0;
    const limiter = new RateLimiter(6, 1, () => now);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(10);
    expect(limiter.peek("a")).toBe(10);
    now += 9_000;
    expect(limiter.peek("a")).toBe(1);
  });

  it("refunds a token and sweeps refilled buckets", () => {
    let now = 0;
    const limiter = new RateLimiter(60, 1, () => now);
    limiter.take("a");
    limiter.refund("a");
    expect(limiter.take("a")).toBe(0);
    expect(limiter.size).toBe(1);
    now += 60_000;
    limiter.sweep();
    expect(limiter.size).toBe(0);
  });
});

describe("gate", () => {
  it("bounds work in flight per key and releases once", () => {
    const gate = new Gate(2);
    const first = gate.enter("a");
    const second = gate.enter("a");
    expect(gate.enter("a")).toBeUndefined();
    expect(gate.enter("b")).toBeDefined();
    first?.();
    first?.();
    expect(gate.inFlight("a")).toBe(1);
    expect(gate.enter("a")).toBeDefined();
    second?.();
  });
});

describe("fair shares", () => {
  it("gives a network an eighth of a pool, never less than the per-client limit", () => {
    expect(fairShare(120, 20)).toBe(20);
    expect(fairShare(240, 10)).toBe(30);
    expect(fairShare(4, 10)).toBe(4);
    expect(fairShare(3, 0)).toBe(1);
  });

  it("refuses a network past its share while others still draw on the pool", () => {
    const now = () => 0;
    const pool = new SharedRate(16, 1, now);
    expect([pool.take("a"), pool.take("a")]).toEqual([0, 0]);
    expect(pool.take("a")).toBeGreaterThan(0);
    for (let index = 0; index < 14; index++) expect(pool.take(`n${String(index)}`)).toBe(0);
    expect(pool.take("b")).toBeGreaterThan(0);
    pool.refund("a");
    expect(pool.take("c")).toBe(0);
  });

  it("shares a host's budget across networks, each with at most its share of that host", () => {
    const now = () => 0;
    const hosts = new KeyedSharedRate(16, 1, now);
    expect([hosts.take("seller", "a"), hosts.take("seller", "a")]).toEqual([0, 0]);
    expect(hosts.take("seller", "a")).toBeGreaterThan(0);
    // Another host is a budget of its own; another network still draws on this one.
    expect(hosts.take("other", "a")).toBe(0);
    for (let index = 0; index < 14; index++) expect(hosts.take("seller", `n${String(index)}`)).toBe(0);
    expect(hosts.take("seller", "b")).toBeGreaterThan(0);
    hosts.refund("seller", "a");
    expect(hosts.take("seller", "c")).toBe(0);
  });

  it("bounds a network's slots in flight within the global gate", () => {
    const gate = new SharedGate(16, 1);
    const held = [gate.enter("a"), gate.enter("a")];
    expect(gate.enter("a")).toBeUndefined();
    expect(gate.enter("b")).toBeDefined();
    expect(gate.inFlight()).toBe(3);
    held[0]?.();
    held[0]?.();
    expect(gate.inFlight()).toBe(2);
    expect(gate.enter("a")).toBeDefined();
  });
});

describe("daily budget", () => {
  it("refuses a key past its bytes until the next UTC day", () => {
    let now = Date.UTC(2026, 9, 3, 23, 59, 0);
    const budget = new DailyBudget(100, () => now);
    budget.add("a", 99);
    expect(budget.check("a")).toBe(0);
    budget.add("a", 1);
    expect(budget.check("a")).toBe(60);
    expect(budget.check("b")).toBe(0);
    now += 60_000;
    expect(budget.check("a")).toBe(0);
  });
});

describe("client keys", () => {
  it("keys IPv4 by address and IPv6 by /56, ports and brackets stripped", () => {
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("203.0.113.9:5678")).toBe("203.0.113.9");
    expect(clientKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:0::/56");
    expect(clientKey("2001:db8:1:2ff::9")).toBe("2001:db8:1:200::/56");
    expect(clientKey("[2001:db8:1:2::9]")).toBe("2001:db8:1:0::/56");
    expect(clientKey("[2001:db8:1:2::9]:443")).toBe("2001:db8:1:0::/56");
  });

  it("puts every address it cannot parse in one shared key", () => {
    for (const junk of ["unknown", "not-an-ip", "1.2.3.4:5678:9", "999.1.1.1", ""]) {
      expect(clientKey(junk)).toBe(UNPARSED);
      expect(networkKey(junk)).toBe(UNPARSED);
    }
  });

  it("groups networks by IPv4 address and IPv6 /48", () => {
    expect(networkKey("203.0.113.9:80")).toBe("203.0.113.9");
    expect(networkKey("2001:db8:1:2ff::9")).toBe("2001:db8:1::/48");
    expect(networkKey("2001:db8:1:ffff::9")).toBe("2001:db8:1::/48");
    expect(networkKey("2001:db8:2::9")).toBe("2001:db8:2::/48");
  });
});

describe("address hashing", () => {
  it("is stable within a day and changes with the day", () => {
    let now = Date.UTC(2026, 9, 3, 12);
    const hasher = new IpHasher(() => now);
    const first = hasher.hash("203.0.113.9");
    expect(hasher.hash("203.0.113.9")).toBe(first);
    expect(hasher.hash("203.0.113.10")).not.toBe(first);
    now += 86_400_000;
    expect(hasher.hash("203.0.113.9")).not.toBe(first);
  });
});
