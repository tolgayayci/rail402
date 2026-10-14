/**
 * An engine that replays recorded event logs instead of paying: for working on the page without a
 * wallet or a network (`pnpm --filter @rail402.dev/playground dev:fake`) and for component tests. It
 * signs nothing and sends nothing. Production builds never include it.
 */
import type { CheckId, LabEvent, ListingView } from "../engine/events.ts";
import type {
  BudgetView,
  CodedError,
  Engine,
  EngineState,
  ListPage,
  PayRequest,
  PublicConfig,
  RunHandle,
  RunReport,
  RunSummary,
  ScenarioRequest,
  SearchPage,
  SearchRequest,
} from "../engine/types.ts";
import { CodedFailure, clientError } from "../app/engine.tsx";
import { toAtomic, toDecimal } from "../projection/format.ts";
import { ALL_LISTINGS, SAMPLE_VERSIONS, SELLER_CHECK, TOOL_DEFINITIONS } from "../../test/fixtures/bazaar.ts";
import { CONFIG } from "../../test/fixtures/config.ts";
import { IDS } from "../../test/fixtures/ids.ts";
import { CHECK_RUNS, SCENARIO_RUNS, WALLET_FUND } from "../../test/fixtures/runs.ts";

export interface FakeEngineOptions {
  readonly config?: PublicConfig;
  /** Milliseconds between replayed events; 0 replays a run synchronously. */
  readonly stepMs?: number;
  /**
   * The wallet the page starts with: ready and funded; none (encrypted storage available); none in a
   * browser without storage (`memory`); open in another tab (`locked`); or created but not set up.
   */
  readonly wallet?: FakeWallet;
  /** How test-funds setup ends: every step succeeds, or the purchase fails (the faucet path). */
  readonly fund?: "ok" | "purchase-fails";
  /** Payments waiting for chain proof at start; `reconcile()` proves them. */
  readonly unfinished?: number;
}

/** The coded failure a fake test-funds setup ends with when the purchase fails. */
export const FAKE_PURCHASE_FAILURE = Object.freeze({
  code: "account_funding_failed",
  reason: "The testnet exchange had no offer to fill the purchase (op_too_few_offers).",
});

export type FakeWallet = "ready" | "none" | "memory" | "locked" | "unfunded";

export const FAKE_WALLETS: readonly FakeWallet[] = ["ready", "none", "memory", "locked", "unfunded"];

const TRUST_ORDER = ["settled", "origin_verified", "domain_verified"] as const;

export function createFakeEngine(options: FakeEngineOptions = {}): Engine {
  return new FakeEngine(options);
}

class FakeEngine implements Engine {
  readonly config: PublicConfig;
  readonly wallet: Engine["wallet"];
  private current: EngineState;
  private readonly listeners = new Set<(state: EngineState) => void>();
  private readonly reports = new Map<string, RunReport>();
  private readonly stepMs: number;
  private sessionTotal: string;
  private runs = 0;

  constructor(options: FakeEngineOptions) {
    this.config = options.config ?? CONFIG;
    this.stepMs = options.stepMs ?? 450;
    this.sessionTotal = this.config.caps.sessionTotal;
    this.current = initialState(options.wallet ?? "ready", options.unfinished ?? 0, this);
    const fundLog =
      options.fund === "purchase-fails"
        ? [
            ...WALLET_FUND.filter((event) => event.kind === "wallet" && event.step !== "bought"),
            {
              runId: "",
              at: 0,
              kind: "run",
              phase: "end",
              status: "error",
              ...FAKE_PURCHASE_FAILURE,
            } satisfies LabEvent,
          ]
        : WALLET_FUND;
    this.wallet = {
      create: () =>
        this.walletRun([{ runId: "", at: 0, kind: "wallet", step: "created" }], () => {
          this.update({
            wallet: { ...this.readyWallet(), setup: { account: false, trustline: false, funded: false } },
            balances: { xlm: null, asset: null, readAt: Date.now() },
            budget: this.budget("0"),
          });
        }),
      import: (seed: string) =>
        /^S[A-Z2-7]{55}$/.test(seed)
          ? this.walletRun([{ runId: "", at: 0, kind: "wallet", step: "imported" }], () => {
              this.update({
                wallet: this.readyWallet(),
                balances: { xlm: "100", asset: "0.5", readAt: Date.now() },
                budget: this.budget("0"),
              });
            })
          : this.refused({
              code: "key_invalid",
              reason: "The secret key is not a valid Stellar secret seed.",
              retryable: false,
            }),
      fund: () => {
        const wallet = this.current.wallet;
        if (wallet.status !== "ready") return this.refused(clientError("playground_wallet_missing"));
        return this.walletRun(fundLog, (events) => {
          const steps = new Set(events.flatMap((event) => (event.kind === "wallet" ? [event.step] : [])));
          const setup = {
            account: wallet.setup.account || steps.has("friendbot"),
            trustline: wallet.setup.trustline || steps.has("trustline"),
            funded: wallet.setup.funded || steps.has("bought"),
          };
          this.update({
            wallet: { ...wallet, setup },
            balances: {
              xlm: setup.account ? (setup.funded ? "9989.9" : "9999.99") : null,
              asset: setup.trustline ? (setup.funded ? this.config.onboarding.buyAmount : "0") : null,
              readAt: Date.now(),
            },
          });
        });
      },
      exportFile: () =>
        this.current.wallet.status === "ready"
          ? Promise.resolve({ fileName: "stellar-testnet.key" })
          : Promise.reject(new CodedFailure(clientError("playground_wallet_missing"))),
      forget: () =>
        this.walletRun([{ runId: "", at: 0, kind: "wallet", step: "forgotten" }], () => {
          this.update({
            wallet: { status: "none", storage: "persistent" },
            balances: null,
            budget: null,
            unfinished: 0,
          });
        }),
    };
  }

