import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/evidence.ts";

const config = readFileSync(join(REPO_ROOT, "deploy/status/upptimerc.yml"), "utf8");
const sites = config
  .split(/^ {2}- name: /m)
  .slice(1)
  .map((block) => ({
    name: block.split("\n")[0] ?? "",
    url: /^ {4}url: (\S+)$/m.exec(block)?.[1] ?? "",
    block,
  }));

describe("the status checks", () => {
  it("the status checks cover every pubnet endpoint", () => {
    for (const [host, ready] of [
      ["https://testnet.rail402.dev", "/ready/testnet"],
      ["https://mainnet.rail402.dev", "/ready/pubnet"],
    ] as const) {
      for (const path of ["/supported", "/discovery/resources", "/discovery/search", "/health", ready]) {
        const site = sites.find((entry) => entry.url.split("?")[0] === `${host}${path}`);
        expect(site, `${host}${path}`).toBeDefined();
        // A content assertion on every service check: a proxy error page is never "up".
        expect(site?.block, site?.name).toMatch(/__dangerous__body_(down|down_if_text_missing): /);
      }
      // /health's top-level state aggregates both networks, so it never marks one network degraded.
      const health = sites.find((entry) => entry.url === `${host}/health`);
      expect(health?.block).not.toContain("__dangerous__body_degraded");
    }
  });

  it("only reads: https GETs without credentials", () => {
    expect(sites.length).toBeGreaterThan(10);
    for (const site of sites) {
      expect(site.url, site.name).toMatch(/^https:\/\//);
      expect(site.block, site.name).not.toMatch(/^ {4}(method|body|headers):/m);
    }
    expect(config).not.toMatch(/__dangerous__insecure|disable_verify/);
  });
});
