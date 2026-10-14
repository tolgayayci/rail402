/**
 * Facts read from the chain and the facilitator, independent of what a seller reports: balances, a
 * settled transaction (fee bump, fee source against the facilitator's advertised signers, transfers,
 * consumed nonces, the settlement contract's event), and the latest ledger.
 */
import { Asset, Keypair, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { AssetDirectory, contractEventsOf, type StellarNetwork } from "@rail402.dev/stellar";
import {
  accountState,
  inspectTransaction,
  paymentError,
  toDecimal,
  type ExplorerProvider,
} from "@rail402.dev/sdk/browser";
import type { PublicConfig } from "../../../src/shared/public-config.ts";
import { txView } from "./decode.ts";
import type { TxView } from "./events.ts";
import type { BalancesView } from "./types.ts";

/** What the facilitator's `/supported` advertises: its signers and upto settlement authorities. */
export interface SupportedFacts {
  readonly signers: ReadonlySet<string>;
}

export interface ChainFactsOptions {
  readonly server: rpc.Server;
  readonly network: StellarNetwork;
  readonly config: PublicConfig;
  /** The operator fetch (reaches the facilitator proxy). */
  readonly operator: typeof fetch;
  readonly facilitatorUrl: string;
  readonly explorer: ExplorerProvider;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** Reads of a just-settled transaction the RPC may not show yet. */
const TX_ATTEMPTS = 5;
const TX_DELAY_MS = 2_000;
/** Reads of a balance an RPC node behind the settlement's ledger may answer from. */
const BALANCE_ATTEMPTS = 5;
const BALANCE_DELAY_MS = 1_000;
const SUPPORTED_TTL_MS = 60_000;

export class ChainFacts {
  readonly #options: ChainFactsOptions;
  readonly #assets: AssetDirectory;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #latest: number | null = null;
  #supported: { facts: SupportedFacts; at: number } | undefined;

  constructor(options: ChainFactsOptions) {
    this.#options = options;
    this.#assets = new AssetDirectory(options.server, options.config.networkPassphrase);
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.#now = options.now ?? Date.now;
  }

  get assets(): AssetDirectory {
    return this.#assets;
  }

  /** The latest ledger last read; null before the first read. */
  latestLedger(): number | null {
    return this.#latest;
  }

  /** Reads the latest ledger; null when the RPC does not answer. */
  async refreshLedger(): Promise<number | null> {
    try {
      this.#latest = (await this.#options.server.getLatestLedger()).sequence;
    } catch {
      // The last known value stays.
    }
    return this.#latest;
  }

  /** The account's XLM and asset balances, decimal; null for a missing account or trustline. */
  async balances(address: string): Promise<BalancesView> {
    const { config, server } = this.#options;
    const state = await accountState({ server, passphrase: config.networkPassphrase }, address);
    const asset = state.exists ? await this.assetBalance(address) : null;
    return {
      xlm: state.xlm === null ? null : toDecimal(state.xlm, 7),
      asset,
      readAt: this.#now(),
    };
  }

  /**
   * The account's balance of the policy asset, decimal; null without a trustline. With `atLeastLedger`
   * (a settlement's ledger), the trustline is read until the answering node has reached that ledger, so
   * a node behind the one that showed the settlement cannot report the balance before it.
   */
  async assetBalance(address: string, atLeastLedger?: number): Promise<string | null> {
    const { config, server } = this.#options;
    if (atLeastLedger === undefined) {
      const funds = await this.#assets.funds(config.asset.contract, address);
      if (funds === undefined || !funds.trustline) return null;
      return toDecimal(funds.balance, config.asset.decimals);
    }
    const key = xdr.LedgerKey.trustline(
      new xdr.LedgerKeyTrustLine({
        accountId: Keypair.fromPublicKey(address).xdrAccountId(),
        asset: new Asset(config.asset.classic.code, config.asset.classic.issuer).toTrustLineXDRObject(),
      }),
    );
    let read: rpc.Api.GetLedgerEntriesResponse | undefined;
    for (let attempt = 0; attempt < BALANCE_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.#sleep(BALANCE_DELAY_MS);
      read = await server.getLedgerEntries(key);
      if (read.latestLedger >= atLeastLedger) break;
    }
    const entry = read?.entries[0]?.val;
    if (entry === undefined) return null;
    return toDecimal(entry.trustLine().balance().toBigInt(), config.asset.decimals);
  }

  /** A settled transaction, read from the RPC (retried while it is not visible yet). */
  async tx(hash: string): Promise<TxView> {
    const { server, network, config } = this.#options;
    let response: rpc.Api.GetTransactionResponse | undefined;
    for (let attempt = 0; attempt < TX_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.#sleep(TX_DELAY_MS);
      try {
        response = await server.getTransaction(hash);
      } catch {
        response = undefined;
        continue;
      }
      if (response.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) break;
    }
    if (response === undefined) {
      throw paymentError("rpc_unavailable", {
        reason: "The transaction could not be read from the Stellar RPC.",
      });
    }
    const found = response;
    const report = await inspectTransaction(hash, {
      network,
      server: { getTransaction: () => Promise.resolve(found) },
      explorer: this.#options.explorer,
      describe: (contract) => this.#assets.describe(contract),
      facilitator: { url: this.#options.facilitatorUrl, fetch: this.#options.operator },
    });
    return txView(
      report,
      found.status === rpc.Api.GetTransactionStatus.SUCCESS
        ? uptoSettledOf(found, config.uptoContract)
        : null,
    );
  }

  /** The facilitator's advertised signers and settlement authorities, cached for a minute. */
  async supported(): Promise<SupportedFacts> {
    const cached = this.#supported;
    if (cached !== undefined && this.#now() - cached.at < SUPPORTED_TTL_MS) return cached.facts;
    const signers = new Set<string>();
    try {
      const response = await this.#options.operator(`${this.#options.facilitatorUrl}/supported`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const body = (await response.json()) as {
          kinds?: unknown;
          signers?: Record<string, unknown>;
        };
        for (const [pattern, list] of Object.entries(body.signers ?? {})) {
          if (!pattern.startsWith("stellar:") || !Array.isArray(list)) continue;
          for (const signer of list) if (typeof signer === "string") signers.add(signer);
        }
        for (const kind of Array.isArray(body.kinds) ? (body.kinds as unknown[]) : []) {
          const extra = (kind as { extra?: { facilitatorAddress?: unknown } } | null)?.extra;
          if (typeof extra?.facilitatorAddress === "string") signers.add(extra.facilitatorAddress);
        }
      }
    } catch {
      // Unknown: attribution stays unchecked.
    }
    const facts = { signers };
    if (signers.size > 0) this.#supported = { facts, at: this.#now() };
    return facts;
  }

  /** Whether an address is advertised by the facilitator; null before `/supported` was read. */
  advertised(address: string): boolean | null {
    const facts = this.#supported?.facts;
    return facts === undefined ? null : facts.signers.has(address);
  }
}

/** The settlement contract's `upto_settled` event of a transaction, when it emitted one. */
export function uptoSettledOf(
  transaction: rpc.Api.GetSuccessfulTransactionResponse,
  contract: string,
): TxView["uptoSettled"] {
  let events;
  try {
    events = contractEventsOf(transaction);
  } catch {
    return null;
  }
  for (const event of events) {
    const [name] = event.topics;
    if (event.contract !== contract || name?.switch() !== xdr.ScValType.scvSymbol()) continue;
    if (scValToNative(name) !== "upto_settled") continue;
    try {
      const data = scValToNative(event.data) as Record<string, unknown>;
      const amount = data["amount"];
      const max = data["max_amount"];
      if (typeof amount !== "bigint") continue;
      return { amount: amount.toString(), maxAmount: typeof max === "bigint" ? max.toString() : null };
    } catch {
      continue;
    }
  }
  return null;
}
