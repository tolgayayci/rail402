/**
 * Brings the listings of a public Rail402 catalog into the evaluation.
 *
 *   node --conditions=@rail402/source tools/search-eval/src/build/public.ts --capture <facilitator URL>
 *   node --conditions=@rail402/source tools/search-eval/src/build/public.ts --amend
 *
 * `--capture` reads the facilitator's public catalog, GET /discovery/resources page by page with no
 * key, and keeps the raw pages with the capture time and the facilitator's version in
 * construction/public/capture.json.
 *
 * `--amend` turns every captured resource into a corpus listing (`"source": "public"`, with its
 * provenance), one per type, resource and method or tool name: a tool that several owners declared
 * keeps its most trusted listing. To keep the corpus at its size it drops as many sample listings as
 * it adds: those no judge found relevant to any query, and among them the ones the pooled systems
 * returned least. Public listings are judged against every query, so each joins every pool, and the
 * dropped listings leave them. It then writes the packets and assignments for both judge sets.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { BazaarDescriptor, ListingContent, PaymentOption } from "@rail402.dev/bazaar";
import type { CorpusEntry, EvalQuery } from "../dataset.ts";
import { shuffled } from "./corpus.ts";
import { JUDGE_SETS, renderListing, type Pool } from "./pool.ts";

/** Public judges per set; each takes half of the queries. */
const PUBLIC_JUDGES = 2;
const TRUST_ORDER = ["settled", "origin_verified", "domain_verified"];

interface CapturedItem {
  readonly resource: string;
  readonly type: "http" | "mcp";
  readonly accepts: readonly PaymentOption[];
  readonly description?: string;
  readonly mimeType?: string;
  readonly serviceName?: string;
  readonly tags?: readonly string[];
  readonly iconUrl?: string;
  readonly extensions: Readonly<Record<string, unknown>> & { readonly bazaar: BazaarDescriptor };
  readonly rail402: {
    readonly method?: string;
    readonly toolName?: string;
    readonly trust: string;
    readonly listings?: readonly { readonly id: string; readonly firstCataloged: string }[];
  };
}

export interface Capture {
  readonly catalog: string;
  readonly retrievedAt: string;
  readonly facilitatorVersion: string;
  /** SHA-256 of each raw page body, in order. */
  readonly pages: readonly string[];
  readonly items: readonly CapturedItem[];
}

/** One corpus listing per resource: the most trusted of those declaring the same resource. */
export function publicListings(capture: Capture): ListingContent[] {
  const best = new Map<string, CapturedItem>();
  for (const item of capture.items) {
    const key = [item.type, item.resource, item.rail402.method ?? "", item.rail402.toolName ?? ""].join(" ");
    const kept = best.get(key);
    if (
      kept === undefined ||
      TRUST_ORDER.indexOf(item.rail402.trust) > TRUST_ORDER.indexOf(kept.rail402.trust)
    ) {
      best.set(key, item);
    }
  }
  return [...best.values()]
    .sort(
      (a, b) =>
        a.resource.localeCompare(b.resource) ||
        (a.rail402.toolName ?? "").localeCompare(b.rail402.toolName ?? ""),
    )
    .map((item) => {
      const declared = Object.keys(item.extensions)
        .filter((key) => key !== "bazaar")
        .sort();
      return {
        resource: item.resource,
        kind: item.type,
        ...(item.rail402.method === undefined ? {} : { method: item.rail402.method }),
        ...(item.rail402.toolName === undefined ? {} : { toolName: item.rail402.toolName }),
        ...(item.description === undefined ? {} : { description: item.description }),
        ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
        ...(item.serviceName === undefined ? {} : { serviceName: item.serviceName }),
        ...(item.tags === undefined ? {} : { tags: item.tags }),
        ...(item.iconUrl === undefined ? {} : { iconUrl: item.iconUrl }),
        ...(declared.length === 0 ? {} : { extensions: declared }),
        bazaar: item.extensions.bazaar,
        accepts: item.accepts,
      };
    });
}

/**
 * The `count` sample listings whose removal changes the judged dataset least: never graded above 0,
 * and returned by the fewest pooled systems.
 */
export function leastUsedSamples(
  corpus: readonly CorpusEntry[],
  grades: ReadonlyMap<string, number>,
  pools: readonly Pool[],
  count: number,
): string[] {
  const appearances = new Map<string, number>();
  for (const pool of pools) {
    for (const ranking of Object.values(pool.systems)) {
      for (const id of ranking) appearances.set(id, (appearances.get(id) ?? 0) + 1);
    }
  }
  return corpus
    .filter((entry) => entry.source === "sample" && (grades.get(entry.id) ?? 0) === 0)
    .sort((a, b) => (appearances.get(a.id) ?? 0) - (appearances.get(b.id) ?? 0) || a.id.localeCompare(b.id))
    .slice(0, count)
    .map((entry) => entry.id);
}

