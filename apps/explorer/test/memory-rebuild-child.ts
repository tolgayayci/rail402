/**
 * Runs a full-scope rebuild over many large chained ledgers inside a small heap (the parent test starts it
 * with --max-old-space-size) and prints `{ ledgers, retainedHeapMiB, manifestSha256 }`. Every ledger is the
 * committed fixture ledger 5,330,308 (about 0.3 MiB of XDR, 2 MiB decoded) renumbered and re-chained,
 * handed over undecoded the way the data lake does. With 64 requests in flight and no byte budget, the
 * ledgers held decoded at once need more heap than this process gets.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { xdr } from "@stellar/stellar-sdk";
import type { FetchedLedger, SourcedLedger } from "@rail402.dev/ledger-source";
import { parseRegistry } from "@rail402.dev/x402-index";
import { testnetDocument } from "../../../packages/x402-index/test/helpers.ts";
import { rebuild } from "../src/rebuild/rebuild.ts";
import { fixtureMeta } from "./sources.ts";

const LEDGERS = Number(process.env["MEMORY_LEDGERS"] ?? "400");
const BUDGET = process.env["MEMORY_BYTES_IN_FLIGHT"];
const FIRST = 6_000_000;

const template = fixtureMeta(5_330_308);
const value = template.switch() === 1 ? template.v1() : template.v2();
const entry = value.ledgerHeader();

/** The chain's hashes, computed once: ledger n's header names ledger n - 1's hash. */
const hashes = new Map<number, Buffer>();
let previous = Buffer.alloc(32);
for (let sequence = FIRST - 1; sequence < FIRST + LEDGERS; sequence++) {
  entry.header().ledgerSeq(sequence);
  entry.header().previousLedgerHash(previous);
  previous = createHash("sha256").update(entry.header().toXDR()).digest();
  hashes.set(sequence, previous);
}

function ledgerXdr(sequence: number): string {
  entry.header().ledgerSeq(sequence);
  entry.header().previousLedgerHash(hashes.get(sequence - 1) ?? Buffer.alloc(32));
  entry.hash(hashes.get(sequence) ?? Buffer.alloc(32));
  return template.toXDR("base64");
}

let retained = 0;
const collect = (globalThis as { gc?: () => void }).gc;
if (collect === undefined) throw new Error("run with --expose-gc");
let read = 0;
const sample = () => {
  collect();
  retained = Math.max(retained, getHeapStatistics().used_heap_size);
};

const decode = (sequence: number, metadata: string): SourcedLedger => ({
  sequence,
  meta: xdr.LedgerCloseMeta.fromXDR(metadata, "base64"),
  source: "lake",
  uri: `memory:${String(sequence)}`,
});
// Each ledger is made when it is asked for, the way a fast network answers: what the reader holds ahead
// of its turn is what its budget lets it hold.
const source = {
  name: "memory",
  latestLedger: () => Promise.resolve(FIRST + LEDGERS - 1),
  fetchLedger: (sequence: number): Promise<FetchedLedger | undefined> => {
    if (sequence >= FIRST + LEDGERS) return Promise.resolve(undefined);
    const metadata = ledgerXdr(sequence);
    return Promise.resolve({ sequence, bytes: metadata.length, decode: () => decode(sequence, metadata) });
  },
  getLedger: (sequence: number): Promise<SourcedLedger | undefined> => {
    if (sequence >= FIRST + LEDGERS) return Promise.resolve(undefined);
    return Promise.resolve(decode(sequence, ledgerXdr(sequence)));
  },
};

const registry = parseRegistry(testnetDocument());
const epoch = registry.document.epochs.find((item) => item.id === "2025-12-17");
if (epoch === undefined) throw new Error("epoch");
const outDir = mkdtempSync(join(tmpdir(), "rail402-explorer-memory-"));
try {
  const result = await rebuild({
    network: "stellar:testnet",
    epoch: {
      id: epoch.id,
      passphrase: epoch.passphrase,
      fromLedger: epoch.fromLedger,
      dataLakeFolder: epoch.dataLakeFolder,
    },
    registry,
    source,
    sourceDescription: { kind: "directory", uri: null },
    from: FIRST,
    to: FIRST + LEDGERS - 1,
    concurrency: Number(process.env["MEMORY_CONCURRENCY"] ?? "64"),
    ...(BUDGET === undefined ? {} : { maxBytesInFlight: Number(BUDGET) }),
    retainRows: false,
    outDir,
    onProgress: () => {
      if (++read % 20 === 0) sample();
    },
  });
  process.stdout.write(
    `${JSON.stringify({ ledgers: read, retainedHeapMiB: Math.round(retained / 2 ** 20), manifestSha256: result.manifestSha256 })}\n`,
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
