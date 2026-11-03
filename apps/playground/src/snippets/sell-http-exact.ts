// Sell page snippet: an HTTP route at a fixed price. Shown on the page (the price follows the
// visitor's pick), type-checked here, never run.
import type { Express } from "express"; // @hide
import type { x402ResourceServer } from "@x402/core/server"; // @hide
import { paymentMiddleware } from "@x402/express";
import { exact, httpRoute, param } from "@rail402.dev/sdk/seller";
declare const app: Express; // @hide
declare const server: x402ResourceServer; // @hide

const PAY_TO = process.env["PAY_TO"] ?? ""; // your G… address

const forecast = httpRoute({
  method: "GET",
  path: "/forecast/:city",
  description: "Seven-day weather forecast for a city",
  payment: exact({ network: "stellar:testnet", payTo: PAY_TO, price: "$0.01" }),
  pathParams: { city: param.string({ description: "City name", example: "Ankara" }) },
});

app.use(paymentMiddleware({ [forecast.key]: forecast.config }, server)); // before your routes
