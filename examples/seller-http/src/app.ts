/**
 * A paid HTTP API on Stellar built from the stock x402 packages: `@x402/express` with the Stellar
 * `exact` scheme and the Bazaar extension. The route is declared with the `@rail402.dev/sdk/seller`
 * helpers, so its discovery metadata is complete and valid: the first settled payment through a
 * Rail402 facilitator catalogs it in the Bazaar, bound to `payTo`.
 */
import express, { type Express } from "express";
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import {
  exact,
  httpRoute,
  param,
  withSettleDedupe,
  type HttpRouteDeclaration,
} from "@rail402.dev/sdk/seller";

export type Network = "stellar:testnet" | "stellar:pubnet";

export interface SellerOptions {
  /** The G… account or C… contract every payment goes to. */
  readonly payTo: string;
  readonly network: Network;
  /** The facilitator that verifies and settles; `facilitatorUrl` builds one when it is not given. */
  readonly facilitator?: FacilitatorClient;
  readonly facilitatorUrl?: string;
  /** The price of one call in USDC, e.g. "0.001". */
  readonly price: string;
  /** Reverse proxies in front (Express `trust proxy`), so 402s name the public https URL. */
  readonly trustProxy?: number;
}

/** The paid route: a quote of the day by topic. */
export function quoteRoute(
  options: Pick<SellerOptions, "payTo" | "network" | "price">,
): HttpRouteDeclaration {
  return httpRoute({
    method: "GET",
    path: "/quote",
    description: "A short quote of the day on a topic",
    serviceName: "Quote of the day",
    tags: ["quotes", "text"],
    payment: exact({ network: options.network, payTo: options.payTo, price: `$${options.price}` }),
    query: {
      topic: param.enum(["science", "craft", "courage"], {
        description: "Topic of the quote",
        required: true,
        example: "craft",
      }),
    },
    output: { example: { topic: "craft", quote: "Make it work, make it right, make it fast." } },
  });
}

const QUOTES: Readonly<Record<string, string>> = {
  science: "Nothing in life is to be feared, it is only to be understood.",
  craft: "Make it work, make it right, make it fast.",
  courage: "Courage is grace under pressure.",
};

export function createApp(options: SellerOptions): Express {
  // An idempotent facilitator answers every /settle of one payment with its success, and copies of a
  // payment sent together all pass /verify before the first settles: the wrapper serves it once.
  const facilitator = withSettleDedupe(
    options.facilitator ??
      new HTTPFacilitatorClient({ url: options.facilitatorUrl ?? "https://testnet.rail402.dev" }),
  );
  const resourceServer = new x402ResourceServer(facilitator)
    .register(options.network, new ExactStellarScheme())
    .registerExtension(bazaarResourceServerExtension);
  const route = quoteRoute(options);

  const app = express();
  app.set("trust proxy", options.trustProxy ?? 0);
  app.use(paymentMiddleware({ [route.key]: route.config }, resourceServer));
  app.get("/quote", (req, res) => {
    const topic =
      typeof req.query["topic"] === "string" && req.query["topic"] in QUOTES ? req.query["topic"] : "craft";
    res.json({ topic, quote: QUOTES[topic] });
  });
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  return app;
}
