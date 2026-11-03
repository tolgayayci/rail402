/**
 * Helpers for the web role's tests: settlement rows classified from real fixture transactions, a fake
 * RPC that answers getTransaction from fixtures, and an in-memory reader.
 */
import { Address, Keypair, Networks, StrKey, xdr } from "@stellar/stellar-sdk";
import { classifyTransaction, envelopeHashes, networkId, type SettlementRow } from "@rail402.dev/x402-index";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";
import {
  TRANSACTIONS,
  accountSignature,
  addressCredentials,
  payAs,
  sealResult,
  signEntry,
  type FixtureTransaction,
} from "../../../packages/x402-index/test/helpers.ts";
import type {
  AccountRole,
  AccountTotals,
  PaymentFilter,
  SellerSummary,
  SellerTotal,
  SettlementPage,
} from "../src/api/queries.ts";
import { encodeCursor, type Keyset } from "../src/api/paging.ts";
import { accountList, facilitatorList, paymentsList } from "../src/api/queries.ts";
import type { ComputedReport } from "../src/api/report.ts";
import { createExplorerApp, type ExplorerReads, type ServedNetwork } from "../src/web/app.ts";
import type { BazaarClient } from "../src/web/bazaar.ts";
import type { HoldingsClient } from "../src/web/holdings.ts";
import { LiveLookup, type LookupBudget } from "../src/web/live-lookup.ts";

export { TRANSACTIONS };
export const REGISTRY = REGISTRIES["stellar:testnet"];
export const EPOCH =
  REGISTRY.document.epochs.at(-1) ??
  (() => {
    throw new Error("no epoch");
  })();
export const CONTEXT = {
  network: "stellar:testnet" as const,
  epoch: EPOCH.id,
  passphrase: EPOCH.passphrase,
  registry: REGISTRY,
};

/** The settlement row the rules make of a fixture transaction. */
export function rowOf(fixture: FixtureTransaction): SettlementRow {
  const outcome = classifyTransaction(fixture, CONTEXT);
  if (outcome.kind !== "settlement") throw new Error(`fixture ${fixture.hash} is not a settlement`);
  return outcome.row;
}

export const ATTACKER_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 7));
export const ATTACKER_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 9));
const contractId = (address: string) => Address.fromString(address).toScAddress().contractId();
const scContract = (address: string) => xdr.ScAddress.scAddressTypeContract(contractId(address));

/** A fixture transaction edited the way an attacker would, re-encoded. */
export function tampered(
  fixture: FixtureTransaction,
  edit: (parts: { op: xdr.InvokeHostFunctionOp; events: xdr.ContractEvent[] }) => void,
): FixtureTransaction {
  const envelope = xdr.TransactionEnvelope.fromXDR(fixture.envelopeXdr, "base64");
  const meta = xdr.TransactionMeta.fromXDR(fixture.metaXdr, "base64");
  const [operation] = envelope.feeBump().tx().innerTx().v1().tx().operations();
  if (operation === undefined) throw new Error("no operation");
  edit({ op: operation.body().invokeHostFunctionOp(), events: meta.v4().operations()[0]?.events() ?? [] });
  // Sealed: the result commits to the edited events, as for a contract that really emitted them. The
  // edited envelope has its own hash, which an RPC answers for.
  return {
    ...fixture,
    hash: envelopeHashes(envelope, networkId(Networks.TESTNET)).hash,
    envelopeXdr: envelope.toXDR("base64"),
    resultXdr: sealResult(fixture.resultXdr, meta),
    metaXdr: meta.toXDR("base64"),
  };
}

/** Moves the invocation (and its authorization) to another contract. */
export function retarget(op: xdr.InvokeHostFunctionOp, contract: string): void {
  op.hostFunction().invokeContract().contractAddress(scContract(contract));
  op.auth()[0]?.rootInvocation().function().contractFn().contractAddress(scContract(contract));
}

export function eventSymbol(event: xdr.ContractEvent): string | undefined {
  const [topic] = event.body().v0().topics();
  return topic?.switch() === xdr.ScValType.scvSymbol() ? topic.sym().toString() : undefined;
}

/** The buyer of the custom-token transfers below, whose key the tests hold. */
export const TOKEN_BUYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x31));

/** Moves a transfer to a token outside the SAC rule, from `payer`, keeping its USDC asset topic. */
function moveToCustomToken(op: xdr.InvokeHostFunctionOp, events: xdr.ContractEvent[], payer: string) {
  retarget(op, ATTACKER_TOKEN);
  for (const event of events) event.contractId(contractId(ATTACKER_TOKEN));
  payAs(op, events, payer);
}

/** A transfer from a token outside the SAC rule, whose asset topic still says USDC, signed by its buyer. */
export const fakeSacToken = (fixture: FixtureTransaction) =>
  tampered(fixture, ({ op, events }) => {
    moveToCustomToken(op, events, TOKEN_BUYER.publicKey());
    const [entry] = op.auth();
    if (entry !== undefined) signEntry(entry, [TOKEN_BUYER]);
  });

