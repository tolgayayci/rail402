import { PUBNET, TESTNET, type StellarNetwork } from "@rail402.dev/stellar";
import { paymentError } from "./codes.ts";

/**
 * Where transaction and account links point:
 * - `"rail402"` (the default): the Rail402 Explorer at `https://explorer.rail402.dev`, where pubnet
 *   pages have no prefix and testnet pages live under `/testnet`. It finds a fee-bumped settlement by
 *   its outer hash (the one a settle response returns) and by its inner hash;
 * - `"stellar.expert"`: `https://stellar.expert/explorer/{public|testnet}/…`;
 * - `{ rail402BaseUrl }`: a self-hosted Rail402 Explorer with the same paths;
 * - `{ template, accountTemplate? }`: https templates. `{hash}` is the transaction hash, `{address}`
 *   the account or contract, `{network}` is `public` or `testnet`, `{networkPath}` is `""` on pubnet
 *   and `"/testnet"` on testnet. Without `accountTemplate` there are no account links.
 */
export type ExplorerProvider =
  | "stellar.expert"
  | "rail402"
  | { readonly rail402BaseUrl: string }
  | { readonly template: string; readonly accountTemplate?: string | undefined };

/** The Rail402 Explorer's public address. */
export const RAIL402_EXPLORER_URL = "https://explorer.rail402.dev";

/** The provider links use when none is configured: the Rail402 Explorer. */
export const DEFAULT_EXPLORER: ExplorerProvider = "rail402";

const HASH = /^[0-9a-f]{64}$/;
const ACCOUNT = /^G[A-Z2-7]{55}$/;
const CONTRACT = /^C[A-Z2-7]{55}$/;

function fill(template: string, network: StellarNetwork, values: Readonly<Record<string, string>>): string {
  let url = template
    .replaceAll("{network}", network === PUBNET ? "public" : "testnet")
    .replaceAll("{networkPath}", network === PUBNET ? "" : "/testnet");
  for (const [name, value] of Object.entries(values)) url = url.replaceAll(`{${name}}`, value);
  return url;
}

function rail402Base(provider: ExplorerProvider): string | undefined {
  if (provider === "rail402") return RAIL402_EXPLORER_URL;
  if (typeof provider === "object" && "rail402BaseUrl" in provider) {
    return provider.rail402BaseUrl.replace(/\/+$/, "");
  }
  return undefined;
}

const networkSegment = (network: StellarNetwork) => (network === PUBNET ? "public" : "testnet");
const networkPath = (network: StellarNetwork) => (network === PUBNET ? "" : "/testnet");

/** The explorer page of a transaction (outer or inner hash, 64 hex characters). */
export function explorerUrl(
  network: StellarNetwork,
  hash: string,
  provider: ExplorerProvider = DEFAULT_EXPLORER,
): string {
  const normalized = hash.toLowerCase();
  if (!HASH.test(normalized)) throw paymentError("transaction_hash_invalid");
  const base = rail402Base(provider);
  if (base !== undefined) return `${base}${networkPath(network)}/tx/${normalized}`;
  if (provider === "stellar.expert") {
    return `https://stellar.expert/explorer/${networkSegment(network)}/tx/${normalized}`;
  }
  if (typeof provider === "object" && "template" in provider) {
    return fill(provider.template, network, { hash: normalized });
  }
  throw paymentError("payment_policy_invalid", { reason: "Unknown explorer provider." });
}

/**
 * The explorer page of an account (`G…`) or contract (`C…`) on the given network. Undefined for any
 * other input, and for a template provider without `accountTemplate`.
 */
export function explorerAccountUrl(
  network: StellarNetwork,
  address: string,
  provider: ExplorerProvider = DEFAULT_EXPLORER,
): string | undefined {
  const kind = ACCOUNT.test(address) ? "account" : CONTRACT.test(address) ? "contract" : undefined;
  if (kind === undefined) return undefined;
  const base = rail402Base(provider);
  // The Rail402 Explorer serves accounts and contracts at the same path.
  if (base !== undefined) return `${base}${networkPath(network)}/account/${address}`;
  if (provider === "stellar.expert") {
    return `https://stellar.expert/explorer/${networkSegment(network)}/${kind}/${address}`;
  }
  if (typeof provider === "object" && "template" in provider && provider.accountTemplate !== undefined) {
    return fill(provider.accountTemplate, network, { address });
  }
  return undefined;
}

/** Whether a URL is https without credentials: the only links an explorer setting may produce. */
function safeHttps(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
}

function refuse(reason: string): never {
  throw paymentError("payment_policy_invalid", { reason });
}

/**
 * Validates an explorer template and optional account template: https, no credentials, `{hash}` in
 * the transaction template and `{address}` in the account template, on both networks.
 */
export function explorerTemplate(template: string, accountTemplate?: string): ExplorerProvider {
  for (const network of [TESTNET, PUBNET] as const) {
    if (!template.includes("{hash}") || !safeHttps(fill(template, network, { hash: "0".repeat(64) }))) {
      refuse("An explorer template must be an https URL containing {hash}.");
    }
    if (
      accountTemplate !== undefined &&
      (!accountTemplate.includes("{address}") ||
        !safeHttps(fill(accountTemplate, network, { address: `G${"A".repeat(55)}` })))
    ) {
      refuse("An explorer account template must be an https URL containing {address}.");
    }
  }
  return accountTemplate === undefined ? { template } : { template, accountTemplate };
}

/** Validates a self-hosted Rail402 Explorer base URL: https, no credentials, query or fragment. */
export function rail402Explorer(baseUrl: string): ExplorerProvider {
  if (!safeHttps(baseUrl) || new URL(baseUrl).search !== "" || new URL(baseUrl).hash !== "") {
    refuse("A Rail402 Explorer base URL is an https URL without credentials, query or fragment.");
  }
  return { rail402BaseUrl: baseUrl.replace(/\/+$/, "") };
}

/** Validates any provider value (for example one read from a configuration file or a page). */
export function checkExplorerProvider(provider: unknown): ExplorerProvider {
  if (provider === "stellar.expert" || provider === "rail402") return provider;
  if (typeof provider === "object" && provider !== null) {
    const record = provider as Record<string, unknown>;
    if (typeof record["rail402BaseUrl"] === "string") return rail402Explorer(record["rail402BaseUrl"]);
    if (typeof record["template"] === "string") {
      const account = record["accountTemplate"];
      if (account !== undefined && typeof account !== "string") refuse("accountTemplate must be a string.");
      return explorerTemplate(record["template"], account);
    }
  }
  return refuse('An explorer is "stellar.expert", "rail402", { rail402BaseUrl } or { template }.');
}
