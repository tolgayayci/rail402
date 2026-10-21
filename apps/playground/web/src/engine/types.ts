/**
 * The engine contract: what the page can ask of the code that holds the wallet and talks to sellers,
 * the Bazaar and the chain. The page sees public views and lab events only; the key, payment headers
 * and authorization bytes stay behind this interface.
 */
import type { PublicConfig } from "../../../src/shared/public-config.ts";
import type {
  CheckId,
  ExperimentId,
  JsonValue,
  LabEvent,
  ListingView,
  ScenarioId,
  ToolName,
  Trust,
  TxView,
  VersionView,
} from "./events.ts";

export type { PublicConfig };

/** An error the engine reports: a registered code and a non-empty reason, never a stack. */
export interface CodedError {
  readonly code: string;
  readonly reason: string;
  readonly retryable: boolean;
  readonly details?: JsonValue;
}

/** Where the wallet lives: encrypted in IndexedDB, or in this tab only when the browser cannot store it. */
export type WalletStorage = "persistent" | "memory";

export type WalletState =
  | { readonly status: "loading" }
  | { readonly status: "none"; readonly storage: WalletStorage }
  /** Another tab holds the wallet; this one is read-only. */
  | { readonly status: "locked" }
  | {
      readonly status: "ready";
      readonly address: string;
      readonly network: string;
      readonly createdAt: string;
      readonly storage: WalletStorage;
      /** Setup progress: the account exists, trusts the asset, and holds some of it. */
      readonly setup: { readonly account: boolean; readonly trustline: boolean; readonly funded: boolean };
    };

/** Balances of the wallet, decimal; null when the account or the trustline does not exist. */
export interface BalancesView {
  readonly xlm: string | null;
  readonly asset: string | null;
  /** Epoch milliseconds of the read. */
  readonly readAt: number;
}

/** The session budget, decimal amounts of the policy asset. */
export interface BudgetView {
  readonly session: string;
  readonly window: string;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly perCallCap: string;
  readonly sessionCap: string;
  readonly spent: string;
  readonly pending: string;
  readonly remaining: string;
  /** Reservations the chain can no longer prove either way. */
  readonly awaitingProof: number;
  /** Reported settlements the chain did not confirm. */
  readonly falseClaims: number;
}

export interface EngineState {
  readonly wallet: WalletState;
  readonly balances: BalancesView | null;
  /**
   * Whether the balances were read for this wallet: not yet, read, or the last read failed (the
   * balances then keep the last good read, or stay null).
   */
  readonly balancesRead: "pending" | "ok" | "failed";
  readonly budget: BudgetView | null;
  /** The run in progress; only one runs at a time. */
  readonly activeRun: string | null;
  /** Payments still waiting for chain proof; the engine reconciles them in the background. */
  readonly unfinished: number;
  /** The last background error (reconcile, balance read), shown until the next success. */
  readonly lastError: CodedError | null;
}

export interface RunSummary {
  readonly runId: string;
  readonly status: "ok" | "refused" | "error" | "info";
  readonly code?: string;
  readonly reason?: string;
  /**
   * The settled transactions of a run that ended refused after paying on purpose: the session budget
   * check's first payment, which fits the window before the second is refused.
   */
  readonly transactions?: readonly string[];
}

/**
 * One run. `subscribe` replays the events so far, then delivers new ones; `done` settles when the run
 * ends (it never rejects: failures end the run with status `error` and a code). Wallet runs (create,
 * import, fund, forget) start with their `wallet` event instead of a `run` start event.
 */
export interface RunHandle {
  readonly runId: string;
  subscribe(listener: (event: LabEvent) => void): () => void;
  readonly done: Promise<RunSummary>;
  /** Stops waiting; a payment already sent is still reconciled in the background. */
  abort(): void;
}

