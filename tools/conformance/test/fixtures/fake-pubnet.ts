/**
 * A fake pubnet for rehearsing the pubnet harnesses without touching the network: loaded with
 * `node --import`, it replaces `fetch` with a router that serves a fake Rail402 at
 * https://facilitator.example and a fake demo seller at https://seller.example, and refuses every
 * other request (an RPC, Friendbot, a real facilitator). Every request is appended to the file
 * FAKE_PUBNET_LOG names, one JSON line each, so a test can show what was asked and that nothing
 * settled.
 */
import { appendFileSync } from "node:fs";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { USDC_PUBNET_ADDRESS } from "@x402/stellar";

export const FAKE_FACILITATOR = "https://facilitator.example";
export const FAKE_SELLER = "https://seller.example";
/** The fake seller's payTo and the fake facilitator's upto authority (valid strkeys, no accounts). */
export const FAKE_PAY_TO = "GDKMZDQWLPH466HID3JCZHV2TSPLYY2LOSQ4K2DUZTDUZQGVL6SEGH62";
const FAKE_AUTHORITY = "GBAQ3BGTI3THOPSLXCAAJNHOH7LGU477RFXOQ6NVECNVOTCABEAEI6SX";

const log = process.env["FAKE_PUBNET_LOG"];

function note(entry: Record<string, unknown>): void {
  if (log !== undefined) appendFileSync(log, `${JSON.stringify(entry)}\n`);
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function paymentRequired(url: string): Response {
  const header = encodePaymentRequiredHeader({
    x402Version: 2,
    error: "Payment required",
    resource: { url: url.split("?")[0] ?? url, description: "Current weather for a city" },
    accepts: [
      {
        scheme: "exact",
        network: "stellar:pubnet",
        asset: USDC_PUBNET_ADDRESS,
        amount: "10000",
        payTo: FAKE_PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
    ],
  });
  return new Response("{}", {
    status: 402,
    headers: { "content-type": "application/json", "payment-required": header },
  });
}

function route(method: string, url: URL, authorization: string | null): Response {
  const origin = url.origin;
  if (origin === FAKE_FACILITATOR) {
    if (url.pathname === "/health") return Response.json({ status: "ok", version: "fake-pubnet" });
    if (url.pathname === "/supported") {
      return Response.json({
        kinds: [
          { x402Version: 2, scheme: "exact", network: "stellar:pubnet", extra: { areFeesSponsored: true } },
          {
            x402Version: 2,
            scheme: "upto",
            network: "stellar:pubnet",
            extra: { areFeesSponsored: true, facilitatorAddress: FAKE_AUTHORITY },
          },
        ],
        extensions: ["bazaar"],
        signers: { "stellar:*": [FAKE_AUTHORITY] },
      });
    }
    if (method === "POST" && url.pathname === "/verify") {
      // The service wants a key on pubnet: no key, no service.
      if (authorization === null) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({ isValid: false, invalidReason: "invalid_payload", invalidMessage: "fake" });
    }
  }
  if (origin === FAKE_SELLER && method === "GET") return paymentRequired(url.href);
  throw new TypeError(`fake pubnet: no route for ${method} ${url.href}`);
}

globalThis.fetch = (input, init) => {
  const url = new URL(urlOf(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const authorization = headers.get("authorization");
  note({
    method,
    url: url.href,
    // Only whether a key was sent, never the key.
    bearer: authorization?.startsWith("Bearer ") === true,
  });
  try {
    return Promise.resolve(route(method, url, authorization));
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
};
