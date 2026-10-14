import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { PAY_TO } from "./support.ts";

// `railway config apply` deletes every variable the file does not declare and sets the literal ones, so
// each declared name must be one the server reads, every name the server reads must be declared (or
// be left unmanaged on purpose), and the literal values must load.
const FILE = readFileSync(new URL("../../../.railway/playground.ts", import.meta.url), "utf8");
const CONFIG = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const block = FILE.slice(
  FILE.indexOf("variables: {"),
  FILE.indexOf("\n    },", FILE.indexOf("variables: {")),
);
const declared = [...block.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*([^\n]*)$/gm)].map((match) => ({
  name: match[1] ?? "",
  value: match[2] ?? "",
}));
const literals: Record<string, string> = Object.fromEntries(
  [...block.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*"([^"]*)",/gm)].map((match) => [
    match[1] ?? "",
    match[2] ?? "",
  ]),
);

/** The keys of the configuration schema in config.ts. */
function schemaKeys(): string[] {
  const start = CONFIG.indexOf("const schema = z.object({");
  expect(start, "config.ts defines its schema").toBeGreaterThan(-1);
  const body = CONFIG.slice(start, CONFIG.indexOf("\n});", start));
  return [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1] ?? "");
}

/** Variables the server reads that the file leaves unmanaged on purpose. */
const UNMANAGED: Readonly<Record<string, string>> = {
  PORT: "Railway sets it for the service",
  HOST: "the default, every interface, is what Railway's proxy reaches",
  RAILWAY_PUBLIC_DOMAIN: "Railway sets it to the service's generated domain",
};

describe("the Playground's Railway infrastructure file", () => {
  it("declares every variable the server reads, except the ones it leaves unmanaged on purpose", () => {
    const names = new Set(declared.map(({ name }) => name));
    const expected = schemaKeys();
    expect(expected.length).toBeGreaterThan(40);
    for (const name of expected) {
      if (Object.hasOwn(UNMANAGED, name)) {
        expect(names.has(name), `${name} is listed as unmanaged but declared`).toBe(false);
      } else {
        expect(names.has(name), `${name} would be deleted by railway config apply: declare it`).toBe(true);
      }
    }
    for (const name of Object.keys(UNMANAGED)) expect(expected).toContain(name);
  });

  it("declares only variables the server reads", () => {
    const keys = new Set(schemaKeys());
    for (const { name } of declared) expect(keys.has(name), `${name} is not read by the server`).toBe(true);
  });

  it("sets literal values the server accepts, for the hosted testnet behind one proxy", () => {
    const config = loadConfig({ ...literals, PLAYGROUND_PAY_TO: PAY_TO }, { version: "0.3.0" });
    expect(config).toMatchObject({
      mode: "hosted",
      publicUrl: "https://playground.rail402.dev",
      network: "stellar:testnet",
      trustedProxyHops: 1,
      urls: { facilitator: "https://testnet.rail402.dev", demoSeller: "https://demo.rail402.dev" },
    });
  });

  it("is a project of its own, built from the Playground's Dockerfile, with one replica", () => {
    expect(FILE).toContain('ctx.projectName ?? "rail402-playground"');
    expect(FILE).not.toContain("rail402-stellar-prod");
    expect(FILE).toContain('dockerfilePath: "apps/playground/Dockerfile"');
    expect(FILE).toMatch(/numReplicas: 1/);
    expect(FILE).toContain('healthcheckPath: "/ready"');
    expect(FILE).not.toMatch(/postgres\(|SECRET/);
  });
});
