/**
 * Starts the seller from its environment:
 *   PAY_TO            the G… account or C… contract paid (required; a G… account needs a USDC trustline)
 *   NETWORK           stellar:testnet (default) or stellar:pubnet
 *   FACILITATOR_URL   default https://testnet.rail402.dev; required on pubnet
 *   PRICE             USDC per call, default 0.001
 *   PORT              default 4021
 *   TRUST_PROXY_HOPS  reverse proxies in front, default 0 (set 1 behind a TLS proxy)
 */
import { StrKey } from "@stellar/stellar-sdk";
import { createApp, type Network } from "./app.ts";

function fail(message: string): never {
  process.stderr.write(`seller-http: ${message}\n`);
  process.exit(78);
}

const payTo = process.env["PAY_TO"]?.trim() ?? "";
if (!StrKey.isValidEd25519PublicKey(payTo) && !StrKey.isValidContract(payTo)) {
  fail("PAY_TO must be a Stellar G… account or C… contract");
}
const networkText = process.env["NETWORK"]?.trim() || "stellar:testnet";
if (networkText !== "stellar:testnet" && networkText !== "stellar:pubnet") {
  fail("NETWORK must be stellar:testnet or stellar:pubnet");
}
const network: Network = networkText;
const facilitatorUrl = process.env["FACILITATOR_URL"]?.trim() || undefined;
if (network === "stellar:pubnet" && facilitatorUrl?.startsWith("https://") !== true) {
  fail("FACILITATOR_URL must name an https facilitator that serves stellar:pubnet");
}
const price = process.env["PRICE"]?.trim() || "0.001";
if (!/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,7})?$/.test(price) || Number(price) <= 0) {
  fail("PRICE is a positive USDC amount with at most 7 decimals");
}
const port = Number(process.env["PORT"] ?? "4021");
const trustProxy = Number(process.env["TRUST_PROXY_HOPS"] ?? "0");

createApp({
  payTo,
  network,
  price,
  trustProxy,
  ...(facilitatorUrl === undefined ? {} : { facilitatorUrl }),
}).listen(port, () => {
  process.stdout.write(`seller-http on :${String(port)} (${network}), paying ${payTo}\n`);
});
