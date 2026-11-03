/**
 * Runs the indexer's read-and-commit loop over many large ledgers inside a small heap (the parent test
 * starts it with --max-old-space-size) and prints `{ committed, retainedHeapMiB }`. Every ledger is the
 * committed fixture ledger 5,330,308 (about 0.3 MiB of XDR, 2 MiB decoded) renumbered and re-hashed, served
 * as `getLedgers` pages of base64 XDR, the way Lumeus RPC serves a busy testnet stretch. Holding a round of
 * them decoded at once needs several times the heap this process gets.
 */
import { createHash } from "node:crypto";
import { getHeapStatistics } from "node:v8";
import { xdr } from "@stellar/stellar-sdk";
import type { FetchedLedger } from "@rail402.dev/ledger-source";
import { parseRegistry } from "@rail402.dev/x402-index";
import { testnetDocument } from "../../../packages/x402-index/test/helpers.ts";
import { LedgerBytes } from "../src/indexer/bytes.ts";
import { Ingester } from "../src/indexer/ingester.ts";
import { ExplorerMetrics } from "../src/metrics.ts";
import type { ExplorerStore, LedgerCommit } from "../src/store.ts";
import { fixtureMeta } from "./sources.ts";

const LEDGERS = Number(process.env["MEMORY_LEDGERS"] ?? "400");
const FIRST = 6_000_000;

const template = fixtureMeta(5_330_308);
const value = template.switch() === 1 ? template.v1() : template.v2();

/** The template ledger as ledger `sequence`: renumbered, its header hash recomputed. */
function ledgerXdr(sequence: number): string {
  const entry = value.ledgerHeader();
  entry.header().ledgerSeq(sequence);
  entry.hash(createHash("sha256").update(entry.header().toXDR()).digest());
  return template.toXDR("base64");
}

/** The most heap still in use right after a full collection, sampled every 20 commits (needs --expose-gc). */
let retained = 0;
const collect = (globalThis as { gc?: () => void }).gc;
if (collect === undefined) throw new Error("run with --expose-gc");
const sample = () => {
  collect();
  retained = Math.max(retained, getHeapStatistics().used_heap_size);
};

const rpc = {
  retention: () => Promise.resolve({ oldestLedger: 1, latestLedger: FIRST + LEDGERS }),
  fetchLedgers: async (start: number, limit: number): Promise<FetchedLedger[]> => {
    await new Promise((resolve) => setImmediate(resolve));
    const page: FetchedLedger[] = [];
    for (let sequence = start; sequence < Math.min(start + limit, FIRST + LEDGERS); sequence++) {
      const metadata = ledgerXdr(sequence);
      page.push({
        sequence,
        bytes: metadata.length,
        decode: () => {
          const meta = xdr.LedgerCloseMeta.fromXDR(metadata, "base64");
          return { sequence, meta, source: "rpc", uri: "memory#getLedgers" };
        },
      });
    }
    return page;
  },
};

const pending = new Set(Array.from({ length: LEDGERS }, (_, index) => FIRST + index));
let committed = 0;
// The store calls one round makes, over memory: no discovery routes, every ledger pending until committed.
const store = {
  syncRoutes: () => Promise.resolve(0),
  routes: () => Promise.resolve([]),
  newestCandidate: () => Promise.resolve(FIRST + LEDGERS - 1),
  ledgerCounts: () => Promise.resolve({ pending: pending.size, indexed: committed, failed: 0 }),
  pendingLedgers: (_network: string, _epoch: string, limit: number) =>
    Promise.resolve([...pending].slice(0, limit)),
  deferLedger: () => Promise.reject(new Error("every ledger is served")),
  markFailed: () => Promise.reject(new Error("no ledger fails")),
  commitLedger: async (entry: LedgerCommit) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (!pending.delete(entry.ledger)) return false;
    if (++committed % 20 === 0) sample();
    return true;
  },
} as unknown as ExplorerStore;

const registry = parseRegistry(testnetDocument());
const epoch = registry.document.epochs.find((entry) => entry.id === "2025-12-17");
if (epoch === undefined) throw new Error("epoch");
const abort = new AbortController();
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
await new Ingester({
  network: "stellar:testnet",
  registry,
  epoch,
  store,
  activity: {
    walkRange: () => {
      throw new Error("there are no discovery routes");
    },
  },
  // The indexer's defaults: page limit 100, 8 requests and commits at once, 64 MiB of raw bytes held.
  bytes: new LedgerBytes({
    lake: { fetchLedger: () => Promise.resolve(undefined) },
    rpc,
    retentionMarginLedgers: 0,
  }),
  metrics: new ExplorerMetrics(),
  logger: quiet,
  from: epoch.fromLedger,
  signal: abort.signal,
  sleep: () => {
    abort.abort();
    return Promise.resolve();
  },
}).run();
process.stdout.write(`${JSON.stringify({ committed, retainedHeapMiB: Math.round(retained / 2 ** 20) })}\n`);
