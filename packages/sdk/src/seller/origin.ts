import { rpc } from "@stellar/stellar-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { fetchStellarTomlAccounts } from "@rail402.dev/bazaar";
import { createSafeFetch, effectivePort, type EgressPolicyInput } from "@rail402.dev/safe-fetch";
import {
  AssetDirectory,
  TESTNET,
  baseAccount,
  isStellarNetwork,
  networkPassphrase,
  type StellarNetwork,
} from "@rail402.dev/stellar";
import { parseRequired } from "../flow/common.ts";
import { probeTool } from "../flow/mcp.ts";
import type { HttpMethod } from "../flow/types.ts";
import { redact } from "../redact.ts";
import { sellerCodes, sellerError, type SellerCode } from "./codes.ts";
import { validateListing, type ValidationReport } from "./validate.ts";

export interface CheckSellerOriginOptions {
  /** HTTP method of the unpaid request; GET by default. Ignored for MCP tools. */
  readonly method?: HttpMethod;
  /** Checks an MCP tool at `url` (the MCP endpoint) instead of an HTTP resource. */
  readonly toolName?: string;
  readonly transport?: "streamable-http" | "sse";
  /** Arguments for the unpaid tool call. */
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly network?: StellarNetwork;
  /** The facilitator the seller settles through; its /supported is checked when given. */
  readonly facilitatorUrl?: string;
  /** A Soroban RPC for the network; payTo's ability to receive the asset is checked when given. */
  readonly rpcUrl?: string;
  /** Allow loopback URLs (and plain-http RPCs), for a seller running locally. */
  readonly allowLoopback?: boolean;
  /**
   * Replaces the outbound policy of the unpaid request or tool call. By default it allows https, http
   * on testnet, ports 443, 80 and the URL's own, and private addresses only with `allowLoopback`. A
   * service checking URLs from untrusted callers narrows it, for example to https on port 443.
   */
  readonly egress?: EgressPolicyInput;
  readonly signal?: AbortSignal;
}

