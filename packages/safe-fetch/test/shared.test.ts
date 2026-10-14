import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as root from "@rail402.dev/safe-fetch";
import * as shared from "@rail402.dev/safe-fetch/shared";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const manifest = JSON.parse(readFileSync(resolve(source, "../package.json"), "utf8")) as { version: string };

/** Every module `entry` reaches through relative imports, with its source text. */
function moduleGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    const text = readFileSync(file, "utf8");
    seen.set(file, text);
    for (const match of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const specifier = match[1];
      if (specifier !== undefined && specifier.endsWith(".ts")) visit(resolve(dirname(file), specifier));
    }
  };
  visit(resolve(source, entry));
  return seen;
}

describe("@rail402.dev/safe-fetch/shared", () => {
  it("exports the contract, the policy, the registry and the codes", () => {
    for (const name of [
      "resolvePolicy",
      "DEFAULT_LIMITS",
      "DEFAULT_TIMEOUTS",
      "DEFAULT_USER_AGENT",
      "effectivePort",
      "finalRequestOf",
      "markFinalRequest",
      "egressCodes",
      "EgressError",
      "isEgressError",
    ]) {
      expect(shared, name).toHaveProperty(name);
    }
    expect(shared).not.toHaveProperty("createSafeFetch");
    expect(shared).not.toHaveProperty("checkUrl");
  });

  it("is the same module the root re-exports", () => {
    expect(root.finalRequestOf).toBe(shared.finalRequestOf);
    expect(root.markFinalRequest).toBe(shared.markFinalRequest);
    expect(root.resolvePolicy).toBe(shared.resolvePolicy);
    expect(root.EgressError).toBe(shared.EgressError);
  });

  it("reaches no Node module and no Node global", () => {
    const graph = moduleGraph("shared.ts");
    expect([...graph.keys()].map((file) => file.slice(source.length + 1)).sort()).toEqual([
      "codes.ts",
      "limits.ts",
      "shared.ts",
    ]);
    for (const [file, text] of graph) {
      expect(text, file).not.toMatch(/from\s+"node:/);
      expect(text, file).not.toMatch(/\b(?:Buffer|process|require)\b[.(]/);
    }
  });

  it("names the package version in the default user agent", () => {
    expect(shared.DEFAULT_USER_AGENT).toBe(`rail402/${manifest.version} (+https://rail402.dev)`);
    expect(shared.resolvePolicy().userAgent).toBe(shared.DEFAULT_USER_AGENT);
  });

  it("computes the effective port", () => {
    expect(shared.effectivePort(new URL("https://example.com/"))).toBe(443);
    expect(shared.effectivePort(new URL("http://example.com/"))).toBe(80);
    expect(shared.effectivePort(new URL("https://example.com:8443/"))).toBe(8443);
  });

  it("records a final request for responses another implementation returns", () => {
    const response = new Response("ok");
    expect(shared.finalRequestOf(response)).toBeUndefined();
    shared.markFinalRequest(response, { method: "GET", bodyDropped: true });
    expect(shared.finalRequestOf(response)).toEqual({ method: "GET", bodyDropped: true });
    expect(Object.isFrozen(shared.finalRequestOf(response))).toBe(true);
    expect(shared.finalRequestOf(new Response("ok"))).toBeUndefined();
  });

  describe("with the Node implementation", () => {
    let server: Server;
    let origin: string;

    beforeAll(async () => {
      server = createServer((_request, response) => {
        response.end("ok");
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    });

    afterAll(async () => {
      await new Promise((done) => server.close(done));
    });

    it("shares the registry, so the shared reader sees what createSafeFetch recorded", async () => {
      const safeFetch = root.createSafeFetch({
        schemes: ["http:"],
        ports: [Number(new URL(origin).port)],
        allowPrivateNetwork: "loopback",
      });
      try {
        const response = await safeFetch(`${origin}/`, { method: "POST", body: "x" });
        expect(await response.text()).toBe("ok");
        expect(shared.finalRequestOf(response)).toEqual({ method: "POST", bodyDropped: false });
      } finally {
        safeFetch.close();
      }
    });
  });
});
