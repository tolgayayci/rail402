/**
 * The Explorer indexer of the local drill stack: the production `Ingester`, store, metrics and health
 * server over its own Postgres database, indexing a registry of the drill service's accounts on the
 * private Stellar network. Ledger bytes come through the production RPC ledger source from the
 * network's RPC. Discovery, which Lumeus Activity answers for public networks and which does not index
 * a private one, is answered from the network's RPC instead (`RpcActivity`): every transaction whose fee
 * source, source or operation source is the route's account, read with `getTransactions`. A discovery
 * source that fails is reported to the indexer as Lumeus Activity reports a 5xx: a retryable
 * `lumeus_unavailable`.
 */
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FeeBumpTransaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { sql } from "kysely";
import { createDatabase, migrate } from "@rail402.dev/store-postgres";
import {
  LumeusError,
  RpcLedgerSource,
  type ActivityRecord,
  type ActivityRoute,
  type ReadView,
  type WalkStep,
} from "../../../packages/ledger-source/src/index.ts";
import { parseRegistry, type RegistrySnapshot } from "../../../packages/x402-index/src/index.ts";
import { EXPLORER_MIGRATIONS, createExplorerDatabase } from "../../../apps/explorer/src/db.ts";
import { startHealthServer } from "../../../apps/explorer/src/health.ts";
import { LedgerBytes } from "../../../apps/explorer/src/indexer/bytes.ts";
import { Ingester, type ActivitySource } from "../../../apps/explorer/src/indexer/ingester.ts";
import { ExplorerMetrics } from "../../../apps/explorer/src/metrics.ts";
import { ExplorerStore } from "../../../apps/explorer/src/store.ts";

const NETWORK = "stellar:testnet";
const EPOCH = "local";

/** One JSON-RPC call; any failure of the source is a retryable `lumeus_unavailable`, as for Activity. */
async function discoveryCall<T>(url: string, method: string, params?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new LumeusError("lumeus_unavailable", "the discovery source did not answer", {
      retryable: true,
      cause: error,
    });
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new LumeusError("lumeus_unavailable", `the discovery source answered ${String(response.status)}`, {
      status: response.status,
      retryable: true,
    });
  }
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.result === undefined) {
    throw new LumeusError("lumeus_unavailable", `the discovery source refused ${method}`, {
      status: 200,
      retryable: true,
    });
  }
  return body.result;
}

interface RpcTransaction {
  readonly txHash: string;
  readonly ledger: number;
  readonly envelopeXdr: string;
}

/** The accounts a transaction names as fee source, source or operation source. */
function accountsOf(envelope: string, passphrase: string): Set<string> {
  const accounts = new Set<string>();
  const parsed = TransactionBuilder.fromXDR(envelope, passphrase);
  const inner = parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
  if (parsed instanceof FeeBumpTransaction) accounts.add(parsed.feeSource);
  accounts.add(inner.source);
  for (const operation of inner.operations)
    if (operation.source !== undefined) accounts.add(operation.source);
  return accounts;
}

/**
 * Discovery over the network's RPC: the head is the RPC's latest ledger, and a route's records are the
 * transactions that name its account. Each ledger is scanned once and kept, so every route reads the
 * same answer. A walk covers its whole range in one window and one page.
 */
export class RpcActivity implements ActivitySource {
  readonly #url: string;
  readonly #passphrase: string;
  readonly #generation = `local-${randomBytes(4).toString("hex")}`;
  /** Accounts named per scanned ledger, with each transaction's hash. */
  readonly #ledgers = new Map<number, { hash: string; accounts: Set<string> }[]>();
  #scanning: Promise<void> = Promise.resolve();

  constructor(url: string, passphrase: string) {
    this.#url = url;
    this.#passphrase = passphrase;
  }

