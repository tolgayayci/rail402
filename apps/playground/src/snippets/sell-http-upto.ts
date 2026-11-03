// Sell page snippet: an HTTP route that charges what a call used, up to a cap. Shown on the page (the
// cap follows the visitor's pick), type-checked here, never run.
import type { Express } from "express"; // @hide
import type { x402ResourceServer } from "@x402/core/server"; // @hide
import { paymentMiddleware } from "@x402/express";
import { UptoStellarServerScheme, httpRoute, param, setUptoCharge, upto } from "@rail402.dev/sdk/seller";
declare const app: Express; // @hide
declare const server: x402ResourceServer; // @hide

const PAY_TO = process.env["PAY_TO"] ?? ""; // your G… address

const forecast = httpRoute({
  method: "GET",
  path: "/forecast/:city",
  description: "Seven-day weather forecast for a city",
  payment: upto({ network: "stellar:testnet", payTo: PAY_TO, maxPrice: "$0.01", maxTimeoutSeconds: 120 }),
  pathParams: { city: param.string({ description: "City name", example: "Ankara" }) },
});

server.register("stellar:testnet", new UptoStellarServerScheme());
app.use(paymentMiddleware({ [forecast.key]: forecast.config }, server)); // before your routes
app.get("/forecast/:city", (req, res) => {
  setUptoCharge(res, "40%"); // charge what this call used, at most the cap
  res.json({ city: req.params.city, days: [] });
});
