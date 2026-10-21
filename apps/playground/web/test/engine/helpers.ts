import { Keypair, StrKey, buildAuthorizationEntryPreimage } from "@stellar/stellar-sdk";
import { USDC, TESTNET } from "@rail402.dev/stellar";
import {
  UPTO_TESTNET_DEPLOYMENT,
  authorizationPreimage,
  unsignedPayerEntry,
  type UptoTerms,
} from "@rail402.dev/upto";
import { transferAuthorization } from "../../../../../packages/sdk/test/chain-fixtures.ts";
import {
  CHECK_IDS,
  DEFAULT_CAPS,
  LAB_PATHS,
  LAB_PRICES,
  EXPERIMENT_IDS,
  SCENARIO_IDS,
} from "../../../src/shared/lab.ts";
import type { PublicConfig } from "../../../src/shared/public-config.ts";
import {
  RELAY_LIMITS,
  RELAY_MAX_REDIRECTS,
  RELAY_TIMEOUT_MAXIMA,
} from "../../../src/shared/relay-protocol.ts";

export const ORIGIN = "https://playground.example";
export const DEMO = "https://demo.example";
export const USDC_CONTRACT = USDC[TESTNET].contract;
export const UPTO_CONTRACT = UPTO_TESTNET_DEPLOYMENT.address;
export const PAY_TO = Keypair.random().publicKey();
export const ISSUER = Keypair.random().publicKey();
export const OTHER_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));

export function testConfig(overrides: Partial<PublicConfig> = {}): PublicConfig {
  return {
    version: "0.4.0",
    commit: "test",
    mode: "hosted",
    network: "stellar:testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    urls: {
      public: ORIGIN,
      rpc: "https://rpc.example",
      horizon: "https://horizon.example",
      friendbot: "https://friendbot.example",
      facilitator: "https://facilitator.example",
      bazaar: "https://facilitator.example",
      demoSeller: DEMO,
      docs: "https://docs.example",
    },
    explorerTemplate: "https://explorer.example/{network}/tx/{hash}",
    asset: {
      contract: USDC_CONTRACT,
      symbol: "USDC",
      decimals: 7,
      classic: { code: "USDC", issuer: ISSUER },
    },
    uptoContract: UPTO_CONTRACT,
    caps: {
      perCallDefault: DEFAULT_CAPS.perCall,
      perCallLowPreset: DEFAULT_CAPS.lowCap,
      perCallCeiling: DEFAULT_CAPS.perCallCeiling,
      sessionTotal: DEFAULT_CAPS.sessionTotal,
      sessionTtlMs: DEFAULT_CAPS.sessionTtlMs,
    },
    lab: {
      enabled: true,
      payTo: PAY_TO,
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
    onboarding: { buyAmount: "1", keepXlm: "10", faucetUrl: "https://faucet.example" },
    ...overrides,
  };
}

/** A 402 payment request with one exact USDC option. */
export function exactRequired(
  options: { amount?: string; payTo?: string; error?: string; bazaar?: boolean } = {},
) {
  return {
    x402Version: 2,
    ...(options.error === undefined ? {} : { error: options.error }),
    resource: { url: `${DEMO}/weather?city=Ankara`, description: "Weather", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: "stellar:testnet",
        asset: USDC_CONTRACT,
        amount: options.amount ?? "10000",
        payTo: options.payTo ?? PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
    ],
    ...(options.bazaar === true
      ? {
          extensions: {
            bazaar: { info: { input: { type: "http", method: "GET" }, output: {} }, schema: {} },
          },
        }
      : {}),
  };
}

/** Base64 of JSON, as x402 headers carry it. */
export function header(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

const PASSPHRASE = "Test SDF Network ; September 2015";

/** The base64 preimage a payer signs for an exact `transfer(payer → payTo, amount)`. */
export function exactPreimage(options: {
  payer: string;
  payTo: string;
  amount: bigint;
  nonce: bigint;
  expiration: number;
}): string {
  const entry = transferAuthorization({
    asset: USDC_CONTRACT,
    payer: options.payer,
    payTo: options.payTo,
    amount: options.amount,
    nonce: options.nonce,
  });
  return buildAuthorizationEntryPreimage(entry, options.expiration, PASSPHRASE).toXDR("base64");
}

/** The base64 preimage a payer signs for upto terms on the canonical contract. */
export function uptoPreimage(options: { payer: string; terms: UptoTerms; nonce: bigint }): string {
  const entry = unsignedPayerEntry({
    contract: UPTO_CONTRACT,
    payer: options.payer,
    terms: options.terms,
    nonce: options.nonce,
  });
  return authorizationPreimage(entry, PASSPHRASE).toXDR("base64");
}
