import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { parseQuery } from "@rail402.dev/search";
import { catalogA, datasetHashes, expand, uncachedQuery } from "../src/datasets.ts";
import { runClosedLoop, runOpenLoop, type Sample } from "../src/driver.ts";
import { publicEnv, recordedArgs } from "../src/env.ts";
import { runSettleProbe, type SettleSetup } from "../src/settle.ts";
import { percentile, summarize } from "../src/summary.ts";

describe("the open-loop driver", () => {
  it("sends at the scheduled rate however slowly the service answers", async () => {
    const samples: Sample[] = [];
    const sentAt: number[] = [];
    const started = performance.now();
    const result = await runOpenLoop({
      base: "http://service.example",
      rate: 100,
      durationMs: 500,
      next: (index) => ({ path: `/discovery/search?query=q${String(index)}`, label: "warm" }),
      onSample: (sample) => samples.push(sample),
      fetch: async () => {
        sentAt.push(performance.now() - started);
        await new Promise((resolve) => setTimeout(resolve, 200));
        return new Response(
          JSON.stringify({
            partialResults: false,
            rail402: { method: "hybrid", queryEmbedding: "cached", revision: 3 },
          }),
        );
      },
    });
    expect(result).toEqual({ sent: 50, saturated: 0 });
    // A closed loop of one would have sent 3 requests in 500 ms; this one kept the schedule.
    expect(Math.max(...sentAt)).toBeLessThan(700);
    expect(samples).toHaveLength(50);
    // Timers can fire a millisecond early; every latency still includes the 200 ms service time.
    expect(samples.every((sample) => sample.latencyMs >= 195)).toBe(true);
    expect(samples[0]).toMatchObject({
      status: 200,
      method: "hybrid",
      queryEmbedding: "cached",
      revision: 3,
    });
  });

  it("measures latency from when a request was due, so a stall shows in the tail", async () => {
    const samples: Sample[] = [];
    let clock = 0;
    let release: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = runOpenLoop({
      base: "http://service.example",
      rate: 1_000,
      durationMs: 10,
      now: () => clock,
      next: () => ({ path: "/discovery/resources", label: "list" }),
      onSample: (sample) => samples.push(sample),
      fetch: async () => {
        await stalled;
        return new Response("{}");
      },
    });
    // Every request was due within the first 10 ms; the service answers them all at 300 ms.
    await new Promise((resolve) => setTimeout(resolve, 50));
    clock = 300;
    release();
    await done;
    expect(samples).toHaveLength(10);
    expect(Math.min(...samples.map((s) => s.latencyMs))).toBeGreaterThan(290);
    expect(samples.map((s) => s.dueMs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("records requests beyond its in-flight cap as saturated, unsent", async () => {
    const samples: Sample[] = [];
    const result = await runOpenLoop({
      base: "http://service.example",
      rate: 1_000,
      durationMs: 20,
      maxInFlight: 5,
      next: () => ({ path: "/health", label: "probe" }),
      onSample: (sample) => samples.push(sample),
      fetch: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolve(new Response("{}"));
          }, 100),
        ),
    });
    expect(result.sent).toBe(5);
    expect(result.saturated).toBe(15);
    expect(samples.filter((s) => s.error === "client_saturated")).toHaveLength(15);
  });

  it("records a failed request with status 0 and the error", async () => {
    const samples: Sample[] = [];
    await runOpenLoop({
      base: "http://service.example",
      rate: 100,
      durationMs: 10,
      next: () => ({ path: "/health", label: "probe" }),
      onSample: (sample) => samples.push(sample),
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    expect(samples[0]).toMatchObject({ status: 0, error: "TypeError" });
  });
});

describe("the closed-loop driver", () => {
  it("keeps one request in flight per client and reports the throughput", async () => {
    const samples: Sample[] = [];
    let inFlight = 0;
    let most = 0;
    const result = await runClosedLoop({
      base: "http://service.example",
      concurrency: 4,
      durationMs: 300,
      next: (index) => ({ path: `/discovery/search?query=q${String(index)}`, label: "warm" }),
      onSample: (sample) => samples.push(sample),
      fetch: async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 50));
        inFlight--;
        return new Response("{}");
      },
    });
    expect(most).toBe(4);
    // Four clients of 50 ms requests for 300 ms: about 6 rounds each, never more than 7.
    expect(result.sent).toBeGreaterThanOrEqual(20);
    expect(result.sent).toBeLessThanOrEqual(28);
    expect(samples).toHaveLength(result.sent);
    expect(result.throughputPerSecond).toBeGreaterThan(50);
    // Nothing waits to be sent, so a request's latency is its service time.
    expect(samples.every((sample) => sample.latencyMs - sample.serviceMs < 1)).toBe(true);
  });
});

