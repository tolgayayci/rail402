import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { UPTO_TESTNET_DEPLOYMENT } from "@rail402.dev/upto";
import { ConfigError, loadConfig, networkSettingsDigest, parseAssets } from "@rail402.dev/service";
import { COLD_SIGNER, secretFile, sponsorKeyFile } from "./secret-fixtures.ts";

const testnetSecret = Keypair.random().secret();
const pubnetSecret = Keypair.random().secret();
const base = {
  DATABASE_URL: "postgres://rail402:rail402@localhost:5432/rail402",
  TESTNET_RPC_URL: "https://soroban-testnet.stellar.org",
  TESTNET_SPONSOR_SECRET: testnetSecret,
};
const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
/** Every pubnet setting that has no default, decided. */
const pubnetSettings = {
  PUBNET_RPC_SINGLE_PROVIDER: "true",
  METRICS_PRIVATE_TOKEN_SHA256: "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff",
  PUBNET_RPC_URL: "https://mainnet.sorobanrpc.com",
  PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(pubnetSecret),
  PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
  PUBNET_REQUIRE_API_KEY: "false",
  PUBNET_RATE_LIMIT_PER_MINUTE: "60",
  PUBNET_KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR: "1",
  PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "50",
  PUBNET_MAX_TX_FEE_STROOPS: "300000",
  PUBNET_INCLUSION_FEE_STROOPS: "200",
  PUBNET_ASSETS: `${PUBNET_USDC}:USDC:7:10000`,
};
const databaseFile = { DATABASE_URL_FILE: secretFile(base.DATABASE_URL) };
const pubnetOnly = {
  ...without(base, "DATABASE_URL"),
  ...databaseFile,
  NETWORKS: "stellar:pubnet",
  ...pubnetSettings,
};
const bothNetworks = { ...pubnetOnly, NETWORKS: "stellar:testnet,stellar:pubnet" };
/** An access-key file holding one pubnet key. */
function keysFile(keys: readonly Record<string, unknown>[]): string {
  return secretFile(JSON.stringify({ schemaVersion: 1, keys }));
}
const pubnetKey = {
  id: "acme-prod-1",
  sha256: "ab".repeat(32),
  networks: ["stellar:pubnet"],
  sponsorBudgetXlmPerHour: "2",
  expiresAt: "2027-04-30T00:00:00Z",
  createdAt: "2026-11-02T10:00:00Z",
};
/** Pubnet with API keys required, as `upto` on pubnet needs. */
const pubnetKeyed = { ...pubnetOnly, PUBNET_REQUIRE_API_KEY: "true", API_KEYS_FILE: keysFile([pubnetKey]) };

/** The ConfigError `load` throws: its code and message. */
function refusal(load: () => unknown): { code: string; message: string } {
  try {
    load();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return { code: (error as ConfigError).code, message: (error as ConfigError).message };
  }
  throw new Error("the configuration was accepted");
}

function without(env: Record<string, string>, ...names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));
}

