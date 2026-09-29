/**
 * Builds the judgment pools and the blinded packets judges read.
 *
 *   node --conditions=@rail402/source tools/search-eval/src/build/pool.ts [--judges 8]
 *
 * A query's pool is the union of what several different systems return, so the judgments do not
 * favour the system under test: Rail402's hybrid and BM25 search, dense retrieval with no floor,
 * dense retrieval over the name and description only, an independent TF-IDF with its own
 * tokenizer, and every listing written for the capabilities the query's author had in mind.
 * Each judge set gets its own packet per query with the listings in its own seeded order and no
 * trace of which system found them.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MemoryCatalogStore, type ListingContent } from "@rail402.dev/bazaar";
import {
  AssetRegistry,
  OnnxEmbedder,
  SearchService,
  cosine,
  ensureModel,
  loadManifest,
  toDocument,
  type KnownAsset,
} from "@rail402.dev/search";
import { toListing, type CorpusEntry, type EvalQuery } from "../dataset.ts";
import { shuffled, type ListingRecord } from "./corpus.ts";
import type { QueryRecord } from "./queries.ts";

const DEPTH = 20;
const SHORT_DEPTH = 15;
export const JUDGE_SETS = ["a", "b"] as const;

export interface Pool {
  readonly query: string;
  readonly pool: readonly string[];
  readonly systems: Readonly<Record<string, readonly string[]>>;
}

/** A listing as judges see it: what it does and how it is called, never its price or network. */
export function renderListing(id: string, listing: ListingContent): string {
  const info = listing.bazaar.info as {
    input?: Record<string, unknown>;
    output?: { example?: unknown };
  };
  const lines = [`### ${id}`];
  lines.push(
    listing.kind === "mcp"
      ? `MCP tool \`${listing.toolName ?? ""}\` at ${listing.resource}`
      : `HTTP ${listing.method ?? "GET"} ${listing.resource}`,
  );
  if (listing.serviceName !== undefined) lines.push(`Name: ${listing.serviceName}`);
  if (listing.description !== undefined) lines.push(`Description: ${listing.description}`);
  if (listing.tags !== undefined && listing.tags.length > 0) lines.push(`Tags: ${listing.tags.join(", ")}`);
  const parameters = describeParameters(listing);
  if (parameters.length > 0) lines.push(`Parameters: ${parameters.join("; ")}`);
  const example = info.output?.example;
  if (example !== undefined) lines.push(`Returns, for example: ${truncate(JSON.stringify(example), 300)}`);
  return lines.join("\n");
}

function describeParameters(listing: ListingContent): string[] {
  const input = (listing.bazaar.info as { input?: Record<string, unknown> }).input ?? {};
  const schemaInput = ((
    listing.bazaar.schema as { properties?: { input?: { properties?: Record<string, unknown> } } }
  ).properties?.input?.properties ?? {}) as Record<
    string,
    { properties?: Record<string, { type?: string; description?: string }> }
  >;
  const described = new Map<string, { type?: string; description?: string }>();
  for (const key of ["queryParams", "body", "pathParams"]) {
    for (const [name, definition] of Object.entries(schemaInput[key]?.properties ?? {}))
      described.set(name, definition);
  }
  const mcpSchema = input["inputSchema"] as
    { properties?: Record<string, { type?: string; description?: string }> } | undefined;
  for (const [name, definition] of Object.entries(mcpSchema?.properties ?? {}))
    described.set(name, definition);
  return [...described].map(
    ([name, definition]) =>
      `${name}${definition.type === undefined ? "" : ` (${definition.type})`}${definition.description === undefined ? "" : `: ${definition.description}`}`,
  );
}

function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}

/** An independent lexical ranker: lower-cased words, no stemming, no stopwords, TF-IDF cosine. */
export class TfIdf {
  private readonly vectors: Map<string, Map<string, number>>;
  private readonly idf = new Map<string, number>();

