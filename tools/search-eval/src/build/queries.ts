/**
 * Builds the evaluation queries from query drafts written blind to the corpus.
 *
 *   node tools/search-eval/src/build/queries.ts --check <drafts.jsonl>...   validate drafts only
 *   node tools/search-eval/src/build/queries.ts --drafts <dir> --out <dir> [--typos 12]
 *
 * Typo queries are derived from other queries by seeded character edits. Ids are assigned after a
 * seeded shuffle, and each written class is split evenly into dev and test, so the split is fixed before
 * any tuning and says nothing about who wrote a query. A typo query takes its source query's split.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { SearchFilter } from "@rail402.dev/search";
import type { EvalQuery, ExpectedConstraints, QueryClass } from "../dataset.ts";
import { shuffled } from "./corpus.ts";

const WRITTEN_CLASSES = [
  "intent",
  "paraphrase",
  "keyword",
  "constraint",
  "stellar",
  "mcp",
  "no_answer",
] as const;
const NETWORKS = ["stellar:testnet", "stellar:pubnet"];
const SYMBOLS = ["USDC", "EURC", "XLM"];
const TYPO: QueryClass = "typo";

export interface QueryDraft {
  readonly draft: string;
  readonly text: string;
  readonly class: (typeof WRITTEN_CLASSES)[number];
  readonly targets: readonly string[];
  readonly filter?: SearchFilter;
  readonly expected?: ExpectedConstraints;
}

/** Construction metadata for one query. Used for pooling and analysis, never shown to judges. */
export interface QueryRecord {
  readonly id: string;
  readonly draft: string;
  readonly targets: readonly string[];
  /** For typo queries: the query they were derived from. */
  readonly typoOf?: string;
}

export function queryProblems(value: unknown, capabilities: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const draft = value as Partial<QueryDraft> | null;
  if (draft === null || typeof draft !== "object") return ["not an object"];
  if (typeof draft.draft !== "string" || draft.draft === "") problems.push("draft id missing");
  if (typeof draft.text !== "string" || draft.text.trim() === "" || draft.text.length > 300) {
    problems.push("text must be 1-300 characters");
  }
  if (!WRITTEN_CLASSES.includes(draft.class as (typeof WRITTEN_CLASSES)[number])) {
    problems.push(`class must be one of ${WRITTEN_CLASSES.join(", ")}`);
  }
  if (!Array.isArray(draft.targets)) problems.push("targets must be a list");
  for (const target of draft.targets ?? []) {
    if (!capabilities.has(target)) problems.push(`unknown capability ${target}`);
  }
  if (draft.class === "no_answer" && (draft.targets?.length ?? 0) > 0)
    problems.push("no_answer queries have no targets");
  if (draft.class !== "no_answer" && (draft.targets?.length ?? 0) === 0)
    problems.push("targets must not be empty");
  const filter = draft.filter as Record<string, unknown> | undefined;
  if (filter !== undefined) {
    for (const [key, value] of Object.entries(filter)) {
      if (key === "network" && NETWORKS.includes(String(value))) continue;
      if (key === "type" && (value === "http" || value === "mcp")) continue;
      if (key === "asset" && SYMBOLS.includes(String(value))) continue;
      problems.push(`unsupported filter ${key}=${String(value)}`);
    }
  }
  const expected = draft.expected;
  if (expected !== undefined) {
    if (expected.network !== undefined && !NETWORKS.includes(expected.network))
      problems.push("bad expected.network");
    if (expected.type !== undefined && !new Set<unknown>(["http", "mcp"]).has(expected.type))
      problems.push("bad expected.type");
    if (expected.asset !== undefined && !SYMBOLS.includes(expected.asset))
      problems.push("bad expected.asset");
    if (expected.maxPrice !== undefined) {
      if (!/^\d+(\.\d{1,7})?$/.test(expected.maxPrice.amount)) problems.push("bad expected.maxPrice.amount");
      if (!["USD", ...SYMBOLS].includes(expected.maxPrice.unit)) problems.push("bad expected.maxPrice.unit");
    }
    for (const [key, value] of Object.entries(filter ?? {})) {
      if ((expected as Record<string, unknown>)[key] !== value)
        problems.push(`filter ${key} is missing from expected`);
    }
  } else if (filter !== undefined && Object.keys(filter).length > 0) {
    problems.push("a query with a filter needs expected constraints");
  }
  if (draft.class === "constraint" && (expected === undefined || Object.keys(expected).length === 0)) {
    problems.push("constraint queries need expected constraints");
  }
  return problems;
}

/** One or two seeded character edits (swap, drop or double) in words of five letters or more. */
export function withTypos(text: string, seed: number): string {
  const order = shuffled(
    text
      .split(" ")
      .map((word, index) => ({ word, index }))
      .filter(({ word }) => /^\p{L}{5,}$/u.test(word)),
    seed,
  );
  const words = text.split(" ");
  for (const [n, { word, index }] of order.slice(0, text.length > 30 ? 2 : 1).entries()) {
    const at = 1 + ((seed + n * 7) % (word.length - 2));
    const edit = (seed + n) % 3;
    words[index] =
      edit === 0
        ? word.slice(0, at) + (word[at + 1] ?? "") + (word[at] ?? "") + word.slice(at + 2)
        : edit === 1
          ? word.slice(0, at) + word.slice(at + 1)
          : word.slice(0, at) + (word[at] ?? "") + word.slice(at);
  }
  return words.join(" ");
}

