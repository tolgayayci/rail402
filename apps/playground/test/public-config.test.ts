import { describe, expect, it } from "vitest";
import {
  CHECK_IDS,
  DEFAULT_CAPS,
  LAB_PATHS,
  LAB_PRICES,
  EXPERIMENT_IDS,
  SCENARIO_IDS,
} from "../src/shared/lab.ts";
import {
  parsePublicConfig,
  publicConfigSchema,
  secretLikeNames,
  type PublicConfig,
} from "../src/shared/public-config.ts";
import { RELAY_LIMITS, RELAY_MAX_REDIRECTS, RELAY_TIMEOUT_MAXIMA } from "../src/shared/relay-protocol.ts";

const account = `G${"A".repeat(55)}`;
const contract = `C${"B".repeat(55)}`;

const sampleConfig: PublicConfig = {
  version: "0.3.0",
  commit: "51beacb",
  mode: "hosted",
  network: "stellar:testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  urls: {
    public: "https://playground.rail402.dev",
    rpc: "https://soroban-testnet.stellar.org",
    horizon: "https://horizon-testnet.stellar.org",
    friendbot: "https://friendbot.stellar.org",
    facilitator: "https://testnet.rail402.dev",
    bazaar: "https://testnet.rail402.dev",
    demoSeller: "https://demo.rail402.dev",
    docs: "https://docs.rail402.dev",
  },
  explorerTemplate: "https://stellar.expert/explorer/{network}/tx/{hash}",
  asset: { contract, symbol: "USDC", decimals: 7, classic: { code: "USDC", issuer: account } },
  uptoContract: contract,
  caps: {
    perCallDefault: DEFAULT_CAPS.perCall,
    perCallLowPreset: DEFAULT_CAPS.lowCap,
    perCallCeiling: DEFAULT_CAPS.perCallCeiling,
    sessionTotal: DEFAULT_CAPS.sessionTotal,
    sessionTtlMs: DEFAULT_CAPS.sessionTtlMs,
  },
  lab: {
    enabled: true,
    payTo: account,
    paths: { sell: LAB_PATHS.sell, greedy: LAB_PATHS.greedy, offers: { ...LAB_PATHS.offers } },
    prices: {
      sell: LAB_PRICES.sell.atomic,
      greedyCap: LAB_PRICES.greedyCap.atomic,
      greedyCharge: LAB_PRICES.greedyCharge.atomic,
    },
    scenarios: [...SCENARIO_IDS],
    experiments: [...EXPERIMENT_IDS],
    checks: [...CHECK_IDS],
  },
  relay: {
    enabled: true,
    policy: { schemes: ["https:"], ports: [443], allowLoopback: false, maxRedirects: RELAY_MAX_REDIRECTS },
    limits: { ...RELAY_LIMITS },
    timeoutMaxima: { ...RELAY_TIMEOUT_MAXIMA },
  },
  onboarding: { buyAmount: "1", keepXlm: "10", faucetUrl: "https://faucet.circle.com" },
};

describe("PublicConfig", () => {
  it("accepts a complete configuration", () => {
    expect(parsePublicConfig(sampleConfig)).toEqual(sampleConfig);
    expect(parsePublicConfig(JSON.parse(JSON.stringify(sampleConfig)))).toEqual(sampleConfig);
  });

  it("is testnet only and refuses unknown or malformed fields", () => {
    expect(parsePublicConfig({ ...sampleConfig, network: "stellar:pubnet" })).toBeUndefined();
    expect(parsePublicConfig({ ...sampleConfig, extra: true })).toBeUndefined();
    expect(
      parsePublicConfig({ ...sampleConfig, urls: { ...sampleConfig.urls, rpc: "ftp://x" } }),
    ).toBeUndefined();
    expect(
      parsePublicConfig({ ...sampleConfig, caps: { ...sampleConfig.caps, perCallDefault: "0.00000001" } }),
    ).toBeUndefined();
    expect(parsePublicConfig({ ...sampleConfig, explorerTemplate: "https://x/" })).toBeUndefined();
    expect(
      parsePublicConfig({ ...sampleConfig, lab: { ...sampleConfig.lab, payTo: "S".repeat(56) } }),
    ).toBeUndefined();
    expect(parsePublicConfig(undefined)).toBeUndefined();
  });

  it("has no property name that looks like secret material", () => {
    expect(secretLikeNames(sampleConfig)).toEqual([]);
    expect(Object.keys(publicConfigSchema.shape)).toContain("networkPassphrase");
  });

  it("finds secret-looking names at any depth", () => {
    expect(
      secretLikeNames({
        a: { secretKey: 1 },
        list: [{ seed: 2 }],
        paymentSignature: 3,
        networkPassphrase: 4,
      }),
    ).toEqual(["a.secretKey", "list[0].seed", "paymentSignature"]);
  });
});
