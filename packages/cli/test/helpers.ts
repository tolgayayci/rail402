import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET, USDC } from "@rail402.dev/stellar";
import {
  MemorySpendLedger,
  resolvePolicy,
  type BudgetSnapshot,
  type Buyer,
  type CallResult,
  type Listing,
  type ResolvedPolicy,
  type SearchHit,
  type SearchPage,
  type TransactionReport,
} from "@rail402.dev/sdk";
import { run, type CliDeps, type OpenBuyer } from "@rail402.dev/cli";

export const payer = Keypair.random().publicKey();
export const seller = Keypair.random().publicKey();
export const usdcContract = USDC[TESTNET].contract;
export const LISTING_ID = "96eab768-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
export const TX_HASH = "b".repeat(64);

export const policy: ResolvedPolicy = await resolvePolicy(TESTNET, undefined, { requireCaps: true });

export function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    listingId: LISTING_ID,
    type: "http",
    resource: "https://demo.example/weather",
    method: "GET",
    toolName: null,
    transport: null,
    routeTemplate: null,
    owner: seller,
    trust: "origin_verified",
    settlements: 12,
    prices: [
      {
        scheme: "exact",
        amount: "0.001",
        atomic: "10000",
        asset: "USDC",
        assetContract: usdcContract,
        decimals: 7,
        payTo: seller,
        feesSponsored: true,
        receivable: true,
        maxTimeoutSeconds: 300,
        withinPolicy: true,
      },
    ],
    callable: true,
    notCallableReason: null,
    withinPolicy: true,
    seller: { serviceName: "Weather", description: "Current weather for a city", tags: [], mimeType: null },
    input: { schema: { city: { type: "string" } }, example: { city: "Istanbul" }, pathParams: [] },
    output: { example: { temperature: 21 } },
    lastUpdated: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

