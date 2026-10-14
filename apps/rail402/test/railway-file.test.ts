import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { loadConfig } from "@rail402.dev/service";

// `railway config apply` deletes every variable the file does not declare and sets the literal ones, so
// each declared name must be one the service reads, every name the service reads must be declared (or
// be left unmanaged on purpose), and the literal values must load.
const FILE = readFileSync(new URL("../../../.railway/railway.ts", import.meta.url), "utf8");
const CONFIG = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const block = FILE.slice(
  FILE.indexOf("variables: {"),
  FILE.indexOf("\n    },", FILE.indexOf("variables: {")),
);
const declared = [...block.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*([^\n]*)$/gm)].map((match) => ({
  name: match[1] ?? "",
  value: match[2] ?? "",
}));
/** Literal string values, including one wrapped onto the next line. */
const literals: Record<string, string> = Object.fromEntries(
  [...block.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*\n?\s*"([^"]*)",/gm)].map((match) => [
    match[1] ?? "",
    match[2] ?? "",
  ]),
);

/** The keys of one `z.object({ … })` schema in config.ts. */
function schemaKeys(name: string): string[] {
  const start = CONFIG.indexOf(`const ${name} = z.object({`);
  expect(start, `config.ts defines ${name}`).toBeGreaterThan(-1);
  const body = CONFIG.slice(start, CONFIG.indexOf("\n});", start));
  return [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1] ?? "");
}

/**
 * Variables the service reads that the file leaves unmanaged on purpose, so `railway config apply`
 * removes them when an operator set them by hand. The file configures a testnet facilitator, so no
 * PUBNET_ variable is managed either.
 */
const UNMANAGED: Readonly<Record<string, string>> = {
  PORT: "Railway sets it for the service",
  HOST: "the default, every interface, is what Railway's proxy reaches",
  STORE: "the default, postgres, is the database the file provisions",
  DISCOVERY_ALLOW_LOOPBACK:
    "for local conformance runs only; a hosted catalog must refuse loopback resources",
  SEARCH_MODEL_DIR: "the image sets it to the embedding model it carries",
  SEARCH_MODEL_DOWNLOAD: "the image carries the model, so the service never downloads one",
};

describe("the Railway infrastructure file", () => {
  it("declares every variable the service reads, except the ones it leaves unmanaged on purpose", () => {
    const names = new Set(declared.map(({ name }) => name));
    const expected = [
      ...schemaKeys("baseSchema"),
      ...schemaKeys("networkSchema").map((key) => `TESTNET_${key}`),
    ];
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

  it("declares only variables the service reads", () => {
    expect(declared.length).toBeGreaterThan(10);
    for (const { name } of declared) {
      const key = name.replace(/^(TESTNET|PUBNET)_/, "");
      const read = new RegExp(`^\\s+(${name}|${key}):`, "m").test(CONFIG) || name === "RAIL402_VERSION";
      expect(read, `${name} is not a variable the service reads`).toBe(true);
    }
  });

  it("sets literal values the service accepts, with two assets and an hourly sponsor budget", () => {
    expect(literals["TESTNET_ASSETS"]).toMatch(/:USDC:7,.*:TEST6:6$/);
    const config = loadConfig({
      ...literals,
      DATABASE_URL: "postgres://rail402:rail402@localhost:5432/rail402",
      TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
    });
    const [testnet] = config.networks;
    expect(testnet?.assets.map((asset) => [asset.symbol, asset.decimals])).toEqual([
      ["USDC", 7],
      ["TEST6", 6],
    ]);
    expect(testnet?.maxSponsorSpendPerHourStroops).toBe(100n * 10_000_000n);
  });
});
