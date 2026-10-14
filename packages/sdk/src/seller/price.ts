import { rpc } from "@stellar/stellar-sdk";
import {
  AssetDirectory,
  CONTRACT_ADDRESS,
  USDC,
  baseAccount,
  isStellarNetwork,
  networkPassphrase,
  type StellarNetwork,
} from "@rail402.dev/stellar";
import { isValidDecimals, toAtomic } from "../money.ts";
import { sellerError } from "./codes.ts";

/**
 * A price in whole units: `"$0.01"` is USDC on the option's network; an object names the asset by
 * symbol ("USDC") or contract (C…). A custom contract needs its on-chain `decimals` (see
 * `assetDecimals`), because a price is always converted to base units here, never by rounding.
 */
export type Price =
  `$${string}` | { readonly amount: string; readonly asset: string; readonly decimals?: number };

/** A payment option as `@x402/core` route and tool configurations take it, priced in base units. */
export interface PaymentOption {
  readonly scheme: string;
  readonly network: StellarNetwork;
  readonly payTo: string;
  readonly price: {
    readonly amount: string;
    readonly asset: string;
    readonly extra?: Record<string, unknown>;
  };
  readonly maxTimeoutSeconds?: number;
  readonly extra?: Record<string, unknown>;
}

export interface ExactOptions {
  readonly network: StellarNetwork;
  /** A G… account or C… contract; muxed (M…) addresses are refused. */
  readonly payTo: string;
  readonly price: Price;
  /** How long a signed authorization stays valid; Rail402 accepts 10-300 seconds. */
  readonly maxTimeoutSeconds?: number;
  /**
   * `authorization` (the default) verifies before the handler runs and settles after it succeeds;
   * `upfront` settles before the handler runs. Pair `upfront` with `withSettleDedupe`.
   */
  readonly paymentFlow?: "authorization" | "upfront";
}

export interface UptoOptions {
  readonly network: StellarNetwork;
  /** A G… account or C… contract; muxed (M…) addresses are refused. */
  readonly payTo: string;
  /** The most a single call can be charged; the settled amount can be lower, down to zero. */
  readonly maxPrice: Price;
  /**
   * How long the buyer's authorization stays valid; it must cover the handler's worst case plus
   * settlement. Rail402 accepts 10-300 seconds.
   */
  readonly maxTimeoutSeconds?: number;
}

/** The authorization lifetimes Rail402's facilitator accepts. */
export const MIN_TIMEOUT_SECONDS = 10;
export const MAX_TIMEOUT_SECONDS = 300;

/** A converted price: the asset contract and the amount in base units. */
export interface ResolvedPrice {
  readonly asset: string;
  readonly amount: string;
  readonly decimals: number;
}

/** The `exact` payment option for a route's `accepts` or a tool's payment configuration. */
export function exact(options: ExactOptions): PaymentOption {
  const network = checkNetwork(options.network);
  const payTo = checkPayTo(options.payTo);
  const price = resolvePrice(options.price, network);
  const timeout = checkTimeout(options.maxTimeoutSeconds);
  const flow: unknown = options.paymentFlow;
  if (flow !== undefined && flow !== "authorization" && flow !== "upfront") {
    throw sellerError("seller_declaration_invalid", 'paymentFlow must be "authorization" or "upfront".', {
      path: "paymentFlow",
    });
  }
  return Object.freeze({
    scheme: "exact",
    network,
    payTo,
    price: Object.freeze({ amount: price.amount, asset: price.asset }),
    ...(timeout === undefined ? {} : { maxTimeoutSeconds: timeout }),
    ...(flow === undefined ? {} : { extra: Object.freeze({ paymentFlow: flow }) }),
  });
}

/**
 * The `upto` payment option: the buyer authorizes `maxPrice` and the seller settles the amount the
 * call used, from zero up to that cap, after serving it (`setUptoCharge` for HTTP routes,
 * `meteredToolServer` and `chargeUpto` for MCP tools). Register the upto server scheme
 * (`UptoStellarServerScheme`) on the resource server; it copies the facilitator's settlement
 * authority into the requirements.
 */
export function upto(options: UptoOptions): PaymentOption {
  const network = checkNetwork(options.network);
  const payTo = checkPayTo(options.payTo);
  const price = resolvePrice(options.maxPrice, network);
  const timeout = checkTimeout(options.maxTimeoutSeconds);
  return Object.freeze({
    scheme: "upto",
    network,
    payTo,
    price: Object.freeze({ amount: price.amount, asset: price.asset }),
    ...(timeout === undefined ? {} : { maxTimeoutSeconds: timeout }),
  });
}

