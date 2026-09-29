/**
 * Reproduces Rail402's published search evaluation from a fresh clone.
 *
 *   pnpm eval                          evaluate and print the report (writes results/report.json)
 *   pnpm eval --check                  release gate against data/baseline.json (non-zero exit on failure);
 *                                      baseline.json must match the copy at the release tag it names
 *   pnpm eval --write-baseline <tag>   record data/baseline.json and data/report.json for a release tag
 *   pnpm eval --data <dir>             evaluate another dataset directory
 *
 * The embedding model is downloaded on first use and verified against its pinned hashes.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { OnnxEmbedder, ensureModel, loadManifest, type KnownAsset } from "@rail402.dev/search";
import { loadDataset } from "./dataset.ts";
import { evaluate, type Report } from "./evaluate.ts";
import { BASELINE_TAG, baselineIntegrity, baselineOf, gate, type Baseline } from "./gate.ts";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: new URL("../data/", import.meta.url).pathname },
    models: { type: "string", default: ".models" },
    check: { type: "boolean", default: false },
    "write-baseline": { type: "string" },
    repeats: { type: "string", default: "3" },
  },
});

const directory = pathToFileURL(`${resolve(args.data)}/`);
const dataset = await loadDataset(directory);
const assets = JSON.parse(await readFile(new URL("assets.json", directory), "utf8")) as KnownAsset[];
const manifest = await loadManifest();
const embedder = await OnnxEmbedder.load(
  manifest,
  await ensureModel(manifest, args.models, { download: true }),
);

const report = await evaluate(dataset, {
  embedder,
  assets,
  modelLabel: `${manifest.id}@${manifest.revision}`,
  repeats: Number(args.repeats),
});
print(report);

await mkdir(new URL("../results/", import.meta.url), { recursive: true });
await writeFile(new URL("../results/report.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);

const tag = args["write-baseline"];
if (tag !== undefined) {
  await writeFile(
    new URL("baseline.json", directory),
    `${JSON.stringify(baselineOf(report, tag), null, 2)}\n`,
  );
  await writeFile(new URL("report.json", directory), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nbaseline ${tag} written to ${directory.pathname}baseline.json`);
}

if (args.check) {
  const committed = await readFile(new URL("baseline.json", directory), "utf8");
  const baseline = JSON.parse(committed) as Baseline;
  const failures = [
    ...baselineIntegrity(committed, baseline.tag, taggedBaseline(baseline.tag)),
    ...gate(report, baseline),
  ];
  if (failures.length > 0) {
    console.error(`\nsearch gate FAILED against baseline ${baseline.tag}:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\nsearch gate passed against baseline ${baseline.tag}`);
}

/** baseline.json as recorded at `tag`, or undefined when the tag or the file there is missing. */
function taggedBaseline(tag: string): string | undefined {
  if (!BASELINE_TAG.test(tag)) return undefined;
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const path = relative(root, fileURLToPath(new URL("baseline.json", directory)))
    .split(sep)
    .join("/");
  try {
    return execFileSync("git", ["show", `refs/tags/${tag}:${path}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

function print(result: Report): void {
  const d = result.dataset;
  console.log(
    `dataset ${d.version} (${d.hash.slice(0, 12)}): ${String(d.listings)} listings ` +
      `(${String(d.public)} public, ${String(d.sample)} sample), ${String(d.queries)} queries ` +
      `(${String(d.noAnswerQueries)} without an answer)`,
  );
  console.log(
    `model ${result.model}; ${result.environment.cpu}, ${String(result.environment.cores)} cores, node ${result.environment.node}\n`,
  );
  const rows: [string, string, string, string, string, string, string][] = [
    ["mode", "split", "MRR", "nDCG@10", "Recall@20", "P@1", "queries"],
  ];
  for (const mode of ["lexical", "hybrid"] as const) {
    for (const split of ["dev", "test", "all"] as const) {
      const a = result.modes[mode].splits[split];
      rows.push([
        mode,
        split,
        f(a.mrr),
        f(a.ndcgAt10),
        f(a.recallAt20),
        f(a.precisionAt1),
        String(a.queries),
      ]);
    }
  }
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  for (const row of rows) console.log(row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  "));

  const hybrid = result.modes.hybrid;
  console.log(
    `\ntest 95% CI (hybrid): nDCG@10 [${f(hybrid.intervals.ndcgAt10[0])}, ${f(hybrid.intervals.ndcgAt10[1])}], ` +
      `Recall@20 [${f(hybrid.intervals.recallAt20[0])}, ${f(hybrid.intervals.recallAt20[1])}]`,
  );
  for (const [metric, { delta, pValue }] of Object.entries(result.comparison)) {
    console.log(
      `hybrid − BM25 on test ${metric}: ${delta >= 0 ? "+" : ""}${f(delta)} (paired randomization p = ${pValue.toFixed(4)})`,
    );
  }
  for (const mode of ["lexical", "hybrid"] as const) {
    const l = result.modes[mode].latencyMs;
    console.log(`${mode} latency: p50 ${String(l.p50)} ms, p95 ${String(l.p95)} ms, p99 ${String(l.p99)} ms`);
  }
  const v = result.filters;
  console.log(
    `filters: ${String(v.checkedResults)} results of ${String(v.checkedQueries)} constrained queries checked; violations ${JSON.stringify(v.violations)}`,
  );
  const conformance = result.filterConformance;
  console.log(
    `filter conformance (${String(conformance.listings)} listings, ${String(conformance.queries)} queries, ${conformance.modes.join(" + ")}): ` +
      Object.entries(conformance.byFilter)
        .map(
          ([name, t]) =>
            `${name} ${String(t.results)} results, ${String(t.violations)} violations, ${String(t.missed)} missed`,
        )
        .join("; "),
  );
  const c = result.constraints;
  const recovered = Object.entries(c.extraction)
    .map(
      ([name, e]) => `${name} ${String(e.recovered)}/${String(e.labelled)} (+${String(e.spurious)} spurious)`,
    )
    .join(", ");
  console.log(
    `labelled constraints (${String(c.queries)} queries): recovered ${recovered}; ` +
      `${String(c.resultsUnmet)} of ${String(c.resultsChecked)} hybrid results miss what was asked`,
  );
}

function f(value: number): string {
  return value.toFixed(3);
}
