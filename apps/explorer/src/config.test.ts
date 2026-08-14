import { describe, expect, it } from "vitest";
import { X402Error } from "@rail402/errors";
import { loadConfig } from "./config.js";

const base = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("yields a working testnet default with no env at all", () => {
    const config = loadConfig(base);
    expect(config.port).toBe(4040);
    expect(config.networks).toHaveLength(1);
    const net = config.networks[0]!;
    expect(net.network).toBe("stellar:testnet");
    expect(net.passphrase).toBe("Test SDF Network ; September 2015");
    expect(net.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(net.horizonUrl).toBe("https://horizon-testnet.stellar.org");
    expect(net.watchedSacs).toEqual([]);
    expect(config.ingestEnabled).toBe(true);
    expect(config.dbPath).toBeUndefined();
    expect(config.facilitatorSeeds).toContain("https://facilitator.rail402.dev");
    expect(config.knownUptoContracts).toEqual([
      "CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X",
    ]);
  });

  it("stays outside the upstream e2e port band 4022-4030 by default", () => {
    const { port } = loadConfig(base);
    expect(port < 4022 || port > 4030).toBe(true);
  });

  it("refuses an unknown network with no override, with a coded reason", () => {
    expect.assertions(2);
    try {
      loadConfig({ ...base, EXPLORER_NETWORKS: "stellar:otherchain" });
    } catch (error) {
      expect(error).toBeInstanceOf(X402Error);
      expect((error as X402Error).payload.code).toBe("config_network_rpc_missing");
    }
  });

  it("admits a new network purely through config — mainnet-compatible by construction", () => {
    const config = loadConfig({
      ...base,
      EXPLORER_NETWORKS: "stellar:testnet,stellar:othernet",
      EXPLORER_NETWORK_CONFIG: JSON.stringify({
        "stellar:othernet": {
          passphrase: "Other Net ; 2026",
          rpcUrl: "https://rpc.example.org",
          horizonUrl: "https://horizon.example.org",
          watchedSacs: ["CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"],
        },
      }),
    });
    expect(config.networks).toHaveLength(2);
    const other = config.networks[1]!;
    expect(other.passphrase).toBe("Other Net ; 2026");
    expect(other.watchedSacs).toHaveLength(1);
  });

  it("refuses malformed EXPLORER_NETWORK_CONFIG JSON with a coded reason", () => {
    expect.assertions(2);
    try {
      loadConfig({ ...base, EXPLORER_NETWORK_CONFIG: "{not json" });
    } catch (error) {
      expect(error).toBeInstanceOf(X402Error);
      expect((error as X402Error).payload.code).toBe("config_invalid_value");
    }
  });

  it("refuses a watchedSacs entry that is not a contract address", () => {
    expect.assertions(2);
    try {
      loadConfig({
        ...base,
        EXPLORER_NETWORK_CONFIG: JSON.stringify({
          "stellar:testnet": { watchedSacs: ["GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7"] },
        }),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(X402Error);
      expect((error as X402Error).payload.code).toBe("config_invalid_value");
    }
  });

  it("refuses a non-URL facilitator seed with a coded reason", () => {
    expect.assertions(2);
    try {
      loadConfig({ ...base, EXPLORER_FACILITATOR_SEEDS: "not a url" });
    } catch (error) {
      expect(error).toBeInstanceOf(X402Error);
      expect((error as X402Error).payload.code).toBe("config_invalid_value");
    }
  });

  it("refuses a malformed known upto contract with a coded reason", () => {
    expect.assertions(2);
    try {
      loadConfig({ ...base, EXPLORER_KNOWN_UPTO_CONTRACTS: "GDEADBEEF" });
    } catch (error) {
      expect(error).toBeInstanceOf(X402Error);
      expect((error as X402Error).payload.code).toBe("config_invalid_value");
    }
  });
});
