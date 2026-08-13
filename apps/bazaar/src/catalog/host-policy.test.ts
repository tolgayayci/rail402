import { describe, it, expect } from "vitest";
import { checkResourceHost } from "./host-policy.js";

/**
 * The catalog-side host policy. It must reject exactly what the buyer-side `isPayableResourceUrl`
 * rejects (they are the same policy, restated to keep the server off a buyer-side dep — see
 * host-policy.ts), so these fixtures are also the tripwire for the two drifting apart.
 */

const verdict = (url: string, allowPrivate = false) => checkResourceHost(new URL(url), allowPrivate);
const ok = (url: string, allowPrivate = false) => verdict(url, allowPrivate).ok;

describe("checkResourceHost", () => {
  it("accepts ordinary public https and http hosts", () => {
    for (const url of [
      "https://api.example.com/weather",
      "http://example.org/x",
      "https://sub.domain.example.co.uk/path?q=1",
      "https://api.example.com.:8443/x", // trailing dot on a public host is still public
    ]) {
      expect(ok(url), `${url} should be public`).toBe(true);
    }
  });

  it("refuses loopback names in every form", () => {
    for (const url of [
      "http://localhost/x",
      "http://localhost./x", // trailing-dot bypass
      "http://localhost.localdomain/x",
      "http://ip6-localhost/x",
    ]) {
      expect(ok(url), `${url} should be refused`).toBe(false);
    }
  });

  it("refuses IPv4 literals across dotted, decimal, and hex encodings", () => {
    for (const url of [
      "http://127.0.0.1/x",
      "http://10.0.0.1/x",
      "http://172.16.0.1/x",
      "http://192.168.1.1/x",
      "http://169.254.169.254/latest/meta-data/", // link-local instance metadata
      "http://2130706433/x", // 127.0.0.1 as a single decimal
      "http://0x7f000001/x", // 127.0.0.1 in hex
    ]) {
      expect(ok(url), `${url} should be refused`).toBe(false);
    }
  });

  it("refuses IPv6 literals", () => {
    expect(ok("http://[::1]/x")).toBe(false);
    expect(ok("http://[fe80::1]/x")).toBe(false);
  });

  it("refuses reserved metadata hostnames and internal-resolution suffixes", () => {
    for (const url of [
      "http://metadata.google.internal/x",
      "http://metadata/x",
      "http://instance-data/x",
      "http://vault.internal/x",
      "http://printer.local/x",
      "http://svc.cluster.local/x",
      "http://api.localhost/x",
      "http://db.consul/x",
    ]) {
      expect(ok(url), `${url} should be refused`).toBe(false);
    }
  });

  it("refuses a URL carrying embedded credentials", () => {
    expect(ok("https://user:pass@api.example.com/x")).toBe(false);
    expect(ok("https://user@api.example.com/x")).toBe(false);
  });

  it("gives a non-null reason on every refusal", () => {
    for (const url of ["http://127.0.0.1/x", "http://metadata/x", "https://u:p@x.example/y"]) {
      const v = verdict(url);
      expect(v.ok).toBe(false);
      if (v.ok) continue;
      expect(v.reason).toBeTruthy();
    }
  });

  describe("under the local-development opt-in", () => {
    it("permits loopback and private ranges", () => {
      for (const url of [
        "http://127.0.0.1:4022/x",
        "http://localhost:3000/x",
        "http://10.0.0.5/x",
        "http://[::1]/x",
      ]) {
        expect(ok(url, true), `${url} should pass under opt-in`).toBe(true);
      }
    });

    it("still refuses metadata hostnames and internal-resolution suffixes", () => {
      // The escape hatch is for a local seller by name, never for reaching a metadata service or an
      // internal cluster name — those stay blocked even when private ranges are allowed.
      for (const url of [
        "http://metadata.google.internal/x",
        "http://metadata/x",
        "http://vault.internal/x",
        "http://svc.cluster.local/x",
      ]) {
        expect(ok(url, true), `${url} should stay refused under opt-in`).toBe(false);
      }
    });
  });
});
