import { rpc } from "@stellar/stellar-sdk";
import type { EgressPolicy, SafeFetch } from "@rail402.dev/safe-fetch/shared";
import {
  AssetDirectory,
  LatestLedger,
  PUBNET,
  networkPassphrase,
  type StellarNetwork,
} from "@rail402.dev/stellar";
import { paymentError } from "./codes.ts";
import { DiscoveryClient, type ListFilters, type ListingVersion, type SearchFilters } from "./discovery.ts";
import type { PaymentEventListener } from "./events.ts";
import type { ExplorerProvider } from "./explorer.ts";
import type { FlowContext } from "./flow/common.ts";
import { payHttp, quoteHttp } from "./flow/http.ts";
import { payMcp, quoteMcp } from "./flow/mcp.ts";
import type { CallInput, CallResult, HttpMethod, PayOptions, PaymentTarget, Quote } from "./flow/types.ts";
import { inspectTransaction, type TransactionReport } from "./inspect/transaction.ts";
import { loadSigner, type KeySource, type Sep43AuthSigner } from "./keys.ts";
import { bindingFor, expandRoute, payableHit, toHit, type HitContext, type SearchHit } from "./listing.ts";
import type { Money } from "./money.ts";
import { budgetSnapshot, windowSpecFor, type BudgetSnapshot, type SessionOptions } from "./policy/budget.ts";
import type { SpendLedger } from "./policy/ledger.ts";
import { MemorySpendLedger } from "./policy/memory-ledger.ts";
import { meetsTrust, resolvePolicy, type ResolvedPolicy, type SpendingPolicyInput } from "./policy/policy.ts";
import { reconcile, rpcChainReader, type ReconcileReport } from "./policy/reconcile.ts";
import type { StellarSchemeAdapter } from "./schemes/adapter.ts";
import { exactScheme } from "./schemes/exact.ts";
import { uptoScheme } from "./schemes/upto.ts";

/**
 * How a buyer reaches the network outside the Stellar RPC. Node buyers use safe-fetch for sellers and
 * the platform fetch for operator endpoints; a browser page supplies its own (for example a relay).
 */
export interface BuyerTransport {
  /**
   * Seller requests: probes and paid calls of the HTTP flow. It must honour the `SafeFetch` contract:
   * refuse what its policy forbids with an `EgressError`, and record every response it returns with
   * `markFinalRequest`. Its policy bounds what is sent and which listings count as callable.
   */
  readonly seller: SafeFetch;
  /** A fetch for one MCP session, closed when the session ends. Default: `seller`, never closed. */
  readonly openSession?: (() => SafeFetch) | undefined;
  /** The Bazaar and a facilitator's `/supported`: operator-configured endpoints, never seller URLs. */
  readonly operator: typeof fetch;
}

export interface SearchPage {
  readonly hits: readonly SearchHit[];
  readonly nextCursor: string | null;
  readonly partialResults: boolean;
  readonly method: string | undefined;
}

export interface ListPage {
  readonly hits: readonly SearchHit[];
  readonly pagination: {
    readonly limit: number;
    readonly offset: number;
    readonly total: number;
    readonly asOf: string | undefined;
  };
}

export type Listing = SearchHit & { readonly state: "pending" | "published" | "quarantined" };

export interface SearchAndPayOptions extends PayOptions {
  readonly filters?: SearchFilters;
  /** Default: the first result that is callable, within policy and trusted enough. */
  readonly pick?: (page: SearchPage) => SearchHit | undefined;
  readonly call?: CallInput;
}