  async *walkRange(route: ActivityRoute, from: number, until: number | undefined): AsyncGenerator<WalkStep> {
    const { sequence: head } = await discoveryCall<{ sequence: number }>(this.#url, "getLatestLedger");
    const readView: ReadView = {
      network: "testnet",
      generation: this.#generation,
      decoderVersion: "drill-rpc-activity",
      snapshotLedger: head,
      publishedThrough: head,
    };
    const last = Math.min(until ?? head + 1, head + 1);
    if (from >= last) {
      yield {
        route,
        since: from,
        until: last,
        readView,
        records: [],
        scannedThrough: from - 1,
        complete: true,
      };
      return;
    }
    await this.#scan(from, last);
    const records: ActivityRecord[] = [];
    for (let ledger = from; ledger < last; ledger++) {
      for (const transaction of this.#ledgers.get(ledger) ?? []) {
        if (route.kind === "account" && transaction.accounts.has(route.address)) {
          records.push({
            id: `${String(ledger)}:${transaction.hash}`,
            kind: "transaction",
            type: "fee",
            ledger,
            txHash: transaction.hash,
          });
        }
      }
    }
    yield { route, since: from, until: last, readView, records, scannedThrough: last - 1, complete: true };
  }

  /** Scans every ledger of `[from, last)` not scanned yet; one scan at a time. */
  #scan(from: number, last: number): Promise<void> {
    const run = this.#scanning.then(async () => {
      let start = from;
      while (start < last && this.#ledgers.has(start)) start++;
      if (start >= last) return;
      const found = new Map<number, { hash: string; accounts: Set<string> }[]>();
      let cursor: string | undefined;
      let through: number;
      for (;;) {
        const page = await discoveryCall<{
          transactions: RpcTransaction[] | null;
          latestLedger: number;
          cursor: string;
        }>(this.#url, "getTransactions", {
          ...(cursor === undefined ? { startLedger: start } : {}),
          pagination: { limit: 200, ...(cursor === undefined ? {} : { cursor }) },
          xdrFormat: "base64",
        });
        const transactions = page.transactions ?? [];
        for (const transaction of transactions) {
          if (transaction.ledger >= last) break;
          const list = found.get(transaction.ledger) ?? [];
          list.push({
            hash: transaction.txHash,
            accounts: accountsOf(transaction.envelopeXdr, this.#passphrase),
          });
          found.set(transaction.ledger, list);
        }
        const newest = transactions.at(-1)?.ledger;
        if (transactions.length < 200 || (newest !== undefined && newest >= last)) {
          // Everything through the RPC's head at this answer (and before `last`) has been listed.
          through = Math.min(last - 1, page.latestLedger);
          break;
        }
        cursor = page.cursor;
      }
      for (let ledger = start; ledger <= through; ledger++)
        this.#ledgers.set(ledger, found.get(ledger) ?? []);
    });
    this.#scanning = run.catch(() => undefined);
    return run;
  }
}

/** A registry with one facilitator: the drill service's sponsor and channel accounts, from `from`. */
export function localRegistry(
  passphrase: string,
  from: number,
  accounts: { readonly sponsor: string; readonly channels: readonly string[] },
): RegistrySnapshot {
  const archivedAt = new Date().toISOString();
  const evidence = [
    {
      url: "https://docs.rail402.dev/runbook",
      sha256: "0".repeat(64),
      archivedAt,
      archive: `registry/evidence/${"0".repeat(64)}.json`,
    },
  ];
  const entry = (address: string, role: "sponsor" | "channel") => ({
    address,
    role,
    epoch: EPOCH,
    validFromLedger: from,
    validToLedger: null,
    evidence,
  });
  return parseRegistry({
    schemaVersion: 1,
    network: NETWORK,
    registryVersion: `${archivedAt.slice(0, 10)}.1`,
    epochs: [{ id: EPOCH, passphrase, fromLedger: from, dataLakeFolder: "testnet/2000-01-01" }],
    facilitators: [
      {
        id: "drill",
        name: "The drill service",
        tier: "rail402",
        sharedRelayer: false,
        accounts: [
          entry(accounts.sponsor, "sponsor"),
          ...accounts.channels.map((address) => entry(address, "channel")),
        ],
      },
    ],
    uptoContracts: [],
  });
}

export interface LocalExplorer {
  /** The port of the indexer's `/health` and `/metrics`. */
  readonly port: number;
  readonly metrics: ExplorerMetrics;
  /** Whether a settlement row exists for the transaction. */
  indexed(txHash: string): Promise<boolean>;
  /** The ledger discovery has walked through on every route (`rail402_explorer_last_ledger`). */
  lastLedger(): number | null;
  /** Candidate ledgers by status. */
  ledgerCounts(): Promise<Record<string, number>>;
  /** Why the indexer stopped, when it did. */
  stopped(): string | undefined;
  /** `/health` of the indexer, as its status code and status. */
  health(): Promise<{ status: number; body: { status?: string; lagLedgers?: number | null } }>;
  stop(): Promise<void>;
}

