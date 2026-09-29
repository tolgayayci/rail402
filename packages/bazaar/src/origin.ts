import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { isLoopbackHost, isPublicAddress } from "./url.ts";

export interface OriginFetchOptions {
  readonly timeoutMs?: number;
  /** Largest response body read before the connection is closed. */
  readonly maxBytes?: number;
  /** Allow loopback targets (conformance runs on a local network only). */
  readonly allowLoopback?: boolean;
}

export type OriginResponse =
  | { readonly kind: "payment_required"; readonly paymentRequired: PaymentRequired }
  | { readonly kind: "not_payment_required"; readonly status: number }
  | { readonly kind: "unreachable"; readonly reason: string };

const USER_AGENT = "rail402-bazaar-origin-check/1 (+https://rail402.dev)";
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * Requests a resource without payment and returns the x402 v2 PaymentRequired it answers with.
 *
 * SSRF controls: every DNS answer must be a public address (checked in the connection's own lookup,
 * so the address that was checked is the address that is dialled); redirects are not followed;
 * responses are capped in size and time; only http and https are spoken.
 */
export function fetchPaymentRequired(
  target: string,
  method: string,
  options: OriginFetchOptions = {},
): Promise<OriginResponse> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const maxBytes = options.maxBytes ?? 65_536;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return Promise.resolve({ kind: "unreachable", reason: "invalid URL" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.resolve({ kind: "unreachable", reason: `unsupported scheme ${url.protocol}` });
  }
  const allowLoopback = options.allowLoopback === true && isLoopbackHost(url.hostname);
  const verb = method.toUpperCase();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: OriginResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      url,
      {
        method: verb,
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
          ...(BODY_METHODS.has(verb) ? { "content-type": "application/json", "content-length": "2" } : {}),
        },
        lookup: safeLookup(allowLoopback),
        // Never reuse pooled sockets: each check resolves and validates its own address.
        agent: false,
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const header = response.headers["payment-required"];
        // The body is not needed; drain at most maxBytes so the socket can close cleanly.
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) response.destroy();
        });
        response.on("error", () => undefined);
        if (status !== 402 || typeof header !== "string") {
          response.resume();
          finish({ kind: "not_payment_required", status });
          return;
        }
        try {
          finish({ kind: "payment_required", paymentRequired: decodePaymentRequiredHeader(header) });
        } catch {
          finish({ kind: "unreachable", reason: "the PAYMENT-REQUIRED header could not be decoded" });
        }
        response.resume();
      },
    );

    const timer = setTimeout(() => {
      request.destroy(new Error("timed out"));
      finish({ kind: "unreachable", reason: `no response within ${String(timeoutMs)} ms` });
    }, timeoutMs);

    request.on("error", (error: Error) => {
      finish({ kind: "unreachable", reason: error.message });
    });
    request.end(BODY_METHODS.has(verb) ? "{}" : undefined);
  });
}

/** A DNS lookup that refuses non-public answers (or anything but loopback, when that is allowed). */
export function safeLookup(allowLoopback: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      const refused = addresses.find((entry) =>
        allowLoopback ? !isLoopbackHost(entry.address) : !isPublicAddress(entry.address),
      );
      if (refused !== undefined || addresses.length === 0) {
        const failure = Object.assign(new Error(`refused to connect to ${refused?.address ?? hostname}`), {
          code: "EREFUSED",
        });
        callback(failure, "", 0);
        return;
      }
      if (options.all === true) {
        callback(null, addresses);
      } else {
        const [first] = addresses as [LookupAddress];
        callback(null, first.address, first.family);
      }
    });
  };
}