export interface OriginFinding {
  readonly code: SellerCode;
  readonly reason: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface OriginReport {
  readonly url: string;
  readonly type: "http" | "mcp";
  /** True when the resource asks for payment, the catalog would list it, and no finding was made. */
  readonly ok: boolean;
  /** The unpaid response's status (HTTP), when one arrived. */
  readonly status?: number;
  readonly paymentRequired?: PaymentRequired;
  readonly validation?: ValidationReport;
  readonly findings: readonly OriginFinding[];
  /** Per payment option on the network: whether payTo can receive the asset (undefined: undecidable). */
  readonly receivable?: readonly {
    readonly asset: string;
    readonly payTo: string;
    readonly receivable?: boolean;
  }[];
  /**
   * Whether the resource's domain lists the payTo account in its stellar.toml ACCOUNTS, and (with
   * `rpcUrl`) whether payTo sets the host as its home_domain. The catalog grants `domain_verified` only
   * when both hold.
   */
  readonly domain?: {
    readonly host: string;
    readonly claimsOwner: boolean;
    readonly homeDomainMatches?: boolean;
  };
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const SUPPORTED_TIMEOUT_MS = 10_000;

/**
 * Checks a paid resource the way the Rail402 catalog will: makes the unpaid request (through
 * safe-fetch, or an unpaid `tools/call`), validates the live 402 with the catalog's code, and adds
 * Stellar findings: whether payTo can receive the asset, whether the facilitator settles this scheme
 * and network with sponsored fees and the bazaar extension, and whether the domain's stellar.toml
 * claims payTo and payTo names the domain as its home_domain (which together make the listing
 * `domain_verified`).
 */
export async function checkSellerOrigin(
  url: string,
  options: CheckSellerOriginOptions = {},
): Promise<OriginReport> {
  const network = options.network ?? TESTNET;
  if (!isStellarNetwork(network)) throw sellerError("seller_network_unsupported");
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw sellerError("seller_endpoint_invalid", "The URL to check is not an absolute URL.");
  }
  const type = options.toolName === undefined ? "http" : "mcp";
  const findings: OriginFinding[] = [];
  if (target.protocol === "http:" && network !== TESTNET) {
    findings.push({
      code: "seller_endpoint_invalid",
      reason: "A resource paid on pubnet must be served over https; the catalog refuses plain http.",
    });
  }
  const egress: EgressPolicyInput = options.egress ?? {
    schemes: network === TESTNET ? ["https:", "http:"] : ["https:"],
    // The seller's own resource: its own port is allowed.
    ports: [...new Set([443, 80, safePort(target)])],
    allowPrivateNetwork: options.allowLoopback === true ? "loopback" : false,
  };

  let required: PaymentRequired | undefined;
  let status: number | undefined;
  try {
    if (type === "mcp") {
      const probed = await probeTool(
        () => createSafeFetch(egress),
        {
          kind: "mcp",
          url: target.href,
          toolName: options.toolName ?? "",
          ...(options.arguments === undefined ? {} : { arguments: options.arguments }),
          ...(options.transport === undefined ? {} : { transport: options.transport }),
        },
        options.signal,
      );
      if (probed.kind === "payment") required = probed.required;
    } else {
      ({ required, status } = await probeHttp(target, options.method ?? "GET", egress, options.signal));
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    findings.push(unreachable(error));
    return { url: target.href, type, ok: false, ...(status === undefined ? {} : { status }), findings };
  }
  if (required === undefined) {
    findings.push({
      code: "seller_origin_not_payment_required",
      reason:
        type === "mcp"
          ? "The unpaid tool call returned a result instead of asking for payment."
          : `The unpaid request was answered with HTTP ${String(status)} and no x402 version 2 PAYMENT-REQUIRED header.`,
    });
    return { url: target.href, type, ok: false, ...(status === undefined ? {} : { status }), findings };
  }

  const validation = await validateListing(required, {
    network,
    concreteUrl: target.href,
    ...(options.method === undefined ? {} : { method: options.method }),
    ...(options.allowLoopback === true ? { allowLoopback: true } : {}),
  });
  const onNetwork = required.accepts.filter((option) => option.network === network);
  const [receivable, facilitator, domain] = await Promise.all([
    options.rpcUrl === undefined ? undefined : checkReceivable(onNetwork, network, options),
    options.facilitatorUrl === undefined ? undefined : checkFacilitator(options.facilitatorUrl, onNetwork),
    type === "http" && onNetwork[0] !== undefined
      ? checkDomain(target, onNetwork[0].payTo, network, options)
      : undefined,
  ]);
  for (const entry of receivable ?? []) {
    if (entry.receivable === false) {
      findings.push({
        code: "seller_asset_not_receivable",
        reason: `${entry.payTo} cannot receive ${entry.asset} now: add an authorized trustline for the asset.`,
        details: { asset: entry.asset, payTo: entry.payTo },
      });
    }
  }
  if (facilitator !== undefined) findings.push(...facilitator);
  return {
    url: target.href,
    type,
    ok: validation.catalogable && findings.length === 0,
    ...(status === undefined ? {} : { status }),
    paymentRequired: required,
    validation,
    findings,
    ...(receivable === undefined ? {} : { receivable }),
    ...(domain === undefined ? {} : { domain }),
  };
}

async function probeHttp(
  target: URL,
  method: string,
  egress: EgressPolicyInput,
  signal: AbortSignal | undefined,
): Promise<{ required: PaymentRequired | undefined; status: number }> {
  const fetch = createSafeFetch(egress);
  try {
    const verb = method.toUpperCase();
    const body = BODY_METHODS.has(verb) ? "{}" : null;
    const response = await fetch(target, {
      method: verb,
      headers: {
        accept: "application/json",
        ...(body === null ? {} : { "content-type": "application/json" }),
      },
      body,
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    await response.body?.cancel().catch(() => undefined);
    const header = response.headers.get("payment-required");
    if (response.status !== 402 || header === null || header === "") {
      return { required: undefined, status: response.status };
    }
    let decoded: unknown;
    try {
      decoded = decodePaymentRequiredHeader(header);
    } catch {
      return { required: undefined, status: response.status };
    }
    try {
      return { required: parseRequired(decoded), status: response.status };
    } catch {
      return { required: undefined, status: response.status };
    }
  } finally {
    fetch.close();
  }
}

/** Distinct (asset, payTo) pairs whose receivability one check reads; the rest are not checked. */
export const MAX_RECEIVABLE_CHECKS = 8;

/** Receivability reads run at once. */
const RECEIVABLE_CONCURRENCY = 4;

/**
 * Whether each distinct (asset, payTo) pair can receive now. A seller's 402 is untrusted input, so the
 * work is bounded: at most MAX_RECEIVABLE_CHECKS pairs are read, a few at a time (each costs RPC
 * simulations); further pairs are reported without `receivable`, as not checked.
 */
async function checkReceivable(
  options: PaymentRequired["accepts"],
  network: StellarNetwork,
  check: CheckSellerOriginOptions,
): Promise<{ asset: string; payTo: string; receivable?: boolean }[]> {
  const directory = new AssetDirectory(
    new rpc.Server(check.rpcUrl ?? "", { allowHttp: check.allowLoopback === true }),
    networkPassphrase(network),
  );
  const pairs = new Map<string, { asset: string; payTo: string }>();
  for (const option of options) {
    pairs.set(`${option.asset} ${option.payTo}`, { asset: option.asset, payTo: option.payTo });
  }
  const entries = [...pairs.values()];
  const results: { asset: string; payTo: string; receivable?: boolean }[] = entries.map((pair) => ({
    ...pair,
  }));
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < Math.min(entries.length, MAX_RECEIVABLE_CHECKS); index = next++) {
      const pair = entries[index];
      if (pair === undefined) continue;
      const receivable = await directory.receivable(pair.asset, pair.payTo).catch(() => undefined);
      if (receivable !== undefined) results[index] = { ...pair, receivable };
    }
  };
  await Promise.all(Array.from({ length: RECEIVABLE_CONCURRENCY }, worker));
  return results;
}

/** The facilitator's /supported must list each option's scheme and network with sponsored fees, and bazaar. */
async function checkFacilitator(
  facilitatorUrl: string,
  options: PaymentRequired["accepts"],
): Promise<OriginFinding[]> {
  const finding = (reason: string): OriginFinding => ({ code: "seller_facilitator_unsupported", reason });
  let supported: unknown;
  try {
    // An endpoint the seller configured, not one from untrusted input.
    const response = await fetch(new URL("supported", withSlash(facilitatorUrl)), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(SUPPORTED_TIMEOUT_MS),
    });
    if (!response.ok)
      return [finding(`The facilitator's /supported answered HTTP ${String(response.status)}.`)];
    supported = await response.json();
  } catch (error) {
    return [finding(`The facilitator's /supported could not be read: ${redact(message(error))}`)];
  }
  const kinds = field(supported, "kinds");
  const extensions = field(supported, "extensions");
  const findings: OriginFinding[] = [];
  for (const option of options) {
    const kind = Array.isArray(kinds)
      ? (kinds as unknown[]).find(
          (entry) =>
            field(entry, "x402Version") === 2 &&
            field(entry, "scheme") === option.scheme &&
            field(entry, "network") === option.network,
        )
      : undefined;
    if (kind === undefined) {
      findings.push(finding(`The facilitator does not settle ${option.scheme} on ${option.network}.`));
    } else if (field(field(kind, "extra"), "areFeesSponsored") !== true) {
      findings.push(
        finding(`The facilitator does not sponsor fees for ${option.scheme} on ${option.network}.`),
      );
    }
  }
  if (!Array.isArray(extensions) || !extensions.includes("bazaar")) {
    findings.push(finding("The facilitator does not support the bazaar extension, so nothing is cataloged."));
  }
  return findings;
}

async function checkDomain(
  target: URL,
  payTo: string,
  network: StellarNetwork,
  check: CheckSellerOriginOptions,
): Promise<{ host: string; claimsOwner: boolean; homeDomainMatches?: boolean }> {
  const owner = baseAccount(payTo);
  const allowLoopback = check.allowLoopback === true;
  const toml = await fetchStellarTomlAccounts(target.host, { allowLoopback }).catch(() => undefined);
  const claimsOwner = toml?.ok === true && owner !== undefined && toml.accounts.includes(owner);
  if (check.rpcUrl === undefined) return { host: target.host, claimsOwner };
  const directory = new AssetDirectory(
    new rpc.Server(check.rpcUrl, { allowHttp: allowLoopback }),
    networkPassphrase(network),
  );
  const homeDomain = await directory.homeDomain(payTo).catch(() => undefined);
  return {
    host: target.host,
    claimsOwner,
    homeDomainMatches: homeDomain === target.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
  };
}

function unreachable(error: unknown): OriginFinding {
  const code = field(error, "code");
  return {
    code: "seller_origin_unreachable",
    reason: `${sellerCodes.seller_origin_unreachable.reason} ${redact(message(error))}`.trim(),
    ...(typeof code === "string" ? { details: { cause: code } } : {}),
  };
}

function safePort(url: URL): number {
  try {
    return effectivePort(url);
  } catch {
    return 443;
  }
}

function withSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function message(error: unknown): string {
  const reason = field(error, "reason");
  if (typeof reason === "string") return reason;
  return error instanceof Error ? error.message.slice(0, 200) : "";
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
