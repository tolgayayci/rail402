/**
 * Whether a payment header holds an x402 payment at all, before any limit counts it as paid. A paid
 * request draws on the paid limits, which are smaller and shared by every visitor, so a header that
 * merely exists must not count: anything that does not decode as a payment payload is refused as
 * malformed before a token is taken. The facilitator still verifies every payment that passes.
 */

/** Longest payment header, base64 characters, that can hold a payment. */
export const PAYMENT_HEADER_MAX_LENGTH = 16_384;

/** Longest signed transaction or authorization, base64 characters, inside a payment payload. */
const PAYLOAD_FIELD_MAX_LENGTH = 12_288;

const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Whether `value` is a base64 JSON payment payload of one of `versions`: `x402Version`, the chosen
 * requirements (`accepted`, v2) or `scheme` and `network` (v1), and a `payload` carrying a signed
 * `transaction` (exact) or `authorization` (upto) of bounded size.
 */
export function isPaymentHeader(value: string, versions: readonly number[] = [2]): boolean {
  const text = value.trim();
  if (text === "" || text.length > PAYMENT_HEADER_MAX_LENGTH || !BASE64.test(text)) return false;
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(text.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8"),
    );
  } catch {
    return false;
  }
  return isPaymentPayload(decoded, versions);
}

/** Whether a decoded value is a payment payload of one of `versions` (see isPaymentHeader). */
export function isPaymentPayload(decoded: unknown, versions: readonly number[] = [2]): boolean {
  if (!isRecord(decoded)) return false;
  const version = decoded["x402Version"];
  if (typeof version !== "number" || !versions.includes(version)) return false;
  if (version >= 2) {
    if (!isRecord(decoded["accepted"])) return false;
  } else if (typeof decoded["scheme"] !== "string" || typeof decoded["network"] !== "string") {
    return false;
  }
  const payload = decoded["payload"];
  if (!isRecord(payload)) return false;
  return [payload["transaction"], payload["authorization"]].some(
    (field) => typeof field === "string" && field !== "" && field.length <= PAYLOAD_FIELD_MAX_LENGTH,
  );
}

/** The `_meta` key an MCP tool call carries its payment under. */
export const MCP_PAYMENT_META_KEY = "x402/payment";

/** Largest request body read for an MCP payment; the relay forwards at most 64 KiB anyway. */
const MCP_BODY_MAX_BYTES = 65_536;

/**
 * Whether a request body is a JSON-RPC message carrying an MCP payment in `params._meta["x402/payment"]`
 * (a batch counts when any message does): `none` when it carries none or is no JSON-RPC body, `payment`
 * when the payment has the shape of an x402 payment payload, `invalid` when the key holds anything
 * else. A tool call paid this way is a paid request, the same as one with a payment header.
 */
export function mcpPaymentOf(body: Uint8Array | undefined): "none" | "payment" | "invalid" {
  if (body === undefined || body.byteLength > MCP_BODY_MAX_BYTES) return "none";
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return "none";
  }
  let found: "none" | "payment" | "invalid" = "none";
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!isRecord(message) || message["jsonrpc"] !== "2.0") continue;
    const params = message["params"];
    const meta = isRecord(params) ? params["_meta"] : undefined;
    if (!isRecord(meta) || !Object.hasOwn(meta, MCP_PAYMENT_META_KEY)) continue;
    if (!isPaymentPayload(meta[MCP_PAYMENT_META_KEY])) return "invalid";
    found = "payment";
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