/**
 * The same custom-token transfer naming `victim` as its payer, with a signature no key made: a token
 * whose transfer never asks for the payer's authorization lets it succeed on chain.
 */
export const forgedPayer = (fixture: FixtureTransaction, victim: Keypair) =>
  tampered(fixture, ({ op, events }) => {
    moveToCustomToken(op, events, victim.publicKey());
    const [entry] = op.auth();
    if (entry !== undefined)
      addressCredentials(entry).signature(
        xdr.ScVal.scvVec([accountSignature(victim.rawPublicKey(), Buffer.alloc(64, 0xab))]),
      );
  });

/** An upto settle on a contract outside the registry that emits upto_settled. */
export const fakeUptoSettled = (fixture: FixtureTransaction) =>
  tampered(fixture, ({ op, events }) => {
    retarget(op, ATTACKER_CONTRACT);
    for (const event of events)
      if (eventSymbol(event) === "upto_settled") event.contractId(contractId(ATTACKER_CONTRACT));
  });

/** A fetch that answers RPC getTransaction from `known` (by hash) and NOT_FOUND otherwise. */
export function fakeRpc(known: Readonly<Record<string, FixtureTransaction>>) {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      id: number;
      params: { hash: string };
    };
    calls.push(body.params.hash);
    const fixture = known[body.params.hash];
    const result =
      fixture === undefined
        ? { status: "NOT_FOUND", latestLedger: 5_400_000 }
        : {
            status: "SUCCESS",
            ledger: fixture.ledger,
            createdAt: String(Date.parse(fixture.closedAt) / 1000),
            applicationOrder: fixture.txIndex,
            envelopeXdr: fixture.envelopeXdr,
            resultXdr: fixture.resultXdr,
            resultMetaXdr: fixture.metaXdr,
          };
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 }),
    );
  };
  return { fetch, calls };
}

export function liveLookup(
  known: Readonly<Record<string, FixtureTransaction>>,
  budget?: LookupBudget,
  now?: () => number,
) {
  const rpc = fakeRpc(known);
  const lookup = new LiveLookup({
    network: "stellar:testnet",
    rpcUrl: "https://rpc.example.org",
    context: CONTEXT,
    fetch: rpc.fetch,
    ...(budget === undefined ? {} : { budget }),
    ...(now === undefined ? {} : { now }),
  });
  return { lookup, calls: rpc.calls };
}

const newestFirst = (a: SettlementRow, b: SettlementRow) => b.ledger - a.ledger || b.txIndex - a.txIndex;

