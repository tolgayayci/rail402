/**
 * The Playground engine: everything the page can do, behind the `Engine` contract. It holds the
 * wallet (through the vault), the browser buyer over the page's transports, the persisted budget
 * ledger, the observer that turns traffic into lab events, and the runs. The page sees public state
 * and lab events only.
 *
 * - One run at a time: a second run while one is active ends at once, refused with
 *   `playground_run_in_progress`. Runs start only from the page's click handlers.
 * - Every payment of a run carries the idempotency key `pg_<runId>`.
 * - SDK events are reported on the run whose call they belong to, also after it ended, so a hold the
 *   background reconciliation releases later shows up on the run that made it.
 * - Methods that return a promise reject with a `CodedError`, never a raw exception.
 */
import { rpc } from "@stellar/stellar-sdk";
import { createTools, type ToolBuyer } from "@rail402.dev/mcp/tools";
import {
  MemorySpendLedger,
  StorageSpendLedger,
  effectiveCap,
  explorerTemplate,
  meetsTrust,
  paymentError,
  resolvePolicy,
  toAtomic,
  type Buyer,
  type BudgetSnapshot,
  type CallInput,
  type KeyValueStore,
  type PaymentEvent,
  type PaymentTarget,
  type ResolvedPolicy,
  type SearchFilters,
  type SearchHit,
  type SessionOptions,
  type SpendLedger,
} from "@rail402.dev/sdk/browser";
import { AssetDirectory, TESTNET } from "@rail402.dev/stellar";
import { playgroundError } from "../../../src/shared/codes.ts";
import {
  SCENARIO_EXPERIMENTS,
  runIdempotencyKey,
  type CheckId,
  type ScenarioId,
} from "../../../src/shared/lab.ts";
import type { PublicConfig } from "../../../src/shared/public-config.ts";
import { Observer } from "../transport/observe.ts";
import { bazaarProxyUrl, facilitatorProxyUrl } from "../transport/operator-fetch.ts";
import { createSellerTransport } from "../transport/seller.ts";
import { acquireTabLock, type LockRequester, type TabLock } from "../wallet/tab-lock.ts";
import type { OnboardingOperations } from "../wallet/onboarding.ts";
import { WalletVault, type StoredWallet } from "../wallet/vault.ts";
import { PLANNER_LABEL, defaultPlan, runAgent } from "./agent/planner.ts";
import {
  buildBuyer as buildBrowserBuyer,
  ledgerPrefix,
  optionJudge,
  policyInput,
  schemeAdapters,
  sessionTotalKey,
  type BuyerWiring,
  type PolicyOptions,
} from "./buyer.ts";
import { Catalog } from "./catalog.ts";
import { ChainFacts } from "./chain.ts";
import { checkCap, runCheck } from "./checks/refusals.ts";
import { codedError, engineError, toJsonValue } from "./errors.ts";
import type { JsonValue, LabEventBody, ListingView, VersionView, TxView } from "./events.ts";
import { runOvercharge } from "./experiments/overcharge.ts";
import { runReplay } from "./experiments/replay.ts";
import { ReconcileLoop, type Timers } from "./reconcile.ts";
import { Run } from "./run.ts";
import { runReport } from "./run-report.ts";
import {
  outcomeOf,
  payOnce,
  reportRefusal,
  settledOutcome,
  type Outcome,
  type RunBuyer,
  type RunContext,
} from "./scenarios/context.ts";
import { runPay } from "./scenarios/pay.ts";
import { runUpto } from "./scenarios/upto.ts";
import type {
  BudgetView,
  CodedError,
  Engine,
  EngineState,
  ListPage,
  ListRequest,
  PayRequest,
  PriceView,
  RunHandle,
  RunReport,
  ScenarioRequest,
  SearchPage,
  SearchRequest,
  ToolDefinitionView,
  WalletActions,
} from "./types.ts";

export { PLANNER_LABEL };

export interface EngineOptions {
  readonly config: PublicConfig;
  /** The browser's fetch. */
  readonly fetch?: typeof fetch;
  /** Where the budget ledger and the chosen session total are kept: the page's `localStorage`. */
  readonly storage?: KeyValueStore | null;
  readonly vault?: WalletVault | Promise<WalletVault>;
  readonly locks?: LockRequester;
  readonly server?: rpc.Server;
  /** Builds the browser buyer; tests pass their own. */
  readonly buildBuyer?: (wiring: BuyerWiring) => Promise<Buyer>;
  /** Saves a file for the user; default an object-URL download. */
  readonly download?: (fileName: string, blob: Blob) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timers?: Timers;
  readonly focus?: EventTarget;
  readonly randomId?: () => string;
  readonly now?: () => number;
  /** Chain and facilitator reads; tests pass their own. */
  readonly chain?: EngineChain;
  /** Onboarding's chain operations; tests pass their own. */
  readonly onboarding?: OnboardingOperations;
}

