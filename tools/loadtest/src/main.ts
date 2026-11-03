/**
 * Load test of Rail402 discovery. See tools/loadtest/README.md for the staging stack and the exact
 * commands. Run it against a local staging service only.
 *
 *   node --conditions=@rail402/source tools/loadtest/src/main.ts --url http://127.0.0.1:8090 \
 *     --state warm|uncached|cold-index --rate 50 --duration 120 [--warmup 30] [--mix search|list|mixed]
 *     [--seed postgres://…/rail402_loadtest --catalog A|B] [--store postgres://…/rail402_loadtest]
 *     [--bump-seconds 10] [--probe /health]
 *     [--probe-rate 5] [--config-env staging.env] [--cpus 2] [--memory 3g] [--out <dir>]
 *     [--settle <facilitator url> --settle-setup <file> [--settle-rate 1]] [--concurrency <clients>]
 *
 * `--settle` adds the settle probe (src/settle.ts): real payments settled through that facilitator on the
 * local private network during the run, labelled `settle`. `--rate 0` runs the probe alone.
 * `--concurrency <n>` replaces the open loop with a closed loop of n clients (src/driver.ts), for a
 * throughput curve; `--rate` is then ignored.
 */
import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Listing } from "@rail402.dev/bazaar";
import { PostgresCatalogStore, createDatabase, migrate } from "@rail402.dev/store-postgres";
import { corpusUuid, seedCatalog, toListing, type Dataset } from "@rail402.dev/search-eval";
import { catalogA, catalogB, datasetHashes, evalQueries, uncachedQuery } from "./datasets.ts";
import { runClosedLoop, runOpenLoop, type Planned, type Sample } from "./driver.ts";
import { runSettleProbe, type SettleSetup } from "./settle.ts";
import { publicEnv, recordedArgs } from "./env.ts";
import { summarize } from "./summary.ts";

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    state: { type: "string", default: "warm" },
    mix: { type: "string", default: "search" },
    rate: { type: "string", default: "25" },
    duration: { type: "string", default: "120" },
    warmup: { type: "string", default: "30" },
    seed: { type: "string" },
    store: { type: "string" },
    catalog: { type: "string", default: "A" },
    "bump-seconds": { type: "string", default: "10" },
    probe: { type: "string" },
    "probe-rate": { type: "string", default: "5" },
    settle: { type: "string" },
    "settle-setup": { type: "string" },
    "settle-rate": { type: "string", default: "1" },
    "config-env": { type: "string" },
    cpus: { type: "string" },
    memory: { type: "string" },
    out: { type: "string" },
    concurrency: { type: "string" },
  },
});

const STATES = ["warm", "uncached", "cold-index"] as const;
const MIXES = ["search", "list", "mixed"] as const;
type State = (typeof STATES)[number];
const state = args.state as State;
const mix = args.mix as (typeof MIXES)[number];
if (args.url === undefined || !STATES.includes(state) || !MIXES.includes(mix)) {
  console.error(
    "usage: --url <staging service> --state warm|uncached|cold-index [--mix search|list|mixed] …",
  );
  process.exit(2);
}
if (state === "cold-index" && args.seed === undefined && args.store === undefined) {
  console.error(
    "--state cold-index changes the catalog during the run and needs --seed or --store <staging database>",
  );
  process.exit(2);
}
if (args.settle !== undefined && args["settle-setup"] === undefined) {
  console.error("--settle needs --settle-setup <file> from src/settle-setup.ts");
  process.exit(2);
}
const settleSetup =
  args["settle-setup"] === undefined
    ? undefined
    : (JSON.parse(await readFile(args["settle-setup"], "utf8")) as SettleSetup);
const base = args.url.replace(/\/$/, "");
const rate = Number(args.rate);
const concurrency = args.concurrency === undefined ? undefined : Number(args.concurrency);
if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency >= 1)) {
  console.error("--concurrency must be a whole number of clients, 1 or more");
  process.exit(2);
}
const durationMs = Number(args.duration) * 1_000;
const warmupMs = Number(args.warmup) * 1_000;
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const out = resolve(
  args.out ??
    join(
      fileURLToPath(new URL("../results/", import.meta.url)),
      `${runId}-${state}-${mix}-${concurrency === undefined ? `${args.rate}rps` : `c${String(concurrency)}`}`,
    ),
);
await mkdir(out, { recursive: true });

