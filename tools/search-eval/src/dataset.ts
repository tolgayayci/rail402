import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { contentHash, type Listing, type ListingContent } from "@rail402.dev/bazaar";
import type { SearchFilter } from "@rail402.dev/search";

/** Where a corpus entry comes from. Sample listings are written for the evaluation and labelled so. */
export type Source = "public" | "sample";

export interface CorpusEntry {
  readonly id: string;
  readonly source: Source;
  /** For public listings: where and when it was retrieved. */
  readonly provenance?: { readonly catalog: string; readonly retrievedAt: string };
  readonly listing: ListingContent;
}

export type QueryClass =
  "intent" | "paraphrase" | "keyword" | "constraint" | "stellar" | "mcp" | "no_answer" | "typo";

/**
 * Every hard constraint a searcher means, labelled by hand, whether stated in the text or sent as
 * parameters. It is independent of Rail402's query parser, so the evaluation can measure how well
 * the parser recovers constraints and check results against what the searcher asked for.
 */
export interface ExpectedConstraints {
  readonly network?: string;
  readonly type?: "http" | "mcp";
  /** Asset symbol. */
  readonly asset?: string;
  /** `USD` for dollar amounts (any USD-pegged asset), otherwise an asset symbol. */
  readonly maxPrice?: { readonly amount: string; readonly unit: string };
  readonly scheme?: string;
  /** A G…, C… or M… address; a G… account also matches muxed addresses on it. */
  readonly payTo?: string;
}

export interface EvalQuery {
  readonly id: string;
  readonly text: string;
  readonly class: QueryClass;
  readonly split: "dev" | "test";
  /** Explicit request filters, sent alongside the text as API parameters. */
  readonly filter?: SearchFilter;
  readonly expected?: ExpectedConstraints;
}

export interface Manifest {
  readonly version: string;
  readonly files: Readonly<
    Record<"corpus" | "queries" | "qrels", { readonly sha256: string; readonly count: number }>
  >;
  readonly corpus: { readonly public: number; readonly sample: number };
  readonly judging: {
    readonly scale: string;
    readonly method: string;
    readonly judges: readonly string[];
    readonly agreement?: Readonly<Record<string, number>>;
  };
}

export interface Dataset {
  readonly directory: URL;
  readonly corpus: readonly CorpusEntry[];
  readonly queries: readonly EvalQuery[];
  /** query id → (listing id → grade) */
  readonly qrels: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly manifest: Manifest;
  /** SHA-256 over the three data files, identifying exactly what was evaluated. */
  readonly hash: string;
}

/** Loads the dataset and refuses to proceed if any file differs from its manifest hash. */
export async function loadDataset(directory: URL): Promise<Dataset> {
  const read = (name: string) => readFile(new URL(name, directory));
  const [corpusBytes, queryBytes, qrelBytes, manifestBytes] = await Promise.all([
    read("corpus.jsonl"),
    read("queries.jsonl"),
    read("qrels.tsv"),
    read("manifest.json"),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
  const check = (name: "corpus" | "queries" | "qrels", bytes: Buffer) => {
    const actual = sha256(bytes);
    if (actual !== manifest.files[name].sha256) {
      throw new Error(
        `${name} has sha256 ${actual}, but manifest.json records ${manifest.files[name].sha256}`,
      );
    }
  };
  check("corpus", corpusBytes);
  check("queries", queryBytes);
  check("qrels", qrelBytes);

  const corpus = lines(corpusBytes).map((line) => JSON.parse(line) as CorpusEntry);
  const queries = lines(queryBytes).map((line) => JSON.parse(line) as EvalQuery);
  const qrels = new Map<string, Map<string, number>>();
  const ids = new Set(corpus.map((entry) => entry.id));
  for (const line of lines(qrelBytes)) {
    const [query = "", listing = "", grade = ""] = line.split("\t");
    if (!ids.has(listing)) throw new Error(`qrels reference unknown listing ${listing}`);
    const value = Number(grade);
    if (!Number.isInteger(value) || value < 0 || value > 3) throw new Error(`invalid grade "${grade}"`);
    let judged = qrels.get(query);
    if (judged === undefined) {
      judged = new Map<string, number>();
      qrels.set(query, judged);
    }
    judged.set(listing, value);
  }
  return {
    directory,
    corpus,
    queries,
    qrels,
    manifest,
    hash: sha256(Buffer.concat([corpusBytes, queryBytes, qrelBytes])),
  };
}

/** A corpus entry as a published catalog listing. */
export function toListing(entry: CorpusEntry, sequence: number): Listing {
  const content = entry.listing;
  const option = content.accepts[0];
  const date = new Date("2026-09-01T00:00:00.000Z");
  return {
    id: entry.id,
    sequence,
    identity: {
      network: option?.network ?? "stellar:testnet",
      kind: content.kind,
      resource: content.resource,
      method: content.method ?? "",
      toolName: content.toolName ?? "",
      scope: content.resource.startsWith("mcp:") ? (option?.payTo ?? "") : "",
    },
    owner: option?.payTo ?? "",
    trust: "settled",
    state: "published",
    version: 1,
    content,
    contentHash: contentHash(content),
    firstCatalogedAt: date,
    lastUpdated: date,
    lastSettledAt: date,
    settlements: 1,
  };
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function lines(bytes: Buffer): string[] {
  return bytes
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}
