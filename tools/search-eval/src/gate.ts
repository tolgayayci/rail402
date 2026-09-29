import type { Report } from "./evaluate.ts";

/** The committed reference a release is measured against, tied to exactly what produced it. */
export interface Baseline {
  readonly tag: string;
  readonly datasetHash: string;
  readonly model: string;
  readonly test: {
    readonly lexical: { readonly ndcgAt10: number; readonly recallAt20: number };
    readonly hybrid: { readonly ndcgAt10: number; readonly recallAt20: number };
  };
}

/** Largest drop from the baseline a release may show on nDCG@10 or Recall@20. */
export const TOLERANCE = 0.02;

export function baselineOf(report: Report, tag: string): Baseline {
  const pick = (mode: "lexical" | "hybrid") => ({
    ndcgAt10: round(report.modes[mode].splits.test.ndcgAt10),
    recallAt20: round(report.modes[mode].splits.test.recallAt20),
  });
  return {
    tag,
    datasetHash: report.dataset.hash,
    model: report.model,
    test: { lexical: pick("lexical"), hybrid: pick("hybrid") },
  };
}

/** Release tags of the search evaluation: `search-eval-v<major>.<minor>.<patch>`. */
export const BASELINE_TAG = /^search-eval-v\d+\.\d+\.\d+$/;

/**
 * Whether the committed baseline is the one its release tag recorded. A change cannot lower the bar
 * by editing baseline.json: the file must be byte-identical to the copy at the tag it names, and a
 * new baseline takes a new tag. `tagged` is the file at the tag, undefined when the tag is missing.
 */
export function baselineIntegrity(committed: string, tag: string, tagged: string | undefined): string[] {
  if (!BASELINE_TAG.test(tag)) return [`baseline tag ${JSON.stringify(tag)} is not a search-eval-vX.Y.Z tag`];
  if (tagged === undefined) {
    return [
      `tag ${tag} was not found; fetch tags (git fetch --tags) or tag the commit that recorded this baseline`,
    ];
  }
  if (tagged !== committed) return [`baseline.json differs from the copy recorded at ${tag}`];
  return [];
}

/**
 * Release gate. Fails on: a changed dataset or model without a re-baseline; hybrid dropping more than
 * TOLERANCE below the baseline on test nDCG@10 or Recall@20; hybrid scoring below BM25, either as
 * measured now or as fixed at the baseline; any filter violation, or any filter-conformance violation or
 * missed listing. Returns the failures; an empty list passes.
 */
export function gate(report: Report, baseline: Baseline): string[] {
  const failures: string[] = [];
  if (report.dataset.hash !== baseline.datasetHash) {
    failures.push(
      `dataset ${report.dataset.hash.slice(0, 12)} differs from the baseline's ${baseline.datasetHash.slice(0, 12)}; re-baseline in a dedicated change`,
    );
  }
  if (report.model !== baseline.model) {
    failures.push(
      `model ${report.model} differs from the baseline's ${baseline.model}; re-baseline in a dedicated change`,
    );
  }
  const hybrid = report.modes.hybrid.splits.test;
  const lexical = report.modes.lexical.splits.test;
  for (const metric of ["ndcgAt10", "recallAt20"] as const) {
    const floor = baseline.test.hybrid[metric] - TOLERANCE;
    if (hybrid[metric] < floor - 1e-9) {
      failures.push(
        `hybrid test ${metric} ${hybrid[metric].toFixed(4)} is below the baseline floor ${floor.toFixed(4)}`,
      );
    }
    if (hybrid[metric] < lexical[metric] - 1e-9) {
      failures.push(
        `hybrid test ${metric} ${hybrid[metric].toFixed(4)} is below BM25's ${lexical[metric].toFixed(4)}`,
      );
    }
    // BM25 shares the tokenizer and query parser, so it also moves with a change; the tagged BM25 does not.
    if (hybrid[metric] < baseline.test.lexical[metric] - 1e-9) {
      failures.push(
        `hybrid test ${metric} ${hybrid[metric].toFixed(4)} is below the baseline BM25's ${baseline.test.lexical[metric].toFixed(4)}`,
      );
    }
  }
  for (const [constraint, count] of Object.entries(report.filters.violations)) {
    if (count > 0) failures.push(`${String(count)} result(s) violated the ${constraint} constraint`);
  }
  for (const [constraint, tally] of Object.entries(report.filterConformance.byFilter)) {
    if (tally.violations > 0) {
      failures.push(
        `filter conformance: ${String(tally.violations)} result(s) violated the ${constraint} filter`,
      );
    }
    if (tally.missed > 0) {
      failures.push(
        `filter conformance: ${String(tally.missed)} listing(s) satisfying the ${constraint} filter were missed`,
      );
    }
  }
  return failures;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
