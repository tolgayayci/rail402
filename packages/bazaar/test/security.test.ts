import { afterAll, describe, expect, it } from "vitest";
import {
  SchemaSandbox,
  canonicalizeUrl,
  externalReference,
  isPublicAddress,
  isPublicHostname,
  isSafeTemplate,
  templateMatchesPath,
} from "@rail402.dev/bazaar";

describe("SchemaSandbox", () => {
  const sandbox = new SchemaSandbox({ timeoutMs: 250 });
  afterAll(async () => {
    await sandbox.close();
  });

  it("validates info against a well-formed schema", async () => {
    const schema = { type: "object", properties: { input: { type: "object" } }, required: ["input"] };
    expect(await sandbox.validate(schema, { input: {} })).toEqual({ ok: true });
    expect(await sandbox.validate(schema, {})).toMatchObject({ ok: false, code: "bazaar_info_invalid" });
  });

  it("stops a catastrophic-backtracking pattern within its budget and keeps serving", async () => {
    const schema = { type: "object", properties: { input: { type: "string", pattern: "^(a+)+$" } } };
    const started = performance.now();
    const verdict = await sandbox.validate(schema, { input: `${"a".repeat(40)}!` });
    expect(verdict).toMatchObject({ ok: false, code: "bazaar_schema_timeout" });
    expect(performance.now() - started).toBeLessThan(2_000);
    // A fresh worker takes over.
    expect(await sandbox.validate({ type: "object" }, {})).toEqual({ ok: true });
  });

  it("stops a combinatorial uniqueItems check within its budget", async () => {
    const schema = { type: "object", properties: { input: { type: "array", uniqueItems: true } } };
    const items = Array.from({ length: 2_000 }, (_, i) => ({ k: i % 7, v: [i % 3, i % 5] }));
    const started = performance.now();
    const verdict = await sandbox.validate(schema, { input: items });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(["bazaar_schema_timeout", "bazaar_schema_too_large", "bazaar_info_invalid", undefined]).toContain(
      verdict.ok ? undefined : verdict.code,
    );
  });

  it("refuses oversized and deeply nested documents before compiling them", async () => {
    const big = { type: "object", description: "x".repeat(40_000) };
    expect(await sandbox.validate(big, {})).toMatchObject({ ok: false, code: "bazaar_schema_too_large" });
    let deep: Record<string, unknown> = { type: "object" };
    for (let i = 0; i < 40; i++) deep = { type: "object", properties: { next: deep } };
    expect(await sandbox.validate(deep, {})).toMatchObject({ ok: false, code: "bazaar_schema_too_large" });
  });

  it("refuses non-object schemas and uncompilable schemas with a reason", async () => {
    expect(await sandbox.validate("nope", {})).toMatchObject({ ok: false, code: "bazaar_schema_invalid" });
    const verdict = await sandbox.validate({ type: 42 }, {});
    expect(verdict).toMatchObject({ ok: false, code: "bazaar_schema_invalid" });
    expect(verdict.ok ? "" : verdict.reason).not.toBe("");
  });

  it.each([
    [{ $ref: "https://evil.example/schema.json" }, "https://evil.example/schema.json"],
    [{ properties: { a: { $ref: "file:///etc/passwd" } } }, "file:///etc/passwd"],
    [{ $id: "https://evil.example/" }, "https://evil.example/"],
    [{ allOf: [{ $dynamicRef: "other.json#x" }] }, "other.json#x"],
    [{ $ref: "relative.json" }, "relative.json"],
  ])("detects external reference %j", (schema, reference) => {
    expect(externalReference(schema)).toBe(reference);
  });

  it("does not charge a new worker's startup to the first validation's time budget", async () => {
    // A budget below the time a worker thread takes to start and load its validator.
    const cold = new SchemaSandbox({ timeoutMs: 100 });
    try {
      expect(await cold.validate({ type: "object" }, {})).toEqual({ ok: true });
      expect(await cold.warm()).toBe(true);
    } finally {
      await cold.close();
    }
  });

  it("refuses validations beyond its queue at once instead of delaying everyone", async () => {
    const small = new SchemaSandbox({ timeoutMs: 250, maxQueued: 2 });
    try {
      const slow = { type: "string", pattern: "^(a+)+$" };
      const info = "a".repeat(40) + "!";
      const verdicts = await Promise.all([
        small.validate(slow, info),
        small.validate(slow, info),
        small.validate({ type: "object" }, {}),
      ]);
      expect(verdicts[2]).toMatchObject({ ok: false, code: "bazaar_schema_timeout" });
      expect((verdicts[2] as { reason: string }).reason).toContain("busy");
      expect(await small.validate({ type: "object" }, {})).toEqual({ ok: true });
    } finally {
      await small.close();
    }
  });

  it("finds external references in every schema position, and only there", async () => {
    for (const schema of [
      { properties: { a: { $ref: "https://x.example/s.json" } } },
      { items: { $ref: "https://x.example/s.json" } },
      { prefixItems: [{ $id: "https://x.example/s.json" }] },
      { $defs: { a: { $dynamicRef: "https://x.example/s.json" } } },
      { anyOf: [{ not: { $ref: "https://x.example/s.json" } }] },
    ]) {
      expect(await sandbox.validate(schema, {}), JSON.stringify(schema)).toMatchObject({
        ok: false,
        code: "bazaar_schema_external_reference",
      });
    }
    // Data that merely looks like a keyword: a property named $id, a $ref inside enum or examples.
    const lookalikes = {
      type: "object",
      properties: { $id: { type: "string" }, link: { enum: [{ $ref: "https://x.example" }] } },
      examples: [{ $ref: "https://x.example" }],
    };
    expect(await sandbox.validate(lookalikes, { $id: "a", link: { $ref: "https://x.example" } })).toEqual({
      ok: true,
    });
  });

  it("allows same-document references", async () => {
    const schema = {
      $defs: { city: { type: "string" } },
      type: "object",
      properties: { input: { type: "object", properties: { city: { $ref: "#/$defs/city" } } } },
    };
    expect(externalReference(schema)).toBeUndefined();
    expect(await sandbox.validate(schema, { input: { city: "Izmir" } })).toEqual({ ok: true });
  });
});

