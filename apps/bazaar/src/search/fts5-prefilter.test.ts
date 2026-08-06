import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  HELD_OUT_CORPUS_LARGE,
  HELD_OUT_BROAD_DEV,
  HELD_OUT_BROAD_LOCKED,
  HELD_OUT_DEV,
  HELD_OUT_LOCKED,
} from "./heldout.js";
import { describeEntry } from "./index.js";
import { entryKey } from "../catalog/types.js";

/**
 * Why the catalog's SQLite backend does NOT use SQLite's full-text engine for retrieval.
 *
 * The durable backend (`catalog/persistence.ts`) is built on `node:sqlite`, which ships FTS5 with
 * bm25 ranking compiled in. Reaching for it as a first-stage candidate generator is the obvious
 * move — it would bound memory as the catalog grows, and it costs nothing to enable.
 *
 * This measures it instead of assuming, because the thing at risk is the one measured deliverable
 * in the project. A candidate stage is a hard filter: whatever it does not return, the hybrid ranker
 * can never rank, so its recall is a ceiling on the whole system's recall.
 *
 * **Result: a lexical prefilter is badly lossy on this corpus.** Against all 127 judgments over the
 * 2,000-document held-out corpus, FTS5 with an OR-of-terms query returns:
 *
 * | K | relevant documents retained |
 * |---|---|
 * | 50 | 64.4% |
 * | 200 | 70.8% |
 * | 500 | 79.5% |
 *
 * At K=500 — a quarter of the entire corpus, which defeats the point of a prefilter — it is still
 * discarding one relevant document in five. The shipped hybrid reaches ~80% recall at **K=10**, so
 * an FTS5 prefilter would cap the ceiling at roughly where the current system already operates while
 * adding a stage. That is the semantic half of the hybrid doing work lexical matching cannot
 * reproduce, which is the same thing Phase 2's ablation found from the other direction.
 *
 * So SQLite stores rows and nothing else. If the catalog ever outgrows memory, the answer is a
 * vector-aware candidate stage, not this one — and it will need its own measurement before it ships.
 *
 * This test exists so the decision is reproducible and so a future change that claims a lexical
 * prefilter is sufficient has to argue with a number.
 */

const JUDGMENTS = [
  ...HELD_OUT_BROAD_DEV,
  ...HELD_OUT_BROAD_LOCKED,
  ...HELD_OUT_DEV,
  ...HELD_OUT_LOCKED,
];

/** Recall of an FTS5 top-K candidate stage over the held-out corpus. */
function ftsCandidateRecall(k: number): { recall: number; retained: number; relevant: number } {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE docs USING fts5(key UNINDEXED, body, tokenize='unicode61')");
    const insert = db.prepare("INSERT INTO docs (key, body) VALUES (?, ?)");
    for (const entry of HELD_OUT_CORPUS_LARGE) {
      // The same text the BM25 half of the shipped ranker sees, so this compares retrieval rather
      // than field extraction.
      const body = describeEntry(entry)
        .map(([text]) => text)
        .join(" ");
      insert.run(entryKey(entry.resource, entry.toolName), body);
    }

    const query = db.prepare("SELECT key FROM docs WHERE docs MATCH ? ORDER BY bm25(docs) LIMIT ?");
    let relevant = 0;
    let retained = 0;
    for (const judgment of JUDGMENTS) {
      // FTS5 has its own query syntax; feeding it raw prose throws on punctuation and operators.
      const terms = judgment.query
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter(t => t.length > 2);
      if (terms.length === 0) continue;
      const rows = query.all(terms.join(" OR "), k) as { key: string }[];
      const returned = new Set(rows.map(r => r.key));
      relevant += judgment.relevant.length;
      retained += judgment.relevant.filter(r => returned.has(r)).length;
    }
    return { recall: retained / relevant, retained, relevant };
  } finally {
    db.close();
  }
}

describe("FTS5 as a candidate stage — measured, and rejected", () => {
  it("loses a fifth of the relevant documents even at K=500", () => {
    const wide = ftsCandidateRecall(500);
    // Stated as a ceiling rather than an equality: the assertion encodes the DECISION (a lexical
    // prefilter is lossy here), not a snapshot that a corpus edit would break for no reason.
    expect(wide.recall).toBeLessThan(0.95);

    // And it gets worse at a K small enough to be worth having.
    const narrow = ftsCandidateRecall(50);
    expect(narrow.recall).toBeLessThan(wide.recall);
    expect(narrow.recall).toBeLessThan(0.8);
  });
});
