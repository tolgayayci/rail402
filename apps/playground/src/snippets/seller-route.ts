// Sell page snippet: an Express route priced with the seller helpers, settled through Rail402 and
// listed in the Bazaar. Shown on the page (with `{{…}}` filled in), type-checked here, never run.
import type { Express } from "express"; // @hide
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { exact, httpRoute, param } from "@rail402.dev/sdk/seller";
declare const app: Express; // @hide

const PAY_TO = process.env["PAY_TO"] ?? ""; // the address from step 2

const forecast = httpRoute({
  method: "GET",
  path: "/forecast/:city",
  description: "Seven-day weather forecast for a city",
  payment: exact({ network: "stellar:testnet", payTo: PAY_TO, price: "$0.01" }),
  pathParams: { city: param.string({ description: "City name", example: "Ankara" }) },
});

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: "{{facilitator}}" }))
  .register("stellar:testnet", new ExactStellarScheme())
  .registerExtension(bazaarResourceServerExtension);

app.use(paymentMiddleware({ [forecast.key]: forecast.config }, server)); // before your routes
