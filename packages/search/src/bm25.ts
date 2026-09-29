import { FIELD_WEIGHTS, type Field, type SearchDocument } from "./text.ts";

export interface Scored {
  readonly id: string;
  readonly score: number;
}

const FIELDS = Object.keys(FIELD_WEIGHTS) as Field[];

/**
 * BM25F: term frequencies are length-normalised per field, weighted by field importance and summed,
 * then saturated once (Robertson & Zaragoza, 2009). Immutable once built.
 */
export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly postings = new Map<string, Map<string, number>>();
  private readonly documentCount: number;

  constructor(documents: readonly SearchDocument[], options: { k1?: number; b?: number } = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
    this.documentCount = documents.length;

    const averageLength = Object.fromEntries(
      FIELDS.map((field) => [
        field,
        documents.reduce((sum, doc) => sum + doc.fields[field].length, 0) / Math.max(documents.length, 1),
      ]),
    ) as Record<Field, number>;

    for (const doc of documents) {
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
        let posting = this.postings.get(token);
        if (posting === undefined) {
          posting = new Map();
          this.postings.set(token, posting);
        }
        posting.set(doc.id, frequency);
      }
    }
  }

  /** Documents matching at least one query term, best first, optionally limited to `candidates`. */
  search(queryTokens: readonly string[], candidates?: ReadonlySet<string>): Scored[] {
    const scores = new Map<string, number>();
    for (const token of new Set(queryTokens)) {
      const posting = this.postings.get(token);
      if (posting === undefined) continue;
      const idf = Math.log(1 + (this.documentCount - posting.size + 0.5) / (posting.size + 0.5));
      for (const [id, frequency] of posting) {
        if (candidates !== undefined && !candidates.has(id)) continue;
        scores.set(id, (scores.get(id) ?? 0) + (idf * frequency) / (this.k1 + frequency));
      }
    }
    return [...scores].map(([id, score]) => ({ id, score })).sort(byScore);
  }
}

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
