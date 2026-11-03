/**
 * The load test's datasets, all synthetic and deterministic:
 * - catalog A: the search evaluation corpus as it is (500 listings);
 * - catalog B: catalog A expanded ten times (5,000 listings), each copy on its own host and payTo;
 * - the evaluation queries (202), for repeated, cached searches;
 * - uncached queries, generated from word lists with a salt, so a run can send queries it never sent.
 * `data/manifest.json` records the SHA-256 of each; a unit test checks the generators still match it.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Keypair } from "@stellar/stellar-sdk";
import type { CorpusEntry, EvalQuery } from "@rail402.dev/search-eval";

const EVAL_DATA = new URL("../../search-eval/data/", import.meta.url);

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** SHA-256 of entries as JSON Lines, one entry per line in order. */
export function hashLines(entries: readonly unknown[]): string {
  return sha256(entries.map((entry) => JSON.stringify(entry)).join("\n"));
}

async function lines<T>(name: string): Promise<T[]> {
  const text = await readFile(new URL(name, EVAL_DATA), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/** Catalog A: the evaluation corpus. */
export function catalogA(): Promise<CorpusEntry[]> {
  return lines<CorpusEntry>("corpus.jsonl");
}

/** The evaluation queries' texts. */
export async function evalQueries(): Promise<string[]> {
  return (await lines<EvalQuery>("queries.jsonl")).map((query) => query.text);
}

/** A Stellar account derived from a label, the same on every run. */
function accountFor(label: string): string {
  return Keypair.fromRawEd25519Seed(
    createHash("sha256").update(`rail402-loadtest:${label}`).digest(),
  ).publicKey();
}

/**
 * `corpus` and `factor - 1` copies of it. Copy k of a listing lives on host `c<k>.<host>` (an `mcp://`
 * tool keeps its URL) and is paid to an account of its own, so every copy is a distinct listing.
 */
export function expand(corpus: readonly CorpusEntry[], factor: number): CorpusEntry[] {
  const entries: CorpusEntry[] = [...corpus];
  for (let copy = 1; copy < factor; copy++) {
    for (const entry of corpus) {
      const payTo = accountFor(`${entry.id}:${String(copy)}`);
      const url = new URL(entry.listing.resource);
      const resource =
        url.protocol === "mcp:"
          ? entry.listing.resource
          : entry.listing.resource.replace(url.host, `c${String(copy)}.${url.host}`);
      entries.push({
        ...entry,
        id: `${entry.id}-x${String(copy)}`,
        listing: {
          ...entry.listing,
          resource,
          accepts: entry.listing.accepts.map((option) => ({ ...option, payTo })),
        },
      });
    }
  }
  return entries;
}

/** Catalog B: catalog A expanded ten times. */
export async function catalogB(): Promise<CorpusEntry[]> {
  return expand(await catalogA(), 10);
}

const SUBJECTS = [
  "weather",
  "translation",
  "geocoding",
  "invoice",
  "sentiment",
  "transcription",
  "currency",
  "flight",
  "shipping",
  "recipe",
  "stock",
  "news",
  "image",
  "sanctions",
  "address",
  "calendar",
  "tax",
  "energy",
  "traffic",
  "genome",
];
const ACTIONS = [
  "lookup",
  "forecast",
  "validation",
  "summary",
  "conversion",
  "tracking",
  "screening",
  "analysis",
  "search",
  "scoring",
  "extraction",
  "alerts",
  "history",
  "comparison",
  "estimate",
  "report",
];
const QUALIFIERS = [
  "for small shops",
  "with hourly detail",
  "in bulk",
  "for agents",
  "as json",
  "for mobile apps",
  "with sources",
  "near real time",
  "for europe",
  "for logistics teams",
  "with confidence scores",
  "for researchers",
];

/**
 * The `index`th uncached query of a run salted with `salt`: a search no earlier run of a different
 * salt sends, made of ordinary words, with no network, asset or price constraint in it.
 */
export function uncachedQuery(index: number, salt: string): string {
  const subject = SUBJECTS[index % SUBJECTS.length] ?? "";
  const action = ACTIONS[Math.floor(index / SUBJECTS.length) % ACTIONS.length] ?? "";
  const qualifier =
    QUALIFIERS[Math.floor(index / (SUBJECTS.length * ACTIONS.length)) % QUALIFIERS.length] ?? "";
  const round = Math.floor(index / (SUBJECTS.length * ACTIONS.length * QUALIFIERS.length));
  return `${subject} ${action} ${qualifier} variant ${salt}${round.toString(36)}`;
}

/** The hashes `data/manifest.json` records. */
export async function datasetHashes(): Promise<Record<string, { sha256: string; count: number }>> {
  const a = await catalogA();
  const b = expand(a, 10);
  const queries = await evalQueries();
  const uncached = Array.from({ length: 1_000 }, (_, index) => uncachedQuery(index, "manifest"));
  return {
    catalogA: { sha256: hashLines(a), count: a.length },
    catalogB: { sha256: hashLines(b), count: b.length },
    queries: { sha256: hashLines(queries), count: queries.length },
    uncachedSample: { sha256: hashLines(uncached), count: uncached.length },
  };
}