/** Converts a price to base units of its asset on `network`. Throws `seller_price_invalid`. */
export function resolvePrice(price: Price, network: StellarNetwork): ResolvedPrice {
  let amount: string;
  let asset: string;
  let decimals: number | undefined;
  if (typeof price === "string") {
    if (!price.startsWith("$")) {
      throw sellerError("seller_price_invalid", 'A price string is a dollar amount such as "$0.01".');
    }
    amount = price.slice(1);
    asset = "USDC";
  } else if ((price as unknown) !== null && typeof price === "object") {
    const fields = price as { amount?: unknown; asset?: unknown; decimals?: number };
    if (typeof fields.amount !== "string" || typeof fields.asset !== "string") {
      throw sellerError("seller_price_invalid", "A price object needs a string amount and asset.");
    }
    ({ amount, asset, decimals } = fields as { amount: string; asset: string; decimals?: number });
  } else {
    throw sellerError("seller_price_invalid");
  }

  let contract: string;
  if (asset.toUpperCase() === "USDC") {
    const usdc = USDC[network];
    if (decimals !== undefined && decimals !== usdc.decimals) {
      throw sellerError("seller_price_invalid", `USDC has ${String(usdc.decimals)} decimals on Stellar.`);
    }
    contract = usdc.contract;
    decimals = usdc.decimals;
  } else if (CONTRACT_ADDRESS.test(asset)) {
    contract = asset;
    if (decimals === undefined) {
      throw sellerError(
        "seller_price_invalid",
        "A custom asset needs its decimals; read them from the network with assetDecimals().",
      );
    }
  } else {
    throw sellerError("seller_price_invalid", 'The asset must be "USDC" or a token contract address (C…).');
  }
  if (!isValidDecimals(decimals)) {
    throw sellerError("seller_price_invalid", "decimals must be an integer from 0 to 38.");
  }
  const atomic = toAtomic(amount, decimals);
  if (atomic === undefined) {
    throw sellerError(
      "seller_price_invalid",
      `"${amount.slice(0, 40)}" is not a decimal amount with at most ${String(decimals)} fraction digits within the i128 range.`,
    );
  }
  if (atomic <= 0n) throw sellerError("seller_price_invalid", "The price must be greater than zero.");
  return { asset: contract, amount: atomic.toString(), decimals };
}

export interface AssetDecimalsOptions {
  readonly network: StellarNetwork;
  /** A Soroban RPC for the network, e.g. https://soroban-testnet.stellar.org. */
  readonly rpcUrl: string;
  /** Needed for a plain-http RPC (a local network). */
  readonly allowHttp?: boolean;
}

/**
 * Reads a token's `decimals()` from the network, so a custom asset's price converts exactly. Throws
 * `seller_asset_unreadable` when the contract is not a readable SEP-41 token or the RPC fails.
 */
export async function assetDecimals(asset: string, options: AssetDecimalsOptions): Promise<number> {
  const network = checkNetwork(options.network);
  if (asset.toUpperCase() === "USDC") return USDC[network].decimals;
  if (!CONTRACT_ADDRESS.test(asset)) {
    throw sellerError("seller_price_invalid", 'The asset must be "USDC" or a token contract address (C…).');
  }
  const directory = new AssetDirectory(
    new rpc.Server(options.rpcUrl, { allowHttp: options.allowHttp === true }),
    networkPassphrase(network),
  );
  const facts = await directory.describe(asset);
  if (facts === undefined || !isValidDecimals(facts.decimals)) {
    throw sellerError("seller_asset_unreadable", undefined, { asset });
  }
  return facts.decimals;
}

function checkNetwork(network: unknown): StellarNetwork {
  if (!isStellarNetwork(network)) throw sellerError("seller_network_unsupported");
  return network;
}

/**
 * A G… account or C… contract. A muxed (M…) payTo is refused for both schemes: its CAP-67 transfer
 * event names the base account, which the x402 exact verifier does not match to payTo, and the upto
 * settlement contract pulls funds with `transfer_from`, which carries no muxed id.
 */
function checkPayTo(payTo: unknown): string {
  if (typeof payTo === "string" && baseAccount(payTo) !== undefined && payTo.startsWith("M")) {
    throw sellerError(
      "seller_declaration_invalid",
      "payTo is a muxed (M…) address, which x402 payments on Stellar cannot pay; use its base G… account.",
      { path: "payTo" },
    );
  }
  if (typeof payTo !== "string" || baseAccount(payTo) === undefined) {
    throw sellerError(
      "seller_declaration_invalid",
      "payTo must be a Stellar account (G…) or contract (C…).",
      { path: "payTo" },
    );
  }
  return payTo;
}

function checkTimeout(seconds: unknown): number | undefined {
  if (seconds === undefined) return undefined;
  if (
    !Number.isSafeInteger(seconds) ||
    (seconds as number) < MIN_TIMEOUT_SECONDS ||
    (seconds as number) > MAX_TIMEOUT_SECONDS
  ) {
    throw sellerError(
      "seller_declaration_invalid",
      `maxTimeoutSeconds must be an integer from ${String(MIN_TIMEOUT_SECONDS)} to ${String(MAX_TIMEOUT_SECONDS)}.`,
      { path: "maxTimeoutSeconds" },
    );
  }
  return seconds as number;
}