// --- the staging catalog --------------------------------------------------------------------------
let store: PostgresCatalogStore | undefined;
let closeDb: (() => Promise<void>) | undefined;
// --store opens an already seeded staging catalog, for --state cold-index to add listings to.
const database = args.seed ?? args.store;
if (database !== undefined) {
  const name = new URL(database).pathname.replace(/^\//, "");
  if (!/(eval|staging|loadtest)/i.test(name)) {
    console.error(
      `refusing to use database "${name}": its name must contain "loadtest", "staging" or "eval"`,
    );
    process.exit(2);
  }
  const db = createDatabase({ connectionString: database, maxConnections: 2 });
  closeDb = () => db.destroy();
  await migrate(db);
  store = new PostgresCatalogStore(db);
}
if (args.seed !== undefined && store !== undefined) {
  const corpus = args.catalog === "B" ? await catalogB() : await catalogA();
  const inserted = await seedCatalog(store, { corpus } as unknown as Dataset);
  console.log(
    `catalog ${args.catalog}: ${String(corpus.length)} listings (${String(inserted)} inserted now)`,
  );
  await waitForRevision(await store.revision());
}

async function waitForRevision(revision: number): Promise<void> {
  const deadline = Date.now() + 300_000;
  for (;;) {
    const response = await fetch(`${base}/discovery/search?query=weather&limit=1`).catch(() => undefined);
    const body =
      response?.status === 200 ? ((await response.json()) as { rail402?: { revision?: number } }) : undefined;
    if ((body?.rail402?.revision ?? -1) >= revision) return;
    if (Date.now() > deadline) throw new Error("the service did not index the catalog in time");
    await sleep(1_000);
  }
}

// --- what each request asks -----------------------------------------------------------------------
const queries = await evalQueries();
const salt = runId.replace(/[^0-9]/g, "").slice(-10);
const searchPath = (query: string) => `/discovery/search?query=${encodeURIComponent(query)}&limit=10`;
const plan = (index: number, phase: "warmup" | "run"): Planned => {
  if (mix === "list" || (mix === "mixed" && index % 5 === 4)) {
    return { path: `/discovery/resources?limit=20&offset=${String((index * 20) % 500)}`, label: "list" };
  }
  if (state === "uncached") {
    return {
      path: searchPath(uncachedQuery(index, `${phase === "warmup" ? "w" : "r"}${salt}`)),
      label: "uncached",
    };
  }
  return { path: searchPath(queries[index % queries.length] ?? "weather"), label: state };
};

const samples: Sample[] = [];
const ndjson = createWriteStream(join(out, "requests.ndjson"));
let highestRevision = -1;
const record = (sample: Sample) => {
  let labelled = sample;
  if (state === "cold-index" && sample.label === "cold-index" && sample.revision !== undefined) {
    // The first answer at a new revision includes that revision's index build.
    if (sample.revision > highestRevision) highestRevision = sample.revision;
    else labelled = { ...sample, label: "warm-index" };
  }
  samples.push(labelled);
  ndjson.write(`${JSON.stringify(labelled)}\n`);
};

// --- warm-up (not recorded) -----------------------------------------------------------------------
if (state === "warm" || state === "cold-index") {
  for (const query of queries) await fetch(`${base}${searchPath(query)}`).then((r) => r.text());
}
if (warmupMs > 0) {
  const warmup = {
    base,
    durationMs: warmupMs,
    next: (i: number) => plan(i, "warmup"),
    onSample: () => undefined,
  };
  await (concurrency === undefined
    ? runOpenLoop({ ...warmup, rate })
    : runClosedLoop({ ...warmup, concurrency }));
}
if (state === "cold-index") {
  const response = await fetch(`${base}${searchPath("weather")}`);
  highestRevision = ((await response.json()) as { rail402: { revision: number } }).rail402.revision;
}

// --- the run --------------------------------------------------------------------------------------
let bumps = 0;
const bumper =
  state === "cold-index" && store !== undefined
    ? setInterval(
        () => {
          void bump();
        },
        Number(args["bump-seconds"]) * 1_000,
      )
    : undefined;
async function bump(): Promise<void> {
  if (store === undefined) return;
  const [template] = await catalogA();
  if (template === undefined) return;
  bumps++;
  const id = `bump-${salt}-${String(bumps)}`;
  const listing: Listing = {
    ...toListing(
      {
        ...template,
        id,
        listing: { ...template.listing, resource: `https://bump${String(bumps)}.loadtest.example/${salt}` },
      },
      0,
    ),
    id: corpusUuid(id),
    listedAt: new Date(),
  };
  await store.transaction(listing.identity, (tx) =>
    tx.insert(listing, {
      listingId: listing.id,
      version: 1,
      createdAt: new Date(),
      cause: "settlement",
      owner: listing.owner,
      trust: listing.trust,
      state: listing.state,
      content: listing.content,
    }),
  );
}

const started = new Date().toISOString();
const main = { base, durationMs, next: (i: number) => plan(i, "run"), onSample: record };
const runs: Promise<unknown>[] = [
  concurrency === undefined ? runOpenLoop({ ...main, rate }) : runClosedLoop({ ...main, concurrency }),
];
if (args.probe !== undefined) {
  const probe = args.probe;
  runs.push(
    runOpenLoop({
      base,
      rate: Number(args["probe-rate"]),
      durationMs,
      next: () => ({ path: probe, label: "probe" }),
      onSample: record,
    }),
  );
}
let settled: { sent: number; failed: number } | undefined;
if (args.settle !== undefined && settleSetup !== undefined) {
  const facilitator = args.settle;
  runs.push(
    runSettleProbe({
      facilitator,
      setup: settleSetup,
      rate: Number(args["settle-rate"]),
      durationMs,
      onSample: record,
    }).then((result) => {
      settled = result;
    }),
  );
}
const [result] = (await Promise.all(runs)) as [
  { sent: number; saturated: number } | { sent: number; throughputPerSecond: number },
];
if (bumper !== undefined) clearInterval(bumper);
await new Promise((done) => ndjson.end(done));

// --- outputs --------------------------------------------------------------------------------------
const summary = {
  state,
  mix,
  ...(concurrency === undefined ? { loop: "open", rate } : { loop: "closed", concurrency }),
  durationSeconds: durationMs / 1_000,
  ...result,
  ...(settled === undefined ? {} : { settle: { ...settled, rate: Number(args["settle-rate"]) } }),
  labels: summarize(samples),
};
await writeFile(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
const health = await fetch(`${base}/health`)
  .then((r) => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : undefined))
  .catch(() => undefined);
const config = {
  started,
  args: recordedArgs(args, gitRoot()),
  git: git(),
  node: process.version,
  host: { cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, memoryBytes: totalmem() },
  limits: { cpus: args.cpus ?? null, memory: args.memory ?? null },
  datasets: await datasetHashes(),
  catalog: args.seed === undefined ? null : args.catalog,
  bumps,
  settle:
    settleSetup === undefined
      ? null
      : {
          facilitator: args.settle ?? null,
          rpc: settleSetup.rpcUrl,
          asset: settleSetup.asset,
          payers: settleSetup.payers.length,
          amount: settleSetup.amount,
        },
  service: {
    version: health?.["version"] ?? null,
    ranker: (health?.["search"] as { ranker?: unknown } | undefined)?.ranker ?? null,
  },
  env: args["config-env"] === undefined ? null : publicEnv(await readFile(args["config-env"], "utf8")),
  httpCache: "none at the origin: discovery responses carry no Cache-Control",
};
await writeFile(join(out, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
await closeDb?.();
console.log(JSON.stringify(summary.labels, null, 2));
console.log(`results in ${out}`);

function gitRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

function git(): { commit: string | null; dirty: boolean | null } {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}
