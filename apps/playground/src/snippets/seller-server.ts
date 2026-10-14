// Code-panel snippet: an Express app that takes x402 payments through Rail402 and is listed in the
// Bazaar. Shown on the page (with `{{…}}` filled in), type-checked here, never run.
import express from "express"; // @hide
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server"; // @hide
import { paymentMiddleware } from "@x402/express"; // @hide
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar"; // @hide
import { ExactStellarScheme } from "@x402/stellar/exact/server"; // @hide
import { forecast } from "./seller-route.ts"; // @hide

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: "{{facilitator}}" })) // @step:settle
  .register("stellar:testnet", new ExactStellarScheme()) // @step:settle
  .registerExtension(bazaarResourceServerExtension); // @step:catalog

const app = express();
app.use(paymentMiddleware({ [forecast.key]: forecast.config }, server)); // @step:quote,paid-request
app.get("/forecast/:city", (req, res) => res.json({ city: req.params.city, days: [] })); // @step:deliver
app.listen(4021); // @step:origin-check
