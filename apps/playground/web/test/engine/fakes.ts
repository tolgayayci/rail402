/**
 * Fakes for the engine's unit tests: a buyer whose calls the test scripts, chain and catalog reads,
 * and a run context around them.
 */
import { createTools } from "@rail402.dev/mcp/tools";
import {
  paymentError,
  resolvePolicy,
  type BudgetSnapshot,
  type CallResult,
  type ResolvedPolicy,
  type SearchHit,
} from "@rail402.dev/sdk/browser";
import { TESTNET } from "@rail402.dev/stellar";
import type { PublicConfig } from "../../../src/shared/public-config.ts";
import { policyInput } from "../../src/engine/buyer.ts";
import type { ListingView, TxView } from "../../src/engine/events.ts";
import { Run } from "../../src/engine/run.ts";
import type { RunBuyer, RunContext } from "../../src/engine/scenarios/context.ts";
import type { ReplayHandle } from "../../src/transport/observe.ts";
import { PAY_TO, USDC_CONTRACT, testConfig } from "./helpers.ts";

export const HASH = "e".repeat(64);
export const LISTING_ID = "0b3c4c02-73d1-4f4a-9e7b-6f0b8f3f0d11";

export function policyFor(config: PublicConfig): Promise<ResolvedPolicy> {
  return resolvePolicy(TESTNET, policyInput(config), { requireCaps: true });
}

export function paidResult(
  options: { transaction?: string | null; paid?: boolean; verifiedOnChain?: boolean } = {},
): CallResult {
  const paid = options.paid ?? true;
  return {
    callId: "call-1",
    paid,
    payment: paid
      ? {
          status: "settled",
          scheme: "exact",
          network: TESTNET,
          asset: "USDC",
          assetContract: USDC_CONTRACT,
          decimals: 7,
          authorized: { amount: "0.001", atomic: "10000" },
          settled: { amount: "0.001", atomic: "10000" },
          payTo: PAY_TO,
          payer: PAY_TO,
          transaction: options.transaction === undefined ? HASH : options.transaction,
          explorerUrl: null,
          verifiedOnChain: options.verifiedOnChain ?? true,
        }
      : null,
    response: {
      kind: "http",
      status: 200,
      contentType: "application/json",
      json: { ok: true },
      bytes: 11,
      truncated: false,
    },
    budget: null,
    replayed: false,
  };
}

export function budgetSnapshot(): BudgetSnapshot {
  return {
    session: "default",
    window: "w1",
    network: TESTNET,
    payer: PAY_TO,
    startedAt: "2026-10-03T00:00:00.000Z",
    expiresAt: "2026-10-04T00:00:00.000Z",
    autoRenew: true,
    assets: [
      {
        asset: "USDC",
        contract: USDC_CONTRACT,
        decimals: 7,
        perCallCap: "0.1",
        sessionCap: "1",
        spent: "0.001",
        pending: "0",
        remaining: "0.999",
      },
    ],
    awaitingProof: 0,
    falseClaims: 0,
  };
}

export function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    listingId: LISTING_ID,
    type: "mcp",
    resource: "https://demo.example/mcp",
    method: null,
    toolName: "hourly_forecast",
    transport: "streamable-http",
    routeTemplate: null,
    owner: PAY_TO,
    trust: "origin_verified",
    settlements: 2,
    prices: [
      {
        scheme: "exact",
        amount: "0.0012",
        atomic: "12000",
        asset: "USDC",
        assetContract: USDC_CONTRACT,
        decimals: 7,
        payTo: PAY_TO,
        feesSponsored: true,
        receivable: true,
        maxTimeoutSeconds: 60,
        withinPolicy: true,
      },
    ],
    callable: true,
    notCallableReason: null,
    withinPolicy: true,
    seller: { serviceName: "Demo", description: "Hourly forecast", tags: [], mimeType: null },
    input: { schema: null, example: null, pathParams: [] },
    output: { example: null },
    lastUpdated: "2026-10-03T00:00:00.000Z",
    ...overrides,
  };
}

export function view(source: SearchHit, rank: number | null = 1): ListingView {
  return {
    id: source.listingId ?? "",
    resource: source.resource,
    type: source.type === "mcp" ? "mcp" : "http",
    method: source.method,
    toolName: source.toolName,
    description: null,
    serviceName: null,
    owner: PAY_TO,
    network: TESTNET,
    trust: source.trust,
    state: null,
    version: 1,
    settlements: source.settlements,
    price: null,
    callable: source.callable,
    rank,
  };
}

export function txView(hash = HASH): TxView {
  return {
    hash,
    network: TESTNET,
    status: "SUCCESS",
    ledger: 10,
    closedAt: "2026-10-03T00:00:00Z",
    feeBump: null,
    feeSourceAdvertised: true,
    transfers: [],
    x402Shape: "exact",
    nonces: ["1"],
    uptoSettled: null,
    explorerUrl: `https://explorer.example/testnet/tx/${hash}`,
  };
}

/** A buyer whose operations the test supplies; unsupplied ones fail. */
export function fakeBuyer(policy: ResolvedPolicy, overrides: Partial<RunBuyer> = {}): RunBuyer {
  const fail = () => Promise.reject(paymentError("payment_request_invalid", { reason: "not scripted" }));
  return {
    network: TESTNET,
    address: PAY_TO,
    policy,
    pay: fail,
    payListing: fail,
    quote: fail,
    search: fail,
    listing: fail,
    budget: () => Promise.resolve(budgetSnapshot()),
    reconcile: fail,
    ...overrides,
  };
}

export interface FakeContextOptions {
  readonly buyer: RunBuyer;
  readonly config?: PublicConfig;
  readonly balances?: (string | null)[];
  readonly catalog?: Partial<RunContext["catalog"]>;
  readonly replay?: ReplayHandle;
  readonly derive?: RunContext["derive"];
  readonly judgeWith?: RunContext["judgeWith"];
  readonly cap?: string;
}

export function fakeContext(options: FakeContextOptions): { context: RunContext; run: Run } {
  const run = new Run("run-1", () => 0);
  const balances = [...(options.balances ?? ["1", "0.999"])];
  const unscripted = () => Promise.reject(new Error("not scripted"));
  const context: RunContext = {
    run,
    config: options.config ?? testConfig(),
    buyer: options.buyer,
    payer: PAY_TO,
    cap: options.cap ?? "0.01",
    key: "pg_run-1",
    chain: {
      assetBalance: () =>
        Promise.resolve(balances.length > 1 ? (balances.shift() ?? null) : (balances[0] ?? null)),
      tx: (hash) => Promise.resolve(txView(hash)),
    },
    catalog: {
      search: unscripted,
      list: unscripted,
      listing: unscripted,
      versions: unscripted,
      ...options.catalog,
    },
    replay: () =>
      options.replay ?? {
        held: false,
        resend: () => Promise.reject(new Error("nothing held")),
        drop: () => undefined,
      },
    derive: options.derive ?? (() => Promise.resolve(options.buyer)),
    judgeWith: options.judgeWith ?? (() => undefined),
    tools: (buyer) => createTools({ buyer }),
    sleep: () => Promise.resolve(),
  };
  return { context, run };
}