/** The reads over an array of rows, with keyset pages like the database's. */
export class MemoryReader implements ExplorerReads {
  readonly rows: SettlementRow[];
  constructor(rows: readonly SettlementRow[]) {
    this.rows = [...rows].sort(newestFirst);
  }
  #page(list: string, rows: SettlementRow[], page: Keyset): SettlementPage {
    const after = page.after;
    const tail =
      after === undefined
        ? rows
        : rows.filter(
            (row) =>
              row.ledger < after.ledger || (row.ledger === after.ledger && row.txIndex < after.txIndex),
          );
    const items = tail.slice(0, page.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: tail.length > page.limit && last !== undefined ? encodeCursor(list, last) : null,
    };
  }
  settlement(_network: string, _epochs: readonly string[], hash: string) {
    return Promise.resolve(this.rows.find((row) => row.txHash === hash || row.innerHash === hash));
  }
  failedAttempt() {
    return Promise.resolve(undefined);
  }
  accountSettlements(
    network: string,
    epoch: string,
    address: string,
    role: AccountRole,
    page: Keyset,
    muxedId?: string,
  ) {
    const rows = this.rows.filter(
      (row) =>
        (role !== "payTo" && muxedId === undefined && row.payer === address) ||
        (role !== "payer" &&
          row.payTo === address &&
          (muxedId === undefined || row.payToMuxedId === muxedId)),
    );
    return Promise.resolve(this.#page(accountList(network, epoch, address, role, muxedId), rows, page));
  }
  /** Totals per side and asset, as the indexer keeps them. */
  accountTotals(_network: string, _epoch: string, address: string): Promise<AccountTotals> {
    const items = (["payer", "payTo"] as const).flatMap((role) => {
      const mine = this.rows.filter((row) => (role === "payer" ? row.payer : row.payTo) === address);
      const assets = [...new Set(mine.map((row) => row.asset.contract))];
      return assets.map((contract) => {
        const of = mine.filter((row) => row.asset.contract === contract);
        const [first] = of;
        const times = of.map((row) => row.closedAt).sort();
        return {
          role,
          assetContract: contract,
          assetCode: first?.asset.code ?? null,
          assetIssuer: first?.asset.issuer ?? null,
          assetVerified: first?.asset.verified ?? false,
          payments: of.length,
          volume: of.reduce((sum, row) => sum + BigInt(row.amount), 0n).toString(),
          firstAt: times[0] ?? "",
          lastAt: times.at(-1) ?? "",
        };
      });
    });
    return Promise.resolve({ items, more: { payer: 0, payTo: 0 } });
  }
  facilitatorSettlements(network: string, epoch: string, id: string, page: Keyset) {
    const rows = this.rows.filter((row) => row.attribution.facilitatorId === id);
    return Promise.resolve(this.#page(facilitatorList(network, epoch, id), rows, page));
  }
  payments(network: string, epoch: string, filter: PaymentFilter, page: Keyset) {
    const rows = this.rows.filter(
      (row) =>
        (filter.facilitator !== undefined
          ? row.attribution.facilitatorId === filter.facilitator
          : filter.shaped === true
            ? row.attribution.tier === "shaped"
            : row.attribution.tier === "rail402" || row.attribution.tier === "facilitator") &&
        (filter.scheme === undefined || row.scheme === filter.scheme) &&
        (filter.asset === undefined || row.asset.contract === filter.asset) &&
        (filter.fromLedger === undefined || row.ledger >= filter.fromLedger),
    );
    return Promise.resolve(this.#page(paymentsList(network, epoch, filter), rows, page));
  }
  firstLedgerSince(_network: string, _epoch: string, since: string) {
    const rows = this.rows.filter((row) => row.closedAt >= since);
    return Promise.resolve(rows.length === 0 ? null : Math.min(...rows.map((row) => row.ledger)));
  }
  settlementsByHash(_network: string, _epochs: readonly string[], hashes: readonly string[]) {
    return Promise.resolve(
      this.rows.filter(
        (row) => hashes.includes(row.txHash) || (row.innerHash !== null && hashes.includes(row.innerHash)),
      ),
    );
  }
  sellerSummary(_network: string, _epoch: string, payTo: string): Promise<SellerSummary> {
    const rows = this.rows.filter((row) => row.payTo === payTo);
    return Promise.resolve({
      exact: rows.filter((row) => row.scheme === "exact").length,
      upto: rows.filter((row) => row.scheme === "upto").length,
      payers: new Set(rows.map((row) => row.payer)).size,
    });
  }
  uptoReceived(_network: string, _epoch: string, payTo: string, limit: number) {
    return Promise.resolve(
      this.rows.filter((row) => row.payTo === payTo && row.scheme === "upto").slice(0, limit),
    );
  }
  sellerTotals(_network: string, _epoch: string, addresses: readonly string[]) {
    const totals = new Map<string, SellerTotal>();
    for (const row of this.rows) {
      if (!addresses.includes(row.payTo)) continue;
      const total = totals.get(row.payTo);
      totals.set(row.payTo, {
        payments: (total?.payments ?? 0) + 1,
        lastAt: total === undefined || row.closedAt > total.lastAt ? row.closedAt : total.lastAt,
      });
    }
    return Promise.resolve(totals as ReadonlyMap<string, SellerTotal>);
  }
  ping() {
    return Promise.resolve();
  }
}

/** An Explorer app serving testnet (and mainnet with `pubnet`) over `reader`, with an optional live lookup and report. */
export function testApp(options: {
  reader: ExplorerReads;
  pubnet?: boolean;
  lookup?: LiveLookup;
  bazaar?: BazaarClient;
  holdings?: HoldingsClient;
  bazaarBudgetMs?: number;
  trustedProxyHops?: number;
  report?: ComputedReport;
  ratePerMinute?: number;
  maxInFlight?: number;
  now?: () => number;
}) {
  const network: ServedNetwork = {
    network: "stellar:testnet",
    registry: REGISTRY,
    epoch: EPOCH,
    lookup: options.lookup,
    publicRpcUrl: "https://soroban-testnet.stellar.org",
    bazaar: options.bazaar,
    holdings: options.holdings,
  };
  return createExplorerApp({
    reader: options.reader,
    reports: { get: () => options.report },
    networks: options.pubnet === true ? [network, pubnetNetwork()] : [network],
    ratePerMinute: options.ratePerMinute ?? 1_000,
    publicUrl: "https://explorer.example.org",
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.bazaarBudgetMs === undefined ? {} : { bazaarBudgetMs: options.bazaarBudgetMs }),
    ...(options.trustedProxyHops === undefined ? {} : { trustedProxyHops: options.trustedProxyHops }),
    ...(options.maxInFlight === undefined ? {} : { maxInFlight: options.maxInFlight }),
  });
}

function pubnetNetwork(): ServedNetwork {
  const registry = REGISTRIES["stellar:pubnet"];
  const epoch = registry.document.epochs.at(-1);
  if (epoch === undefined) throw new Error("no pubnet epoch");
  return {
    network: "stellar:pubnet",
    registry,
    epoch,
    lookup: undefined,
    publicRpcUrl: "https://mainnet.sorobanrpc.com",
  };
}
