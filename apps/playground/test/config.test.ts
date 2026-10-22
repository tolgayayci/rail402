import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  connectOrigins,
  containsSecretSeed,
  loadConfig,
  publicConfigOf,
} from "../src/config.ts";
import { secretLikeNames } from "../src/shared/public-config.ts";
import { PAY_TO, testConfig } from "./support.ts";

const base = { PUBLIC_URL: "https://playground.example", PLAYGROUND_PAY_TO: PAY_TO };

function refusal(env: Record<string, string>): string {
  try {
    loadConfig(env, { version: "0.3.0" });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected the configuration to be refused");
}

describe("configuration", () => {
  it("defaults to the public testnet, hosted Rail402 and the demo seller", () => {
    const config = testConfig();
    expect(config).toMatchObject({
      port: 8080,
      host: "::",
      mode: "hosted",
      publicUrl: "https://playground.example",
      network: "stellar:testnet",
      urls: {
        rpc: "https://soroban-testnet.stellar.org",
        horizon: "https://horizon-testnet.stellar.org",
        friendbot: "https://friendbot.stellar.org",
        facilitator: "https://testnet.rail402.dev",
        bazaar: "https://testnet.rail402.dev",
        demoSeller: "https://demo.rail402.dev",
        docs: "https://docs.rail402.dev",
      },
      asset: {
        contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        symbol: "USDC",
        decimals: 7,
        classic: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      },
      payTo: PAY_TO,
      features: { relay: true, lab: true },
      relayDenyHosts: [],
      relayTrustedHosts: ["demo.rail402.dev"],
      trustedProxyHops: 0,
      version: "0.3.0",
    });
    expect(config.limits.relayUnpaidPerMinute).toBe(60);
    expect(config.limits.relayBytesPerIpPerDay).toBe(100 * 1_048_576);
  });

  it("serves the testnet only", () => {
    expect(refusal({ ...base, NETWORK: "stellar:pubnet" })).toMatch(/^NETWORK: only stellar:testnet/);
  });

  it("requires an origin as PUBLIC_URL, https unless loopback", () => {
    expect(refusal({ PLAYGROUND_PAY_TO: PAY_TO })).toMatch(/^PUBLIC_URL/);
    expect(refusal({ ...base, PUBLIC_URL: "https://playground.example/app" })).toMatch(/origin/);
    expect(refusal({ ...base, PUBLIC_URL: "http://playground.example" })).toMatch(/https/);
    expect(testConfig({ PUBLIC_URL: "http://127.0.0.1:8080/" }).publicUrl).toBe("http://127.0.0.1:8080");
  });

  it("allows local mode only with a loopback PUBLIC_URL", () => {
    expect(refusal({ ...base, PLAYGROUND_MODE: "local" })).toMatch(/loopback/);
    expect(testConfig({ PLAYGROUND_MODE: "local", PUBLIC_URL: "http://localhost:4000" }).mode).toBe("local");
  });

  it("listens on every interface when hosted, and only on loopback in local mode", () => {
    const local = { ...base, PLAYGROUND_MODE: "local", PUBLIC_URL: "http://127.0.0.1:4000" };
    expect(loadConfig(base, { version: "0.3.0" }).host).toBe("::");
    expect(loadConfig(local, { version: "0.3.0" }).host).toBe("127.0.0.1");
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(loadConfig({ ...local, HOST: host }, { version: "0.3.0" }).host).toBe(host);
    }
    for (const host of ["::", "0.0.0.0", "192.168.1.20"]) {
      expect(refusal({ ...local, HOST: host })).toMatch(/^HOST must be a loopback address/);
    }
  });

  it("requires a public payTo while the lab is on, and drops it when the lab is off", () => {
    expect(refusal({ PUBLIC_URL: base.PUBLIC_URL })).toMatch(/^PLAYGROUND_PAY_TO is required/);
    expect(
      refusal({ ...base, PLAYGROUND_PAY_TO: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" }),
    ).toMatch(/^PLAYGROUND_PAY_TO: must be a G/);
    const off = loadConfig({ PUBLIC_URL: base.PUBLIC_URL, LAB_ENABLED: "false" }, { version: "0.3.0" });
    expect(off.payTo).toBeUndefined();
    expect(publicConfigOf(off).lab).toMatchObject({ enabled: false, payTo: null });
  });

  it("checks that the classic asset is the one behind the asset contract", () => {
    expect(refusal({ ...base, ASSET_CLASSIC: `EURC:${PAY_TO}` })).toMatch(/does not match ASSET_CONTRACT/);
  });

  it("refuses a Stellar secret seed in any environment value, naming only the variable", () => {
    const seed = Keypair.random().secret();
    for (const env of [
      { ...base, SOME_UNRELATED_VALUE: seed },
      { ...base, DATABASE_HINT: `prefix-${seed}-suffix` },
      { ...base, LOG_LEVEL: `XX${seed}` },
    ]) {
      const message = refusal(env);
      expect(message).toMatch(/holds a Stellar secret seed/);
      expect(message).not.toContain(seed);
    }
  });

  it("does not judge variables by their names", () => {
    const config = testConfig({
      PLATFORM_PRIVATE_DOMAIN: "playground.internal",
      SECRET_SAUCE: "not a seed",
      MY_PRIVATE_KEY_PATH: "/nowhere",
    });
    expect(config.publicUrl).toBe("https://playground.example");
    expect(containsSecretSeed(`S${"A".repeat(55)}`)).toBe(false);
  });

  it("reads limits, kill switches and host lists", () => {
    const config = testConfig({
      RELAY_ENABLED: "false",
      RELAY_DENY_HOSTS: " Evil.Example. , other.example",
      RELAY_TRUSTED_HOSTS: "",
      RELAY_PAID_PER_MINUTE: "5",
      TRUSTED_PROXY_HOPS: "1",
    });
    expect(config.features).toEqual({ relay: false, lab: true });
    expect(config.relayDenyHosts).toEqual(["evil.example", "other.example"]);
    expect(config.relayTrustedHosts).toEqual([]);
    expect(config.limits.relayPaidPerMinute).toBe(5);
    expect(config.trustedProxyHops).toBe(1);
    expect(refusal({ ...base, RELAY_PAID_PER_MINUTE: "0" })).toMatch(/^RELAY_PAID_PER_MINUTE/);
    expect(refusal({ ...base, RELAY_ENABLED: "yes" })).toMatch(/^RELAY_ENABLED/);
  });

  it("reports the commit in the version unless one is set", () => {
    expect(testConfig({ RAIL402_COMMIT: "abc1234def5678" }).version).toBe("0.3.0+abc1234def56");
    expect(testConfig({ RAIL402_VERSION: "0.4.0+abc", RAIL402_COMMIT: "abc" }).version).toBe("0.4.0+abc");
    expect(refusal({ ...base, RAIL402_COMMIT: "not hex" })).toMatch(/^RAIL402_COMMIT/);
  });

  it("refuses a non-https explorer template", () => {
    expect(refusal({ ...base, EXPLORER_TEMPLATE: "http://explorer.example/tx/{hash}" })).toMatch(
      /^EXPLORER_TEMPLATE/,
    );
    expect(refusal({ ...base, EXPLORER_TEMPLATE: "https://explorer.example/tx/" })).toMatch(
      /^EXPLORER_TEMPLATE/,
    );
  });
});

describe("public configuration", () => {
  it("matches the shared schema and holds no secret-like property", () => {
    const published = publicConfigOf(testConfig());
    expect(secretLikeNames(published)).toEqual([]);
    expect(published).toMatchObject({
      mode: "hosted",
      network: "stellar:testnet",
      networkPassphrase: "Test SDF Network ; September 2015",
      urls: { public: "https://playground.example" },
      lab: { enabled: true, payTo: PAY_TO },
      relay: { enabled: true, policy: { schemes: ["https:"], ports: [443], allowLoopback: false } },
      onboarding: { buyAmount: "1", keepXlm: "10", faucetUrl: "https://faucet.circle.com" },
    });
  });

  it("offers only what its switched-on features can run", () => {
    const all = publicConfigOf(testConfig()).lab;
    expect(all.scenarios).toEqual(["pay", "upto", "agent"]);
    expect(all.experiments).toEqual(["normal", "replay", "overcharge"]);
    expect(all.checks).toHaveLength(7);
    const noLab = publicConfigOf(testConfig({ LAB_ENABLED: "false" })).lab;
    expect(noLab.scenarios).toEqual(["pay", "upto", "agent"]);
    expect(noLab.experiments).toEqual(["normal", "replay"]);
    expect(noLab.checks).toEqual(["recipient", "per-call-cap", "session-budget", "private-address"]);
    const noRelay = publicConfigOf(testConfig({ RELAY_ENABLED: "false" })).lab;
    expect(noRelay.scenarios).toEqual([]);
    expect(noRelay.experiments).toEqual(["normal", "overcharge"]);
    expect(noRelay.checks).toEqual(["network", "asset", "amount"]);
  });

  it("mirrors the local relay policy", () => {
    const local = publicConfigOf(testConfig({ PLAYGROUND_MODE: "local", PUBLIC_URL: "http://127.0.0.1:9" }));
    expect(local.relay.policy).toMatchObject({ schemes: ["https:", "http:"], allowLoopback: true });
  });

  it("lists the Stellar endpoints the page connects to", () => {
    expect(connectOrigins(testConfig({ RPC_URL: "https://rpc.example:8443/soroban/rpc" }))).toEqual([
      "https://rpc.example:8443",
      "https://horizon-testnet.stellar.org",
      "https://friendbot.stellar.org",
    ]);
  });
});
