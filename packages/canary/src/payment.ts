import { x402Client, x402HTTPClient } from "@x402/core/client";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { X402Error } from "@rail402.dev/errors";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { NETWORK } from "./testnet.js";

/**
 * Building payments the way a real buyer does.
 *
 * Shared by every canary so none of them hand-rolls a payload. A hand-built payload would test our
 * understanding of the wire format rather than the wire format itself, and the two diverge exactly
 * when it matters.
 */

export interface StockBuyer {
  readonly address: string;
  /** Fetch a 402 from `url` and answer it, returning the payload and the requirements it satisfies. */
  pay(url: string): Promise<{ payload: PaymentPayload; accepted: PaymentRequirements }>;
}

export function stockBuyer(secret: string): StockBuyer {
  const signer = createEd25519Signer(secret, NETWORK);
  const client = new x402Client();
  client.register("stellar:*", new ExactStellarScheme(signer));
  const http = new x402HTTPClient(client);

  return {
    address: signer.address,
    async pay(url: string) {
      const response = await fetch(url);
      if (response.status !== 402) {
        throw new X402Error("canary_setup_failed", {
          reason: `Expected HTTP 402 from ${url}, got ${response.status}. No payment was demanded, so there is nothing to pay.`,
          details: { status: response.status },
        });
      }
      const body: unknown = await response.json().catch(() => undefined);
      const required = http.getPaymentRequiredResponse(name => response.headers.get(name), body);
      const accepted = required.accepts[0];
      if (!accepted) {
        throw new X402Error("canary_setup_failed", {
          reason: "The 402 response carried no payment requirements to satisfy.",
        });
      }
      const payload = await http.createPaymentPayload(required);
      return { payload, accepted };
    },
  };
}

export interface FacilitatorResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}

/** POST a facilitator request. Never throws on a rejection — a rejection is the subject of study. */
export async function callFacilitator(
  base: string,
  path: "/verify" | "/settle",
  paymentPayload: unknown,
  paymentRequirements: unknown,
  x402Version = 2,
): Promise<FacilitatorResponse> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x402Version, paymentPayload, paymentRequirements }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body, headers: response.headers };
}

/** POST a raw body, for the malformed-input cases a typed helper cannot express. */
export async function postRaw(
  base: string,
  path: string,
  body: string,
): Promise<FacilitatorResponse> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: parsed, headers: response.headers };
}

export interface BazaarVerdict {
  status: string;
  rejectedReason?: string;
  code?: string;
}

/**
 * Decode the `EXTENSION-RESPONSES` header: base64 JSON keyed by extension name.
 *
 * Returns `undefined` for anything unreadable rather than throwing, so a malformed header is
 * reported as the missing verdict it is — which is what a seller would experience.
 */
export function decodeExtensionResponses(header: string | null): BazaarVerdict | undefined {
  if (!header) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    if (!decoded || typeof decoded !== "object") return undefined;
    const bazaar = (decoded as Record<string, unknown>)["bazaar"];
    if (!bazaar || typeof bazaar !== "object") return undefined;
    const status = (bazaar as Record<string, unknown>)["status"];
    if (typeof status !== "string") return undefined;
    return bazaar as unknown as BazaarVerdict;
  } catch {
    return undefined;
  }
}

/** Pull whatever the facilitator called the failure, always yielding a non-empty string. */
export function reasonOf(body: Record<string, unknown>): string {
  for (const key of ["reason", "invalidReason", "errorReason", "error"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return JSON.stringify(body);
}
