import { FIELD_WEIGHTS, type Field, type SearchDocument } from "./text.ts";

export interface Scored {
  readonly id: string;
  readonly score: number;
}

const FIELDS = Object.keys(FIELD_WEIGHTS) as Field[];

/**
 * BM25F: term frequencies are length-normalised per field, weighted by field importance and summed,
 * then saturated once (Robertson & Zaragoza, 2009). Immutable once built.
 *
 * Postings are packed: each term maps to one flat array of (document index, weighted frequency)
 * pairs, so a term costs one array however many documents hold it, and the index's size can be
 * estimated from what it holds (see `bytes`).
 */
export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly ids: readonly string[];
  private readonly postings = new Map<string, number[]>();
  private readonly documentCount: number;
  /** Estimated memory the index holds, in bytes. */
  readonly bytes: number;

  constructor(documents: readonly SearchDocument[], options: { k1?: number; b?: number } = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
    this.documentCount = documents.length;
    this.ids = documents.map((doc) => doc.id);

    const averageLength = Object.fromEntries(
      FIELDS.map((field) => [
        field,
        documents.reduce((sum, doc) => sum + doc.fields[field].length, 0) / Math.max(documents.length, 1),
      ]),
    ) as Record<Field, number>;

    let entries = 0;
    for (const [index, doc] of documents.entries()) {
      const weighted = new Map<string, number>();
      for (const field of FIELDS) {
        const tokens = doc.fields[field];
        if (tokens.length === 0) continue;
        const counts = new Map<string, number>();
        for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
        const average = averageLength[field] > 0 ? averageLength[field] : 1;
        const normaliser = 1 - this.b + this.b * (tokens.length / average);
        for (const [token, count] of counts) {
          weighted.set(token, (weighted.get(token) ?? 0) + (FIELD_WEIGHTS[field] * count) / normaliser);
        }
      }
      for (const [token, frequency] of weighted) {
        const posting = this.postings.get(token);
        if (posting === undefined) {
          // A token can be a slice of the text it came from, which would keep that whole text alive:
          // the index keeps its own copy. A new posting starts at its exact size; most terms of a
          // large catalog occur in one document only.
          this.postings.set(Buffer.from(token, "utf8").toString("utf8"), [index, frequency]);
        } else {
          posting.push(index, frequency);
        }
        entries++;
      }
    }
    let terms = 0;
    for (const token of this.postings.keys()) terms += termBytes(token);
    this.bytes = terms + entries * POSTING_ENTRY_BYTES + this.ids.length * 16 + 256;
  }

  /** Documents matching at least one query term, best first, optionally limited to `candidates`. */
  search(queryTokens: readonly string[], candidates?: ReadonlySet<string>): Scored[] {
    const scores = new Map<string, number>();
    for (const token of new Set(queryTokens)) {
      const posting = this.postings.get(token);
      if (posting === undefined) continue;
      const size = posting.length / 2;
      const idf = Math.log(1 + (this.documentCount - size + 0.5) / (size + 0.5));
      for (let at = 0; at < posting.length; at += 2) {
        const id = this.ids[posting[at] ?? -1];
        const frequency = posting[at + 1] ?? 0;
        if (id === undefined || (candidates !== undefined && !candidates.has(id))) continue;
        scores.set(id, (scores.get(id) ?? 0) + (idf * frequency) / (this.k1 + frequency));
      }
    }
    return [...scores].map(([id, score]) => ({ id, score })).sort(byScore);
  }
}

/**
 * Estimated bytes of one term in the index: the key string (UTF-16, as a cons or flattened string), its
 * map slot, and the posting array's headers and initial backing store. Calibrated against measured
 * heap (see the memory test in packages/search/test) with a margin.
 */
export function termBytes(token: string): number {
  return 2 * token.length + 120;
}

/** Estimated bytes of one (document, frequency) pair in a posting: two unboxed doubles plus growth slack. */
export const POSTING_ENTRY_BYTES = 24;

export function byScore(a: Scored, b: Scored): number {
  return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Reciprocal rank fusion (Cormack, Clarke & Büttcher, 2009): Σ 1 / (k + rank) over each ranking. */
export function reciprocalRankFusion(rankings: readonly (readonly Scored[])[], k = 60): Scored[] {
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((entry, index) => {
      fused.set(entry.id, (fused.get(entry.id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...fused].map(([id, score]) => ({ id, score })).sort(byScore);
}
