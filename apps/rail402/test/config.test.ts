import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { UPTO_TESTNET_DEPLOYMENT } from "@rail402.dev/upto";
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
      // Testnet leaves room for first payments that create balance entries.
      maxTransactionFeeStroops: 1_000_000,
    });
    expect(testnet?.upto?.maxTransactionFeeStroops).toBe(5_000_000);
    expect(testnet?.assets.map((asset) => asset.contract)).toEqual([
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    ]);
  });

  it("reads the settlement waits, defaulting to 5 s for a channel and 25 s for confirmation", () => {
    expect(loadConfig(base).settlement).toEqual({
      channelWaitMs: 5_000,
      confirmTimeoutMs: 25_000,
      reconcileIdleMs: 30_000,
      reconcileThirdParty: true,
    });
    expect(
      loadConfig({
        ...base,
        SETTLE_CHANNEL_WAIT_MS: "30000",
        SETTLE_CONFIRM_TIMEOUT_MS: "0",
        RECONCILE_THIRD_PARTY_SETTLEMENTS: "false",
      }).settlement,
    ).toEqual({
      channelWaitMs: 30_000,
      confirmTimeoutMs: 0,
      reconcileIdleMs: 5_000,
      reconcileThirdParty: false,
    });
    expect(loadConfig({ ...base, SETTLE_RECONCILE_IDLE_MS: "0" }).settlement.reconcileIdleMs).toBe(0);
    expect(() => loadConfig({ ...base, SETTLE_RECONCILE_IDLE_MS: "600001" })).toThrow(
      /SETTLE_RECONCILE_IDLE_MS/,
    );
    expect(() => loadConfig({ ...base, SETTLE_CHANNEL_WAIT_MS: "-1" })).toThrow(/SETTLE_CHANNEL_WAIT_MS/);
    expect(() => loadConfig({ ...base, SETTLE_CONFIRM_TIMEOUT_MS: "300001" })).toThrow(
      /SETTLE_CONFIRM_TIMEOUT_MS/,
    );
    expect(() => loadConfig({ ...base, RECONCILE_THIRD_PARTY_SETTLEMENTS: "yes" })).toThrow(
      /RECONCILE_THIRD_PARTY_SETTLEMENTS/,
    );
  });

  it("reads the observability settings, watching every accepted asset's contract TTL", () => {
    const config = loadConfig(base);
    expect(config.observability).toEqual({
      metricsTokenSha256: undefined,
      contractTtl: { pollMs: 300_000, warnLedgers: 518_400, criticalLedgers: 120_960 },
    });
    expect(config.networks[0]?.ttlContracts).toEqual([
      { alias: "USDC", contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" },
      { alias: "upto", contract: UPTO_TESTNET_DEPLOYMENT.address },
    ]);
    const extra = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const token = "A".repeat(64);
    const custom = loadConfig({
      ...base,
      METRICS_TOKEN_SHA256: token,
      CONTRACT_TTL_POLL_MS: "60000",
      CONTRACT_TTL_WARN_LEDGERS: "1000",
      CONTRACT_TTL_CRITICAL_LEDGERS: "100",
      TESTNET_TTL_CONTRACTS: `payments:${extra}`,
    });
    expect(custom.observability).toEqual({
      metricsTokenSha256: token.toLowerCase(),
      contractTtl: { pollMs: 60_000, warnLedgers: 1_000, criticalLedgers: 100 },
    });
    expect(custom.networks[0]?.ttlContracts.map((watched) => watched.alias)).toEqual([
      "USDC",
      "upto",
      "payments",
    ]);
    expect(() => loadConfig({ ...base, METRICS_TOKEN_SHA256: "secret" })).toThrow(/METRICS_TOKEN_SHA256/);
    expect(() =>
      loadConfig({ ...base, CONTRACT_TTL_WARN_LEDGERS: "10", CONTRACT_TTL_CRITICAL_LEDGERS: "20" }),
    ).toThrow(/CONTRACT_TTL_CRITICAL_LEDGERS/);
    expect(() => loadConfig({ ...base, TESTNET_TTL_CONTRACTS: `USDC:${extra}` })).toThrow(/used twice/);
    expect(() => loadConfig({ ...base, TESTNET_TTL_CONTRACTS: "x:GABC" })).toThrow(/contract address/);
    expect(() => loadConfig({ ...base, TESTNET_TTL_CONTRACTS: `bad alias:${extra}` })).toThrow(
      /ALIAS:CONTRACT/,
    );
    expect(() =>
      loadConfig({
        ...base,
        TESTNET_TTL_CONTRACTS: "usdc:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      }),
    ).toThrow(/already watched/);
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
    expect(() => loadConfig({ ...pubnet, PUBNET_REQUIRE_API_KEY: "false" })).toThrow(
      /PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR must be set/,
    );
    const decided = { ...pubnet, PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "50" };
    expect(() => loadConfig({ ...decided, PUBNET_REQUIRE_API_KEY: "true" })).toThrow(/API_KEY_SHA256/);
    expect(() =>
      loadConfig({ ...decided, PUBNET_REQUIRE_API_KEY: "false", PUBNET_RPC_URL: "http://rpc" }),
    ).toThrow(/https/);
    const config = loadConfig({ ...decided, PUBNET_REQUIRE_API_KEY: "false" });
    expect(config.networks.find((n) => n.network === "stellar:pubnet")).toMatchObject({
      maxSponsorSpendPerHourStroops: 500_000_000n,
      autoProvisionChannels: false,
      maxTransactionFeeStroops: 300_000,
      assets: [
        expect.objectContaining({ contract: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" }),
      ],
    });
  });

  it("reads the fee ceilings per network, each configurable", () => {
    const testnet = loadConfig({
      ...base,
      TESTNET_MAX_TX_FEE_STROOPS: "250000",
      TESTNET_UPTO_MAX_TX_FEE_STROOPS: "400000",
    }).networks[0];
    expect(testnet?.maxTransactionFeeStroops).toBe(250_000);
    expect(testnet?.upto?.maxTransactionFeeStroops).toBe(400_000);
    const pubnet = loadConfig({
      ...base,
      NETWORKS: "stellar:pubnet",
      PUBNET_RPC_URL: "https://mainnet.sorobanrpc.com",
      PUBNET_SPONSOR_SECRET: pubnetSecret,
      PUBNET_REQUIRE_API_KEY: "false",
      PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "50",
      PUBNET_MAX_TX_FEE_STROOPS: "600000",
    }).networks[0];
    expect(pubnet?.maxTransactionFeeStroops).toBe(600_000);
    // The inclusion-fee bounds are checked against the ceiling in force, default or configured.
    expect(() => loadConfig({ ...base, TESTNET_INCLUSION_FEE_STROOPS: "1000001" })).toThrow(
      /INCLUSION_FEE_STROOPS exceeds TESTNET_MAX_TX_FEE_STROOPS/,
    );
    expect(
      loadConfig({ ...base, TESTNET_INCLUSION_FEE_CAP_STROOPS: "900000" }).networks[0]
        ?.inclusionFeeCapStroops,
    ).toBe(900_000);
    expect(() =>
      loadConfig({
        ...base,
        NETWORKS: "stellar:pubnet",
        PUBNET_RPC_URL: "https://mainnet.sorobanrpc.com",
        PUBNET_SPONSOR_SECRET: pubnetSecret,
        PUBNET_REQUIRE_API_KEY: "false",
        PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "50",
        PUBNET_INCLUSION_FEE_CAP_STROOPS: "900000",
      }),
    ).toThrow(/PUBNET_INCLUSION_FEE_CAP_STROOPS exceeds PUBNET_MAX_TX_FEE_STROOPS/);
  });

  it("refuses loopback discovery fetches on a service that serves pubnet", () => {
    expect(() =>
      loadConfig({
        ...base,
        NETWORKS: "stellar:testnet,stellar:pubnet",
        PUBNET_RPC_URL: "https://mainnet.sorobanrpc.com",
        PUBNET_SPONSOR_SECRET: pubnetSecret,
        PUBNET_REQUIRE_API_KEY: "false",
        PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "50",
        DISCOVERY_ALLOW_LOOPBACK: "true",
      }),
    ).toThrow(/DISCOVERY_ALLOW_LOOPBACK/);
  });

  it("serves upto on testnet by default with the canonical contract, and never on pubnet unless enabled", () => {
    const testnet = loadConfig(base).networks[0];
    expect(testnet?.upto).toEqual({
      contract: UPTO_TESTNET_DEPLOYMENT.address,
      wasmHash: UPTO_TESTNET_DEPLOYMENT.wasmHash,
      zeroSettlement: "onchain",
      maxTransactionFeeStroops: 5_000_000,
      ttl: {
        keeper: true,
        extendBelowLedgers: 518_400,
        extendToLedgers: undefined,
        autoRestore: true,
        maxFeeStroops: 500_000_000,
      },
    });
    expect(loadConfig({ ...base, TESTNET_UPTO_ENABLED: "false" }).networks[0]).toMatchObject({
      upto: undefined,
      ttlContracts: [expect.objectContaining({ alias: "USDC" })],
    });
    // upto needs a timeout of one ledger more than the margin to be acceptable at all.
    expect(() =>
      loadConfig({ ...base, TESTNET_EXPIRATION_MARGIN_LEDGERS: "60", TESTNET_TIMEOUT_MAX_SECONDS: "300" }),
    ).toThrow(/TESTNET_TIMEOUT_MAX_SECONDS must be at least 305/);
    expect(
      loadConfig({ ...base, TESTNET_EXPIRATION_MARGIN_LEDGERS: "59", TESTNET_TIMEOUT_MAX_SECONDS: "300" })
        .networks[0]?.upto,
    ).toBeDefined();

    const pubnet = {
      ...base,
      NETWORKS: "stellar:pubnet",
      PUBNET_RPC_URL: "https://mainnet.sorobanrpc.com",
      PUBNET_SPONSOR_SECRET: pubnetSecret,
      PUBNET_REQUIRE_API_KEY: "false",
      PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "50",
    };
    expect(loadConfig(pubnet).networks[0]?.upto).toBeUndefined();
    expect(() => loadConfig({ ...pubnet, PUBNET_UPTO_ENABLED: "true" })).toThrow(
      /PUBNET_UPTO_CONTRACT and PUBNET_UPTO_WASM_HASH/,
    );
    const contract = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    expect(() =>
      loadConfig({ ...pubnet, PUBNET_UPTO_ENABLED: "true", PUBNET_UPTO_CONTRACT: contract }),
    ).toThrow(/PUBNET_UPTO_WASM_HASH/);
    const enabled = loadConfig({
      ...pubnet,
      PUBNET_UPTO_ENABLED: "true",
      PUBNET_UPTO_CONTRACT: contract,
      PUBNET_UPTO_WASM_HASH: "AB".repeat(32),
    }).networks[0];
    expect(enabled?.upto).toMatchObject({
      contract,
      wasmHash: "ab".repeat(32),
      // A zero settled on-chain would cost the sponsor a fee for nothing.
      zeroSettlement: "offchain",
      maxTransactionFeeStroops: 500_000,
      // Restoring pays rent from the sponsor: on mainnet an operator decides.
    });
    expect(enabled?.upto?.ttl).toMatchObject({ autoRestore: false, keeper: true });
    const pubnetUpto = {
      ...pubnet,
      PUBNET_UPTO_ENABLED: "true",
      PUBNET_UPTO_CONTRACT: contract,
      PUBNET_UPTO_WASM_HASH: "ab".repeat(32),
    };
    expect(
      loadConfig({ ...pubnetUpto, PUBNET_UPTO_ZERO_SETTLEMENT: "onchain" }).networks[0]?.upto?.zeroSettlement,
    ).toBe("onchain");
    // An off-chain zero lives only in the settlement ledger, so it needs the shared, durable one.
    expect(() => loadConfig({ ...pubnetUpto, STORE: "memory" })).toThrow(
      /PUBNET_UPTO_ZERO_SETTLEMENT=offchain needs STORE=postgres/,
    );
    expect(
      loadConfig({ ...pubnetUpto, STORE: "memory", PUBNET_UPTO_ZERO_SETTLEMENT: "onchain" }).networks[0]
        ?.upto,
    ).toMatchObject({ zeroSettlement: "onchain" });
    expect(enabled?.ttlContracts.map((watched) => watched.alias)).toEqual(["USDC", "upto"]);
  });

  it("validates the upto settings", () => {
    const contract = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    expect(() => loadConfig({ ...base, TESTNET_UPTO_CONTRACT: contract })).toThrow(
      /TESTNET_UPTO_WASM_HASH is required/,
    );
    expect(() => loadConfig({ ...base, TESTNET_UPTO_WASM_HASH: "cd".repeat(32) })).toThrow(
      /does not match the canonical contract/,
    );
    expect(() => loadConfig({ ...base, TESTNET_UPTO_CONTRACT: "GABC" })).toThrow(/TESTNET_UPTO_CONTRACT/);
    expect(() => loadConfig({ ...base, TESTNET_UPTO_ZERO_SETTLEMENT: "skip" })).toThrow(
      /TESTNET_UPTO_ZERO_SETTLEMENT/,
    );
    expect(() => loadConfig({ ...base, STORE: "memory", TESTNET_UPTO_ZERO_SETTLEMENT: "offchain" })).toThrow(
      /TESTNET_UPTO_ZERO_SETTLEMENT=offchain needs STORE=postgres/,
    );
    // An authorization expiring at the current ledger can never be included.
    expect(() => loadConfig({ ...base, TESTNET_EXPIRATION_MARGIN_LEDGERS: "0" })).toThrow(
      /TESTNET_EXPIRATION_MARGIN_LEDGERS/,
    );
    expect(() => loadConfig({ ...base, TESTNET_UPTO_MAX_TX_FEE_STROOPS: "50" })).toThrow(
      /TESTNET_UPTO_MAX_TX_FEE_STROOPS/,
    );
    expect(() =>
      loadConfig({
        ...base,
        TESTNET_INCLUSION_FEE_STROOPS: "5000",
        TESTNET_INCLUSION_FEE_CAP_STROOPS: "5000",
        TESTNET_UPTO_MAX_TX_FEE_STROOPS: "1000",
      }),
    ).toThrow(/exceeds TESTNET_UPTO_MAX_TX_FEE_STROOPS/);
    expect(() =>
      loadConfig({
        ...base,
        TESTNET_UPTO_TTL_EXTEND_BELOW_LEDGERS: "1000",
        TESTNET_UPTO_TTL_EXTEND_TO_LEDGERS: "1000",
      }),
    ).toThrow(/must exceed TESTNET_UPTO_TTL_EXTEND_BELOW_LEDGERS/);
    expect(() => loadConfig({ ...base, TESTNET_TTL_CONTRACTS: `upto:${contract}` })).toThrow(/used twice/);
    expect(() =>
      loadConfig({ ...base, TESTNET_TTL_CONTRACTS: `mine:${UPTO_TESTNET_DEPLOYMENT.address}` }),
    ).toThrow(/already watched/);
    expect(() =>
      loadConfig({ ...base, TESTNET_ASSETS: `${UPTO_TESTNET_DEPLOYMENT.address}:TOKEN:7` }),
    ).toThrow(/upto contract is an accepted asset/);
    expect(() => loadConfig({ ...base, TESTNET_ASSETS: `${contract}:upto:7` })).toThrow(/symbol "upto"/);

    const custom = loadConfig({
      ...base,
      TESTNET_UPTO_CONTRACT: contract,
      TESTNET_UPTO_WASM_HASH: "ef".repeat(32),
      TESTNET_UPTO_ZERO_SETTLEMENT: "offchain",
      TESTNET_UPTO_MAX_TX_FEE_STROOPS: "750000",
      TESTNET_UPTO_LEDGER_SECONDS: "5.5",
      TESTNET_UPTO_TTL_KEEPER: "false",
      TESTNET_UPTO_TTL_EXTEND_BELOW_LEDGERS: "100",
      TESTNET_UPTO_TTL_EXTEND_TO_LEDGERS: "5000",
      TESTNET_UPTO_TTL_AUTO_RESTORE: "false",
      TESTNET_UPTO_TTL_MAX_FEE_STROOPS: "10000000",
    }).networks[0];
    expect(custom?.upto).toEqual({
      contract,
      wasmHash: "ef".repeat(32),
      zeroSettlement: "offchain",
      maxTransactionFeeStroops: 750_000,
      ledgerSeconds: 5.5,
      ttl: {
        keeper: false,
        extendBelowLedgers: 100,
        extendToLedgers: 5_000,
        autoRestore: false,
        maxFeeStroops: 10_000_000,
      },
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
        PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "50",
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