describe("the summary", () => {
  it("reports latency over every request sent, and successes and failures apart", () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 99)).toBe(0);
    const sample = (latencyMs: number, status = 200, extra: Partial<Sample> = {}): Sample => ({
      dueMs: 0,
      label: "uncached",
      path: "/",
      status,
      latencyMs,
      serviceMs: latencyMs,
      ...extra,
    });
    const summary = summarize([
      sample(10, 200, { method: "hybrid", queryEmbedding: "computed" }),
      sample(20, 200, { method: "lexical", queryEmbedding: "saturated", partialResults: true }),
      sample(999, 429),
      // A timeout counts at the time it took; an unsent request in no latency.
      sample(30_000, 0, { error: "TimeoutError" }),
      sample(0, 0, { error: "client_saturated" }),
    ])["uncached"];
    expect(summary).toMatchObject({
      requests: 5,
      errors: 3,
      errorRate: 0.6,
      unsent: 1,
      latencyMs: { count: 4, p50: 20, p95: 30_000, p99: 30_000, max: 30_000, mean: 7_757.25 },
      successLatencyMs: { count: 2, p50: 10, p99: 20, max: 20, mean: 15 },
      errorLatencyMs: { count: 2, p50: 999, max: 30_000 },
      methods: { hybrid: 1, lexical: 1 },
      queryEmbeddings: { computed: 1, saturated: 1 },
      partial: 1,
      statuses: { "200": 2, "429": 1, "0": 2 },
    });
  });

  it("summarizes more samples than a spread argument list can hold", () => {
    const count = 250_000;
    const samples: Sample[] = Array.from({ length: count }, (_, i) => ({
      dueMs: i,
      label: "warm",
      path: "/",
      status: i % 100 === 0 ? 500 : 200,
      latencyMs: (i % 1_000) + 1,
      serviceMs: 1,
    }));
    const summary = summarize(samples)["warm"];
    expect(summary?.requests).toBe(count);
    expect(summary?.latencyMs).toMatchObject({ count, p50: 500, p99: 990, max: 1_000 });
    expect(summary?.errorLatencyMs.count).toBe(count / 100);
    expect(summary?.successLatencyMs.max).toBe(1_000);
  });
});

describe("the settle probe", () => {
  const setup: SettleSetup = {
    rpcUrl: "http://localhost:8000/rpc",
    friendbotUrl: "http://localhost:8000/friendbot",
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    code: "USDC",
    payTo: Keypair.random().publicKey(),
    amount: "10000",
    payers: [Keypair.random().secret()],
  };

  it("signs ahead of time, so signing never counts in a settlement's latency", async () => {
    const samples: Sample[] = [];
    const bodies: unknown[] = [];
    let answered = 0;
    const result = await runSettleProbe({
      facilitator: "http://facilitator.example/",
      setup,
      rate: 10,
      durationMs: 300,
      leadMs: 200,
      pay: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { payload: { transaction: "AAAA" } };
      },
      fetch: async (url, init) => {
        expect(url).toBe("http://facilitator.example/settle");
        bodies.push(JSON.parse(init.body as string));
        await new Promise((resolve) => setTimeout(resolve, 20));
        // The second settlement is answered without success.
        return answered++ === 1
          ? Response.json({ success: false, errorReason: "invalid_exact_stellar_payload_wrong_amount" })
          : Response.json({ success: true, transaction: "ab".repeat(32) });
      },
      onSample: (sample) => samples.push(sample),
    });
    expect(result).toEqual({ sent: 3, failed: 0 });
    expect(bodies[0]).toMatchObject({
      x402Version: 2,
      paymentPayload: { payload: { transaction: "AAAA" } },
      paymentRequirements: { scheme: "exact", asset: setup.asset, payTo: setup.payTo, amount: "10000" },
    });
    // Each settlement takes 20 ms; signing (100 ms) happened before it was due.
    expect(samples.every((sample) => sample.latencyMs < 90)).toBe(true);
    const summary = summarize(samples)["settle"];
    expect(summary).toMatchObject({ requests: 3, errors: 1, unsent: 0 });
    expect(samples.filter((sample) => sample.error !== undefined)).toEqual([
      expect.objectContaining({ status: 200, error: "invalid_exact_stellar_payload_wrong_amount" }),
    ]);
  });
});

