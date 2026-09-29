import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import { tokenize, type Embedder, type KnownAsset } from "@rail402.dev/search";
import {
  baselineIntegrity,
  baselineOf,
  checkFilters,
  conformanceCatalog,
  evaluate,
  gate,
  loadDataset,
  unmetConstraints,
  type Report,
} from "../src/index.ts";

const FIXTURE = new URL("./fixture/", import.meta.url);

/** Deterministic stand-in for the ONNX model, so the harness test runs without it. */
const embedder: Embedder = {
  id: "hash",
  dimensions: 4096,
  embed: (text) => {
    const vector = new Float32Array(4096);
    for (const token of tokenize(text)) {
      const bucket = createHash("sha256").update(token).digest().readUInt16BE(0) % 4096;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    return Promise.resolve(vector.map((value) => value / (Math.sqrt(norm) || 1)));
  },
};

async function run(): Promise<Report> {
  const dataset = await loadDataset(FIXTURE);
  const assets = JSON.parse(await readFile(new URL("assets.json", FIXTURE), "utf8")) as KnownAsset[];
  return evaluate(dataset, { embedder, assets, modelLabel: "hash", repeats: 1 });
}

describe("search evaluation harness", () => {
  it("evaluates both modes per split and class, with zero filter violations", async () => {
    const report = await run();
    expect(report.dataset).toMatchObject({ listings: 6, sample: 6, queries: 5, noAnswerQueries: 1 });
    for (const mode of ["lexical", "hybrid"] as const) {
      const test = report.modes[mode].splits.test;
      expect(test.queries).toBe(2);
      expect(test.mrr).toBe(1);
      expect(report.modes[mode].classes.constraint?.queries).toBe(1);
    }
    expect(report.filters.checkedQueries).toBeGreaterThanOrEqual(2);
    expect(Object.values(report.filters.violations).every((count) => count === 0)).toBe(true);
    expect(report.modes.hybrid.latencyMs.p50).toBeGreaterThanOrEqual(0);
  });

  it("refuses a dataset whose files do not match the manifest", async () => {
    const copy = await mkdtemp(join(tmpdir(), "eval-"));
    for (const name of ["corpus.jsonl", "queries.jsonl", "qrels.tsv", "manifest.json", "assets.json"]) {
      await copyFile(new URL(name, FIXTURE), join(copy, name));
    }
    await writeFile(join(copy, "qrels.tsv"), "Q1\tL3\t3\n");
    await expect(loadDataset(new URL(`file://${copy}/`))).rejects.toThrow(/qrels has sha256/);
  });

  it("gates releases on regressions, dataset changes and BM25 parity", async () => {
    const report = await run();
    const baseline = baselineOf(report, "v-test");
    expect(gate(report, baseline)).toEqual([]);

    const regressed: Report = {
      ...report,
      modes: {
        ...report.modes,
        hybrid: {
          ...report.modes.hybrid,
          splits: {
            ...report.modes.hybrid.splits,
            test: { ...report.modes.hybrid.splits.test, ndcgAt10: baseline.test.hybrid.ndcgAt10 - 0.05 },
          },
        },
      },
    };
    expect(gate(regressed, baseline).join("\n")).toMatch(/below the baseline floor/);
    expect(gate(regressed, baseline).join("\n")).toMatch(/below BM25/);
    expect(
      gate({ ...report, dataset: { ...report.dataset, hash: "0".repeat(64) } }, baseline).join("\n"),
    ).toMatch(/re-baseline/);
    const violating: Report = {
      ...report,
      filters: { ...report.filters, violations: { ...report.filters.violations, price: 1 } },
    };
    expect(gate(violating, baseline).join("\n")).toMatch(/price constraint/);
    const missing: Report = {
      ...report,
      filterConformance: {
        ...report.filterConformance,
        byFilter: {
          ...report.filterConformance.byFilter,
          payTo: { ...report.filterConformance.byFilter.payTo, missed: 2 },
        },
      },
    };
    expect(gate(missing, baseline).join("\n")).toMatch(/satisfying the payTo filter were missed/);

    // BM25 moves with the tokenizer and parser; hybrid is also held to the BM25 fixed at the baseline.
    const raisedBm25 = {
      ...baseline,
      test: {
        ...baseline.test,
        lexical: { ...baseline.test.lexical, ndcgAt10: report.modes.hybrid.splits.test.ndcgAt10 + 0.01 },
      },
    };
    expect(gate(report, raisedBm25).join("\n")).toMatch(/below the baseline BM25/);
  });

  it("accepts only the baseline recorded at the release tag it names", () => {
    const committed = '{"tag":"search-eval-v1.0.0"}\n';
    expect(baselineIntegrity(committed, "search-eval-v1.0.0", committed)).toEqual([]);
    expect(
      baselineIntegrity(committed, "search-eval-v1.0.0", '{"tag":"search-eval-v1.0.0","x":1}\n'),
    ).toEqual([expect.stringMatching(/differs from the copy recorded at search-eval-v1.0.0/)]);
    expect(baselineIntegrity(committed, "search-eval-v9.9.9", undefined)).toEqual([
      expect.stringMatching(/was not found/),
    ]);
    expect(baselineIntegrity(committed, "v-test", committed)).toEqual([
      expect.stringMatching(/not a search-eval/),
    ]);
  });

  it("finds no violated and no missed listing for any filter on the conformance catalog", async () => {
    const report = await checkFilters();
    expect(report.listings).toBeGreaterThan(150);
    for (const [name, tally] of Object.entries(report.byFilter)) {
      expect(tally.queries, name).toBeGreaterThan(2);
      expect(tally.results, name).toBeGreaterThan(0);
      expect({ name, violations: tally.violations, missed: tally.missed }).toEqual({
        name,
        violations: 0,
        missed: 0,
      });
    }
  });

  it("checks recipients independently: a G account covers its muxed addresses, an M address only itself", () => {
    const muxed = conformanceCatalog().find((listing) => listing.content.accepts[0]?.payTo.startsWith("M"));
    if (muxed === undefined) throw new Error("no muxed listing in the conformance catalog");
    const address = muxed.content.accepts[0]?.payTo ?? "";
    const base = MuxedAccount.fromAddress(address, "0").baseAccount().accountId();
    const sibling = new MuxedAccount(new Account(base, "0"), "999").accountId();
    expect(unmetConstraints(muxed.content, { payTo: address }, [])).toEqual([]);
    expect(unmetConstraints(muxed.content, { payTo: base }, [])).toEqual([]);
    expect(unmetConstraints(muxed.content, { payTo: sibling }, [])).toEqual(["payTo"]);
    expect(unmetConstraints(muxed.content, { payTo: Keypair.random().publicKey() }, [])).toEqual(["payTo"]);
  });
});