/** The chain reads the engine makes. */
export type EngineChain = Pick<
  ChainFacts,
  "balances" | "assetBalance" | "tx" | "refreshLedger" | "latestLedger" | "supported" | "advertised"
>;

type Listener = (state: EngineState) => void;

/** SDK events that open a call; only these attach a call the engine has not seen to the active run. */
const OPENING_EVENTS: ReadonlySet<PaymentEvent["type"]> = new Set(["probe", "quote", "refused", "reserved"]);

/** Arming a stored wallet that failed is tried again this often, 1 s apart and doubling up to 16 s. */
const ARM_ATTEMPTS = 6;
const ARM_RETRY_MS = 1_000;
const ARM_RETRY_MAX_MS = 16_000;

export class PlaygroundEngine implements Engine {
  readonly config: PublicConfig;
  readonly wallet: WalletActions;
  /** Settles once the engine read its wallet (or found it locked by another tab). */
  readonly ready: Promise<void>;

  readonly #options: EngineOptions;
  readonly #fetch: typeof fetch;
  readonly #storage: KeyValueStore | null;
  readonly #listeners = new Set<Listener>();
  readonly #observer: Observer;
  readonly #transport: ReturnType<typeof createSellerTransport>;
  readonly #chain: EngineChain;
  readonly #catalog: Catalog;
  readonly #server: rpc.Server;
  readonly #origin: string;
  readonly #runs = new Map<string, Run>();
  readonly #callRuns = new Map<string, Run>();
  readonly #loop: ReconcileLoop;
  readonly #sleep: (ms: number) => Promise<void>;
  #state: EngineState = {
    wallet: { status: "loading" },
    balances: null,
    balancesRead: "pending",
    budget: null,
    activeRun: null,
    unfinished: 0,
    lastError: null,
  };
  #vault: WalletVault | undefined;
  #lock: TabLock | undefined;
  #buyer: Buyer | undefined;
  #ledger: SpendLedger | undefined;
  #active: Run | null = null;
  #basePolicy: Promise<ResolvedPolicy>;
  #tools: readonly ToolDefinitionView[] | undefined;
  #disposed = false;

  constructor(options: EngineOptions) {
    this.#options = options;
    const config = options.config;
    this.config = config;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#storage =
      options.storage === undefined
        ? ((globalThis as { localStorage?: KeyValueStore }).localStorage ?? null)
        : options.storage;
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.#origin = new URL(config.urls.public).origin;
    this.#server =
      options.server ??
      new rpc.Server(config.urls.rpc, { allowHttp: new URL(config.urls.rpc).protocol === "http:" });
    const assetFacts = (contract: string) =>
      contract === config.asset.contract
        ? { symbol: config.asset.symbol, decimals: config.asset.decimals }
        : undefined;
    this.#observer = new Observer({ assetFacts });
    this.#transport = createSellerTransport({ config, observer: this.#observer, fetch: this.#fetch });
    this.#chain =
      options.chain ??
      new ChainFacts({
        server: this.#server,
        network: TESTNET,
        config,
        operator: this.#transport.operator,
        facilitatorUrl: facilitatorProxyUrl(this.#origin),
        explorer: explorerTemplate(config.explorerTemplate),
        sleep: this.#sleep,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    const adapters = schemeAdapters(config);
    this.#basePolicy = resolvePolicy(TESTNET, policyInput(config), {
      requireCaps: false,
      describe: (contract) => new AssetDirectory(this.#server, config.networkPassphrase).describe(contract),
    });
    this.#basePolicy.catch(() => undefined);
    let basePolicy: ResolvedPolicy | undefined;
    void this.#basePolicy.then((policy) => {
      basePolicy = policy;
    });
    this.#catalog = new Catalog({
      network: TESTNET,
      bazaarUrl: bazaarProxyUrl(this.#origin),
      operator: this.#transport.operator,
      hitContext: () => {
        const policy = this.#buyer?.policy ?? basePolicy;
        if (policy === undefined) throw playgroundError("playground_config_unavailable");
        return { network: TESTNET, policy, adapters, egress: this.#transport.policy };
      },
    });
    this.#loop = new ReconcileLoop({
      due: () =>
        this.#active === null &&
        this.#buyer !== undefined &&
        (this.#state.unfinished > 0 ||
          (this.#state.wallet.status === "ready" && !this.#state.wallet.setup.funded)),
      tick: () => this.#tick(),
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      ...(options.focus === undefined ? {} : { focus: options.focus }),
    });
    this.wallet = {
      create: () => this.#walletRun(async (vault) => [await vault.create(TESTNET), "created"]),
      import: (seed) => this.#walletRun(async (vault) => [await vault.import(seed, TESTNET), "imported"]),
      fund: (options) => this.#fund(options?.topUp === true),
      exportFile: () => this.#exportFile(),
      forget: () => this.#forget(),
    };
    this.ready = this.#start();
  }

  // -------------------------------------------------------------------------------------------------
  // State

  state(): EngineState {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #set(patch: Partial<EngineState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) {
      try {
        listener(this.#state);
      } catch {
        // A failing listener never breaks the engine.
      }
    }
  }

  async #start(): Promise<void> {
    try {
      this.#vault = await (this.#options.vault ?? WalletVault.open());
      const lock = await acquireTabLock({ locks: this.#options.locks });
      this.#lock = lock;
      if (!lock.held) {
        this.#set({ wallet: { status: "locked" } });
        void lock
          .wait()
          .then((held) => {
            this.#lock = held;
            return this.#loadWallet();
          })
          .catch((error: unknown) => {
            this.#set({ lastError: codedError(error) });
          });
        return;
      }
      await this.#loadWallet();
    } catch (error) {
      this.#set({ wallet: { status: "none", storage: "memory" }, lastError: codedError(error) });
    }
  }

  async #loadWallet(): Promise<void> {
    const vault = this.#requireVault();
    let wallet: StoredWallet | undefined;
    try {
      wallet = await vault.load();
    } catch (error) {
      this.#set({ wallet: { status: "none", storage: vault.storage }, lastError: codedError(error) });
      return;
    }
    if (vault.storage === "memory") {
      this.#set({ lastError: codedError(playgroundError("playground_wallet_storage_unavailable")) });
    }
    if (wallet === undefined) {
      this.#set({ wallet: { status: "none", storage: vault.storage } });
    } else if (!(await this.#tryArm(wallet))) {
      void this.#keepArming(wallet);
    }
    this.#loop.start();
  }

  /**
   * Arms a stored wallet and reads its balances; false when arming failed. Arming reads the chain
   * (the asset's facts), which can fail for a moment: the wallet then stays loading with the coded
   * error shown, never reported missing, since its key is still stored.
   */
  async #tryArm(wallet: StoredWallet): Promise<boolean> {
    try {
      await this.#arm(wallet);
    } catch (error) {
      this.#set({ lastError: codedError(error) });
      return false;
    }
    await this.#refresh();
    return true;
  }

  /** Tries arming again with backoff, until it works, the wallet changes or the engine is disposed. */
  async #keepArming(wallet: StoredWallet): Promise<void> {
    for (let attempt = 0; attempt < ARM_ATTEMPTS; attempt++) {
      await this.#sleep(Math.min(ARM_RETRY_MAX_MS, ARM_RETRY_MS * 2 ** attempt));
      if (this.#disposed || this.#buyer !== undefined || this.#vault?.wallet?.address !== wallet.address)
        return;
      if (await this.#tryArm(wallet)) return;
    }
  }

  /** Wires the buyer for a wallet: the persisted ledger, the chosen session total, the tapped key. */
  async #arm(wallet: StoredWallet): Promise<void> {
    const vault = this.#requireVault();
    this.#ledger =
      this.#storage === null
        ? new MemorySpendLedger()
        : new StorageSpendLedger(this.#storage, { prefix: ledgerPrefix(wallet.address) });
    this.#buyer = await this.#build({ sessionTotal: this.#sessionTotal(wallet.address) });
    this.#set({
      wallet: {
        status: "ready",
        address: wallet.address,
        network: wallet.network,
        createdAt: wallet.createdAt,
        storage: vault.storage,
        setup: { account: false, trustline: false, funded: false },
      },
      // The setup flags and balances are unknown until the chain is read.
      balances: null,
      balancesRead: "pending",
    });
  }

  /** A buyer with the wallet's tapped key and ledger, under the given policy and session. */
  #build(policy: PolicyOptions, session?: SessionOptions): Promise<Buyer> {
    const vault = this.#requireVault();
    const ledger = this.#ledger;
    if (ledger === undefined) throw playgroundError("playground_wallet_missing");
    const signer = vault.signer({
      network: TESTNET,
      uptoContracts: [this.config.uptoContract],
      latestLedger: () => this.#chain.latestLedger(),
      onAuthorization: (view) => {
        this.#active?.emit({ kind: "auth", view });
      },
    });
    return (this.#options.buildBuyer ?? buildBrowserBuyer)({
      config: this.config,
      signer,
      transport: this.#transport,
      ledger,
      bazaarUrl: bazaarProxyUrl(this.#origin),
      facilitatorUrl: facilitatorProxyUrl(this.#origin),
      onEvent: (event) => {
        this.#onSdkEvent(event);
      },
      policy,
      ...(session === undefined ? {} : { session }),
    });
  }

  #sessionTotal(address: string): string {
    try {
      const stored = this.#storage?.getItem(sessionTotalKey(address)) ?? null;
      const decimals = this.config.asset.decimals;
      const value = stored === null ? undefined : toAtomic(stored, decimals);
      const ceiling = toAtomic(this.config.caps.sessionTotal, decimals);
      if (stored !== null && value !== undefined && value > 0n && ceiling !== undefined && value <= ceiling) {
        return stored;
      }
    } catch {
      // Unreadable storage: the operator's total applies.
    }
    return this.config.caps.sessionTotal;
  }

  /** Re-reads balances, setup progress and the budget. */
  async #refresh(): Promise<void> {
    const vault = this.#vault;
    const wallet = vault?.wallet;
    if (wallet === undefined || this.#state.wallet.status !== "ready") {
      this.#set({ balances: null, balancesRead: "pending", budget: null, unfinished: 0 });
      return;
    }
    let lastError: CodedError | null = null;
    try {
      const balances = await this.#chain.balances(wallet.address);
      const funded =
        balances.asset !== null && (toAtomic(balances.asset, this.config.asset.decimals) ?? 0n) > 0n;
      this.#set({
        balances,
        balancesRead: "ok",
        wallet: {
          ...this.#state.wallet,
          setup: { account: balances.xlm !== null, trustline: balances.asset !== null, funded },
        },
      });
    } catch (error) {
      lastError = codedError(error);
      this.#set({ balancesRead: "failed" });
    }
    this.#set({ lastError });
    this.#refreshBudget();
  }

  /** Re-reads the budget and the payments awaiting proof from the ledger. */
  #refreshBudget(): void {
    const buyer = this.#buyer;
    const ledger = this.#ledger;
    const address = this.#vault?.wallet?.address;
    if (buyer === undefined || ledger === undefined || address === undefined) return;
    let unfinished: number;
    try {
      unfinished = ledger.unfinished(TESTNET, address).length;
    } catch (error) {
      this.#set({ lastError: codedError(error) });
      return;
    }
    void buyer.budget().then(
      (snapshot) => {
        this.#set({ budget: budgetView(snapshot), unfinished });
      },
      (error: unknown) => {
        this.#set({ lastError: codedError(error), unfinished });
      },
    );
  }

  async #tick(): Promise<void> {
    const buyer = this.#buyer;
    if (buyer === undefined) return;
    if (this.#state.unfinished > 0) {
      try {
        await buyer.reconcile();
      } catch (error) {
        this.#set({ lastError: codedError(error) });
      }
    }
    await this.#refresh();
  }

  // -------------------------------------------------------------------------------------------------
  // Events

  /**
   * Reports an SDK event on the run whose call it belongs to. A call this engine has not seen yet is
   * the active run's only when the event opens a call (probe, quote, refusal, reservation); any other
   * event of an unknown call belongs to a payment of an earlier page load or run (a reconciliation of
   * an older reservation, inside a paid call or in the background) and only refreshes the budget. A
   * reconciliation that proves a run's payment after it ended has its transaction read onto that run.
   */
  #onSdkEvent(event: PaymentEvent): void {
    const callId = "callId" in event ? event.callId : undefined;
    let run: Run | null | undefined = callId === undefined ? this.#active : this.#callRuns.get(callId);
    if (run === undefined) {
      run = OPENING_EVENTS.has(event.type) ? this.#active : null;
      if (run !== null && callId !== undefined) this.#callRuns.set(callId, run);
    }
    run?.emit({ kind: "sdk", event });
    if (event.type === "settled" && event.transaction !== null && run?.ended === true) {
      const settledRun = run;
      void this.#chain.tx(event.transaction).then(
        (view) => {
          settledRun.emit({ kind: "chain", phase: "tx", view });
        },
        () => undefined,
      );
    }
    if (event.type !== "probe" && event.type !== "quote") this.#refreshBudget();
  }

  // -------------------------------------------------------------------------------------------------
  // Runs

  /**
   * Starts a run unless one is active. `body` returns the outcome; an error it throws is reported as a
   * refusal at its layer. Aborting ends the run at once; a payment already sent is reconciled later.
   */
  #begin(
    start: LabEventBody | null,
    body: (run: Run) => Promise<Outcome>,
    failure: "outcome" | "error" = "outcome",
  ): RunHandle {
    const run = new Run(this.#options.randomId?.() ?? crypto.randomUUID(), this.#options.now);
    this.#runs.set(run.runId, run);
    if (start !== null) run.emit(start);
    if (this.#active !== null) {
      const coded = codedError(playgroundError("playground_run_in_progress"));
      run.emit({ kind: "refusal", layer: "playground", code: coded.code, reason: coded.reason });
      run.finish({ status: "refused", code: coded.code, reason: coded.reason });
      return run;
    }
    this.#active = run;
    this.#set({ activeRun: run.runId });
    run.signal.addEventListener(
      "abort",
      () => {
        const coded = codedError(playgroundError("playground_run_aborted"));
        run.finish({ status: "error", code: coded.code, reason: coded.reason });
      },
      { once: true },
    );
    void (async () => {
      let outcome: Outcome;
      try {
        outcome = await body(run);
      } catch (error) {
        const coded = run.ended ? codedError(error) : reportRefusalOn(run, error);
        outcome =
          failure === "error"
            ? { status: "error", code: coded.code, reason: coded.reason }
            : outcomeOf(error, coded);
      } finally {
        this.#observer.detach();
        this.#active = null;
        this.#set({ activeRun: null });
      }
      run.finish(outcome);
      await this.#refresh();
    })();
    return run;
  }

  /** What every paying run needs: the wallet's buyer, a valid cap, the observer on this run. */
  async #context(run: Run, cap: string): Promise<RunContext> {
    const buyer = this.#buyer;
    const payer = this.#vault?.wallet?.address;
    if (this.#state.wallet.status === "locked") throw playgroundError("playground_wallet_locked");
    if (buyer === undefined || payer === undefined) throw playgroundError("playground_wallet_missing");
    const money = { amount: cap, asset: this.config.asset.symbol };
    effectiveCap(buyer.policy, money);
    // The observer judges each quoted option against the policy of the buyer that pays it.
    const judgeWith = (payingBuyer: RunBuyer) => {
      this.#observer.attach({
        emit: (event) => {
          run.emit(event);
        },
        judge: optionJudge(payingBuyer.policy, schemeAdapters(this.config), payer, money),
        advertised: (address) => this.#chain.advertised(address),
      });
    };
    judgeWith(buyer);
    await Promise.all([this.#chain.refreshLedger(), this.#chain.supported()]);
    return {
      run,
      config: this.config,
      buyer,
      payer,
      cap,
      key: runIdempotencyKey(run.runId),
      chain: this.#chain,
      catalog: this.#catalog,
      replay: () => this.#observer.armReplay(),
      // A derived buyer keeps the session total you chose unless it asks for a lower one.
      derive: (options) =>
        this.#build({ sessionTotal: this.#sessionTotal(payer), ...options.policy }, options.session),
      judgeWith,
      tools: (toolBuyer: ToolBuyer) => createTools({ buyer: toolBuyer }),
      sleep: this.#sleep,
    };
  }

  run(request: ScenarioRequest): RunHandle {
    const cap = request.cap;
    return this.#begin(
      { kind: "run", phase: "start", scenario: request.scenario, variant: request.experiment, cap },
      async (run) => {
        const offered: readonly string[] = SCENARIO_EXPERIMENTS[request.scenario];
        if (!offered.includes(request.experiment)) {
          throw paymentError("payment_request_invalid", {
            reason: `The ${request.scenario} scenario has no ${request.experiment} experiment.`,
          });
        }
        if (!this.config.lab.scenarios.includes(request.scenario)) {
          throw playgroundError("playground_feature_disabled", {
            reason: `The ${request.scenario} scenario is turned off on this Playground.`,
          });
        }
        if (!this.config.lab.experiments.includes(request.experiment)) {
          throw playgroundError("playground_feature_disabled", {
            reason: `The ${request.experiment} experiment is turned off on this Playground.`,
          });
        }
        const context = await this.#context(run, cap);
        return dispatch(request.scenario, request.experiment, context, request.params);
      },
    );
  }

  check(check: CheckId): RunHandle {
    const cap = checkCap(check, this.config);
    return this.#begin({ kind: "run", phase: "start", scenario: "pay", variant: check, cap }, async (run) => {
      if (!this.config.lab.checks.includes(check)) {
        throw playgroundError("playground_feature_disabled", {
          reason: `The ${check} check is turned off on this Playground.`,
        });
      }
      return runCheck(await this.#context(run, cap), check);
    });
  }

  pay(request: PayRequest): RunHandle {
    const target = "target" in request ? "http" : request.type;
    return this.#begin(
      {
        kind: "run",
        phase: "start",
        scenario: "pay",
        variant: "normal",
        cap: request.cap,
        ...(target === undefined ? {} : { target }),
      },
      async (run) => {
        const context = await this.#context(run, request.cap);
        const options = {
          maxAmount: { amount: request.cap, asset: this.config.asset.symbol },
          idempotencyKey: context.key,
          signal: run.signal,
        };
        if ("target" in request) {
          const method = request.method ?? "GET";
          const target: PaymentTarget = {
            kind: "http",
            url: request.target,
            method,
            ...(request.body === undefined || ["GET", "HEAD", "DELETE"].includes(method)
              ? {}
              : { body: request.body }),
          };
          const paid = await payOnce(context, () => context.buyer.pay(target, options));
          return paid.ok ? settledOutcome(paid.result, "Paid and delivered.") : outcomeOf(paid.error);
        }
        const { hit, view } = await this.#catalog.listing(request.listingId, run.signal);
        run.emit({ kind: "bazaar", phase: "listing", listing: view });
        const call = callInputFor(hit, request.params ?? {});
        const paid = await payOnce(context, () => context.buyer.payListing(request.listingId, call, options));
        return paid.ok ? settledOutcome(paid.result, "Paid and delivered.") : outcomeOf(paid.error);
      },
    );
  }

  // -------------------------------------------------------------------------------------------------
  // Wallet

  #walletRun(operation: (vault: WalletVault) => Promise<[StoredWallet, "created" | "imported"]>): RunHandle {
    return this.#begin(
      null,
      async (run) => {
        await this.ready;
        this.#requireLock();
        const [wallet, step] = await operation(this.#requireVault());
        run.emit({ kind: "wallet", step });
        await this.#arm(wallet);
        await this.#refresh();
        this.#loop.start();
        return { status: "ok", reason: `Testnet wallet ${wallet.address} is ready in this browser.` };
      },
      "error",
    );
  }

  #fund(topUp: boolean): RunHandle {
    return this.#begin(
      null,
      async (run) => {
        await this.ready;
        this.#requireLock();
        const vault = this.#requireVault();
        if (vault.wallet === undefined) throw playgroundError("playground_wallet_missing");
        const { asset, urls, onboarding, networkPassphrase } = this.config;
        await vault.fund(
          {
            server: this.#server,
            passphrase: networkPassphrase,
            friendbotUrl: urls.friendbot,
            fetch: this.#fetch,
            asset: { contract: asset.contract, code: asset.classic.code, issuer: asset.classic.issuer },
            buyAmount: onboarding.buyAmount,
            keepXlm: onboarding.keepXlm,
            topUp,
            signal: run.signal,
            sleep: this.#sleep,
            onStep: (step, transaction) => {
              run.emit({ kind: "wallet", step, ...(transaction === undefined ? {} : { transaction }) });
            },
          },
          this.#options.onboarding,
        );
        await this.#refresh();
        return { status: "ok", reason: `Funded with ${onboarding.buyAmount} ${asset.symbol} for testing.` };
      },
      "error",
    );
  }

  #forget(): RunHandle {
    return this.#begin(
      null,
      async (run) => {
        await this.ready;
        this.#requireLock();
        const vault = this.#requireVault();
        const address = vault.wallet?.address;
        await vault.forget();
        if (address !== undefined && this.#storage !== null) {
          try {
            new StorageSpendLedger(this.#storage, { prefix: ledgerPrefix(address) }).reset();
            this.#storage.removeItem(sessionTotalKey(address));
          } catch {
            // Storage that cannot be written holds nothing to forget.
          }
        }
        await this.#buyer?.close();
        this.#buyer = undefined;
        this.#ledger = undefined;
        run.emit({ kind: "wallet", step: "forgotten" });
        this.#set({
          wallet: { status: "none", storage: vault.storage },
          balances: null,
          balancesRead: "pending",
          budget: null,
          unfinished: 0,
        });
        return { status: "ok", reason: "The wallet and its budget were deleted from this browser." };
      },
      "error",
    );
  }

  #exportFile(): Promise<{ readonly fileName: string }> {
    try {
      const vault = this.#requireVault();
      if (vault.wallet === undefined) throw playgroundError("playground_wallet_missing");
      const { fileName, blob } = vault.keyFile();
      (this.#options.download ?? download)(fileName, blob);
      return Promise.resolve({ fileName });
    } catch (error) {
      return Promise.reject(engineError(error));
    }
  }

  #requireVault(): WalletVault {
    if (this.#vault === undefined) throw playgroundError("playground_wallet_storage_unavailable");
    return this.#vault;
  }

  #requireLock(): void {
    if (this.#lock?.held !== true) throw playgroundError("playground_wallet_locked");
  }

  async lowerSessionTotal(total: string): Promise<void> {
    try {
      const address = this.#vault?.wallet?.address;
      if (address === undefined || this.#buyer === undefined)
        throw playgroundError("playground_wallet_missing");
      if (this.#active !== null) throw playgroundError("playground_run_in_progress");
      const decimals = this.config.asset.decimals;
      const next = typeof total === "string" ? toAtomic(total.trim(), decimals) : undefined;
      const current = toAtomic(this.#sessionTotal(address), decimals);
      if (next === undefined || next <= 0n || current === undefined) {
        throw paymentError("payment_cap_invalid", {
          reason: `The session total must be a positive amount with at most ${String(decimals)} decimals.`,
        });
      }
      if (next > current) {
        throw paymentError("payment_cap_invalid", {
          reason: "The session total can only be lowered, never raised.",
        });
      }
      this.#storage?.setItem(sessionTotalKey(address), total.trim());
      this.#buyer = await this.#build({ sessionTotal: total.trim() });
      await this.#refresh();
    } catch (error) {
      throw engineError(error);
    }
  }

  async reconcile(): Promise<void> {
    try {
      if (this.#active !== null || this.#buyer === undefined) return;
      await this.#buyer.reconcile();
      await this.#refresh();
    } catch (error) {
      const failure = engineError(error);
      this.#set({ lastError: failure.toJSON() });
      throw failure;
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Bazaar, chain

  async search(request: SearchRequest): Promise<SearchPage> {
    try {
      await this.#basePolicy;
      const filters: { -readonly [K in keyof SearchFilters]: SearchFilters[K] } = {};
      if (request.type !== undefined) filters.type = request.type;
      if (request.payTo !== undefined) filters.payTo = request.payTo;
      if (request.limit !== undefined) filters.limit = request.limit;
      if (request.cursor !== undefined) filters.cursor = request.cursor;
      if (request.maxPrice !== undefined) {
        const { asset } = this.config;
        filters.asset = request.maxPrice.asset === asset.symbol ? asset.contract : request.maxPrice.asset;
        filters.maxPrice = request.maxPrice.amount;
      }
      const found = await this.#catalog.search(request.query, filters);
      const minimum = request.minimumTrust;
      return {
        items:
          minimum === undefined ? found.views : found.views.filter((view) => meetsTrust(view.trust, minimum)),
        method: found.page.method ?? null,
        partialResults: found.page.partialResults,
        cursor: found.page.nextCursor,
      };
    } catch (error) {
      throw engineError(error);
    }
  }

  async list(request: ListRequest): Promise<ListPage> {
    try {
      await this.#basePolicy;
      const listed = await this.#catalog.list({
        ...(request.type === undefined ? {} : { type: request.type }),
        ...(request.payTo === undefined ? {} : { payTo: request.payTo }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        ...(request.offset === undefined ? {} : { offset: request.offset }),
      });
      return { items: listed.views, total: listed.total, offset: listed.offset, limit: listed.limit };
    } catch (error) {
      throw engineError(error);
    }
  }

  async listing(id: string): Promise<ListingView> {
    try {
      await this.#basePolicy;
      return (await this.#catalog.listing(id)).view;
    } catch (error) {
      throw engineError(error);
    }
  }

  async versions(id: string): Promise<readonly VersionView[]> {
    try {
      return await this.#catalog.versions(id);
    } catch (error) {
      throw engineError(error);
    }
  }

  async quote(url: string): Promise<PriceView | null> {
    try {
      const buyer = this.#buyer;
      // A quote's SDK events would join an active run: none is made while one runs.
      if (buyer === undefined || this.#state.wallet.status !== "ready" || this.#active !== null) return null;
      const quote = await buyer.quote(
        { kind: "http", url },
        { maxAmount: { amount: this.config.caps.perCallCeiling, asset: this.config.asset.symbol } },
      );
      if (!quote.paymentRequired) return null;
      const option = quote.options[quote.chosen ?? 0];
      if (option === undefined) return null;
      return { scheme: option.scheme, amount: option.amount, atomic: option.atomic, symbol: option.asset };
    } catch (error) {
      throw engineError(error);
    }
  }

  async inspect(hash: string): Promise<TxView> {
    try {
      return await this.#chain.tx(hash.trim().toLowerCase());
    } catch (error) {
      throw engineError(error);
    }
  }

  toolDefinitions(): readonly ToolDefinitionView[] {
    this.#tools ??= createTools({ buyer: definitionsOnly(this.config) }).definitions.map((definition) => ({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      inputSchema: toJsonValue(definition.inputSchema) ?? {},
    }));
    return this.#tools;
  }

  exportRun(runId: string): RunReport | undefined {
    const run = this.#runs.get(runId);
    return run === undefined ? undefined : runReport(run, this.config);
  }

  /** Stops the background loop and gives the wallet lock up. */
  dispose(): void {
    this.#disposed = true;
    this.#loop.stop();
    this.#lock?.release();
  }
}

/** Starts the engine over a configuration. */
export function createEngine(options: EngineOptions): PlaygroundEngine {
  return new PlaygroundEngine(options);
}

function dispatch(
  scenario: ScenarioId,
  experiment: ScenarioRequest["experiment"],
  context: RunContext,
  params: ScenarioRequest["params"],
): Promise<Outcome> {
  switch (scenario) {
    case "pay":
      return experiment === "replay" ? runReplay(context, params) : runPay(context, params);
    case "upto":
      return experiment === "overcharge" ? runOvercharge(context, params) : runUpto(context, params);
    case "agent":
      return runAgentWithCap(context, params);
  }
}

/**
 * The agent pays under a policy whose per-call ceiling is the run's cap, so its get_budget call reads
 * the same per-call cap as the MCP configuration the page shows.
 */
async function runAgentWithCap(context: RunContext, params: ScenarioRequest["params"]): Promise<Outcome> {
  const buyer = await context.derive({ policy: { perCall: context.cap } });
  context.judgeWith(buyer);
  const { symbol } = context.config.asset;
  return runAgent(
    { ...context, buyer },
    defaultPlan(context.cap, symbol, params, context.config.urls.demoSeller),
  );
}

function reportRefusalOn(run: Run, error: unknown): CodedError {
  return reportRefusal({ run } as RunContext, error);
}

/**
 * How a listing is called with the page's parameters: path values, then query values (or JSON body
 * fields for a POST, PUT or PATCH listing), or tool arguments.
 */
export function callInputFor(hit: SearchHit, params: Readonly<Record<string, JsonValue>>): CallInput {
  if (hit.type === "mcp") return { arguments: { ...params } };
  const withBody = ["POST", "PUT", "PATCH"].includes((hit.method ?? "GET").toUpperCase());
  const pathParams: Record<string, string> = {};
  const query: Record<string, string | number | boolean> = {};
  const body: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(params)) {
    if (hit.input.pathParams.includes(name)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        pathParams[name] = String(value);
    } else if (withBody) body[name] = value;
    else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      query[name] = value;
  }
  return {
    ...(Object.keys(pathParams).length === 0 ? {} : { pathParams }),
    ...(Object.keys(query).length === 0 ? {} : { query }),
    ...(Object.keys(body).length === 0 ? {} : { body }),
  };
}

/** The budget snapshot of the policy asset as the page shows it. */
export function budgetView(snapshot: BudgetSnapshot): BudgetView | null {
  const [asset] = snapshot.assets;
  if (asset === undefined) return null;
  return {
    session: snapshot.session,
    window: snapshot.window,
    startedAt: snapshot.startedAt,
    expiresAt: snapshot.expiresAt,
    perCallCap: asset.perCallCap,
    sessionCap: asset.sessionCap,
    spent: asset.spent,
    pending: asset.pending,
    remaining: asset.remaining,
    awaitingProof: snapshot.awaitingProof,
    falseClaims: snapshot.falseClaims,
  };
}

/** A tool buyer that only lets the tools describe themselves. */
function definitionsOnly(config: PublicConfig): ToolBuyer {
  const refuse = () => Promise.reject(playgroundError("playground_wallet_missing"));
  return {
    network: TESTNET,
    address: undefined,
    get policy(): ResolvedPolicy {
      throw playgroundError("playground_wallet_missing", { reason: `No buyer for ${config.network} yet.` });
    },
    search: refuse,
    listing: refuse,
    pay: refuse,
    payListing: refuse,
    budget: refuse,
    reconcile: refuse,
  };
}

/** Saves a blob as a file through a temporary object URL. */
function download(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    link.click();
  } finally {
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }
}

export type { RunBuyer };