describe("the datasets", () => {
  it("match the hashes in data/manifest.json", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../data/manifest.json", import.meta.url), "utf8"),
    ) as {
      datasets: unknown;
    };
    expect(await datasetHashes()).toEqual(manifest.datasets);
  });

  it("expand catalog A into distinct listings, each copy on its own host and payTo", async () => {
    const corpus = await catalogA();
    const expanded = expand(corpus, 3);
    expect(expanded).toHaveLength(corpus.length * 3);
    const identity = (entry: (typeof expanded)[number]) =>
      // A listing's identity: network, resource, method, tool, and for an mcp:// tool its owner.
      [
        entry.listing.accepts[0]?.network,
        entry.listing.resource,
        entry.listing.method ?? "",
        entry.listing.toolName ?? "",
        entry.listing.resource.startsWith("mcp:") ? entry.listing.accepts[0]?.payTo : "",
      ].join(" ");
    expect(new Set(expanded.map(identity)).size).toBe(expanded.length);
    expect(new Set(expanded.map((entry) => entry.id)).size).toBe(expanded.length);
  });

  it("generate uncached queries that are distinct, salted, and free of constraints", () => {
    const run = Array.from({ length: 5_000 }, (_, index) => uncachedQuery(index, "a1"));
    expect(new Set(run).size).toBe(run.length);
    const other = new Set(Array.from({ length: 5_000 }, (_, index) => uncachedQuery(index, "b2")));
    expect(run.some((query) => other.has(query))).toBe(false);
    for (const query of run.slice(0, 500)) {
      expect(parseQuery(query, new Set(["USDC", "EURC"])).recognised).toEqual([]);
    }
  });
});

describe("the recorded configuration", () => {
  it("records database URLs without credentials and paths relative to the repository", () => {
    expect(
      recordedArgs(
        {
          seed: "postgres://rail402:hunter2@127.0.0.1:5433/rail402_loadtest",
          store: "postgres://u:p@db/rail402_staging",
          out: "/repo/tools/loadtest/results/run",
          url: "http://127.0.0.1:8795",
          rate: "50",
        },
        "/repo",
      ),
    ).toEqual({
      seed: "postgres://127.0.0.1:5433/rail402_loadtest",
      store: "postgres://db/rail402_staging",
      out: "tools/loadtest/results/run",
      url: "http://127.0.0.1:8795",
      rate: "50",
    });
  });

  it("keeps load settings and drops secrets and connection strings", () => {
    expect(
      publicEnv(
        [
          "SEARCH_EMBED_CONCURRENCY=1",
          "RATE_LIMIT_PER_MINUTE=0",
          "TESTNET_SPONSOR_SECRET=SABC",
          "DATABASE_URL=postgres://u:p@h/db",
          "SEARCH_CURSOR_SECRET=00",
          "PUBNET_BAZAAR_MAX_NEW_LISTINGS_PER_HOUR=200",
        ].join("\n"),
      ),
    ).toEqual({
      SEARCH_EMBED_CONCURRENCY: "1",
      RATE_LIMIT_PER_MINUTE: "0",
      PUBNET_BAZAAR_MAX_NEW_LISTINGS_PER_HOUR: "200",
    });
  });
});
