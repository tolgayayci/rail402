import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { ConfigError, loadConfig, parseAssets } from "@rail402.dev/service";

const testnetSecret = Keypair.random().secret();
const pubnetSecret = Keypair.random().secret();
const base = {
  DATABASE_URL: "postgres://rail402:rail402@localhost:5432/rail402",
  TESTNET_RPC_URL: "https://soroban-testnet.stellar.org",
  TESTNET_SPONSOR_SECRET: testnetSecret,
};

describe("loadConfig", () => {
  it("applies safe defaults for a testnet facilitator", () => {
    const config = loadConfig(base);
    expect(config.store).toEqual({ kind: "postgres", url: base.DATABASE_URL });
    expect(config.networks).toHaveLength(1);
    const [testnet] = config.networks;
    expect(testnet).toMatchObject({
      network: "stellar:testnet",
      channelCount: 8,
      requireApiKey: false,
      autoProvisionChannels: true,
      inclusionFeeStroops: 100,
    });
    expect(testnet?.assets.map((asset) => asset.contract)).toEqual([
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    ]);
  });

  it("requires a database unless the memory store is chosen explicitly", () => {
    const { DATABASE_URL: _omit, ...withoutDatabase } = base;
    expect(() => loadConfig(withoutDatabase)).toThrow(/DATABASE_URL/);
    expect(loadConfig({ ...withoutDatabase, STORE: "memory" }).store).toEqual({ kind: "memory" });
  });

  it("requires explicit, safe mainnet settings", () => {
    const pubnet = {
      ...base,
      NETWORKS: "stellar:testnet,stellar:pubnet",
      PUBNET_RPC_URL: "https://mainnet.sorobanrpc.com",
      PUBNET_SPONSOR_SECRET: pubnetSecret,
    };
    expect(() => loadConfig(pubnet)).toThrow(/PUBNET_REQUIRE_API_KEY/);
    expect(() => loadConfig({ ...pubnet, PUBNET_REQUIRE_API_KEY: "true" })).toThrow(/API_KEY_SHA256/);
    expect(() =>
      loadConfig({ ...pubnet, PUBNET_REQUIRE_API_KEY: "false", PUBNET_RPC_URL: "http://rpc" }),
    ).toThrow(/https/);
    const config = loadConfig({ ...pubnet, PUBNET_REQUIRE_API_KEY: "false" });
    expect(config.networks.find((n) => n.network === "stellar:pubnet")).toMatchObject({
      autoProvisionChannels: false,
      assets: [
        expect.objectContaining({ contract: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" }),
      ],
    });
  });

  it("refuses one sponsor for two networks", () => {
    expect(() =>
      loadConfig({
        ...base,
        NETWORKS: "stellar:testnet,stellar:pubnet",
        PUBNET_RPC_URL: "https://mainnet.sorobanrpc.com",
        PUBNET_SPONSOR_SECRET: testnetSecret,
        PUBNET_REQUIRE_API_KEY: "false",
      }),
    ).toThrow(/own sponsor/);
  });

  it("names the variable and never echoes a secret", () => {
    const bad = "SNOTAVALIDSECRETSEED";
    try {
      loadConfig({ ...base, TESTNET_SPONSOR_SECRET: bad });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain("TESTNET_SPONSOR_SECRET");
      expect((error as Error).message).not.toContain(bad);
    }
  });

  it("rejects unknown networks and inconsistent limits", () => {
    expect(() => loadConfig({ ...base, NETWORKS: "stellar:futurenet" })).toThrow(/unknown network/);
    expect(() => loadConfig({ ...base, TESTNET_TIMEOUT_MIN_SECONDS: "400" })).toThrow(/TIMEOUT_MIN/);
    expect(() => loadConfig({ ...base, TESTNET_INCLUSION_FEE_STROOPS: "50" })).toThrow(/INCLUSION_FEE/);
  });
});

describe("parseAssets", () => {
  const usdc = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
  it("parses contract, symbol, decimals and optional bounds", () => {
    expect(parseAssets(`${usdc}:USDC:7:100:5000000`, "ASSETS")).toEqual([
      { contract: usdc, symbol: "USDC", decimals: 7, minAmount: 100n, maxAmount: 5_000_000n },
    ]);
  });

  it.each([
    ["GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO:USDC:7", /contract/],
    [`${usdc}:US-DC:7`, /symbol/],
    [`${usdc}:USDC:x`, /decimals/],
    [`${usdc}:USDC:7:9:1`, /minimum exceeds/],
    [`${usdc}:USDC:7,${usdc}:USDC:7`, /twice/],
  ])("rejects %s", (value, pattern) => {
    expect(() => parseAssets(value, "ASSETS")).toThrow(pattern);
  });
});
