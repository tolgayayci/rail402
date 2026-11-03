import { StrKey } from "@stellar/stellar-sdk";
import { DEFAULT_PAID_LIMITS, type PaidLimits } from "./limits.ts";
import type { StellarNetwork } from "./metered.ts";

/** What the demo seller reads from its environment. */
export interface DemoSellerConfig {
  readonly payTo: string;
  readonly network: StellarNetwork;
  /** Undefined: Rail402's hosted testnet facilitator (testnet only; pubnet must name one). */
  readonly facilitatorUrl: string | undefined;
  /** Undefined: Circle's USDC on the network. */
  readonly asset: { readonly contract: string; readonly decimals: number } | undefined;
  readonly publicUrl: string | undefined;
  readonly metered: boolean;
  /** Payments the seller asks the facilitator about per minute, per client and for all clients. */
  readonly paidLimits: PaidLimits;
  readonly port: number;
  readonly trustProxy: number;
}

/**
 * Reads the configuration, refusing anything invalid with a message (the process exits 78):
 * - `PAY_TO`: the G… account or C… contract paid (required);
 * - `NETWORK`: `stellar:testnet` (default) or `stellar:pubnet`;
 * - `FACILITATOR_URL`: https on pubnet, where it is required;
 * - `ASSET`: `C…:DECIMALS` of the token prices are paid in (default: Circle's USDC on the network);
 * - `PUBLIC_URL`: the public origin the MCP tools are declared at;
 * - `METERED`: serve the `upto` route and tool (default true on testnet, false on pubnet);
 * - `PAID_PER_MINUTE`, `PAID_GLOBAL_PER_MINUTE`: payments the seller asks the facilitator about per
 *   minute, per client (default 60) and for all clients (default 120);
 * - `PORT`, `TRUST_PROXY_HOPS`.
 */
export function sellerConfig(env: Readonly<Record<string, string | undefined>>): DemoSellerConfig {
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const payTo = read("PAY_TO") ?? "";
  if (!StrKey.isValidEd25519PublicKey(payTo) && !StrKey.isValidContract(payTo)) {
    throw new Error("PAY_TO must be a Stellar G… account or C… contract");
  }
  const networkText = read("NETWORK") ?? "stellar:testnet";
  if (networkText !== "stellar:testnet" && networkText !== "stellar:pubnet") {
    throw new Error("NETWORK must be stellar:testnet or stellar:pubnet");
  }
  const network: StellarNetwork = networkText;
  const pubnet = network === "stellar:pubnet";

  const facilitatorUrl = read("FACILITATOR_URL");
  if (facilitatorUrl === undefined && pubnet) {
    throw new Error("FACILITATOR_URL is required on stellar:pubnet");
  }
  if (facilitatorUrl !== undefined) {
    const protocol = URL.canParse(facilitatorUrl) ? new URL(facilitatorUrl).protocol : "";
    if (protocol !== "https:" && (pubnet || protocol !== "http:")) {
      throw new Error(`FACILITATOR_URL must be an ${pubnet ? "https" : "http(s)"} URL`);
    }
  }

  const assetText = read("ASSET");
  let asset: DemoSellerConfig["asset"];
  if (assetText !== undefined) {
    const match = /^(C[A-Z2-7]{55}):([0-9]{1,2})$/.exec(assetText);
    if (match === null || !StrKey.isValidContract(match[1] ?? "") || Number(match[2]) > 38) {
      throw new Error("ASSET is the token's C… contract and its decimals, e.g. CB…:7");
    }
    asset = { contract: match[1] ?? "", decimals: Number(match[2]) };
  }

  const publicUrl = read("PUBLIC_URL");
  if (publicUrl !== undefined && !/^https?:\/\/[^/?#]+\/?$/.test(publicUrl)) {
    throw new Error("PUBLIC_URL must be an origin such as https://demo.rail402.dev");
  }
  const meteredText = (read("METERED") ?? (pubnet ? "false" : "true")).toLowerCase();
  if (meteredText !== "true" && meteredText !== "false") throw new Error("METERED must be true or false");

  const integer = (name: string, fallback: number, max: number, min = 0): number => {
    const text = read(name);
    if (text === undefined) return fallback;
    const value = Number(text);
    if (!/^[0-9]{1,5}$/.test(text) || value < min || value > max)
      throw new Error(`${name} must be an integer from ${String(min)} to ${String(max)}`);
    return value;
  };
  return {
    payTo,
    network,
    facilitatorUrl,
    asset,
    publicUrl,
    metered: meteredText === "true",
    paidLimits: {
      perClient: integer("PAID_PER_MINUTE", DEFAULT_PAID_LIMITS.perClient, 99_999, 1),
      global: integer("PAID_GLOBAL_PER_MINUTE", DEFAULT_PAID_LIMITS.global, 99_999, 1),
    },
    port: integer("PORT", 8080, 65_535),
    trustProxy: integer("TRUST_PROXY_HOPS", 0, 5),
  };
}