async function capture(from: string, out: string): Promise<void> {
  const base = from.replace(/\/+$/, "");
  const health = (await (await fetch(`${base}/health`)).json()) as { version?: string };
  const pages: string[] = [];
  const items: CapturedItem[] = [];
  let asOf: string | undefined;
  for (let offset = 0; ; offset += 100) {
    const query = `limit=100&offset=${String(offset)}${asOf === undefined ? "" : `&asOf=${encodeURIComponent(asOf)}`}`;
    const response = await fetch(`${base}/discovery/resources?${query}`);
    if (response.status !== 200)
      throw new Error(`GET /discovery/resources answered ${String(response.status)}`);
    const body = await response.text();
    pages.push(createHash("sha256").update(body).digest("hex"));
    const page = JSON.parse(body) as { items: CapturedItem[]; pagination: { total: number; asOf: string } };
    asOf ??= page.pagination.asOf;
    items.push(...page.items);
    if (offset + 100 >= page.pagination.total) break;
  }
  const result: Capture = {
    catalog: `${base}/discovery/resources`,
    retrievedAt: asOf,
    facilitatorVersion: health.version ?? "unknown",
    pages,
    items,
  };
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "capture.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${String(items.length)} resources captured from ${result.catalog} at ${result.retrievedAt}`);
}

async function amend(root: string): Promise<void> {
  const data = join(root, "data");
  const construction = join(root, "construction");
  const lines = async <T>(path: string) =>
    (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as T);
  const captured = JSON.parse(
    await readFile(join(construction, "public", "capture.json"), "utf8"),
  ) as Capture;
  const corpus = await lines<CorpusEntry>(join(data, "corpus.jsonl"));
  const queries = await lines<EvalQuery>(join(data, "queries.jsonl"));
  const pools = await lines<Pool>(join(construction, "pools.jsonl"));
  const grades = new Map<string, number>();
  for (const judgment of await lines<{ listing: string; grade: number }>(join(data, "judgments.jsonl"))) {
    grades.set(judgment.listing, Math.max(grades.get(judgment.listing) ?? 0, judgment.grade));
  }

  const listings = publicListings(captured);
  const kept = corpus.filter((entry) => entry.source === "sample");
  const dropped = new Set(leastUsedSamples(kept, grades, pools, listings.length));
  const added: CorpusEntry[] = listings.map((listing, index) => ({
    id: `P${String(index + 1).padStart(3, "0")}`,
    source: "public",
    provenance: { catalog: captured.catalog, retrievedAt: captured.retrievedAt },
    listing,
  }));
  const next = [...added, ...kept.filter((entry) => !dropped.has(entry.id))];
  await writeFile(join(data, "corpus.jsonl"), next.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const publicIds = added.map((entry) => entry.id);
  const amended = pools.map((pool) => ({
    ...pool,
    pool: [...pool.pool.filter((id) => !dropped.has(id)), ...publicIds],
  }));
  await writeFile(
    join(construction, "pools.jsonl"),
    amended.map((pool) => JSON.stringify(pool)).join("\n") + "\n",
  );

  const byId = new Map(added.map((entry) => [entry.id, entry.listing]));
  for (const set of JUDGE_SETS) {
    const directory = join(construction, "judging", set);
    await mkdir(join(directory, "packets-public"), { recursive: true });
    for (const query of queries) {
      const order = shuffled(publicIds, seedOf(`public:${set}:${query.id}`));
      const body = [
        `# ${query.id}`,
        "",
        `Query: ${JSON.stringify(query.text)}`,
        "",
        `Candidates: ${String(order.length)}`,
        "",
        ...order.map((id) => `${renderListing(id, byId.get(id) as ListingContent)}\n`),
      ].join("\n");
      await writeFile(join(directory, "packets-public", `${query.id}.md`), body);
    }
    const assigned = shuffled(
      queries.map((query) => query.id),
      seedOf(`public-assign:${set}`),
    );
    for (let judge = 0; judge < PUBLIC_JUDGES; judge++) {
      const mine = assigned.filter((_, index) => index % PUBLIC_JUDGES === judge).sort();
      await writeFile(join(directory, `judge-p${String(judge + 1)}.txt`), `${mine.join("\n")}\n`);
    }
  }
  console.log(
    `added ${publicIds.join(", ")}; dropped ${[...dropped].sort().join(", ")}; corpus ${String(next.length)}; ` +
      `packets for ${String(queries.length)} queries in each judge set`,
  );
}

function seedOf(label: string): number {
  return Number.parseInt(createHash("sha256").update(label).digest("hex").slice(0, 8), 16);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      capture: { type: "string" },
      amend: { type: "boolean", default: false },
      root: { type: "string", default: new URL("../../", import.meta.url).pathname },
    },
  });
  const root = resolve(values.root);
  if (values.capture !== undefined) await capture(values.capture, join(root, "construction", "public"));
  else if (values.amend) await amend(root);
  else throw new Error("pass --capture <facilitator URL> or --amend");
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) await main();