/** Inputs of a scenario run. `cap` is the per-call cap, decimal, required for every paying run. */
export interface ScenarioRequest {
  readonly scenario: ScenarioId;
  readonly experiment: ExperimentId;
  readonly cap: string;
  /** Overrides of the scenario's defaults, such as `city` or `days`. */
  readonly params?: Readonly<Record<string, string | number>>;
}

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Pay any URL (the Lab), or a Bazaar listing (the Bazaar). */
export type PayRequest =
  | {
      readonly target: string;
      readonly method?: HttpMethod;
      /** JSON body for POST, PUT and PATCH. */
      readonly body?: JsonValue;
      readonly cap: string;
    }
  | {
      readonly listingId: string;
      /** The listing's type as the page read it, recorded on the run; the listing itself decides what is paid. */
      readonly type?: "http" | "mcp";
      /** Path and query parameters (HTTP) or tool arguments (MCP). */
      readonly params?: Readonly<Record<string, JsonValue>>;
      readonly cap: string;
    };

export interface SearchRequest {
  readonly query: string;
  readonly type?: "http" | "mcp";
  readonly maxPrice?: { readonly amount: string; readonly asset: string };
  readonly minimumTrust?: Trust;
  readonly payTo?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SearchPage {
  readonly items: readonly ListingView[];
  readonly method: string | null;
  readonly partialResults: boolean;
  readonly cursor: string | null;
}

export interface ListRequest {
  readonly type?: "http" | "mcp";
  readonly payTo?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ListPage {
  readonly items: readonly ListingView[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

/** A rail402-mcp tool, as the agent and the code panel show it. */
export interface ToolDefinitionView {
  readonly name: ToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
}

/** A run's export: built from its event log only, so it holds nothing the events do not. */
export interface RunReport {
  readonly format: "rail402-playground-run";
  readonly version: 1;
  readonly runId: string;
  readonly network: string;
  readonly playgroundVersion: string;
  readonly startedAt: string;
  readonly summary: RunSummary | null;
  readonly events: readonly LabEvent[];
}

/** The price a resource asks: the option the buyer would choose, or else the first one offered. */
export interface PriceView {
  readonly scheme: string;
  /** Decimal amount; null when the asset is outside the policy. */
  readonly amount: string | null;
  readonly atomic: string;
  readonly symbol: string;
}

export interface WalletActions {
  /** Generates a fresh testnet key in this tab. */
  create(): RunHandle;
  /** Imports a testnet secret seed; the caller clears its input field right after. */
  import(seed: string): RunHandle;
  /**
   * Friendbot, the asset trustline, then a small purchase of the asset: each a real transaction, each
   * skipped when done. `topUp` buys again even when the wallet already holds some.
   */
  fund(options?: { readonly topUp?: boolean }): RunHandle;
  /**
   * Downloads the key as a file (the seed on one line), after the page confirmed with the user. The
   * engine starts the download itself; the seed never reaches the page.
   */
  exportFile(): Promise<{ readonly fileName: string }>;
  /** Deletes the wallet and its budget ledger from this browser. */
  forget(): RunHandle;
}

/** The engine. Methods returning a promise reject with a CodedError, never with a raw exception. */
export interface Engine {
  readonly config: PublicConfig;
  state(): EngineState;
  /** Called after every state change; returns the unsubscribe function. */
  subscribe(listener: (state: EngineState) => void): () => void;
  readonly wallet: WalletActions;
  /** Lowers the session budget total (decimal); raising it is refused. */
  lowerSessionTotal(total: string): Promise<void>;
  /** Proves pending payments now instead of waiting for the background loop. */
  reconcile(): Promise<void>;

  run(request: ScenarioRequest): RunHandle;
  check(check: CheckId): RunHandle;
  pay(request: PayRequest): RunHandle;

  search(request: SearchRequest): Promise<SearchPage>;
  list(request: ListRequest): Promise<ListPage>;
  listing(id: string): Promise<ListingView>;
  versions(id: string): Promise<readonly VersionView[]>;
  /**
   * The price an HTTP URL asks, read from one unpaid request: nothing is signed or reserved. Null when
   * it asks for no payment, or before a wallet is set up (the buyer's policy judges the options).
   */
  quote(url: string): Promise<PriceView | null>;
  inspect(hash: string): Promise<TxView>;
  toolDefinitions(): readonly ToolDefinitionView[];
  /** The report of a run of this page load; undefined for an unknown run. */
  exportRun(runId: string): RunReport | undefined;
}
