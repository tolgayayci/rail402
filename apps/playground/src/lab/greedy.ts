import type { Context } from "hono";
import type { FacilitatorClient, RouteConfig } from "@x402/core/server";
import { TESTNET } from "@rail402.dev/stellar";
import { upto } from "@rail402.dev/sdk/seller";
import type { PlaygroundConfig } from "../config.ts";
import { GREEDY_MAX_TIMEOUT_SECONDS, LAB_PATHS, LAB_PRICES } from "../shared/lab.ts";

/**
 * A misbehaving seller, on purpose: `GET /lab/greedy/history` quotes an upto cap of 0.01 and then asks
 * the facilitator to settle 0.02, twice what the buyer authorized. Rail402 refuses that settlement, so
 * nothing moves; the buyer's hold returns once the authorization expires (60 seconds). It declares no
 * Bazaar metadata, so it is never listed.
 *
 * The stock seller middleware refuses a settlement override above the cap before the facilitator sees
 * it, so this seller overcharges the way a dishonest one would: its own facilitator client rewrites the
 * amount of every settle request.
 */

export const GREEDY_ROUTE_KEY = `GET ${LAB_PATHS.greedy}`;

const DAYS_MAX = 30;

/** The route configuration for the stock payment middleware. */
export function greedyRouteConfig(config: PlaygroundConfig, payTo: string): RouteConfig {
  return {
    accepts: [
      {
        ...upto({
          network: TESTNET,
          payTo,
          maxPrice: {
            amount: LAB_PRICES.greedyCap.decimal,
            asset: config.asset.contract,
            decimals: config.asset.decimals,
          },
          maxTimeoutSeconds: GREEDY_MAX_TIMEOUT_SECONDS,
        }),
      },
    ],
    description:
      "Playground sample that overcharges on purpose: it asks to settle twice the authorized cap, which the facilitator refuses",
    mimeType: "application/json",
  };
}

/** The facilitator client of the greedy route: every settle asks for LAB_PRICES.greedyCharge. */
export function overcharging(facilitator: FacilitatorClient): FacilitatorClient {
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) =>
      facilitator.settle(payload, { ...requirements, amount: LAB_PRICES.greedyCharge.atomic }),
    getSupported: () => facilitator.getSupported(),
  };
}

/** The handler: serves the history; the route's facilitator client asks to settle above the cap. */
export function greedyHandler(c: Context): Response {
  const city = (c.req.query("city") ?? "Berlin").slice(0, 80);
  const asked = Number.parseInt(c.req.query("days") ?? "7", 10);
  const days = Number.isSafeInteger(asked) && asked >= 1 && asked <= DAYS_MAX ? asked : 7;
  return c.json({
    city,
    days: Array.from({ length: days }, (_, index) => ({ daysAgo: index + 1, high: 18, low: 9 })),
    charged: { requested: LAB_PRICES.greedyCharge.atomic, cap: LAB_PRICES.greedyCap.atomic },
  });
}
