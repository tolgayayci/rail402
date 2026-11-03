import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/evidence.ts";

const caddyfile = readFileSync(join(REPO_ROOT, "deploy/proxy/Caddyfile.example"), "utf8");
/**
 * Request headers that carry a signed payment or an API key: the x402 payment headers, the API key, and
 * the payment the Playground relay forwards to a seller (`x-relay-h-` + `payment-signature`). Caddy itself
 * redacts only Authorization and cookies.
 */
const CREDENTIAL_HEADERS = ["Payment-Signature", "X-Payment", "X-Api-Key", "X-Relay-H-Payment-Signature"];

/** The named loggers of the global options block, which opens the file. */
function globalLoggers(): Map<string, string> {
  const options = /^\{\n([\s\S]*?)^\}$/m.exec(caddyfile)?.[1] ?? "";
  return new Map(
    [...options.matchAll(/^\tlog (\S+) \{\n([\s\S]*?)^\t\}$/gm)].map(([, name = "", body = ""]) => [
      name,
      body,
    ]),
  );
}

describe("the proxy example", () => {
  it("keeps payment headers and API keys out of the access log", () => {
    const site = /^\(rail402_site\) \{\n([\s\S]*?)^\}$/m.exec(caddyfile)?.[1] ?? "";
    const log = /^\tlog \{\n([\s\S]*?)^\t\}$/m.exec(site)?.[1] ?? "";
    for (const header of CREDENTIAL_HEADERS) {
      expect(log, header).toMatch(new RegExp(`^\\t\\t\\trequest>headers>${header} delete$`, "m"));
    }
  });

  it("keeps payment headers and API keys out of the log of failed requests", () => {
    // A request that ends in a handler error (no ready replica, a failed round trip) is logged with its
    // headers on http.log.error.*, which no site's access log receives: the default logger must leave
    // those entries to one that deletes the same headers.
    const loggers = globalLoggers();
    expect(loggers.get("default")).toMatch(/^\t\texclude (?:\S+ )*http\.log\.error(?: \S+)*$/m);
    const errors = [...loggers.values()].filter((body) => /^\t\tinclude http\.log\.error$/m.test(body));
    expect(errors).toHaveLength(1);
    for (const header of CREDENTIAL_HEADERS) {
      expect(errors[0]).toContain(`request>headers>${header} delete`);
    }
  });

  it("keeps payment headers and API keys out of every log besides the sites' access logs", () => {
    // Everything no named logger takes reaches the default one: reverse_proxy's own entries (a body cut
    // off mid-response, debug round trips) and the access entries of a request whose Host matches a site
    // only without case, or no site at all. Every logger in the global options deletes the headers.
    const loggers = globalLoggers();
    expect([...loggers.keys()]).toContain("default");
    for (const [name, body] of loggers) {
      for (const header of CREDENTIAL_HEADERS) {
        expect(body, `log ${name}`).toMatch(new RegExp(`^\\t\\t\\trequest>headers>${header} delete$`, "m"));
      }
    }
  });

  it("answers host names no site claims with a 404 of its own", () => {
    expect(caddyfile).toMatch(/^http:\/\/, https:\/\/ \{\n\trespond "Not found" 404\n\}$/m);
  });

  it("balances two replicas and routes only to one whose /ready answers", () => {
    expect(caddyfile).toMatch(/reverse_proxy facilitator-a:8080 facilitator-b:8080 \{/);
    expect(caddyfile).toContain("health_uri /ready");
    expect(caddyfile).toContain("health_status 200");
    expect(caddyfile).toMatch(/lb_try_duration \d+s/);
  });

  it("serves both network hosts with the same site rules", () => {
    const sites = [
      ...caddyfile.matchAll(/^([a-z0-9.-]+) \{\n\timport rail402_site\n\timport rail402_facilitator\n\}/gm),
    ];
    expect(sites.map((site) => site[1])).toEqual(["testnet.example.com", "mainnet.example.com"]);
  });

  it("replaces X-Forwarded-For with the resolved client and trusts no proxy unless one is listed", () => {
    expect(caddyfile).toContain("header_up X-Forwarded-For {client_ip}");
    // trusted_proxies stays a commented example: an active one would let its ranges pick the client address.
    expect(caddyfile).toMatch(/^\t\t# trusted_proxies static /m);
    expect(caddyfile).not.toMatch(/^\s*trusted_proxies/m);
  });
});
