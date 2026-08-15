import { describe, expect, it } from "vitest";
import { Asset } from "@stellar/stellar-sdk";
import { X402Error } from "@rail402/errors";
import {
  loadConfig,
  PUBNET_EURC_ISSUER,
  PUBNET_EURC_SAC,
  PUBNET_USDC_ISSUER,
  PUBNET_USDC_SAC,
} from "./config.js";

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

  it("parses facilitator auth tokens and seeds their base URLs", () => {
    const config = loadConfig({
      ...base,
      EXPLORER_FACILITATOR_AUTH: JSON.stringify({
        "https://channels.openzeppelin.com/x402/testnet": "secret-token",
      }),
    });
    expect(config.facilitatorAuth.get("https://channels.openzeppelin.com/x402/testnet")).toBe(
      "secret-token",
    );
    // Configuring auth for a facilitator also registers it as a seed.
    expect(config.facilitatorSeeds).toContain("https://channels.openzeppelin.com/x402/testnet");
  });

  it("refuses malformed or empty facilitator auth with a coded reason", () => {
    for (const bad of [
      "{not json",
      JSON.stringify(["not-an-object"]),
      JSON.stringify({ "https://x.example": "" }),
      JSON.stringify({ "not a url": "tok" }),
    ]) {
      try {
        loadConfig({ ...base, EXPLORER_FACILITATOR_AUTH: bad });
        throw new Error(`expected rejection for ${bad}`);
      } catch (error) {
        expect(error).toBeInstanceOf(X402Error);
        expect((error as X402Error).payload.code).toBe("config_invalid_value");
      }
    }
  });

  it("has empty auth and no OZ seed by default", () => {
    const config = loadConfig(base);
    expect(config.facilitatorAuth.size).toBe(0);
    expect(config.facilitatorSeeds).not.toContain("https://channels.openzeppelin.com/x402/testnet");
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

describe("pubnet built-ins", () => {
  it("resolves stellar:pubnet entirely from built-in defaults, with a FILTERED tail", () => {
    const config = loadConfig({ ...base, EXPLORER_NETWORKS: "stellar:pubnet" });
    expect(config.networks).toHaveLength(1);
    const net = config.networks[0]!;
    expect(net.passphrase).toBe("Public Global Stellar Network ; September 2015");
    expect(net.rpcUrl).toBe("https://soroban-rpc.mainnet.stellar.gateway.fm");
    expect(net.horizonUrl).toBe("https://horizon.stellar.org");
    // Unlike testnet, pubnet defaults to a filtered watch: ~250 transfer events/ledger (measured
    // 2026-08-15) make an unfiltered tail infeasible against a public RPC.
    expect(net.watchedSacs).toEqual([PUBNET_USDC_SAC, PUBNET_EURC_SAC]);
  });

  it("re-derives the pubnet SAC constants from the Circle issuers — they cannot rot", () => {
    const passphrase = "Public Global Stellar Network ; September 2015";
    expect(new Asset("USDC", PUBNET_USDC_ISSUER).contractId(passphrase)).toBe(PUBNET_USDC_SAC);
    expect(new Asset("EURC", PUBNET_EURC_ISSUER).contractId(passphrase)).toBe(PUBNET_EURC_SAC);
  });

  it("lets an override EMPTY the pubnet watch list — [] means watch every transfer", () => {
    const config = loadConfig({
      ...base,
      EXPLORER_NETWORKS: "stellar:pubnet",
      EXPLORER_NETWORK_CONFIG: JSON.stringify({ "stellar:pubnet": { watchedSacs: [] } }),
    });
    expect(config.networks[0]!.watchedSacs).toEqual([]);
  });
});

describe("bazaar off-switch and backfill cap", () => {
  it("enables the Bazaar join by default and disables it on EXPLORER_BAZAAR_URL=\"\"", () => {
    expect(loadConfig(base).bazaarUrl).toBe("https://facilitator.rail402.dev");
    expect(loadConfig({ ...base, EXPLORER_BAZAAR_URL: "" }).bazaarUrl).toBeUndefined();
  });

  it("refuses a malformed EXPLORER_BAZAAR_URL with a coded reason", () => {
    for (const bad of ["not a url", "ftp://files.example"]) {
      try {
        loadConfig({ ...base, EXPLORER_BAZAAR_URL: bad });
        throw new Error(`expected rejection for ${bad}`);
      } catch (error) {
        expect(error).toBeInstanceOf(X402Error);
        expect((error as X402Error).payload.code).toBe("config_invalid_value");
      }
    }
  });

  it("defaults the backfill to the full retention window and accepts a ledger cap", () => {
    expect(loadConfig(base).backfillMaxLedgers).toBe(0);
    expect(
      loadConfig({ ...base, EXPLORER_BACKFILL_MAX_LEDGERS: "17280" }).backfillMaxLedgers,
    ).toBe(17280);
  });

  it("exposes the backfill page-delay politeness knob", () => {
    expect(loadConfig(base).backfillPageDelayMs).toBe(250);
    expect(
      loadConfig({ ...base, EXPLORER_BACKFILL_PAGE_DELAY_MS: "1000" }).backfillPageDelayMs,
    ).toBe(1000);
  });
});
