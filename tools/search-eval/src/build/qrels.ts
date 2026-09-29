/**
 * Turns the two blind judge sets into graded relevance judgments.
 *
 *   node --conditions=@rail402/source tools/search-eval/src/build/qrels.ts --check <set> <judge>
 *   node --conditions=@rail402/source tools/search-eval/src/build/qrels.ts --adjudication
 *   node --conditions=@rail402/source tools/search-eval/src/build/qrels.ts --assemble --version <v>
 *
 * Rules: both sets judge every pooled pair; equal grades stand; grades one apart take the lower
 * (conservative); grades two or more apart go to an adjudicator, who sees both grades and notes
 * without knowing which set gave which. A listing that breaks a hand-labelled constraint of the query
 * is graded 0 by code, whatever the judges said: constraint relevance is not a matter of opinion.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ListingContent } from "@rail402.dev/bazaar";
import { unmetConstraints, type EvalAsset } from "../constraints.ts";
import type { CorpusEntry, EvalQuery, Manifest } from "../dataset.ts";
import { shuffled } from "./corpus.ts";
import { JUDGE_SETS, renderListing, type Pool } from "./pool.ts";

interface Judgment {
  readonly query: string;
  readonly listing: string;
  readonly grade: number;
  readonly note?: string;
}

export interface FinalJudgment {
  readonly query: string;
  readonly listing: string;
  readonly a: number;
  readonly b: number;
  readonly adjudicated?: number;
  readonly grade: number;
  /** Set when a labelled constraint forced the grade to 0. */
  readonly override?: "constraint";
}

/** Final grade from two judges and an optional adjudication, per the rules above. */
export function combine(a: number, b: number, adjudicated: number | undefined): number | undefined {
  if (a === b) return a;
  if (Math.abs(a - b) === 1) return Math.min(a, b);
  return adjudicated;
}

/** Cohen's kappa over paired labels; weighted quadratically when `quadratic` is set. */
export function kappa(
  pairs: readonly (readonly [number, number])[],
  categories: number,
  quadratic: boolean,
): number {
  const n = pairs.length;
  if (n === 0) return Number.NaN;
  const weight = (i: number, j: number) =>
    quadratic ? ((i - j) * (i - j)) / ((categories - 1) * (categories - 1)) : i === j ? 0 : 1;
  const rows = new Array<number>(categories).fill(0);
  const columns = new Array<number>(categories).fill(0);
  let observed = 0;
  for (const [i, j] of pairs) {
    rows[i] = (rows[i] ?? 0) + 1;
    columns[j] = (columns[j] ?? 0) + 1;
    observed += weight(i, j);
  }
  let expected = 0;
  for (let i = 0; i < categories; i++) {
    for (let j = 0; j < categories; j++)
      expected += (((rows[i] ?? 0) * (columns[j] ?? 0)) / n) * weight(i, j);
  }
  return expected === 0 ? 1 : 1 - observed / expected;
}

/**
 * Queries whose two judge sets agree on every candidate, grade and note alike, with at least one
 * non-empty note shared. Independent judges converge on grades and on short generic notes, but not
 * on every note of a query: this is the signature of one set's output reaching the other.
 */