describe("resource URL safety", () => {
  const http = { protocols: ["https:", "http:"], allowLoopback: false };

  it.each([
    "http://127.0.0.1/x",
    "http://2130706433/x",
    "http://0x7f000001/x",
    "http://[::1]/x",
    "http://[::ffff:127.0.0.1]/x",
    "http://10.1.2.3/x",
    "http://172.16.0.1/x",
    "http://192.168.1.1/x",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/x",
    "http://[fd00::1]/x",
    "http://[fe80::1]/x",
    "http://localhost/x",
    "http://api.localhost/x",
    "http://printer.local/x",
    "http://intranet/x",
    "http://metadata.internal/x",
  ])("refuses %s", (url) => {
    expect(canonicalizeUrl(url, http)).toMatchObject({ ok: false, code: "bazaar_resource_unsafe" });
  });

  it.each([
    ["https://user:pw@api.example.com/x", "credentials"],
    ["ftp://api.example.com/x", "scheme"],
    ["not a url", "absolute"],
    [`https://api.example.com/${"a".repeat(2100)}`, "exceeds"],
  ])("rejects %s as invalid", (url, fragment) => {
    const result = canonicalizeUrl(url, http);
    expect(result).toMatchObject({ ok: false, code: "bazaar_resource_invalid" });
    expect(result.ok ? "" : result.reason).toContain(fragment === "scheme" ? "must use" : fragment);
  });

  it("canonicalises case, default ports, dot segments, query and fragment", () => {
    const result = canonicalizeUrl("HTTPS://API.Example.com:443/a/./b/../c?x=1#frag", http);
    expect(result.ok && result.url.href).toBe("https://api.example.com/a/c");
  });

  it("normalizes percent-encoding so equivalent paths are one resource", () => {
    const href = (raw: string) => {
      const result = canonicalizeUrl(raw, http);
      return result.ok ? result.url.href : result.code;
    };
    expect(href("https://api.example.com/%61pi")).toBe("https://api.example.com/api");
    expect(href("https://api.example.com/a/%2e%2e/api")).toBe("https://api.example.com/api");
    expect(href("https://api.example.com/caf%c3%a9")).toBe("https://api.example.com/caf%C3%A9");
    // Distinct resources: a server may answer them differently.
    expect(href("https://api.example.com/api/")).toBe("https://api.example.com/api/");
    expect(href("http://api.example.com/api")).toBe("http://api.example.com/api");
  });

  it("refuses route templates that decode to NUL, CR, LF, a backslash or an empty segment", () => {
    expect(isSafeTemplate("/users/:id")).toBe(true);
    for (const template of ["/a%00/:id", "/a%0d%0a/:id", "/a%5c/:id", "/a//:id", "/a%252F%252F/:id"]) {
      expect(isSafeTemplate(template), template).toBe(false);
    }
  });

  it("accepts loopback only when explicitly allowed", () => {
    expect(canonicalizeUrl("http://localhost:4021/x", { ...http, allowLoopback: true }).ok).toBe(true);
    expect(canonicalizeUrl("http://10.0.0.1/x", { ...http, allowLoopback: true }).ok).toBe(false);
  });

  it("classifies public and non-public addresses", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("198.18.0.1")).toBe(false);
    expect(isPublicAddress("64:ff9b::a00:1")).toBe(false);
    expect(isPublicAddress("::127.0.0.1")).toBe(false);
    expect(isPublicAddress("fec0::1")).toBe(false);
    expect(isPublicHostname("api.example.com")).toBe(true);
    expect(isPublicHostname("api.example.com.")).toBe(true);
  });

  it("matches route templates to the paid path segment by segment", () => {
    expect(templateMatchesPath("/users/:id", "/users/42")).toBe(true);
    expect(templateMatchesPath("/users/:id/posts/:post", "/users/42/posts/7")).toBe(true);
    expect(templateMatchesPath("/users/:id", "/users/42/extra")).toBe(false);
    expect(templateMatchesPath("/users/:id", "/admins/42")).toBe(false);
    expect(templateMatchesPath("/users/:id", "/users/")).toBe(false);
    expect(templateMatchesPath("/files/a%20b", "/files/a b")).toBe(true);
  });
});
