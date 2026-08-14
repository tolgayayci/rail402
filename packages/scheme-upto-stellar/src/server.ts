import { convertToTokenAmount, getUsdcAddress } from "@x402/stellar";
import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { uptoContractFor } from "./constants.js";

/**
 * Server side of `upto` on Stellar.
 *
 * A resource server pricing in `upto` declares the **ceiling**. The actual charge is decided after
 * the work is done and communicated to the facilitator as `paymentRequirements.amount` at settle
 * time — the phase-dependent semantics the generic spec defines.
 */
export class UptoStellarServerScheme implements SchemeNetworkServer {
  readonly scheme = "upto";

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price && "asset" in price) {
      return price as AssetAmount;
    }
    // "$0.10" style: default to USDC at 7 decimals, matching `exact`.
    const decimal = String(price).replace(/^\$/, "");
    return { amount: convertToTokenAmount(decimal), asset: getUsdcAddress(network) };
  }

  // The core interface hands us `(asset, network)`, and for this scheme the answer is always 7: a
  // DECIMAL ("$0.10") price is priced in USDC (see `parsePrice`), Stellar USDC is 7-decimal, and 7 is
  // the SEP-41 convention `exact` uses too — so it is right for every asset this scheme can price a
  // decimal in. A token with different decimals cannot reach the decimal path (`parsePrice` forces
  // USDC); it must arrive as an object price `{ amount, asset }` whose amount is ALREADY in atomic
  // units, where decimals are never applied. So the asset argument is deliberately unused rather than
  // driving an on-ledger SEP-41 `decimals()` lookup this synchronous method cannot perform — and
  // returning 7 beats the core default of 6, which would be wrong for Stellar.
  getAssetDecimals(_asset?: string, _network?: string): number {
    return 7;
  }

  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: SupportedKind,
  ): Promise<PaymentRequirements> {
    // The client needs the settlement contract address to build its authorization — and will check
    // it against the canonical table before signing.
    const contract =
      (supportedKind.extra as { uptoContract?: string } | undefined)?.uptoContract ??
      uptoContractFor(requirements.network);

    return {
      ...requirements,
      extra: {
        ...(requirements.extra ?? {}),
        ...(contract ? { uptoContract: contract } : {}),
        areFeesSponsored: true,
      },
    };
  }
}