describe("loadConfig", () => {
  it("applies safe defaults for a testnet facilitator", () => {
    const config = loadConfig(base);
    expect(config.store).toEqual({ kind: "postgres", url: base.DATABASE_URL, acquireTimeoutMs: 5_000 });
    expect(config.networks).toHaveLength(1);
    const [testnet] = config.networks;
    expect(testnet).toMatchObject({
      network: "stellar:testnet",
      channelCount: 8,
      requireApiKey: false,
      autoProvisionChannels: true,
      inclusionFeeStroops: 100,
      // Testnet leaves room for first payments that create balance entries.
      maxTransactionFeeStroops: 2_000_000,
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
      channelQuarantineMs: 60_000,
      reconcileThirdParty: true,
    });
    expect(
      loadConfig({
        ...base,
        SETTLE_CHANNEL_WAIT_MS: "30000",
        SETTLE_CONFIRM_TIMEOUT_MS: "0",
        RECONCILE_THIRD_PARTY_SETTLEMENTS: "false",
        SETTLE_CHANNEL_QUARANTINE_MS: "0",
      }).settlement,
    ).toEqual({
      channelWaitMs: 30_000,
      confirmTimeoutMs: 0,
      reconcileIdleMs: 5_000,
      channelQuarantineMs: 0,
      reconcileThirdParty: false,
    });
    expect(loadConfig({ ...base, SETTLE_RECONCILE_IDLE_MS: "0" }).settlement.reconcileIdleMs).toBe(0);
    expect(() => loadConfig({ ...base, SETTLE_RECONCILE_IDLE_MS: "600001" })).toThrow(
      /SETTLE_RECONCILE_IDLE_MS/,
    );
    expect(() => loadConfig({ ...base, SETTLE_CHANNEL_WAIT_MS: "-1" })).toThrow(/SETTLE_CHANNEL_WAIT_MS/);
    expect(() => loadConfig({ ...base, SETTLE_CHANNEL_QUARANTINE_MS: "3600001" })).toThrow(
      /SETTLE_CHANNEL_QUARANTINE_MS/,
    );
    expect(() => loadConfig({ ...base, SETTLE_CONFIRM_TIMEOUT_MS: "300001" })).toThrow(
      /SETTLE_CONFIRM_TIMEOUT_MS/,
    );
    expect(() => loadConfig({ ...base, RECONCILE_THIRD_PARTY_SETTLEMENTS: "yes" })).toThrow(
      /RECONCILE_THIRD_PARTY_SETTLEMENTS/,
    );
  });

  it("gives a response 30 s to reach its client unless configured", () => {
    expect(loadConfig(base).http.responseWriteTimeoutMs).toBe(30_000);
    expect(loadConfig({ ...base, RESPONSE_WRITE_TIMEOUT_MS: "5000" }).http.responseWriteTimeoutMs).toBe(
      5_000,
    );
    // There is always a deadline: switching it off would let a client that stops reading hold its response.
    expect(() => loadConfig({ ...base, RESPONSE_WRITE_TIMEOUT_MS: "0" })).toThrow(
      /RESPONSE_WRITE_TIMEOUT_MS/,
    );
    expect(() => loadConfig({ ...base, RESPONSE_WRITE_TIMEOUT_MS: "600001" })).toThrow(
      /RESPONSE_WRITE_TIMEOUT_MS/,
    );
  });

  it("reads the observability settings, watching every accepted asset's contract TTL", () => {
    const config = loadConfig(base);
    expect(config.observability).toEqual({
      metricsTokenSha256: undefined,
      metricsPrivateTokenSha256: undefined,
      budgetWarnPercent: 80,
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
      metricsPrivateTokenSha256: undefined,
      budgetWarnPercent: 80,
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

  it("migrates at startup by default, through a separate owner connection when one is set", () => {
    expect(loadConfig(base).migrations).toEqual({ onStart: true, url: undefined });
    const owner = "postgres://owner:pw@localhost:5432/rail402";
    expect(
      loadConfig({ ...base, MIGRATE_ON_START: "false", DATABASE_MIGRATION_URL: owner }).migrations,
    ).toEqual({
      onStart: false,
      url: owner,
    });
    expect(loadConfig({ ...base, DATABASE_MIGRATION_URL_FILE: secretFile(owner) }).migrations.url).toBe(
      owner,
    );
  });

  it("requires a database unless the memory store is chosen explicitly", () => {
    const { DATABASE_URL: _omit, ...withoutDatabase } = base;
    expect(() => loadConfig(withoutDatabase)).toThrow(/DATABASE_URL/);
    expect(loadConfig({ ...withoutDatabase, STORE: "memory" }).store).toEqual({ kind: "memory" });
  });

  it("requires explicit, safe mainnet settings", () => {
    const config = loadConfig(bothNetworks);
    expect(config.networks.find((n) => n.network === "stellar:pubnet")).toMatchObject({
      maxSponsorSpendPerHourStroops: 500_000_000n,
      autoProvisionChannels: false,
      maxTransactionFeeStroops: 300_000,
      inclusionFeeStroops: 200,
      expirationMarginLedgers: 2,
      assets: [expect.objectContaining({ contract: PUBNET_USDC, minAmount: 10_000n })],
    });
    expect(refusal(() => loadConfig({ ...bothNetworks, PUBNET_RPC_URL: "http://rpc" }))).toMatchObject({
      code: "config_pubnet_rpc_insecure",
      message: expect.stringMatching(/https/) as string,
    });
    expect(refusal(() => loadConfig({ ...bothNetworks, PUBNET_REQUIRE_API_KEY: "true" }))).toMatchObject({
      code: "config_access_keys_missing",
      message: expect.stringMatching(/API_KEYS_FILE/) as string,
    });
  });

  it.each([
    ["PUBNET_REQUIRE_API_KEY", "config_pubnet_api_key_policy_missing"],
    ["PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR", "config_pubnet_budget_missing"],
    ["PUBNET_MAX_TX_FEE_STROOPS", "config_pubnet_fee_ceiling_missing"],
    ["PUBNET_INCLUSION_FEE_STROOPS", "config_pubnet_fee_ceiling_missing"],
    ["PUBNET_ASSETS", "config_pubnet_assets_missing"],
    ["PUBNET_SPONSOR_COLD_SIGNER", "config_pubnet_cold_signer_missing"],
  ])("refuses pubnet without %s (%s)", (variable, code) => {
    const failure = refusal(() => loadConfig(without(bothNetworks, variable)));
    expect(failure.code).toBe(code);
    expect(failure.message).toContain(variable);
  });

  it.each([
    ["testnet", base, "TESTNET_SPONSOR_SECRET", "TESTNET_SPONSOR_SECRET"],
    ["pubnet", bothNetworks, "PUBNET_SPONSOR_SECRET_FILE", "PUBNET_SPONSOR_SECRET_FILE"],
  ])(
    "refuses %s without a sponsor seed (config_sponsor_secret_missing)",
    (_network, env, variable, named) => {
      const failure = refusal(() => loadConfig(without(env, variable)));
      expect(failure).toMatchObject({ code: "config_sponsor_secret_missing" });
      expect(failure.message).toContain(named);
      // An empty value is as missing as an absent one.
      expect(refusal(() => loadConfig({ ...env, [variable]: "" })).code).toBe(
        "config_sponsor_secret_missing",
      );
    },
  );

  it.each([
    ["testnet", base, "TESTNET_RPC_URL"],
    ["pubnet", bothNetworks, "PUBNET_RPC_URL"],
  ])("refuses %s without an RPC provider (config_rpc_missing)", (_network, env, variable) => {
    const failure = refusal(() => loadConfig(without(env, variable)));
    expect(failure.code).toBe("config_rpc_missing");
    expect(failure.message).toContain(variable);
    const prefix = variable.replace("RPC_URL", "");
    expect(refusal(() => loadConfig({ ...without(env, variable), [`${prefix}RPC_URLS`]: " , " })).code).toBe(
      "config_rpc_missing",
    );
  });

  it("refuses a pubnet sponsor floor of 0, which would switch readiness and the balance alert off", () => {
    expect(refusal(() => loadConfig({ ...bothNetworks, PUBNET_MIN_SPONSOR_BALANCE_XLM: "0" }))).toMatchObject(
      {
        code: "config_pubnet_sponsor_floor_invalid",
        message: expect.stringMatching(/PUBNET_MIN_SPONSOR_BALANCE_XLM/) as string,
      },
    );
    expect(
      loadConfig({ ...bothNetworks, TESTNET_MIN_SPONSOR_BALANCE_XLM: "0" }).networks.find(
        (n) => n.network === "stellar:testnet",
      ),
    ).toMatchObject({ minSponsorBalanceStroops: 0n });
  });

  it("requires the pubnet sponsor's cold signer for the signer check, never the sponsor key itself", () => {
    expect(loadConfig(bothNetworks).networks.find((n) => n.network === "stellar:pubnet")).toMatchObject({
      checkSponsorSigners: true,
      sponsorColdSigner: COLD_SIGNER,
    });
    expect(
      refusal(() =>
        loadConfig({
          ...bothNetworks,
          PUBNET_SPONSOR_COLD_SIGNER: Keypair.fromSecret(pubnetSecret).publicKey(),
        }),
      ),
    ).toMatchObject({
      code: "config_invalid",
      message: expect.stringMatching(/sponsor's own key/) as string,
    });
    expect(refusal(() => loadConfig({ ...bothNetworks, PUBNET_SPONSOR_COLD_SIGNER: "GNOTAKEY" })).code).toBe(
      "config_invalid",
    );
    // Without the check, no cold signer is needed.
    const unchecked = loadConfig({
      ...without(bothNetworks, "PUBNET_SPONSOR_COLD_SIGNER"),
      PUBNET_ALLOW_SINGLE_SIGNER_SPONSOR: "true",
    }).networks.find((n) => n.network === "stellar:pubnet");
    expect(unchecked).toMatchObject({ checkSponsorSigners: false, sponsorColdSigner: undefined });
  });

  it("refuses pubnet without explicit fee ceilings and an inclusion floor of at least 200", () => {
    expect(refusal(() => loadConfig({ ...pubnetOnly, PUBNET_INCLUSION_FEE_STROOPS: "199" }))).toMatchObject({
      code: "config_pubnet_inclusion_floor_too_low",
      message: expect.stringMatching(/PUBNET_ALLOW_INCLUSION_FEE_BELOW_FLOOR/) as string,
    });
    const overridden = loadConfig({
      ...pubnetOnly,
      PUBNET_INCLUSION_FEE_STROOPS: "100",
      PUBNET_ALLOW_INCLUSION_FEE_BELOW_FLOOR: "true",
    }).networks[0];
    expect(overridden?.inclusionFeeStroops).toBe(100);
    // Testnet keeps the spec minimum without any override.
    expect(loadConfig(base).networks[0]?.inclusionFeeStroops).toBe(100);
    expect(
      refusal(() => loadConfig({ ...pubnetOnly, PUBNET_INCLUSION_FEE_CAP_STROOPS: "150" })),
    ).toMatchObject({ code: "config_fee_bounds_invalid" });
  });

  it("requires an explicit minimum amount for every pubnet asset", () => {
    const other = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    for (const assets of [
      `${PUBNET_USDC}:USDC:7`,
      `${PUBNET_USDC}:USDC:7:0`,
      `${PUBNET_USDC}:USDC:7:10000,${other}:EURC:7`,
    ]) {
      const failure = refusal(() => loadConfig({ ...pubnetOnly, PUBNET_ASSETS: assets }));
      expect(failure.code, assets).toBe("config_pubnet_asset_min_missing");
      expect(failure.message, assets).toContain("PUBNET_ASSETS");
    }
    // Testnet entries may still leave the minimum out.
    expect(loadConfig({ ...base, TESTNET_ASSETS: `${other}:EURC:7` }).networks[0]?.assets[0]?.minAmount).toBe(
      1n,
    );
  });

  it("defaults the pubnet expiration margin to two ledgers", () => {
    expect(loadConfig(pubnetOnly).networks[0]?.expirationMarginLedgers).toBe(2);
    expect(
      loadConfig({ ...pubnetOnly, PUBNET_EXPIRATION_MARGIN_LEDGERS: "1" }).networks[0]
        ?.expirationMarginLedgers,
    ).toBe(1);
    expect(loadConfig(base).networks[0]?.expirationMarginLedgers).toBe(1);
  });

  it("limits payers and payTos on pubnet by default, and nowhere else", () => {
    const [testnet, pubnet] = loadConfig(bothNetworks).networks;
    expect(testnet?.settleLimits).toEqual({
      payerPerMinute: undefined,
      payToPerMinute: undefined,
      payerFailuresPerHour: undefined,
    });
    expect(pubnet?.settleLimits).toEqual({ payerPerMinute: 10, payToPerMinute: 60, payerFailuresPerHour: 3 });
    expect(
      loadConfig({
        ...bothNetworks,
        PUBNET_MAX_SETTLEMENTS_PER_PAYER_PER_MINUTE: "0",
        TESTNET_PAYER_FAILURES_PER_HOUR: "5",
      }).networks.map((network) => [
        network.settleLimits.payerPerMinute,
        network.settleLimits.payerFailuresPerHour,
      ]),
    ).toEqual([
      [undefined, 5],
      [undefined, 3],
    ]);
  });

  it("caps the pubnet TTL keeper's daily spend at one extension unless configured", () => {
    const upto = {
      ...pubnetKeyed,
      PUBNET_UPTO_ENABLED: "true",
      PUBNET_UPTO_CONTRACT: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      PUBNET_UPTO_WASM_HASH: "ab".repeat(32),
      PUBNET_UPTO_MAX_TX_FEE_STROOPS: "500000",
      PUBNET_UPTO_TTL_MAX_FEE_STROOPS: "50000000",
    };
    expect(loadConfig(upto).networks[0]?.upto?.ttl.dailyMaxFeeStroops).toBe(50_000_000);
    expect(
      loadConfig({ ...upto, PUBNET_UPTO_TTL_DAILY_MAX_FEE_STROOPS: "120000000" }).networks[0]?.upto?.ttl
        .dailyMaxFeeStroops,
    ).toBe(120_000_000);
    expect(loadConfig(base).networks[0]?.upto?.ttl.dailyMaxFeeStroops).toBeUndefined();
  });

  it("reads several RPC providers per network, in order, without echoing their URLs", () => {
    const listed = loadConfig({
      ...without(base, "TESTNET_RPC_URL"),
      TESTNET_RPC_URLS: "paid=https://paid.example/rpc/SECRETKEY,https://free.example/rpc",
    }).networks[0];
    expect(listed?.rpcProviders).toEqual([
      { alias: "paid", url: "https://paid.example/rpc/SECRETKEY" },
      { alias: "rpc1", url: "https://free.example/rpc" },
    ]);
    expect(listed?.rpcUrl).toBe("https://paid.example/rpc/SECRETKEY");
    expect(loadConfig(base).networks[0]?.rpcProviders).toEqual([
      { alias: "primary", url: base.TESTNET_RPC_URL },
    ]);
    expect(refusal(() => loadConfig({ ...base, TESTNET_RPC_URLS: "https://free.example/rpc" })).code).toBe(
      "config_rpc_conflict",
    );
    const bad = refusal(() =>
      loadConfig({
        ...without(base, "TESTNET_RPC_URL"),
        TESTNET_RPC_URLS: "a=ftp://SECRETKEY@x,b=https://y",
      }),
    );
    expect(bad.message).not.toContain("SECRETKEY");
    expect(
      refusal(() =>
        loadConfig({ ...without(base, "TESTNET_RPC_URL"), TESTNET_RPC_URLS: "a=https://x,a=https://y" }),
      ).message,
    ).toMatch(/alias twice/);
  });

  it("requires two pubnet RPC providers when several networks are served, unless told otherwise", () => {
    const two = {
      ...without(bothNetworks, "PUBNET_RPC_URL", "PUBNET_RPC_SINGLE_PROVIDER"),
      PUBNET_RPC_URLS: "a=https://a.example,b=https://b.example",
    };
    expect(loadConfig(two).networks[1]?.rpcProviders.map((provider) => provider.alias)).toEqual(["a", "b"]);
    expect(refusal(() => loadConfig(without(bothNetworks, "PUBNET_RPC_SINGLE_PROVIDER"))).code).toBe(
      "config_pubnet_rpc_fallback_missing",
    );
    expect(
      refusal(() => loadConfig({ ...two, PUBNET_RPC_URLS: "a=https://a.example,b=http://b.example" })).code,
    ).toBe("config_pubnet_rpc_insecure");
    // A pubnet-only deployment may run on one provider.
    expect(
      loadConfig(without(pubnetOnly, "PUBNET_RPC_SINGLE_PROVIDER")).networks[0]?.rpcProviders,
    ).toHaveLength(1);
  });

  it("keeps the previous upto authority for at most the longest timeout after a rotation", () => {
    const previous = Keypair.random().secret();
    const soon = new Date(Date.now() + 120_000).toISOString();
    const upto = loadConfig({
      ...base,
      TESTNET_PREVIOUS_SPONSOR_SECRET: previous,
      TESTNET_PREVIOUS_AUTHORITY_UNTIL: soon,
    }).networks[0]?.upto;
    expect(upto?.previousAuthority).toEqual({ sponsorSecret: previous, validUntil: new Date(soon) });
    expect(() => loadConfig({ ...base, TESTNET_PREVIOUS_SPONSOR_SECRET: previous })).toThrow(/go together/);
    expect(() =>
      loadConfig({
        ...base,
        TESTNET_PREVIOUS_SPONSOR_SECRET: previous,
        TESTNET_PREVIOUS_AUTHORITY_UNTIL: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ).toThrow(/TIMEOUT_MAX_SECONDS/);
    // A grace already over is not loaded.
    expect(
      loadConfig({
        ...base,
        TESTNET_PREVIOUS_SPONSOR_SECRET: previous,
        TESTNET_PREVIOUS_AUTHORITY_UNTIL: new Date(Date.now() - 1_000).toISOString(),
      }).networks[0]?.upto?.previousAuthority,
    ).toBeUndefined();
    // The settings digest never includes the previous secret: another secret digests the same.
    const digestWith = (secret: string) => {
      const [network] = loadConfig({
        ...base,
        TESTNET_PREVIOUS_SPONSOR_SECRET: secret,
        TESTNET_PREVIOUS_AUTHORITY_UNTIL: soon,
      }).networks;
      if (network === undefined) throw new Error("no network");
      return networkSettingsDigest(network);
    };
    expect(digestWith(previous)).toBe(digestWith(Keypair.random().secret()));
  });

  it("keeps testnet defaults out of the pubnet configuration", () => {
    const [testnet, pubnet] = loadConfig(bothNetworks).networks;
    expect(testnet).toMatchObject({ maxTransactionFeeStroops: 2_000_000, inclusionFeeStroops: 100 });
    expect(pubnet).toMatchObject({ maxTransactionFeeStroops: 300_000, inclusionFeeStroops: 200 });
    expect(pubnet?.upto).toBeUndefined();
    expect(pubnet?.autoProvisionChannels).toBe(false);
  });

  it("codes every refusal, config_invalid for malformed values", () => {
    expect(refusal(() => loadConfig({ ...base, PORT: "0" }))).toMatchObject({ code: "config_invalid" });
    expect(refusal(() => loadConfig({ ...base, TESTNET_INCLUSION_FEE_STROOPS: "2000000" }))).toMatchObject({
      code: "config_fee_bounds_invalid",
    });
  });

  it("digests each network's effective settings without the sponsor secret", () => {
    const [network] = loadConfig(base).networks;
    if (network === undefined) throw new Error("no network");
    const digest = networkSettingsDigest(network);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // The secret does not take part: another sponsor with the same settings digests the same.
    const other = loadConfig({ ...base, TESTNET_SPONSOR_SECRET: Keypair.random().secret() }).networks[0];
    if (other === undefined) throw new Error("no network");
    expect(networkSettingsDigest(other)).toBe(digest);
    const changed = loadConfig({ ...base, TESTNET_MAX_TX_FEE_STROOPS: "900000" }).networks[0];
    if (changed === undefined) throw new Error("no network");
    expect(networkSettingsDigest(changed)).not.toBe(digest);
  });

  it("reads the fee ceilings per network, each configurable", () => {
    const testnet = loadConfig({
      ...base,
      TESTNET_MAX_TX_FEE_STROOPS: "250000",
      TESTNET_UPTO_MAX_TX_FEE_STROOPS: "400000",
    }).networks[0];
    expect(testnet?.maxTransactionFeeStroops).toBe(250_000);
    expect(testnet?.upto?.maxTransactionFeeStroops).toBe(400_000);
    const pubnet = loadConfig({ ...pubnetOnly, PUBNET_MAX_TX_FEE_STROOPS: "600000" }).networks[0];
    expect(pubnet?.maxTransactionFeeStroops).toBe(600_000);
    // The inclusion-fee bounds are checked against the ceiling in force, default or configured.
    expect(() => loadConfig({ ...base, TESTNET_INCLUSION_FEE_STROOPS: "2000001" })).toThrow(
      /INCLUSION_FEE_STROOPS exceeds TESTNET_MAX_TX_FEE_STROOPS/,
    );
    expect(
      loadConfig({ ...base, TESTNET_INCLUSION_FEE_CAP_STROOPS: "900000" }).networks[0]
        ?.inclusionFeeCapStroops,
    ).toBe(900_000);
    expect(() => loadConfig({ ...pubnetOnly, PUBNET_INCLUSION_FEE_CAP_STROOPS: "900000" })).toThrow(
      /PUBNET_INCLUSION_FEE_CAP_STROOPS exceeds PUBNET_MAX_TX_FEE_STROOPS/,
    );
  });

  it("refuses loopback discovery fetches on a service that serves pubnet", () => {
    expect(() => loadConfig({ ...bothNetworks, DISCOVERY_ALLOW_LOOPBACK: "true" })).toThrow(
      /DISCOVERY_ALLOW_LOOPBACK/,
    );
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
      ...pubnetKeyed,
      PUBNET_UPTO_MAX_TX_FEE_STROOPS: "500000",
      PUBNET_UPTO_TTL_MAX_FEE_STROOPS: "50000000",
    };
    expect(loadConfig(pubnet).networks[0]?.upto).toBeUndefined();
    expect(() => loadConfig({ ...pubnet, PUBNET_UPTO_ENABLED: "true" })).toThrow(
      /PUBNET_UPTO_CONTRACT and PUBNET_UPTO_WASM_HASH/,
    );
    const contract = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    expect(() =>
      loadConfig({ ...pubnet, PUBNET_UPTO_ENABLED: "true", PUBNET_UPTO_CONTRACT: contract }),
    ).toThrow(/PUBNET_UPTO_WASM_HASH/);
    for (const missing of [
      { PUBNET_UPTO_ENABLED: "true" },
      { PUBNET_UPTO_ENABLED: "true", PUBNET_UPTO_CONTRACT: contract },
      { PUBNET_UPTO_ENABLED: "true", PUBNET_UPTO_WASM_HASH: "ab".repeat(32) },
    ]) {
      expect(refusal(() => loadConfig({ ...pubnet, ...missing })).code).toBe("config_upto_contract_missing");
    }
    expect(refusal(() => loadConfig({ ...base, TESTNET_UPTO_CONTRACT: contract })).code).toBe(
      "config_upto_contract_missing",
    );
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
    expect(enabled?.upto?.ttl).toMatchObject({ autoRestore: false, keeper: true, maxFeeStroops: 50_000_000 });
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

    // Rule 7 and the hold after a restore never count ledgers shorter than a second.
    expect(() => loadConfig({ ...base, TESTNET_UPTO_LEDGER_SECONDS: "0.5" })).toThrow(/UPTO_LEDGER_SECONDS/);

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
      loadConfig({ ...bothNetworks, PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(testnetSecret) }),
    ).toThrow(/own sponsor/);
  });

  it("requires explicit upto fee ceilings on pubnet, including the TTL keeper's", () => {
    const contract = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const upto = {
      ...pubnetKeyed,
      PUBNET_UPTO_ENABLED: "true",
      PUBNET_UPTO_CONTRACT: contract,
      PUBNET_UPTO_WASM_HASH: "ab".repeat(32),
      PUBNET_UPTO_MAX_TX_FEE_STROOPS: "500000",
      PUBNET_UPTO_TTL_MAX_FEE_STROOPS: "50000000",
    };
    expect(loadConfig(upto).networks[0]?.upto).toBeDefined();
    for (const variable of ["PUBNET_UPTO_MAX_TX_FEE_STROOPS", "PUBNET_UPTO_TTL_MAX_FEE_STROOPS"]) {
      const failure = refusal(() => loadConfig(without(upto, variable)));
      expect(failure.code, variable).toBe("config_pubnet_fee_ceiling_missing");
      expect(failure.message, variable).toContain(variable);
    }
    // Without the keeper, no extension is ever paid for, so its ceiling is not needed.
    expect(
      loadConfig({ ...without(upto, "PUBNET_UPTO_TTL_MAX_FEE_STROOPS"), PUBNET_UPTO_TTL_KEEPER: "false" })
        .networks[0]?.upto?.ttl.keeper,
    ).toBe(false);
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
