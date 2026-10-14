import { Keypair } from "@stellar/stellar-sdk";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { TESTNET, USDC } from "@rail402.dev/stellar";
import {
  resolvePolicy,
  type BudgetSnapshot,
  type CallResult,
  type Listing,
  type ResolvedPolicy,
  type SearchHit,
  type SearchPage,
} from "@rail402.dev/sdk";
import type { ToolBuyer, ToolResult, Tools } from "@rail402.dev/mcp";

export const payer = Keypair.random().publicKey();
export const seller = Keypair.random().publicKey();
export const usdcContract = USDC[TESTNET].contract;
export const LISTING_ID = "96eab768-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
export const TX_HASH = "a".repeat(64);

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
    seller: {
      serviceName: null,
      description: "Current weather for a city",
      tags: ["weather"],
      mimeType: null,
    },
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

export interface FakeBuyer extends ToolBuyer {
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[];
}

/** A buyer double: each method records its arguments and runs the given implementation. */
export function fakeBuyer(
  implementation: Partial<Omit<ToolBuyer, "network" | "address" | "policy">> & {
    readonly address?: string | undefined;
  } = {},
): FakeBuyer {
  const calls: FakeBuyer["calls"] = [];
  const record =
    <A extends unknown[], R>(method: string, fallback: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      calls.push({ method, args });
      return fallback(...args);
    };
  const page: SearchPage = { hits: [hit()], nextCursor: null, partialResults: false, method: "hybrid" };
  return {
    calls,
    network: TESTNET,
    address: "address" in implementation ? implementation.address : payer,
    policy,
    search: record("search", implementation.search ?? (() => Promise.resolve(page))),
    listing: record(
      "listing",
      implementation.listing ?? (() => Promise.resolve({ ...hit(), state: "published" } as Listing)),
    ),
    pay: record("pay", implementation.pay ?? (() => Promise.resolve(paidResult()))),
    payListing: record("payListing", implementation.payListing ?? (() => Promise.resolve(paidResult()))),
    budget: record("budget", implementation.budget ?? (() => Promise.resolve(budgetSnapshot()))),
    reconcile: record(
      "reconcile",
      implementation.reconcile ??
        (() =>
          Promise.resolve({
            checked: 0,
            settled: 0,
            released: 0,
            awaitingProof: 0,
            unprovable: 0,
            waiting: 0,
            deferred: 0,
          })),
    ),
  };
}

const validator = new AjvJsonSchemaValidator();

/** Checks a tool result the way a client would: the output schema, the text copy and `isError`. */
export function expectConforms(tools: Tools, name: string, result: ToolResult): Record<string, unknown> {
  const definition = tools.definitions.find((candidate) => candidate.name === name);
  if (definition === undefined) throw new Error(`no tool ${name}`);
  const check = validator.getValidator(definition.outputSchema)(result.structuredContent);
  if (!check.valid) {
    throw new Error(
      `${name} result does not match its output schema: ${check.errorMessage}\n${JSON.stringify(result.structuredContent)}`,
    );
  }
  const [text] = result.content;
  if (text?.type !== "text" || text.text !== JSON.stringify(result.structuredContent)) {
    throw new Error(`${name} content[0].text is not the structured result as JSON`);
  }
  if (result.isError !== (result.structuredContent["ok"] === false)) {
    throw new Error(`${name} isError does not match ok`);
  }
  return result.structuredContent;
}
