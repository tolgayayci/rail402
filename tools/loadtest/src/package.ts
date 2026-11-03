/**
 * Assembles a load-test package from the runs of `package.sh`: each run's summary and configuration as
 * the driver wrote them, its raw requests compressed, and at the top a `summary.json` with p50/p95/p99
 * of every run and label and a `config.json` with the stack (image, limits, settings), the host and the
 * dataset hashes.
 *
 *   node --conditions=@rail402/source tools/loadtest/src/package.ts --raw <runs dir> --stack <stack.json> \
 *     --out tools/loadtest/published/<date>
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { createGzip } from "node:zlib";
import { datasetHashes } from "./datasets.ts";
import { recordedArgs } from "./env.ts";
import type { LabelSummary } from "./summary.ts";

const { values: args } = parseArgs({
  options: {
    raw: { type: "string" },
    stack: { type: "string" },
    out: { type: "string" },
  },
});
if (args.raw === undefined || args.stack === undefined || args.out === undefined) {
  console.error("usage: --raw <runs dir> --stack <stack.json> --out <package dir>");
  process.exit(2);
}
const raw = resolve(args.raw);
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const out = resolve(args.out);
await mkdir(out, { recursive: true });

interface RunSummary {
  readonly state: string;
  readonly mix: string;
  readonly loop: "open" | "closed";
  readonly rate?: number;
  readonly concurrency?: number;
  readonly durationSeconds: number;
  readonly sent: number;
  readonly saturated?: number;
  readonly throughputPerSecond?: number;
  readonly settle?: unknown;
  readonly labels: Record<string, LabelSummary>;
}

const runs: Record<string, unknown> = {};
const commits = new Set<string>();
for (const name of (await readdir(raw)).sort()) {
  const directory = join(raw, name);
  if (!(await stat(directory)).isDirectory()) continue;
  const summary = JSON.parse(await readFile(join(directory, "summary.json"), "utf8")) as RunSummary;
  const recorded = JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as {
    args: Record<string, unknown>;
    git: { commit: string | null };
    catalog: string | null;
  };
  // Never publish a connection string's credentials or a path of the machine that ran it.
  const config = { ...recorded, args: recordedArgs(recorded.args, repoRoot) };
  if (config.git.commit !== null) commits.add(config.git.commit);
  const target = join(out, "runs", name);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(target, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  await pipeline(
    createReadStream(join(directory, "requests.ndjson")),
    createGzip({ level: 9 }),
    createWriteStream(join(target, "requests.ndjson.gz")),
  );
  for (const extra of ["host.json"]) {
    const text = await readFile(join(directory, extra), "utf8").catch(() => undefined);
    if (text !== undefined) await writeFile(join(target, extra), text);
  }
  runs[name] = {
    state: summary.state,
    mix: summary.mix,
    loop: summary.loop,
    ...(summary.loop === "open" ? { rate: summary.rate } : { concurrency: summary.concurrency }),
    durationSeconds: summary.durationSeconds,
    sent: summary.sent,
    ...(summary.throughputPerSecond === undefined
      ? {}
      : { throughputPerSecond: summary.throughputPerSecond }),
    labels: Object.fromEntries(
      Object.entries(summary.labels).map(([label, s]) => [
        label,
        {
          requests: s.requests,
          errors: s.errors,
          errorRate: s.errorRate,
          p50: s.latencyMs.p50,
          p95: s.latencyMs.p95,
          p99: s.latencyMs.p99,
          max: s.latencyMs.max,
          queryEmbeddings: s.queryEmbeddings,
          partial: s.partial,
        },
      ]),
    ),
  };
}

await writeFile(
  join(out, "summary.json"),
  `${JSON.stringify(
    {
      description:
        "p50/p95/p99 latency in milliseconds per run and label, from when each request was due (open loop) or sent (closed loop), over every request sent; runs/<run>/summary.json has the full statistics and runs/<run>/requests.ndjson.gz every request.",
      runs,
    },
    null,
    2,
  )}\n`,
);
const stack = JSON.parse(await readFile(resolve(args.stack), "utf8")) as Record<string, unknown>;
await writeFile(
  join(out, "config.json"),
  `${JSON.stringify(
    {
      ...stack,
      driver: {
        commits: [...commits],
        node: process.version,
        host: { cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, memoryBytes: totalmem() },
      },
      datasets: await datasetHashes(),
      httpCache: "none at the origin: discovery responses carry no Cache-Control",
    },
    null,
    2,
  )}\n`,
);
console.log(`package in ${out}: ${String(Object.keys(runs).length)} runs`);
