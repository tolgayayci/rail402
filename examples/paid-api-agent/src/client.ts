import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

/**
 * The buyer side — an **unmodified stock x402 client**.
 *
 * This file imports nothing from this repository. It is `@x402/core` + `@x402/fetch` +
 * `@x402/stellar` exactly as published, which is what the conformance bar requires:
 * "an unmodified canonical client completing a payment end to end". If this works against our
 * facilitator, the wire format is right; if it does not, nothing else we claim matters.
 */

const URL_TO_BUY = process.env.RESOURCE_URL ?? "http://localhost:4023/premium/quote?symbol=XLM";
const SECRET = process.env.CLIENT_STELLAR_PRIVATE_KEY;
const NETWORK = (process.env.STELLAR_NETWORK ?? "stellar:testnet") as `${string}:${string}`;

if (!SECRET) {
  console.error("CLIENT_STELLAR_PRIVATE_KEY is required");
  process.exit(1);
}

const signer = createEd25519Signer(SECRET, NETWORK);

const client = new x402Client();
client.register("stellar:*", new ExactStellarScheme(signer));

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

console.log(`[client]  buyer ${signer.address}`);
console.log(`[client]  GET ${URL_TO_BUY}`);

const response = await fetchWithPayment(URL_TO_BUY);

console.log(`[client]  HTTP ${response.status}`);

// Use the SDK's own decoder rather than hand-rolling base64 — if the stock decoder can read our
// settlement header, so can every other stock client.
const header = response.headers.get("PAYMENT-RESPONSE");
const settlement = header ? decodePaymentResponseHeader(header) : undefined;
if (settlement) console.log(`[client]  settlement:`, JSON.stringify(settlement));

console.log(`[client]  body:`, JSON.stringify(await response.json()));

if (!response.ok) process.exit(1);