export interface Buyer {
  readonly network: StellarNetwork;
  /** The payer, or undefined for a search-only buyer. */
  readonly address: string | undefined;
  /** The spending policy in force, with the network's defaults filled in. */
  readonly policy: ResolvedPolicy;
  search(query: string, filters?: SearchFilters, signal?: AbortSignal): Promise<SearchPage>;
  list(filters?: ListFilters, signal?: AbortSignal): Promise<ListPage>;
  listing(id: string, signal?: AbortSignal): Promise<Listing>;
  /** A listing's public version history, oldest first. */
  listingVersions(id: string, signal?: AbortSignal): Promise<readonly ListingVersion[]>;
  /** The unpaid probe and each option's verdict; never signs. */
  quote(
    target: PaymentTarget,
    options?: { readonly maxAmount?: Money; readonly signal?: AbortSignal },
  ): Promise<Quote>;
  /** Pays a resource given by URL (and tool name for MCP). */
  pay(target: PaymentTarget, options: PayOptions): Promise<CallResult>;
  /** Pays a Bazaar listing, bound to its owner (and, for HTTP, its price). */
  payListing(listing: string | SearchHit, call: CallInput, options: PayOptions): Promise<CallResult>;
  /** Searches, picks a result and pays it through its listing. */
  searchAndPay(
    query: string,
    options: SearchAndPayOptions,
  ): Promise<CallResult & { readonly chosen: SearchHit }>;
  inspectTransaction(hash: string): Promise<TransactionReport>;
  budget(): Promise<BudgetSnapshot>;
  reconcile(): Promise<ReconcileReport>;
  close(): Promise<void>;
}

/** Longest a verification waits between on-chain lookups. */
const VERIFY_DELAY_MS = 2_000;
/** Most rows reconciliation checks on chain in one run. */
const RECONCILE_LIMIT = 20;

/** What `assembleBuyer` wires together; `createBuyer` and `createBrowserBuyer` supply it. */
export interface BuyerDeps {
  readonly network: StellarNetwork;
  readonly signer: KeySource | Sep43AuthSigner | undefined;
  readonly rpcUrl: string;
  readonly bazaarUrl: string | undefined;
  readonly facilitatorUrl: string | undefined;
  readonly policy: SpendingPolicyInput | undefined;
  readonly ledger: SpendLedger | undefined;
  readonly session: SessionOptions | undefined;
  readonly schemes: readonly StellarSchemeAdapter[] | undefined;
  readonly explorer: ExplorerProvider | undefined;
  readonly verify: "sync" | "async" | "off" | undefined;
  readonly onEvent: PaymentEventListener | undefined;
  /** The seller fetch; its policy is the buyer's egress policy. */
  readonly seller: SafeFetch;
  readonly openSession: () => SafeFetch;
  /** Undefined: the platform fetch. */
  readonly operator: typeof fetch | undefined;
  /** How search results are judged callable (`HitContext.checkUrl`). */
  readonly checkUrl: HitContext["checkUrl"];
  /** Releases what the buyer owns when it is closed. */
  readonly close?: (() => void) | undefined;
}

/**
 * Refuses settings that are never allowed on pubnet: plain http or private destinations for sellers,
 * ports other than 443, and an RPC without https.
 */
export function checkPubnetTransport(network: StellarNetwork, egress: EgressPolicy, rpcUrl: string): void {
  if (network !== PUBNET) return;
  if (egress.schemes.includes("http:") || egress.allowPrivateNetwork !== false) {
    throw paymentError("payment_policy_invalid", {
      reason: "Plain http and private-network destinations are never allowed on pubnet.",
    });
  }
  if (egress.ports.some((value) => value !== 443)) {
    throw paymentError("payment_policy_invalid", {
      reason: "Extra ports are for local development; pubnet sellers are paid on port 443.",
    });
  }
  if (new URL(rpcUrl).protocol !== "https:") {
    throw paymentError("payment_policy_invalid", { reason: "The RPC URL must use https on pubnet." });
  }
}

/**
 * Assembles a buyer from resolved parts: resolves the spending policy (custom token decimals are
 * verified on chain), opens the budget window for the signer, and wires discovery, the payment flows
 * and the signing guard. The transport checks for the network come first (`checkPubnetTransport`).
 */