async function capabilityIds(): Promise<Set<string>> {
  const taxonomy = JSON.parse(
    await readFile(new URL("../../construction/taxonomy.json", import.meta.url), "utf8"),
  ) as { categories: { capabilities: [string, string][] }[] };
  return new Set(taxonomy.categories.flatMap((category) => category.capabilities.map(([id]) => id)));
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      check: { type: "boolean", default: false },
      drafts: { type: "string" },
      out: { type: "string" },
      typos: { type: "string", default: "12" },
      seed: { type: "string", default: "202" },
    },
  });
  const capabilities = await capabilityIds();
  const files = values.check
    ? positionals.map((file) => resolve(file))
    : (await readdir(resolve(values.drafts ?? "")))
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .map((name) => join(resolve(values.drafts ?? ""), name));

  const drafts: QueryDraft[] = [];
  const failures: string[] = [];
  const texts = new Map<string, string>();
  for (const file of files) {
    for (const [index, line] of (await readFile(file, "utf8")).split("\n").entries()) {
      if (line.trim() === "") continue;
      const where = `${file}:${String(index + 1)}`;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        failures.push(`${where}: ${(error as Error).message}`);
        continue;
      }
      const problems = queryProblems(value, capabilities);
      if (problems.length > 0) {
        failures.push(`${where}: ${problems.join("; ")}`);
        continue;
      }
      const draft = value as QueryDraft;
      const normalized = draft.text.trim().toLowerCase();
      const duplicate = texts.get(normalized);
      if (duplicate !== undefined) failures.push(`${where}: same text as ${duplicate}`);
      texts.set(normalized, draft.draft);
      drafts.push(draft);
    }
  }
  const counts = new Map<string, number>();
  for (const draft of drafts) counts.set(draft.class, (counts.get(draft.class) ?? 0) + 1);
  console.log(
    `${String(drafts.length)} query drafts: ${[...counts].map(([cls, n]) => `${cls} ${String(n)}`).join(", ")}`,
  );
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  ${failure}`);
    process.exitCode = 1;
    return;
  }
  if (values.check) return;

  const seed = Number(values.seed);
  const written = shuffled(
    [...drafts].sort((a, b) => a.draft.localeCompare(b.draft)),
    seed,
  );
  // Typos are made from answerable queries of the classes people type quickly.
  const sources = written.filter((draft) => ["intent", "keyword", "stellar", "mcp"].includes(draft.class));
  const typoSources = shuffled(sources, seed + 1).slice(0, Number(values.typos));
  const all: { draft: QueryDraft; cls: QueryClass; text: string; typoOf?: QueryDraft }[] = [
    ...written.map((draft) => ({ draft, cls: draft.class, text: draft.text.trim() })),
    ...typoSources.map((draft, index) => ({
      draft: { ...draft, draft: `${draft.draft}-typo` },
      cls: TYPO,
      text: withTypos(draft.text.trim(), seed + index),
      typoOf: draft,
    })),
  ];
  const ordered = shuffled(all, seed + 2);
  const ids = new Map(
    ordered.map((entry, index) => [entry.draft.draft, `Q${String(index + 1).padStart(3, "0")}`]),
  );

  // Even dev/test split within each class, seeded.
  const split = new Map<string, "dev" | "test">();
  for (const cls of new Set(ordered.map((entry) => entry.cls))) {
    const members = shuffled(
      ordered.filter((entry) => entry.cls === cls),
      seed + 3,
    );
    members.forEach((entry, index) => split.set(entry.draft.draft, index % 2 === 0 ? "dev" : "test"));
  }
  // A typo query is its source query misspelled: it goes wherever its source went, so nothing tuned on
  // dev reappears in test.
  for (const { draft, typoOf } of ordered) {
    if (typoOf !== undefined) split.set(draft.draft, split.get(typoOf.draft) ?? "test");
  }

  const queries: EvalQuery[] = ordered.map(({ draft, cls, text }) => ({
    id: ids.get(draft.draft) ?? "",
    text,
    class: cls,
    split: split.get(draft.draft) ?? "test",
    ...(draft.filter === undefined || Object.keys(draft.filter).length === 0 ? {} : { filter: draft.filter }),
    ...(draft.expected === undefined || Object.keys(draft.expected).length === 0
      ? {}
      : { expected: draft.expected }),
  }));
  const records: QueryRecord[] = ordered.map(({ draft, typoOf }) => ({
    id: ids.get(draft.draft) ?? "",
    draft: draft.draft,
    targets: draft.targets,
    ...(typoOf === undefined ? {} : { typoOf: ids.get(typoOf.draft) ?? "" }),
  }));
  const out = resolve(values.out ?? "");
  await writeFile(
    join(out, "queries.jsonl"),
    queries.map((query) => JSON.stringify(query)).join("\n") + "\n",
  );
  await writeFile(
    join(out, "..", "construction", "queries.jsonl"),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  console.log(`${String(queries.length)} queries written to ${out}`);
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) await main();