export function budgetSnapshot(overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot {
  return {
    session: "default",
    window: "w-1",
    network: TESTNET,
    payer,
    startedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
    autoRenew: true,
    assets: [
      {
        asset: "USDC",
        contract: usdcContract,
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
    ...overrides,
  };
}

export function paidResult(overrides: Partial<CallResult> = {}): CallResult {
  return {
    callId: "0b7c6f1e-2a3b-4c5d-9e8f-7a6b5c4d3e2f",
    paid: true,
    replayed: false,
    payment: {
      status: "settled",
      scheme: "exact",
      network: TESTNET,
      asset: "USDC",
      assetContract: usdcContract,
      decimals: 7,
      authorized: { amount: "0.001", atomic: "10000" },
      settled: { amount: "0.001", atomic: "10000" },
      payTo: seller,
      payer,
      transaction: TX_HASH,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${TX_HASH}`,
      verifiedOnChain: true,
    },
    response: {
      kind: "http",
      status: 200,
      contentType: "application/json",
      json: { temperature: 21 },
      bytes: 18,
      truncated: false,
    },
    budget: budgetSnapshot(),
    ...overrides,
  };
}

export function txReport(): TransactionReport {
  return {
    hash: TX_HASH,
    network: TESTNET,
    status: "SUCCESS",
    ledger: 100,
    closedAt: "2026-09-30T00:00:00.000Z",
    feeBump: { outerHash: TX_HASH, innerHash: "c".repeat(64), feeSource: seller, feeCharged: "200" },
    source: seller,
    operations: [{ type: "invokeHostFunction", contract: usdcContract, function: "transfer" }],
    authorizations: [],
    transfers: [
      {
        contract: usdcContract,
        symbol: "USDC",
        from: payer,
        to: seller,
        amount: { atomic: "10000", decimal: "0.001" },
      },
    ],
    x402: { shape: "exact", checks: ["one token transfer invocation"] },
    facilitator: { url: "https://testnet.rail402.dev", attributed: true },
    explorerUrl: `https://stellar.expert/explorer/testnet/tx/${TX_HASH}`,
  };
}

export interface FakeBuyer extends Buyer {
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[];
}

type Methods = Omit<Buyer, "network" | "address" | "policy">;

/** A buyer double: each method records its arguments and runs the given implementation. */
export function fakeBuyer(
  implementation: Partial<Methods> = {},
  address: string | undefined = payer,
): FakeBuyer {
  const calls: FakeBuyer["calls"] = [];
  const record =
    <A extends unknown[], R>(method: string, fallback: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      calls.push({ method, args });
      return fallback(...args);
    };
  const page: SearchPage = { hits: [hit()], nextCursor: null, partialResults: false, method: "hybrid" };
  const unused = (name: string) => () => Promise.reject(new Error(`${name} is not stubbed`));
  return {
    calls,
    network: TESTNET,
    address,
    policy,
    search: record("search", implementation.search ?? (() => Promise.resolve(page))),
    list: record(
      "list",
      implementation.list ??
        (() =>
          Promise.resolve({
            hits: [hit()],
            pagination: { limit: 20, offset: 0, total: 1, asOf: "2026-09-30T00:00:00.000Z" },
          })),
    ),
    listing: record(
      "listing",
      implementation.listing ?? (() => Promise.resolve({ ...hit(), state: "published" } as Listing)),
    ),
    listingVersions: record("listingVersions", implementation.listingVersions ?? (() => Promise.resolve([]))),
    quote: record("quote", implementation.quote ?? unused("quote")),
    pay: record("pay", implementation.pay ?? (() => Promise.resolve(paidResult()))),
    payListing: record("payListing", implementation.payListing ?? (() => Promise.resolve(paidResult()))),
    searchAndPay: record(
      "searchAndPay",
      implementation.searchAndPay ?? (() => Promise.resolve({ ...paidResult(), chosen: hit() })),
    ),
    inspectTransaction: record(
      "inspectTransaction",
      implementation.inspectTransaction ?? (() => Promise.resolve(txReport())),
    ),
    budget: record("budget", implementation.budget ?? (() => Promise.resolve(budgetSnapshot()))),
    reconcile: record("reconcile", implementation.reconcile ?? unused("reconcile")),
    close: () => Promise.resolve(),
  };
}

/** An OpenBuyer that hands out the double and records how it was asked to open. */
export function openWith(buyer: FakeBuyer): OpenBuyer & { readonly opened: { signer: boolean }[] } {
  const opened: { signer: boolean }[] = [];
  const open: OpenBuyer = (_context, options) => {
    opened.push({ signer: options.signer });
    const ledger = new MemorySpendLedger();
    return Promise.resolve({ buyer, ledger, close: () => Promise.resolve() });
  };
  return Object.assign(open, { opened });
}

export interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The single JSON document on stdout. */
  json(): {
    v: number;
    ok: boolean;
    command: string;
    network?: string;
    result?: unknown;
    error?: Record<string, unknown>;
  };
}

/** A private configuration home for one test. */
export interface SandboxHome {
  readonly env: { readonly XDG_CONFIG_HOME: string; readonly XDG_STATE_HOME: string; readonly HOME: string };
  readonly dir: string;
  dispose(): void;
}

export function sandboxHome(): SandboxHome {
  const dir = mkdtempSync(join(tmpdir(), "rail402-cli-"));
  return {
    dir,
    env: { XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), HOME: dir },
    dispose: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function cli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: Partial<CliDeps> = {},
): Promise<CliRun> {
  let stdout = "";
  let stderr = "";
  const status = await run(
    argv,
    env,
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    deps,
  );
  return {
    status,
    stdout,
    stderr,
    json: () => {
      const lines = stdout.trim().split("\n");
      if (lines.length !== 1) throw new Error(`stdout holds ${String(lines.length)} lines, not one document`);
      return JSON.parse(lines[0] ?? "") as ReturnType<CliRun["json"]>;
    },
  };
}