/**
 * Starts the indexer over a new database (`<prefix>_explorer_<run>`, created and migrated through the
 * admin connection `adminUrl`), with discovery read from `discoveryUrl` and ledger bytes from `ledgerUrl`.
 * At the head it polls every second and walks every route each round.
 */
export async function startLocalExplorer(options: {
  readonly adminUrl: string;
  readonly databasePrefix: string;
  readonly registry: RegistrySnapshot;
  readonly discoveryUrl: string;
  readonly ledgerUrl: string;
  readonly log: (line: string) => void;
}): Promise<LocalExplorer> {
  const name = `${options.databasePrefix}_explorer_${randomBytes(4).toString("hex")}`;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error(`unexpected database name ${name}`);
  const admin = createDatabase({ connectionString: options.adminUrl, maxConnections: 1 });
  await sql`CREATE DATABASE ${sql.id(name)}`.execute(admin);
  const url = new URL(options.adminUrl);
  url.pathname = `/${name}`;
  url.search = "";
  const db = createExplorerDatabase({ connectionString: url.toString(), maxConnections: 8 });
  const drop = async () => {
    await db.destroy().catch(() => undefined);
    await sql`DROP DATABASE IF EXISTS ${sql.id(name)} WITH (FORCE)`.execute(admin);
    await admin.destroy();
  };
  let server: Server | undefined;
  try {
    await migrate(db, EXPLORER_MIGRATIONS);
    const registry = options.registry;
    const epoch = registry.document.epochs[0];
    if (epoch === undefined) throw new Error("the registry lists no epoch");
    const store = new ExplorerStore(db);
    await store.loadRegistry(registry);
    const metrics = new ExplorerMetrics();
    const ledgers = new URL(options.ledgerUrl);
    // The production RPC ledger source; it accepts https URLs only, so its requests are sent on to the
    // network's local RPC as they are.
    const rpc = new RpcLedgerSource({
      url: "https://ledgers.drill.invalid/rpc",
      fetch: (_input, init) => fetch(ledgers, init),
      pageLimit: 100,
    });
    const bytes = new LedgerBytes({
      // Every ledger of a drill is inside the RPC's retention; there is no data lake for a private network.
      lake: { fetchLedger: () => Promise.resolve(undefined) },
      rpc,
      pageLimit: 100,
      concurrency: 4,
      onBytesInFlight: (held) => {
        metrics.bytesInFlight.set({ network: NETWORK }, held);
      },
    });
    const abort = new AbortController();
    const ingester = new Ingester({
      network: NETWORK,
      registry,
      epoch,
      store,
      activity: new RpcActivity(options.discoveryUrl, epoch.passphrase),
      bytes,
      metrics,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: (fields, message) => {
          options.log(`explorer indexer: ${message} ${JSON.stringify(fields)}`);
        },
      },
      from: epoch.fromLedger,
      slowRouteRounds: 1,
      concurrency: 4,
      pollMs: 1_000,
      deferSeconds: 1,
      signal: abort.signal,
    });
    let stopped: string | undefined;
    server = await startHealthServer({
      host: "127.0.0.1",
      port: 0,
      registry: metrics.registry,
      maxLagLedgers: 120,
      snapshot: () => ({
        network: NETWORK,
        epoch: epoch.id,
        ...ingester.status,
        stopped: stopped !== undefined,
      }),
    });
    const running = ingester.run().catch((error: unknown) => {
      stopped = (error as { code?: string }).code ?? (error instanceof Error ? error.message : String(error));
    });
    const port = (server.address() as AddressInfo).port;
    const health = server;
    return {
      port,
      metrics,
      indexed: async (txHash) =>
        (await db
          .selectFrom("settlements")
          .select("tx_hash")
          .where("tx_hash", "=", txHash)
          .executeTakeFirst()) !== undefined,
      lastLedger: () => ingester.status.lastLedger,
      ledgerCounts: () => store.ledgerCounts(NETWORK, epoch.id),
      stopped: () => stopped,
      health: async () => {
        const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
        return { status: response.status, body: (await response.json()) as { status?: string } };
      },
      stop: async () => {
        abort.abort();
        await running;
        await new Promise((resolve) => health.close(resolve));
        await drop();
      },
    };
  } catch (error) {
    server?.close();
    await drop().catch(() => undefined);
    throw error;
  }
}