export function copiedQueries(
  pools: ReadonlyMap<string, Pool>,
  a: ReadonlyMap<string, Judgment>,
  b: ReadonlyMap<string, Judgment>,
): string[] {
  const copied: string[] = [];
  for (const pool of pools.values()) {
    let shared = 0;
    let identical = true;
    for (const listing of pool.pool) {
      const key = `${pool.query}|${listing}`;
      const x = a.get(key);
      const y = b.get(key);
      const noteX = x?.note?.trim() ?? "";
      const noteY = y?.note?.trim() ?? "";
      if (x?.grade !== y?.grade || noteX !== noteY) identical = false;
      if (noteX !== "" && noteX === noteY) shared++;
    }
    if (identical && shared > 0) copied.push(pool.query);
  }
  return copied;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function judgmentsOf(judging: string, set: string): Promise<Map<string, Judgment>> {
  const directory = join(judging, set, "judgments");
  const files = (await readdir(directory).catch(() => [] as string[])).filter((name) =>
    name.endsWith(".jsonl"),
  );
  const all = new Map<string, Judgment>();
  for (const file of files.sort()) {
    for (const judgment of await readJsonLines<Judgment>(join(directory, file))) {
      all.set(`${judgment.query}|${judgment.listing}`, judgment);
    }
  }
  return all;
}

/** Problems in one judge's file against the packets assigned to it. */
function judgeProblems(
  assigned: readonly string[],
  pools: ReadonlyMap<string, Pool>,
  judgments: readonly Judgment[],
): string[] {
  const problems: string[] = [];
  const expected = new Set(
    assigned.flatMap((query) => (pools.get(query)?.pool ?? []).map((id) => `${query}|${id}`)),
  );
  const seen = new Set<string>();
  for (const judgment of judgments) {
    const key = `${judgment.query}|${judgment.listing}`;
    if (!expected.has(key)) problems.push(`${key} is not in your packets`);
    else if (seen.has(key)) problems.push(`${key} is judged twice`);
    if (!Number.isInteger(judgment.grade) || judgment.grade < 0 || judgment.grade > 3) {
      problems.push(`${key} has grade ${String(judgment.grade)}, not 0-3`);
    }
    seen.add(key);
  }
  const missing = [...expected].filter((key) => !seen.has(key));
  if (missing.length > 0) {
    problems.push(
      `${String(missing.length)} candidates not judged yet, e.g. ${missing.slice(0, 5).join(", ")}`,
    );
  }
  return problems;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string", default: new URL("../../", import.meta.url).pathname },
      check: { type: "boolean", default: false },
      adjudication: { type: "boolean", default: false },
      assemble: { type: "boolean", default: false },
      version: { type: "string" },
    },
  });
  const root = resolve(values.root);
  const data = join(root, "data");
  const judging = join(root, "construction", "judging");
  const pools = new Map(
    (await readJsonLines<Pool>(join(root, "construction", "pools.jsonl"))).map((pool) => [pool.query, pool]),
  );

  if (values.check) {
    const [set = "", judge = ""] = positionals;
    const assigned = (await readFile(join(judging, set, `judge-${judge}.txt`), "utf8"))
      .split("\n")
      .filter(Boolean);
    const judgments = await readJsonLines<Judgment>(join(judging, set, "judgments", `judge-${judge}.jsonl`));
    // Public-listing judges (p1, p2, …) judge only the public listings of their queries.
    const publicIds = (await readJsonLines<CorpusEntry>(join(data, "corpus.jsonl")))
      .filter((entry) => entry.source === "public")
      .map((entry) => entry.id);
    const scope: ReadonlyMap<string, Pool> = judge.startsWith("p")
      ? new Map(assigned.map((query) => [query, { query, pool: publicIds, systems: {} }]))
      : pools;
    const problems = judgeProblems(assigned, scope, judgments);
    if (problems.length > 0) {
      for (const problem of problems.slice(0, 50)) console.error(`  ${problem}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `judge ${set}-${judge}: ${String(judgments.length)} judgments over ${String(assigned.length)} queries, complete`,
    );
    return;
  }

  const a = await judgmentsOf(judging, "a");
  const b = await judgmentsOf(judging, "b");
  const pairs = [...pools.values()].flatMap((pool) => pool.pool.map((listing) => `${pool.query}|${listing}`));
  const missing = JUDGE_SETS.flatMap((set) =>
    pairs.filter((key) => !(set === "a" ? a : b).has(key)).map((key) => `${set}:${key}`),
  );
  if (missing.length > 0) {
    console.error(
      `${String(missing.length)} pairs are not judged by both sets, e.g. ${missing.slice(0, 5).join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const entries = await readJsonLines<CorpusEntry>(join(data, "corpus.jsonl"));
  const corpus = new Map(entries.map((entry) => [entry.id, entry.listing]));
  const queries = new Map(
    (await readJsonLines<EvalQuery>(join(data, "queries.jsonl"))).map((query) => [query.id, query]),
  );
  const disputed = pairs.filter((key) => Math.abs((a.get(key)?.grade ?? 0) - (b.get(key)?.grade ?? 0)) >= 2);
  const copied = copiedQueries(pools, a, b);
  if (copied.length > 0) {
    console.error(`independence audit: ${copied.join(", ")} judged identically by both sets, notes included`);
    process.exitCode = 1;
    return;
  }

  if (values.adjudication) {
    const directory = join(judging, "adjudication");
    await mkdir(directory, { recursive: true });
    const byQuery = new Map<string, string[]>();
    for (const key of disputed) {
      const [query = "", listing = ""] = key.split("|");
      byQuery.set(query, [...(byQuery.get(query) ?? []), listing]);
    }
    const blocks: string[] = [];
    for (const [query, listings] of [...byQuery].sort()) {
      blocks.push(`# ${query}\n\nQuery: ${JSON.stringify(queries.get(query)?.text ?? "")}\n`);
      for (const listing of listings) {
        const key = `${query}|${listing}`;
        // Present the two opinions in a per-pair random order, so the adjudicator cannot tell the sets apart.
        const opinions = shuffled([a.get(key), b.get(key)], Number.parseInt(sha256(key).slice(0, 8), 16));
        blocks.push(renderListing(listing, corpus.get(listing) as ListingContent));
        opinions.forEach((opinion, index) => {
          blocks.push(
            `Judge ${String(index + 1)}: ${String(opinion?.grade)}${opinion?.note ? ` (${opinion.note})` : ""}`,
          );
        });
        blocks.push("");
      }
    }
    await writeFile(join(directory, "packet.md"), blocks.join("\n"));
    console.log(
      `${String(disputed.length)} disputed pairs in ${String(byQuery.size)} queries written to ${directory}/packet.md`,
    );
    return;
  }

  if (!values.assemble) {
    console.error("pass --check, --adjudication or --assemble");
    process.exitCode = 1;
    return;
  }
  if (values.version === undefined) throw new Error("--version is required with --assemble");
  const adjudications = new Map(
    (await readJsonLines<Judgment>(join(judging, "adjudication", "judgments.jsonl"))).map((judgment) => [
      `${judgment.query}|${judgment.listing}`,
      judgment.grade,
    ]),
  );
  const assets = JSON.parse(await readFile(join(data, "assets.json"), "utf8")) as EvalAsset[];
  const finals: FinalJudgment[] = [];
  const unresolved: string[] = [];
  for (const key of pairs) {
    const [query = "", listing = ""] = key.split("|");
    const gradeA = a.get(key)?.grade ?? 0;
    const gradeB = b.get(key)?.grade ?? 0;
    const adjudicated = adjudications.get(key);
    const combined = combine(gradeA, gradeB, adjudicated);
    if (combined === undefined) {
      unresolved.push(key);
      continue;
    }
    const expected = queries.get(query)?.expected;
    const breaks =
      expected !== undefined &&
      unmetConstraints(corpus.get(listing) as ListingContent, expected, assets).length > 0;
    finals.push({
      query,
      listing,
      a: gradeA,
      b: gradeB,
      ...(adjudicated === undefined || Math.abs(gradeA - gradeB) < 2 ? {} : { adjudicated }),
      grade: breaks ? 0 : combined,
      ...(breaks && combined > 0 ? { override: "constraint" as const } : {}),
    });
  }
  if (unresolved.length > 0) {
    console.error(
      `${String(unresolved.length)} disputed pairs lack an adjudication, e.g. ${unresolved.slice(0, 5).join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const graded = finals.map((final) => [final.a, final.b] as const);
  const agreement = {
    pairs: finals.length,
    exact: round(graded.filter(([x, y]) => x === y).length / finals.length),
    withinOne: round(graded.filter(([x, y]) => Math.abs(x - y) <= 1).length / finals.length),
    quadraticWeightedKappa: round(kappa(graded, 4, true)),
    relevantKappa: round(
      kappa(
        graded.map(([x, y]) => [x >= 2 ? 1 : 0, y >= 2 ? 1 : 0] as const),
        2,
        false,
      ),
    ),
    adjudicated: disputed.length,
    constraintOverrides: finals.filter((final) => final.override !== undefined).length,
    copiedQueries: copied.length,
  };

  const qrels =
    finals.map((final) => `${final.query}\t${final.listing}\t${String(final.grade)}`).join("\n") + "\n";
  await writeFile(join(data, "qrels.tsv"), qrels);
  await writeFile(
    join(data, "judgments.jsonl"),
    finals.map((final) => JSON.stringify(final)).join("\n") + "\n",
  );
  const corpusBytes = await readFile(join(data, "corpus.jsonl"));
  const queryBytes = await readFile(join(data, "queries.jsonl"));
  const manifest: Manifest = {
    version: values.version,
    files: {
      corpus: { sha256: sha256(corpusBytes), count: corpus.size },
      queries: { sha256: sha256(queryBytes), count: queries.size },
      qrels: { sha256: sha256(qrels), count: finals.length },
    },
    corpus: {
      public: entries.filter((entry) => entry.source === "public").length,
      sample: entries.filter((entry) => entry.source === "sample").length,
    },
    judging: {
      scale: "0-3",
      method:
        "pooled top results of six systems, and every public listing for every query; two blind judge sets per pair; one grade apart takes the lower, two or more apart is adjudicated; labelled constraints decided by code",
      judges: ["set a", "set b", "adjudicator"],
      agreement,
    },
  };
  await writeFile(join(data, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(agreement));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) await main();