  state(): EngineState {
    return this.current;
  }

  subscribe(listener: (state: EngineState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  lowerSessionTotal(total: string): Promise<void> {
    const budget = this.current.budget;
    const value = toAtomic(total, 7);
    const cap = budget === null ? undefined : toAtomic(budget.sessionCap, 7);
    if (budget === null || value === undefined || cap === undefined || value <= 0n || value > cap) {
      return Promise.reject(error("payment_policy_invalid", "The session budget can only be lowered."));
    }
    this.sessionTotal = toDecimal(value.toString(), 7) ?? total;
    this.update({ budget: this.budget(budget.spent) });
    return Promise.resolve();
  }

  reconcile(): Promise<void> {
    if (this.current.unfinished > 0) this.update({ unfinished: 0 });
    return Promise.resolve();
  }

  run(request: ScenarioRequest): RunHandle {
    const log = SCENARIO_RUNS[`${request.scenario}:${request.experiment}`];
    if (log === undefined)
      return this.refused(error("playground_request_invalid", "This scenario has no such experiment."));
    return this.replay(log);
  }

  check(check: CheckId): RunHandle {
    return this.replay(CHECK_RUNS[check]);
  }

  pay(request: PayRequest): RunHandle {
    if ("target" in request && /^https?:\/\/(127\.|169\.254\.|localhost)/.test(request.target)) {
      return this.replay(CHECK_RUNS["private-address"]);
    }
    const target =
      "target" in request
        ? request.target
        : (ALL_LISTINGS.find((item) => item.id === request.listingId)?.resource ?? "");
    const log = SCENARIO_RUNS["pay:normal"] ?? [];
    return this.replay(
      log.map((event) =>
        event.kind === "http" && event.phase === "request" ? { ...event, url: target } : event,
      ),
    );
  }

  search(request: SearchRequest): Promise<SearchPage> {
    const words = request.query
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 2);
    const scored = ALL_LISTINGS.filter((item) => this.matches(item, request))
      .map((item) => {
        const text = `${item.description ?? ""} ${item.toolName ?? ""} ${item.resource}`.toLowerCase();
        return { item, score: words.filter((word) => text.includes(word)).length };
      })
      .filter((entry) => entry.score > 0 || words.length === 0)
      .sort((a, b) => b.score - a.score);
    const limit = request.limit ?? 5;
    const offset = request.cursor === undefined ? 0 : Number(request.cursor);
    const page = scored
      .slice(offset, offset + limit)
      .map((entry, index) => ({ ...entry.item, rank: offset + index + 1 }));
    return Promise.resolve({
      items: page,
      method: "hybrid",
      partialResults: false,
      cursor: offset + limit < scored.length ? String(offset + limit) : null,
    });
  }

  list(request: {
    readonly type?: "http" | "mcp";
    readonly payTo?: string;
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<ListPage> {
    const all = ALL_LISTINGS.filter(
      (item) =>
        (request.type === undefined || item.type === request.type) &&
        (request.payTo === undefined || item.owner === request.payTo),
    );
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 20;
    return Promise.resolve({ items: all.slice(offset, offset + limit), total: all.length, offset, limit });
  }

  listing(id: string): Promise<ListingView> {
    const found = ALL_LISTINGS.find((item) => item.id === id);
    return found === undefined
      ? Promise.reject(error("listing_not_found", "No listing has this id."))
      : Promise.resolve(found);
  }

  versions(id: string): ReturnType<Engine["versions"]> {
    const found = ALL_LISTINGS.find((item) => item.id === id);
    if (found === undefined) return Promise.reject(error("listing_not_found", "No listing has this id."));
    if (id === IDS.listing.sample) return Promise.resolve(SAMPLE_VERSIONS);
    return Promise.resolve([
      {
        version: found.version,
        createdAt: "2026-10-01T09:00:00Z",
        cause: "origin_verification",
        transaction: null,
        owner: found.owner,
        trust: found.trust,
        state: found.state ?? "published",
        reason: null,
      },
    ]);
  }

  sellerCheck(request: { readonly url: string }): ReturnType<Engine["sellerCheck"]> {
    if (!URL.canParse(request.url)) {
      return Promise.reject(error("egress_url_invalid", "The URL is not an absolute http(s) URL."));
    }
    return Promise.resolve({ ...SELLER_CHECK, url: request.url });
  }

  quote(url: string): ReturnType<Engine["quote"]> {
    if (!URL.canParse(url))
      return Promise.reject(error("egress_url_invalid", "The URL is not an absolute URL."));
    return Promise.resolve({ scheme: "exact", amount: "0.001", atomic: "10000", symbol: "USDC" });
  }

  inspect(hash: string): ReturnType<Engine["inspect"]> {
    for (const log of Object.values(SCENARIO_RUNS)) {
      for (const event of log) {
        if (event.kind === "chain" && event.phase === "tx" && event.view.hash === hash)
          return Promise.resolve(event.view);
      }
    }
    return Promise.reject(error("transaction_not_found", "No transaction has this hash."));
  }

  toolDefinitions(): ReturnType<Engine["toolDefinitions"]> {
    return TOOL_DEFINITIONS;
  }

  exportRun(runId: string): RunReport | undefined {
    return this.reports.get(runId);
  }

  private matches(item: ListingView, request: SearchRequest): boolean {
    if (request.type !== undefined && item.type !== request.type) return false;
    if (request.payTo !== undefined && item.owner !== request.payTo) return false;
    if (
      request.minimumTrust !== undefined &&
      TRUST_ORDER.indexOf(item.trust) < TRUST_ORDER.indexOf(request.minimumTrust)
    )
      return false;
    if (request.maxPrice !== undefined && item.price?.decimal !== null && item.price !== null) {
      const price = toAtomic(item.price.decimal, 7);
      const max = toAtomic(request.maxPrice.amount, 7);
      if (price !== undefined && max !== undefined && price > max) return false;
    }
    return true;
  }

  readyWallet(): Extract<EngineState["wallet"], { status: "ready" }> {
    return {
      status: "ready",
      address: IDS.buyer,
      network: this.config.network,
      createdAt: "2026-10-03T11:58:00Z",
      storage: "persistent",
      setup: { account: true, trustline: true, funded: true },
    };
  }

  budget(spent: string): BudgetView {
    const total = toAtomic(this.sessionTotal, 7) ?? 0n;
    const used = toAtomic(spent, 7) ?? 0n;
    return {
      session: "default",
      window: "default",
      startedAt: "2026-10-03T11:58:00Z",
      expiresAt: "2026-10-04T11:58:00Z",
      perCallCap: this.config.caps.perCallDefault,
      sessionCap: this.sessionTotal,
      spent: toDecimal(used.toString(), 7) ?? "0",
      pending: "0",
      remaining: toDecimal((total > used ? total - used : 0n).toString(), 7) ?? "0",
      awaitingProof: 0,
      falseClaims: 0,
    };
  }

  private update(patch: Partial<EngineState>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of this.listeners) listener(this.current);
  }

  /** A wallet run: replayed like a payment run, allowed next to one, and applied when it ends. */
  private walletRun(log: readonly LabEvent[], apply: (events: readonly LabEvent[]) => void): RunHandle {
    return this.replay(
      log,
      (events) => {
        apply(events);
      },
      false,
    );
  }

  /** A run that ends at once, refused, without events. */
  private refused(reason: CodedError): RunHandle {
    const summary: RunSummary = {
      runId: `fake-${String(++this.runs)}`,
      status: "refused",
      code: reason.code,
      reason: reason.reason,
    };
    return {
      runId: summary.runId,
      subscribe: () => () => undefined,
      done: Promise.resolve(summary),
      abort: () => undefined,
    };
  }

  /** Replays a log under a fresh run id, one event per step, then applies its effects. */
  private replay(
    log: readonly LabEvent[],
    after?: (events: readonly LabEvent[]) => void,
    paying = true,
  ): RunHandle {
    if (paying && this.current.activeRun !== null) {
      return this.refused(
        error("playground_run_in_progress", "Another run is in progress; wait for it to finish."),
      );
    }
    const runId = `fake-${String(++this.runs)}`;
    const events: LabEvent[] = [];
    const listeners = new Set<(event: LabEvent) => void>();
    let finish: (summary: RunSummary) => void = () => undefined;
    const done = new Promise<RunSummary>((resolve) => {
      finish = resolve;
    });
    let aborted = false;
    if (paying) this.update({ activeRun: runId });

    const emit = (index: number): void => {
      if (aborted) return;
      const source = log[index];
      if (source === undefined) {
        const end = events.find(
          (event): event is Extract<LabEvent, { kind: "run"; phase: "end" }> =>
            event.kind === "run" && event.phase === "end",
        );
        const summary: RunSummary =
          end !== undefined
            ? {
                runId,
                status: end.status,
                ...(end.code === undefined ? {} : { code: end.code }),
                ...(end.reason === undefined ? {} : { reason: end.reason }),
              }
            : { runId, status: "ok" };
        this.reports.set(runId, {
          format: "rail402-playground-run",
          version: 1,
          runId,
          network: this.config.network,
          playgroundVersion: this.config.version,
          startedAt: new Date().toISOString(),
          summary,
          events: [...events],
        });
        this.applyEffects(events);
        after?.(events);
        if (paying) this.update({ activeRun: null });
        finish(summary);
        return;
      }
      const event = { ...source, runId, at: index * this.stepMs } as LabEvent;
      events.push(event);
      for (const listener of listeners) listener(event);
      if (this.stepMs === 0) emit(index + 1);
      else
        setTimeout(() => {
          emit(index + 1);
        }, this.stepMs);
    };

    const handle: RunHandle = {
      runId,
      subscribe: (listener) => {
        for (const event of events) listener(event);
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      done,
      abort: () => {
        aborted = true;
        if (paying) this.update({ activeRun: null });
        finish({
          runId,
          status: "error",
          code: "playground_run_aborted",
          reason: "The run was stopped before it finished.",
        });
      },
    };
    queueMicrotask(() => {
      emit(0);
    });
    return handle;
  }

  /** Moves the balance and the budget the way the replayed run did. */
  private applyEffects(events: readonly LabEvent[]): void {
    let spent = 0n;
    let balance: string | null | undefined;
    for (const event of events) {
      if (event.kind === "sdk" && event.event.type === "settled") spent += BigInt(event.event.amount);
      if (event.kind === "chain" && event.phase === "balance" && event.role === "payer")
        balance = event.after;
    }
    const budget = this.current.budget;
    if (budget !== null && spent > 0n) {
      const before = toAtomic(budget.spent, 7) ?? 0n;
      this.update({ budget: this.budget(toDecimal((before + spent).toString(), 7) ?? budget.spent) });
    }
    if (balance !== undefined && this.current.balances !== null) {
      this.update({ balances: { ...this.current.balances, asset: balance, readAt: Date.now() } });
    }
  }
}

function initialState(wallet: FakeWallet, unfinished: number, engine: FakeEngine): EngineState {
  const base = { activeRun: null, unfinished, lastError: null };
  switch (wallet) {
    case "none":
    case "memory":
      return {
        ...base,
        wallet: { status: "none", storage: wallet === "memory" ? "memory" : "persistent" },
        balances: null,
        budget: null,
      };
    case "locked":
      return { ...base, wallet: { status: "locked" }, balances: null, budget: null };
    case "unfunded":
      return {
        ...base,
        wallet: { ...engine.readyWallet(), setup: { account: false, trustline: false, funded: false } },
        balances: { xlm: null, asset: null, readAt: Date.now() },
        budget: engine.budget("0"),
      };
    case "ready":
      return {
        ...base,
        wallet: engine.readyWallet(),
        balances: { xlm: "9989.9", asset: "1", readAt: Date.now() },
        budget: engine.budget("0"),
      };
  }
}

function error(code: string, reason: string): CodedFailure {
  return new CodedFailure({ code, reason, retryable: false });
}
