import { describe, expect, it } from "vitest";
import { rateLimitKey } from "../src/rate-limit.ts";

describe("rateLimitKey", () => {
  it("keeps an IPv4 address", () => {
    expect(rateLimitKey("203.0.113.9")).toBe("203.0.113.9");
  });

  it("keys an IPv6 address by its /64, however it is written", () => {
    expect(rateLimitKey("2001:db8:0:1::5")).toBe("2001:db8:0:1::/64");
    expect(rateLimitKey("2001:0DB8:0000:0001:ffff:ffff:ffff:ffff")).toBe("2001:db8:0:1::/64");
    expect(rateLimitKey("[2001:db8:0:1::5]")).toBe("2001:db8:0:1::/64");
    expect(rateLimitKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
  });

  it("keys an IPv4-mapped IPv6 address as the IPv4 address", () => {
    expect(rateLimitKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(rateLimitKey("::FFFF:c633:6407")).toBe("198.51.100.7");
  });

  it("keeps anything that is not an address", () => {
    expect(rateLimitKey("unknown")).toBe("unknown");
  });
});
