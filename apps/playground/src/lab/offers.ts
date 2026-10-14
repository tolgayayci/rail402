import type { Context } from "hono";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { PUBNET, TESTNET, USDC } from "@rail402.dev/stellar";
import type { PlaygroundConfig } from "../config.ts";
import { LAB_PATHS } from "../shared/lab.ts";

/**
 * Offers a buyer's spending policy must refuse: each route answers 402 with a well-formed x402
 * version 2 `PAYMENT-REQUIRED` and nothing else. They never verify or settle, so a payment sent to
 * them is never taken: there is nothing behind the 402.
 *
 * - `pubnet`: the price is on Stellar pubnet.
 * - `asset`: the price is in TEST6, a 6-decimal test token the Playground's policy does not allow.
 * - `zero`: the price is zero.
 */

export type OfferId = keyof typeof LAB_PATHS.offers;

/** TEST6 on the testnet (`contracts/testing/deployments/test6-testnet.json`): 6 decimals. */
export const TEST6_TESTNET = "CDS45IRSWVDBV4JM2FPZ52EYXYO54J6DJL35GOSXOTRA4BYM6FFRK2BK";

const MAX_TIMEOUT_SECONDS = 60;

const DESCRIPTIONS: Readonly<Record<OfferId, string>> = {
  pubnet: "Playground check: an offer on Stellar pubnet, which a testnet buyer must refuse",
  asset: "Playground check: an offer in an asset the buyer's policy does not allow",
  zero: "Playground check: an offer with a zero amount, which a buyer must refuse",
};

/** The PAYMENT-REQUIRED body of one offer. */
export function offerOf(id: OfferId, config: PlaygroundConfig, payTo: string): PaymentRequired {
  const option = (
    fields: Pick<PaymentRequirements, "network" | "asset" | "amount">,
  ): PaymentRequirements => ({
    scheme: "exact",
    ...fields,
    payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { areFeesSponsored: true },
  });
  const accepts: Record<OfferId, PaymentRequirements> = {
    pubnet: option({ network: PUBNET, asset: USDC[PUBNET].contract, amount: "100000" }),
    asset: option({ network: TESTNET, asset: TEST6_TESTNET, amount: "10000" }),
    zero: option({ network: TESTNET, asset: config.asset.contract, amount: "0" }),
  };
  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: `${config.publicUrl}${LAB_PATHS.offers[id]}`,
      description: DESCRIPTIONS[id],
      mimeType: "application/json",
    },
    accepts: [accepts[id]],
  };
}

/** A handler answering one offer's 402. */
export function offerHandler(id: OfferId, config: PlaygroundConfig, payTo: string): (c: Context) => Response {
  const header = encodePaymentRequiredHeader(offerOf(id, config, payTo));
  return (c) => {
    c.header("payment-required", header);
    c.header("cache-control", "no-store");
    return c.json({}, 402);
  };
}