  constructor(documents: ReadonlyMap<string, string>) {
    const frequencies = new Map<string, Map<string, number>>();
    const documentFrequency = new Map<string, number>();
    for (const [id, text] of documents) {
      const counts = new Map<string, number>();
      for (const word of words(text)) counts.set(word, (counts.get(word) ?? 0) + 1);
      frequencies.set(id, counts);
      for (const word of counts.keys()) documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
    for (const [word, count] of documentFrequency) this.idf.set(word, Math.log(documents.size / count) + 1);
    this.vectors = new Map([...frequencies].map(([id, counts]) => [id, this.weigh(counts)]));
  }

  search(query: string, depth: number): string[] {
    const counts = new Map<string, number>();
    for (const word of words(query)) counts.set(word, (counts.get(word) ?? 0) + 1);
    const vector = this.weigh(counts);
    const scored: [string, number][] = [];
    for (const [id, document] of this.vectors) {
      let score = 0;
      for (const [word, weight] of vector) score += weight * (document.get(word) ?? 0);
      if (score > 0) scored.push([id, score]);
    }
    return scored
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, depth)
      .map(([id]) => id);
  }

  private weigh(counts: ReadonlyMap<string, number>): Map<string, number> {
    const weights = new Map<string, number>();
    let norm = 0;
    for (const [word, count] of counts) {
      const weight = (1 + Math.log(count)) * (this.idf.get(word) ?? 0);
      weights.set(word, weight);
      norm += weight * weight;
    }
    for (const [word, weight] of weights) weights.set(word, weight / (Math.sqrt(norm) || 1));
    return weights;
  }
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
}

