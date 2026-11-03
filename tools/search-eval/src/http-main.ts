/**
 * Scores a running Rail402 service's search on the frozen evaluation, over HTTP.
 *
 *   node --conditions=@rail402/source tools/search-eval/src/http-main.ts --print-env
 *       the settings a staging service needs on top of the production configuration: the corpus's
 *       assets, no rate limits, and the catalog settings that keep the synthetic listings published
 *   node --conditions=@rail402/source tools/search-eval/src/http-main.ts \
 *       --seed postgres://…/rail402_eval --url http://127.0.0.1:8090 [--out <file>]
 *       seed the corpus into the staging database (through the store; an empty database whose name
 *       contains "eval" or "staging" only), wait for the service to index it, run every query and
 *       apply the parity gate (non-zero exit on failure)
 *
 * Run it against a staging service only, started with the production image and configuration plus the
 * --print-env settings. The baseline knows the corpus's assets on both networks, so the service must
 * serve both: a testnet-only service cannot price or match the pubnet options, and scores below it.
 * Never point --seed at a live database.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import type { KnownAsset } from "@rail402.dev/search";
import { PostgresCatalogStore, createDatabase, migrate } from "@rail402.dev/store-postgres";
import { loadDataset } from "./dataset.ts";
import type { Baseline } from "./gate.ts";
import { evaluateOverHttp, httpGate, seedCatalog } from "./http.ts";

const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: new URL("../data/", import.meta.url).pathname },
    url: { type: "string" },
    seed: { type: "string" },
    out: { type: "string" },
    "wait-seconds": { type: "string", default: "180" },
    "print-env": { type: "boolean", default: false },
  },
});

const directory = pathToFileURL(`${resolve(args.data)}/`);
const assets = JSON.parse(await readFile(new URL("assets.json", directory), "utf8")) as KnownAsset[];

if (args["print-env"]) {
  for (const [prefix, network] of [
    ["TESTNET", "stellar:testnet"],
    ["PUBNET", "stellar:pubnet"],
  ] as const) {
    const known = assets.filter((asset) => asset.network === network);
    // Pubnet requires a minimum amount on every asset: one base unit.
    const minimum = network === "stellar:pubnet" ? ":1" : "";
    console.log(
      `${prefix}_ASSETS=${known.map((a) => `${a.contract}:${a.symbol}:${String(a.decimals)}${minimum}`).join(",")}`,
    );
    console.log(
      `${prefix}_BAZAAR_USD_ASSETS=${known
        .filter((a) => a.usd)
        .map((a) => a.contract)
        .join(",")}`,
    );
  }
  console.log("RATE_LIMIT_PER_MINUTE=0\nSEARCH_RATE_LIMIT_PER_MINUTE=0");
  // The sample listings are on reserved .example hosts, which an origin check finds unreachable and
  // quarantines within seconds, and carry past settlement dates, after which an unconfirmed listing
  // expires: check origins as rarely as allowed and keep unconfirmed listings for ten years.
  console.log("ORIGIN_CHECK_INTERVAL_MS=3600000");
  console.log("TESTNET_BAZAAR_UNVERIFIED_TTL_HOURS=87600\nPUBNET_BAZAAR_UNVERIFIED_TTL_HOURS=87600");
  process.exit(0);
}

if (args.url === undefined) {
  console.error("--url is required (the staging service, e.g. http://127.0.0.1:8090)");
  process.exit(2);
}
const base = args.url.replace(/\/$/, "");
const dataset = await loadDataset(directory);
const get = (path: string) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });

if (args.seed !== undefined) {
  const name = new URL(args.seed).pathname.replace(/^\//, "");
  if (!/(eval|staging)/i.test(name)) {
    console.error(`refusing to seed database "${name}": its name must contain "eval" or "staging"`);
    process.exit(2);
  }
  const db = createDatabase({ connectionString: args.seed, maxConnections: 2 });
  try {
    await migrate(db);
    const store = new PostgresCatalogStore(db);
    const inserted = await seedCatalog(store, dataset);
    const revision = await store.revision();
    console.log(`seeded ${String(inserted)} listings (catalog revision ${String(revision)})`);
    // The service indexes catalog changes in the background; wait until its searches see this revision.
    const deadline = Date.now() + Number(args["wait-seconds"]) * 1_000;
    for (;;) {
      const response = await get("/discovery/search?query=weather&limit=1").catch(() => undefined);
      const body =
        response?.status === 200
          ? ((await response.json()) as { rail402?: { revision?: number } })
          : undefined;
      if ((body?.rail402?.revision ?? -1) >= revision) break;
      if (Date.now() > deadline) throw new Error("the service did not index the seeded catalog in time");
      await sleep(1_000);
    }
  } finally {
    await db.destroy();
  }
}

const report = await evaluateOverHttp({ get, dataset, assets });
const baseline = JSON.parse(await readFile(new URL("baseline.json", directory), "utf8")) as Baseline;
const failures = httpGate(report, baseline);
const evidence = { url: base, baseline: baseline.tag, report, failures, passed: failures.length === 0 };
console.log(JSON.stringify(evidence, null, 2));
if (args.out !== undefined) {
  await mkdir(dirname(resolve(args.out)), { recursive: true });
  await writeFile(resolve(args.out), `${JSON.stringify(evidence, null, 2)}\n`);
}
if (failures.length > 0) {
  console.error(`\nsearch parity FAILED against ${baseline.tag}:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nsearch parity passed against ${baseline.tag}`);
