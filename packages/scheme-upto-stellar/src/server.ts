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

  getAssetDecimals(): number {
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
