import { describe, it, expect } from "vitest";
import { routeTemplateHasHiddenTraversal, isRouteTemplateSafe } from "./route-template.js";

/**
 * The stricter routeTemplate check that closes upstream x402-foundation/x402#3169: the SDK's
 * `isValidRouteTemplate` decodes ONCE, so a double-encoded traversal (`%252e%252e`) passes its check.
 * These fixtures are the tripwire that our repeated-decode check keeps catching it. `bad` is the
 * hostile predicate; `safe` is its negation, which the caller ANDs with the SDK verdict.
 */
const bad = routeTemplateHasHiddenTraversal;

describe("routeTemplateHasHiddenTraversal", () => {
  it("accepts legitimate route templates", () => {
    for (const t of ["/users/{id}", "/a/b/c", "/v1/reports/{reportId}/rows", "/tides", "/{harbour}"]) {
      expect(bad(t)).toBe(false);
    }
  });

  it("treats an absent, empty, or non-string template as nothing to check", () => {
    expect(bad(undefined)).toBe(false);
    expect(bad("")).toBe(false);
    expect(bad(null)).toBe(false);
    expect(bad(42)).toBe(false);
  });

  it("catches a literal path traversal", () => {
    expect(bad("..")).toBe(true);
    expect(bad("/a/../b")).toBe(true);
    expect(bad("/{id}/../../secret")).toBe(true);
  });

  it("catches a single-encoded traversal", () => {
    expect(bad("%2e%2e")).toBe(true);
    expect(bad("/a/%2e%2e/b")).toBe(true);
  });

  // The load-bearing case: the SDK's single decode turns %252e%252e into %2e%2e (no ".."), so it
  // passes upstream's check. Our repeated decode reveals the "..".
  it("catches a DOUBLE-encoded traversal the SDK's single decode misses (#3169)", () => {
    expect(bad("%252e%252e")).toBe(true);
    expect(bad("/x/%252e%252e/y")).toBe(true);
    expect(bad("%25252e%25252e")).toBe(true); // triple-encoded, for good measure
  });

  it("catches backslash traversal, literal and percent-encoded", () => {
    expect(bad("..\\..")).toBe(true);
    expect(bad("%5c..%5c")).toBe(true);
    expect(bad("%255c..%255c")).toBe(true); // double-encoded backslash
  });

  it("catches scheme smuggling and protocol-relative templates", () => {
    expect(bad("https://evil.example")).toBe(true);
    expect(bad("//evil.example")).toBe(true);
    expect(bad("/a/%2f%2fevil")).toBe(false); // decodes to /a///evil — no "//" prefix, not traversal
    expect(bad("%2f%2fevil")).toBe(true); // decodes to //evil — protocol-relative
  });

  it("catches control characters and null bytes", () => {
    expect(bad("%00")).toBe(true); // NUL
    expect(bad("%0d%0a")).toBe(true); // CR LF (log/header injection)
    expect(bad("/a\tb")).toBe(true); // literal tab
  });

  it("treats malformed percent-encoding as hostile rather than guessing", () => {
    expect(bad("/a%zz")).toBe(true);
    expect(bad("%")).toBe(true);
    expect(bad("%25")).toBe(true); // decodes to a bare "%", which then fails to decode
  });
});

describe("isRouteTemplateSafe", () => {
  it("is the negation of the hostile predicate for a provided template", () => {
    expect(isRouteTemplateSafe("/users/{id}")).toBe(true);
    expect(isRouteTemplateSafe("%252e%252e")).toBe(false);
  });

  it("is true for an absent template — there is nothing to make unsafe", () => {
    expect(isRouteTemplateSafe(undefined)).toBe(true);
    expect(isRouteTemplateSafe("")).toBe(true);
  });
});
