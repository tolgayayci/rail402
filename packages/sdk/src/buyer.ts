import {
  checkUrl,
  createSafeFetch,
  resolvePolicy as resolveEgress,
  type EgressPolicyInput,
  type SafeFetch,
} from "@rail402.dev/safe-fetch";
import type { StellarNetwork } from "@rail402.dev/stellar";
import { assembleBuyer, type Buyer } from "./buyer-core.ts";
import { paymentError } from "./codes.ts";
import type { PaymentEventListener } from "./events.ts";
import type { ExplorerProvider } from "./explorer.ts";
import type { KeySource, Sep43AuthSigner } from "./keys.ts";
import { NETWORK_DEFAULTS, requireNetwork } from "./networks.ts";
import type { SessionOptions } from "./policy/budget.ts";
import type { SpendLedger } from "./policy/ledger.ts";
import type { SpendingPolicyInput } from "./policy/policy.ts";
import type { StellarSchemeAdapter } from "./schemes/adapter.ts";

export interface BuyerOptions {
  /** Required: there is no default network. */
  readonly network: StellarNetwork;
  /** Without a signer the buyer can search and quote; paying is `payment_signer_unavailable`. */
  readonly signer?: KeySource | Sep43AuthSigner;
  /** Testnet default: the SDF testnet RPC. Required on pubnet. */
  readonly rpcUrl?: string;
  /** Testnet default: https://testnet.rail402.dev. Required on pubnet for discovery. */
  readonly bazaarUrl?: string;
  readonly policy?: SpendingPolicyInput;
  /** Default: a new in-memory ledger. */
  readonly ledger?: SpendLedger;
  readonly session?: SessionOptions;
  /** Egress policy for seller URLs. Pubnet refuses plain http and private-network destinations. */
  readonly egress?: EgressPolicyInput;
  /**
   * Default: the exact scheme, and the upto scheme signing for the policy's first pinned settlement
   * contract. The policy's `schemes` decides which of them may pay.
   */
  readonly schemes?: readonly StellarSchemeAdapter[];
  readonly explorer?: ExplorerProvider;
  /** On-chain receipt check after a settlement. Default `sync` (a few tries over about six seconds). */
  readonly verify?: "sync" | "async" | "off";
  readonly onEvent?: PaymentEventListener;
  /** A facilitator whose advertised signers attribute inspected transactions. */
  readonly facilitatorUrl?: string;
  /** For the Bazaar and facilitator (operator-configured endpoints); seller URLs always use safe-fetch. */
  readonly fetch?: typeof fetch;
}

/**
 * Creates a buyer: resolves the spending policy (custom token decimals are verified on chain), opens
 * the budget window for the signer, and wires discovery, the payment flows and the signing guard.
 * Seller URLs go through safe-fetch under `egress`; each MCP session opens its own.
 */
export async function createBuyer(options: BuyerOptions): Promise<Buyer> {
  const network = requireNetwork(options.network);
  const defaults = NETWORK_DEFAULTS[network];
  const rpcUrl = options.rpcUrl ?? defaults.rpcUrl;
  if (rpcUrl === undefined || !URL.canParse(rpcUrl)) {
    throw paymentError("payment_policy_invalid", { reason: "An RPC URL is required on pubnet." });
  }
  const egressInput: EgressPolicyInput = options.egress ?? {};
  // Resolved first, so an invalid policy is refused before anything is opened.
  resolveEgress(egressInput);
  const seller: SafeFetch = createSafeFetch(egressInput);
  try {
    return await assembleBuyer({
      network,
      signer: options.signer,
      rpcUrl,
      bazaarUrl: options.bazaarUrl ?? defaults.bazaarUrl,
      facilitatorUrl: options.facilitatorUrl,
      policy: options.policy,
      ledger: options.ledger,
      session: options.session,
      schemes: options.schemes,
      explorer: options.explorer,
      verify: options.verify,
      onEvent: options.onEvent,
      seller,
      openSession: () => createSafeFetch(egressInput),
      operator: options.fetch,
      checkUrl: (url, egress) => checkUrl(url, egress),
      close: () => {
        seller.close();
      },
    });
  } catch (error) {
    seller.close();
    throw error;
  }
}