function fullText(listing: ListingContent): string {
  return [
    listing.serviceName,
    listing.description,
    listing.toolName,
    listing.resource,
    ...(listing.tags ?? []),
    ...describeParameters(listing),
  ]
    .filter((part) => part !== undefined)
    .join(" ");
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

function seedOf(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32BE(0);
}

async function main() {
  const { values } = parseArgs({
    options: {
      root: { type: "string", default: new URL("../../", import.meta.url).pathname },
      models: { type: "string", default: ".models" },
      judges: { type: "string", default: "8" },
    },
  });
  const root = resolve(values.root);
  const data = join(root, "data");
  const construction = join(root, "construction");
  const corpus = await readJsonLines<CorpusEntry>(join(data, "corpus.jsonl"));
  const queries = await readJsonLines<EvalQuery>(join(data, "queries.jsonl"));
  const listingRecords = await readJsonLines<ListingRecord>(join(construction, "listings.jsonl"));
  const queryRecords = new Map(
    (await readJsonLines<QueryRecord>(join(construction, "queries.jsonl"))).map((record) => [
      record.id,
      record,
    ]),
  );
  const assets = JSON.parse(await readFile(join(data, "assets.json"), "utf8")) as KnownAsset[];
  const listings = new Map(corpus.map((entry) => [entry.id, entry.listing]));

  const manifest = await loadManifest();
  const embedder = await OnnxEmbedder.load(
    manifest,
    await ensureModel(manifest, values.models, { download: true }),
  );
  const store = new MemoryCatalogStore();
  for (const [index, entry] of corpus.entries()) {
    const listing = toListing(entry, index + 1);
    await store.transaction(listing.identity, (tx) =>
      tx.insert(listing, {
        listingId: listing.id,
        version: 1,
        createdAt: listing.firstCatalogedAt,
        cause: "settlement",
        owner: listing.owner,
        trust: listing.trust,
        state: listing.state,
        content: listing.content,
      }),
    );
  }
  const registry = new AssetRegistry(assets);
  const secret = Buffer.alloc(32, 2);
  const hybrid = new SearchService({ store, assets: registry, cursorSecret: secret, embedder });
  const lexical = new SearchService({ store, assets: registry, cursorSecret: secret });
  await hybrid.refresh();
  await lexical.refresh();

  const full = new Map<string, Float32Array>();
  const short = new Map<string, Float32Array>();
  for (const entry of corpus) {
    const listing = toListing(entry, 0);
    full.set(entry.id, await embedder.embed(toDocument(listing).embeddingText));
    const summary = [entry.listing.serviceName, entry.listing.description].filter(Boolean).join(". ");
    short.set(
      entry.id,
      await embedder.embed(summary === "" ? (entry.listing.toolName ?? entry.listing.resource) : summary),
    );
  }
  const tfidf = new TfIdf(new Map(corpus.map((entry) => [entry.id, fullText(entry.listing)])));
  const byCapability = new Map<string, string[]>();
  for (const record of listingRecords) {
    for (const capability of record.capabilities) {
      byCapability.set(capability, [...(byCapability.get(capability) ?? []), record.id]);
    }
  }

  const dense = async (vectors: ReadonlyMap<string, Float32Array>, text: string, depth: number) => {
    const query = await embedder.embed(text);
    return [...vectors]
      .map(([id, vector]) => [id, cosine(query, vector)] as const)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, depth)
      .map(([id]) => id);
  };

  const pools: Pool[] = [];
  for (const query of queries) {
    const record = queryRecords.get(query.id);
    const targets =
      record?.typoOf === undefined
        ? (record?.targets ?? [])
        : (queryRecords.get(record.typoOf)?.targets ?? []);
    const systems: Record<string, string[]> = {
      hybrid: (await hybrid.search({ query: query.text, filter: query.filter ?? {}, limit: DEPTH })).resources
        .flat()
        .map((l) => l.id),
      bm25: (await lexical.search({ query: query.text, filter: query.filter ?? {}, limit: DEPTH })).resources
        .flat()
        .map((l) => l.id),
      dense: await dense(full, query.text, DEPTH),
      denseSummary: await dense(short, query.text, SHORT_DEPTH),
      tfidf: tfidf.search(query.text, DEPTH),
      capability: [...new Set(targets.flatMap((target) => byCapability.get(target) ?? []))].sort(),
    };
    const pool = [...new Set(Object.values(systems).flat())].sort();
    pools.push({ query: query.id, pool, systems });
  }
  await writeFile(
    join(construction, "pools.jsonl"),
    pools.map((pool) => JSON.stringify(pool)).join("\n") + "\n",
  );

  const judges = Number(values.judges);
  for (const set of JUDGE_SETS) {
    const directory = join(construction, "judging", set);
    await mkdir(join(directory, "packets"), { recursive: true });
    for (const pool of pools) {
      const query = queries.find((candidate) => candidate.id === pool.query);
      const order = shuffled(pool.pool, seedOf(`${set}:${pool.query}`));
      const body = [
        `# ${pool.query}`,
        "",
        `Query: ${JSON.stringify(query?.text ?? "")}`,
        "",
        `Candidates: ${String(order.length)}`,
        "",
        ...order.map((id) => `${renderListing(id, listings.get(id) as ListingContent)}\n`),
      ].join("\n");
      await writeFile(join(directory, "packets", `${pool.query}.md`), body);
    }
    // Balanced assignments, largest pools first; each judge set groups queries differently.
    const groups = Array.from({ length: judges }, () => ({ size: 0, queries: [] as string[] }));
    const ordered = shuffled(pools, seedOf(`assign:${set}`)).sort((a, b) => b.pool.length - a.pool.length);
    for (const pool of ordered) {
      const lightest = groups.reduce((min, group) => (group.size < min.size ? group : min));
      lightest.size += pool.pool.length;
      lightest.queries.push(pool.query);
    }
    for (const [index, group] of groups.entries()) {
      await writeFile(
        join(directory, `judge-${String(index + 1)}.txt`),
        group.queries.sort().join("\n") + "\n",
      );
    }
  }
  const sizes = pools.map((pool) => pool.pool.length);
  console.log(
    `${String(pools.length)} pools, ${String(sizes.reduce((a, b) => a + b, 0))} pairs per judge set ` +
      `(min ${String(Math.min(...sizes))}, max ${String(Math.max(...sizes))})`,
  );
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) await main();