export async function assembleBuyer(deps: BuyerDeps): Promise<Buyer> {
  const { network, rpcUrl, bazaarUrl } = deps;
  const egress = deps.seller.policy;
  checkPubnetTransport(network, egress, rpcUrl);

  const server = new rpc.Server(rpcUrl, { allowHttp: new URL(rpcUrl).protocol === "http:" });
  const assets = new AssetDirectory(server, networkPassphrase(network));
  const signer = deps.signer === undefined ? undefined : await loadSigner(deps.signer);
  const policy = await resolvePolicy(network, deps.policy, {
    requireCaps: signer !== undefined,
    describe: (contract) => assets.describe(contract),
  });
  const [pinnedUpto] = policy.uptoContracts;
  const adapters = deps.schemes ?? [
    exactScheme(),
    uptoScheme(pinnedUpto === undefined ? {} : { contract: pinnedUpto }),
  ];
  const ledger = deps.ledger ?? new MemorySpendLedger();
  const spec = signer === undefined ? undefined : windowSpecFor(policy, signer.address, deps.session);
  const context: FlowContext = {
    network,
    policy,
    adapters,
    signer,
    ledger,
    spec,
    clock: new LatestLedger(server),
    rpcUrl,
    chain: {
      getTransaction: (hash) => server.getTransaction(hash),
      funds: (asset, account) => assets.funds(asset, account),
      receivable: (asset, payTo) => assets.receivable(asset, payTo),
      reader: rpcChainReader(server),
    },
    explorer: deps.explorer ?? "stellar.expert",
    verify: deps.verify ?? "sync",
    verifyDelayMs: VERIFY_DELAY_MS,
    onEvent: deps.onEvent,
    fetch: deps.seller,
    openSession: deps.openSession,
  };
  const discovery =
    bazaarUrl === undefined
      ? undefined
      : new DiscoveryClient({
          baseUrl: bazaarUrl,
          network,
          ...(deps.operator === undefined ? {} : { fetch: deps.operator }),
        });
  const requireDiscovery = (): DiscoveryClient => {
    if (discovery === undefined) {
      throw paymentError("discovery_unavailable", {
        reason: "No Bazaar URL is configured for this network.",
      });
    }
    return discovery;
  };
  const hitContext: HitContext = { network, policy, adapters, egress, checkUrl: deps.checkUrl };

  const search = async (
    query: string,
    filters?: SearchFilters,
    signal?: AbortSignal,
  ): Promise<SearchPage> => {
    const page = await requireDiscovery().search(query, filters, signal);
    return {
      hits: page.items.map((item) => toHit(item, hitContext)),
      nextCursor: page.nextCursor,
      partialResults: page.partialResults,
      method: page.method,
    };
  };

  const listing = async (id: string, signal?: AbortSignal): Promise<Listing> => {
    const item = await requireDiscovery().listing(id, signal);
    return { ...toHit(item, hitContext), state: item.state };
  };

  const payListing = async (
    selected: string | SearchHit,
    call: CallInput,
    payOptions: PayOptions,
  ): Promise<CallResult> => {
    const id = typeof selected === "string" ? selected : selected.listingId;
    if (id === null) {
      throw paymentError("listing_not_payable", { reason: "The result has no listing on this network." });
    }
    // Always the listing as it stands now: its state, owner and prices bind the payment.
    const item = await requireDiscovery().listing(id, payOptions.signal);
    const hit = toHit(item, hitContext);
    const minimum = hit.type === "mcp" ? policy.minTrust.mcp : policy.minTrust.http;
    const refuse = (reason: string) => paymentError("listing_not_payable", { reason });
    if (item.state !== "published") throw refuse(`The listing is ${item.state}, not published.`);
    if (hit.owner === null || hit.listingId !== id) throw refuse(`The listing is not on ${network}.`);
    if (!meetsTrust(hit.trust, minimum)) {
      throw refuse(`The listing's trust is ${hit.trust}; the policy requires ${minimum}.`);
    }
    if (!hit.callable) throw refuse(hit.notCallableReason ?? "The listing cannot be called.");
    const binding = bindingFor(item, network, hit.owner);
    const receivable = (option: { readonly asset: string; readonly payTo: string }) =>
      hit.prices.find((price) => price.assetContract === option.asset && price.payTo === option.payTo)
        ?.receivable ?? undefined;
    const bound = { binding, receivable };
    if (hit.type === "mcp") {
      if (hit.toolName === null) throw refuse("The MCP listing names no tool.");
      return payMcp(
        context,
        {
          kind: "mcp",
          url: hit.resource,
          toolName: hit.toolName,
          ...(call.arguments === undefined ? {} : { arguments: call.arguments }),
          ...(hit.transport === null ? {} : { transport: hit.transport }),
        },
        payOptions,
        { listing: bound },
      );
    }
    return payHttp(
      context,
      {
        kind: "http",
        url: expandRoute(hit.resource, call.pathParams),
        method: (hit.method ?? "GET") as HttpMethod,
        ...(call.query === undefined ? {} : { query: call.query }),
        ...(call.headers === undefined ? {} : { headers: call.headers }),
        ...(call.body === undefined ? {} : { body: call.body }),
      },
      payOptions,
      { listing: bound },
    );
  };

  return {
    network,
    address: signer?.address,
    policy,
    search,
    list: async (filters, signal) => {
      const page = await requireDiscovery().list(filters, signal);
      return { hits: page.items.map((item) => toHit(item, hitContext)), pagination: page.pagination };
    },
    listing,
    listingVersions: (id, signal) => requireDiscovery().versions(id, signal),
    quote: async (target, quoteOptions = {}) => {
      if (target.kind === "mcp") return quoteMcp(context, target, quoteOptions);
      return quoteHttp(context, target, quoteOptions);
    },
    pay: async (target, payOptions) => {
      if (policy.requireCatalogListing) {
        throw paymentError("payment_listing_required", {
          reason: "The spending policy only pays resources selected from a Bazaar listing; use payListing.",
        });
      }
      return target.kind === "mcp"
        ? payMcp(context, target, payOptions)
        : payHttp(context, target, payOptions);
    },
    payListing,
    searchAndPay: async (query, payOptions) => {
      const page = await search(query, payOptions.filters, payOptions.signal);
      const chosen = (
        payOptions.pick ??
        ((candidates: SearchPage) => candidates.hits.find((hit) => payableHit(hit, policy)))
      )(page);
      if (chosen === undefined) {
        throw paymentError("listing_not_payable", {
          reason: "No search result is callable, within the spending policy and trusted enough to pay.",
        });
      }
      const result = await payListing(chosen, payOptions.call ?? {}, payOptions);
      return { ...result, chosen };
    },
    inspectTransaction: (hash) =>
      inspectTransaction(hash, {
        network,
        server,
        explorer: context.explorer,
        describe: (contract) => assets.describe(contract),
        ...(deps.facilitatorUrl === undefined
          ? {}
          : {
              facilitator: {
                url: deps.facilitatorUrl,
                ...(deps.operator === undefined ? {} : { fetch: deps.operator }),
              },
            }),
      }),
    budget: () => {
      if (spec === undefined) return Promise.reject(paymentError("payment_signer_unavailable"));
      return Promise.resolve(budgetSnapshot(ledger, spec, policy));
    },
    reconcile: async () => {
      if (signer === undefined) throw paymentError("payment_signer_unavailable");
      return reconcile(ledger, rpcChainReader(server), {
        network,
        payer: signer.address,
        maxAuthorizationSeconds: policy.maxAuthorizationSeconds,
        limit: RECONCILE_LIMIT,
        onEvent: deps.onEvent,
      });
    },
    close: () => {
      deps.close?.();
      return Promise.resolve();
    },
  };
}
