import { MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import type { IndexNetwork } from "@rail402.dev/x402-index";

/** A network as pages name and link it. Mainnet pages have no prefix; testnet pages live under /testnet. */
export interface NetworkView {
  readonly network: IndexNetwork;
  readonly slug: "pubnet" | "testnet";
  readonly prefix: "" | "/testnet";
  readonly label: "Mainnet" | "Testnet";
  /** stellar.expert's name for the network. */
  readonly expert: "public" | "testnet";
}

export const NETWORK_VIEWS: Readonly<Record<IndexNetwork, NetworkView>> = {
  "stellar:pubnet": {
    network: "stellar:pubnet",
    slug: "pubnet",
    prefix: "",
    label: "Mainnet",
    expert: "public",
  },
  "stellar:testnet": {
    network: "stellar:testnet",
    slug: "testnet",
    prefix: "/testnet",
    label: "Testnet",
    expert: "testnet",
  },
};

export const viewOfSlug = (slug: string): NetworkView | undefined =>
  slug === "testnet"
    ? NETWORK_VIEWS["stellar:testnet"]
    : slug === "pubnet"
      ? NETWORK_VIEWS["stellar:pubnet"]
      : undefined;

/** Stellar Asset Contract amounts have 7 decimals. */
export const SAC_DECIMALS = 7;

/** An atomic amount as a decimal with `decimals` places, trailing zeros trimmed: 1230000 → "0.123". */
export function decimalAmount(atomic: string, decimals = SAC_DECIMALS): string {
  if (!/^-?\d+$/.test(atomic)) return atomic;
  const negative = atomic.startsWith("-");
  const digits = (negative ? atomic.slice(1) : atomic).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${groupThousands(whole)}${fraction === "" ? "" : `.${fraction}`}`;
}

/** 1234567 → "1,234,567". */
export function groupThousands(digits: string | number): string {
  return String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** An ISO time as "2026-10-22 13:19:02 UTC". */
export function utc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** The first and last six characters of a strkey or hash; pages always show the full value next to it. */
export function shortened(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 6)}…${value.slice(-6)}`;
}

export const stellarExpertTx = (view: NetworkView, hash: string) =>
  `https://stellar.expert/explorer/${view.expert}/tx/${hash}`;

export const stellarExpertAccount = (view: NetworkView, address: string) =>
  `https://stellar.expert/explorer/${view.expert}/${address.startsWith("C") ? "contract" : "account"}/${address}`;

/** A copy-paste command that fetches the transaction from a public RPC, independent of this site. */
export function rpcCommand(rpcUrl: string, hash: string): string {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: { hash } });
  return `curl -s -X POST ${rpcUrl} -H 'Content-Type: application/json' -d '${body}'`;
}

/** A hash as its first six and last four characters: "f53de3…f137". The full value goes in a title. */
export function shortHash(hash: string): string {
  return hash.length <= 12 ? hash : `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

/** A strkey as its first and last four characters: "GBAT…5LVL". The full value goes in a title. */
export function shortKey(address: string): string {
  return address.length <= 10 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** How long ago `iso` was, from `now`: "just now", "21 mins ago", "3 hrs ago", "4 days ago". */
export function ago(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)} hr${hours === 1 ? "" : "s"} ago`;
  return `${String(Math.floor(hours / 24))} days ago`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An ISO time as "26 Oct 2026, 13:58 UTC" (or the date only). */
export function day(iso: string, withTime = true): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = `${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ""} ${String(date.getUTCFullYear())}`;
  return withTime ? `${text}, ${date.toISOString().slice(11, 16)} UTC` : text;
}

/** A UTC day key "2026-10-26" as "26 Oct". */
export function dayLabel(key: string): string {
  const [, month, date] = key.split("-");
  return `${String(Number(date))} ${MONTHS[Number(month) - 1] ?? ""}`;
}

/** A share as a percentage with one decimal: 0.948 → "94.8%". */
export function percent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${((part / whole) * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

/** The base account of an address: an M… muxed address's G… account; any other address as it is. */
export function baseAccount(address: string): string {
  if (!StrKey.isValidMed25519PublicKey(address)) return address;
  return MuxedAccount.fromAddress(address, "0").baseAccount().accountId();
}

/**
 * Assets whose code alone may name them, per network: Circle's USDC. Any other verified Stellar asset,
 * a USDC from another issuer included, is named by its code and a short issuer.
 */
export const DISPLAY_ASSETS: Readonly<
  Record<IndexNetwork, Readonly<Record<string, { readonly contract: string; readonly issuer: string }>>>
> = {
  "stellar:testnet": {
    USDC: {
      contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    },
  },
  "stellar:pubnet": {
    USDC: {
      contract: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    },
  },
};

/**
 * The name a verified Stellar asset is shown under: its bare code only for an allow-listed contract
 * ("USDC"), otherwise its code and a short issuer ("USDC GABC…WXYZ"), so a look-alike never passes for
 * the real one. `code` is untrusted text and is cleaned before display.
 */
export function assetName(network: string, contract: string, code: string, issuer: string | null): string {
  const clean = code.replace(/[^\x21-\x7e]/g, "").slice(0, 12);
  // The native asset's contract has no issuer; people know it as XLM.
  if (clean === "native" && issuer === null) return "XLM";
  const known = (DISPLAY_ASSETS as Readonly<Record<string, (typeof DISPLAY_ASSETS)[IndexNetwork]>>)[
    network
  ]?.[clean];
  if (known !== undefined && known.contract === contract) return clean;
  return `${clean} ${shortKey(issuer ?? contract)}`;
}

/** The allow-listed contract of `code` on `network` (USDC), if any. */
export function displayContract(network: string, code: string): string | undefined {
  return (DISPLAY_ASSETS as Readonly<Record<string, (typeof DISPLAY_ASSETS)[IndexNetwork]>>)[network]?.[code]
    ?.contract;
}
