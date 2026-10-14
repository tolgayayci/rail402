import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { findDefaultAsset, getDefaultAsset } from "@x402/stellar";
import { UPTO_SCHEME } from "../constants.ts";

/**
 * Stellar resource-server side of the x402 `upto` scheme: prices become caps, and the facilitator's
 * settlement authority is copied into the requirements. The actual charge is set after the handler
 * runs, through a settlement override (see {@link uptoSettlementOverrides}).
 */
export class UptoStellarScheme implements SchemeNetworkServer {
  readonly scheme = UPTO_SCHEME;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;

  private readonly moneyParsers: MoneyParser[] = [];
  private readonly decimals = new Map<string, number>();

  /**
   * Registers a money parser, tried in registration order before the default (USDC) conversion.
   *
   * @param parser - Converts a decimal amount to an `AssetAmount`, or returns null to pass
   * @returns This scheme, for chaining
   */
  registerMoneyParser(parser: MoneyParser): this {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Registers the decimals of a custom SEP-41 token, which `$` settlement overrides need to convert
   * a price into atomic units.
   *
   * @param network - CAIP-2 network
   * @param asset - Token contract address
   * @param decimals - The token's `decimals()`
   * @returns This scheme, for chaining
   */
  registerAssetDecimals(network: Network, asset: string, decimals: number): this {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
      throw new Error(`invalid decimals ${decimals} for ${asset}`);
    }
    this.decimals.set(`${network}:${asset}`, decimals);
    return this;
  }

  /**
   * The decimals of an asset, which `$` settlement overrides need.
   *
   * @param asset - Asset address or symbol
   * @param network - Target network
   * @returns Registered or default-asset decimals, or undefined when unknown
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return this.decimals.get(`${network}:${asset}`) ?? findDefaultAsset(asset, network)?.decimals;
  }

  /**
   * Parses a price (the cap) into an `AssetAmount`: an `AssetAmount` is used as is; money goes
   * through the registered parsers, then defaults to the network's USDC (7 decimals).
   *
   * @param price - The price
   * @param network - The network
   * @returns The asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && "amount" in price) {
      if (!price.asset)
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      return { amount: price.amount, asset: price.asset, extra: price.extra ?? {} };
    }
    const { amount, symbol } = parseMoney(price);
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) return result;
    }
    const asset = getDefaultAsset(network, symbol);
    return { amount: convertToTokenAmount(amount, asset.decimals), asset: asset.asset, extra: {} };
  }

  /**
   * Copies `areFeesSponsored` and the settlement authority (`facilitatorAddress`) from the
   * facilitator's supported kind into the requirements.
   *
   * @param requirements - The base payment requirements
   * @param supportedKind - The facilitator's supported kind for this scheme and network
   * @param supportedKind.x402Version - Protocol version
   * @param supportedKind.scheme - Scheme
   * @param supportedKind.network - Network
   * @param supportedKind.extra - `areFeesSponsored` and `facilitatorAddress`
   * @param _ - Extension keys (unused)
   * @returns The enhanced requirements
   */
  enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: { x402Version: number; scheme: string; network: Network; extra?: Record<string, unknown> },
    _: string[],
  ): Promise<PaymentRequirements> {
    const areFeesSponsored = supportedKind.extra?.["areFeesSponsored"];
    const facilitatorAddress = supportedKind.extra?.["facilitatorAddress"];
    return Promise.resolve({
      ...requirements,
      extra: {
        ...requirements.extra,
        ...(typeof areFeesSponsored === "boolean" ? { areFeesSponsored } : {}),
        ...(typeof facilitatorAddress === "string" ? { facilitatorAddress } : {}),
      },
    });
  }
}

const OVERRIDE_FORMAT = /^(?:(?:0|[1-9][0-9]*)|[0-9]+(?:\.[0-9]{1,2})?%|\$[0-9]+(?:\.[0-9]+)?)$/;

/**
 * Builds the settlement override a seller sets after serving the resource (with
 * `setSettlementOverrides(res, …)` or the `Settlement-Overrides` header): an atomic amount, a
 * percentage of the cap (`"50%"`, two decimals at most) or a price (`"$0.002"`, which needs the
 * asset's decimals). The facilitator refuses anything above the cap.
 *
 * @param amount - Atomic units (bigint, safe integer or integer string), `"n%"` or `"$x"`
 * @returns `{ amount }` for the resource server
 */
export function uptoSettlementOverrides(amount: bigint | number | string): { amount: string } {
  let value: string;
  if (typeof amount === "bigint") value = amount.toString();
  else if (typeof amount === "number") {
    if (!Number.isSafeInteger(amount)) throw new Error(`settlement amount ${amount} must be a safe integer`);
    value = String(amount);
  } else value = amount.trim();
  if (!OVERRIDE_FORMAT.test(value)) {
    throw new Error(`settlement amount "${value}" must be a non-negative integer, a percentage or a $ price`);
  }
  const percent = /^([0-9]+(?:\.[0-9]+)?)%$/.exec(value);
  if (percent !== null && Number(percent[1]) > 100)
    throw new Error(`settlement percentage ${value} exceeds 100%`);
  return { amount: value };
}
