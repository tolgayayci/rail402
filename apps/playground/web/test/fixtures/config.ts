/** A complete public configuration, as the hosted Playground serves it. */
import {
  CHECK_IDS,
  DEFAULT_CAPS,
  EXPERIMENT_IDS,
  LAB_PATHS,
  LAB_PRICES,
  SCENARIO_IDS,
} from "../../../src/shared/lab.ts";
import type { PublicConfig } from "../../../src/shared/public-config.ts";
import {
  RELAY_LIMITS,
  RELAY_MAX_REDIRECTS,
  RELAY_TIMEOUT_MAXIMA,
} from "../../../src/shared/relay-protocol.ts";
import { IDS, URLS } from "./ids.ts";

export const CONFIG: PublicConfig = {
  version: "0.3.0",
  commit: "ee73b48",
  mode: "hosted",
  network: "stellar:testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  urls: {
    public: URLS.public,
    rpc: "https://soroban-testnet.stellar.org",
    horizon: "https://horizon-testnet.stellar.org",
    friendbot: "https://friendbot.stellar.org",
    facilitator: URLS.facilitator,
    bazaar: URLS.facilitator,
    demoSeller: URLS.demoSeller,
    docs: URLS.docs,
  },
  explorerTemplate: "https://stellar.expert/explorer/{network}/tx/{hash}",
  asset: {
    contract: IDS.usdc,
    symbol: "USDC",
    decimals: 7,
    classic: { code: "USDC", issuer: IDS.usdcIssuer },
  },
  uptoContract: IDS.uptoContract,
  caps: {
    perCallDefault: DEFAULT_CAPS.perCall,
    perCallLowPreset: DEFAULT_CAPS.lowCap,
    perCallCeiling: DEFAULT_CAPS.perCallCeiling,
    sessionTotal: DEFAULT_CAPS.sessionTotal,
    sessionTtlMs: DEFAULT_CAPS.sessionTtlMs,
  },
  lab: {
    enabled: true,
    payTo: IDS.playgroundPayTo,
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
