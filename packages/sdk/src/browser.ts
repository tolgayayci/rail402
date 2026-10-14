/**
 * `@rail402.dev/sdk/browser`: the buyer for pages and other runtimes without Node. It is the same
 * buyer as `createBuyer` (spending policy, signing guard, budget ledger, discovery, payment flows and
 * on-chain checks) over a transport the page supplies, since a browser cannot open SSRF-safe
 * connections itself. Nothing here imports a Node module; there are no seller helpers, no
 * configuration loading and no SQLite ledger.
 */
import type { SafeFetch } from "@rail402.dev/safe-fetch/shared";
import type { StellarNetwork } from "@rail402.dev/stellar";
import { assembleBuyer, type Buyer, type BuyerTransport } from "./buyer-core.ts";
import { paymentError } from "./codes.ts";
import type { PaymentEventListener } from "./events.ts";
import type { ExplorerProvider } from "./explorer.ts";
import type { Sep43AuthSigner } from "./keys.ts";
import { checkUrlSyntax } from "./listing.ts";
import { NETWORK_DEFAULTS, requireNetwork } from "./networks.ts";
import type { SessionOptions } from "./policy/budget.ts";
import type { SpendLedger } from "./policy/ledger.ts";
import type { SpendingPolicyInput } from "./policy/policy.ts";
import type { StellarSchemeAdapter } from "./schemes/adapter.ts";

export * from "./account.ts";
export type {
  Buyer,
  BuyerTransport,
  ListPage,
  Listing,
  SearchAndPayOptions,
  SearchPage,
} from "./buyer-core.ts";
export * from "./codes.ts";
export * from "./discovery.ts";
export * from "./events.ts";
export * from "./explorer.ts";
export * from "./keys.ts";
export * from "./money.ts";
export * from "./networks.ts";
export * from "./redact.ts";
export type * from "./flow/receipt.ts";
export * from "./flow/types.ts";
export { paymentIdentifier, type FlowContext, type FlowChain } from "./flow/common.ts";
export { ALLOWED_REQUEST_HEADERS, INLINE_BODY_BYTES, buildHttpRequest } from "./flow/http.ts";
export { MCP_PAYMENT_META_KEY, MCP_PAYMENT_RESPONSE_META_KEY, MAX_TOOL_ARGUMENTS_BYTES } from "./flow/mcp.ts";
export * from "./inspect/transaction.ts";
export * from "./listing.ts";
export * from "./policy/policy.ts";
export * from "./policy/decide.ts";
export * from "./policy/guard.ts";
export * from "./policy/ledger.ts";
export * from "./policy/budget.ts";
export * from "./policy/memory-ledger.ts";
export * from "./policy/storage-ledger.ts";
export * from "./policy/reconcile.ts";
export type * from "./schemes/adapter.ts";
export * from "./schemes/exact.ts";
export * from "./schemes/upto.ts";
export { facilitatorRefusal } from "./policy/facilitator.ts";

export interface BrowserBuyerOptions {
  /** Required: there is no default network. */
  readonly network: StellarNetwork;
  /** The payer's signer; every payment authorization goes through the signing guard first. */
  readonly signer: Sep43AuthSigner;
  /** The Soroban RPC, called directly (it must allow the page's origin). https on pubnet. */
  readonly rpcUrl: string;
  readonly transport: BuyerTransport;
  /** Testnet default: https://testnet.rail402.dev. Required on pubnet for discovery. */
  readonly bazaarUrl?: string;
  /** A facilitator whose advertised signers attribute inspected transactions. */
  readonly facilitatorUrl?: string;
  readonly policy?: SpendingPolicyInput;
  /** Default: a new in-memory ledger. A page that reloads keeps its budget with `StorageSpendLedger`. */
  readonly ledger?: SpendLedger;
  readonly session?: SessionOptions;
  readonly schemes?: readonly StellarSchemeAdapter[];
  readonly explorer?: ExplorerProvider;
  /** On-chain receipt check after a settlement. Default `sync`. */
  readonly verify?: "sync" | "async" | "off";
  readonly onEvent?: PaymentEventListener;
}

/**
 * Creates a buyer over a supplied transport. Search results count as callable when their URL passes
 * `checkUrlSyntax` under the seller transport's policy; the transport refuses private destinations.
 * The same pubnet rules as `createBuyer` apply: an https RPC, and a seller policy that allows https on
 * port 443 only and no private network (`payment_policy_invalid`). The transport belongs to the
 * caller: closing the buyer does not close it.
 */
export async function createBrowserBuyer(options: BrowserBuyerOptions): Promise<Buyer> {
  const network = requireNetwork(options.network);
  const { rpcUrl, transport, signer } = options;
  if (typeof rpcUrl !== "string" || !URL.canParse(rpcUrl)) {
    throw paymentError("payment_policy_invalid", { reason: "An RPC URL is required." });
  }
  if (typeof transport.seller !== "function" || typeof transport.operator !== "function") {
    throw paymentError("payment_policy_invalid", {
      reason: "The transport needs a seller fetch and an operator fetch.",
    });
  }
  if (typeof signer.signAuthEntry !== "function") throw paymentError("payment_signer_unavailable");
  const seller = transport.seller;
  return assembleBuyer({
    network,
    signer,
    rpcUrl,
    bazaarUrl: options.bazaarUrl ?? NETWORK_DEFAULTS[network].bazaarUrl,
    facilitatorUrl: options.facilitatorUrl,
    policy: options.policy,
    ledger: options.ledger,
    session: options.session,
    schemes: options.schemes,
    explorer: options.explorer,
    verify: options.verify,
    onEvent: options.onEvent,
    seller,
    openSession: transport.openSession ?? (() => sharedSession(seller)),
    operator: transport.operator,
    checkUrl: checkUrlSyntax,
  });
}

/** The seller fetch for one MCP session, whose end must not close the shared transport. */
function sharedSession(seller: SafeFetch): SafeFetch {
  return Object.assign((input: string | URL, init?: Parameters<SafeFetch>[1]) => seller(input, init), {
    policy: seller.policy,
    close: () => undefined,
  });
}
