// Code-panel snippet: describing and pricing a route with the seller helpers. Shown on the page (with
// `{{…}}` filled in), type-checked here, never run.
import { exact, httpRoute, param } from "@rail402.dev/sdk/seller"; // @hide
declare const PAY_TO: string; // @hide

export const forecast = httpRoute({
  // @step:quote
  method: "GET", // @step:request
  path: "/forecast/:city", // @step:request,catalog
  description: "Seven-day weather forecast for a city", // @step:quote,listed
  payment: exact({ network: "stellar:testnet", payTo: PAY_TO, price: "$0.01" }), // @step:quote,settle,catalog
  pathParams: { city: param.string({ description: "City name", example: "Ankara" }) }, // @step:quote,origin-check
});
