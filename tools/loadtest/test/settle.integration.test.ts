/**
 * The settle probe against a whole facilitator (config, runtime, channels, Bazaar search, HTTP) on the
 * local private Stellar network, while a search flood runs against the same process.
 */
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Keypair } from "@stellar/stellar-sdk";
import { silentLogger } from "@rail402.dev/facilitator";
import { Metrics, createApp, createRuntime, loadConfig, type Runtime } from "@rail402.dev/service";
import { LocalNetwork } from "@rail402.dev/testkit";
import { evalQueries } from "../src/datasets.ts";
import { runOpenLoop, type Sample } from "../src/driver.ts";
import { assertLocalRpc, createSettleSetup, runSettleProbe, settleFacilitatorEnv } from "../src/settle.ts";
import { summarize } from "../src/summary.ts";

const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("the settle probe", () => {
  let runtime: Runtime | undefined;
  let server: ServerType | undefined;
  let url = "";
  let setup: Awaited<ReturnType<typeof createSettleSetup>>;

  beforeAll(async () => {
    setup = await createSettleSetup(net, { payers: 4 });
    const sponsor = Keypair.random();
    await net.fund(sponsor);
    const config = loadConfig({
      STORE: "memory",
      TESTNET_SPONSOR_SECRET: sponsor.secret(),
      TESTNET_CHANNEL_COUNT: "4",
      TESTNET_MAX_TX_FEE_STROOPS: "2000000",
      TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
      TESTNET_UPTO_ENABLED: "false",
      RATE_LIMIT_PER_MINUTE: "0",
      SEARCH_RATE_LIMIT_PER_MINUTE: "0",
      ...settleFacilitatorEnv(setup),
    });
    const metrics = new Metrics();
    runtime = await createRuntime(config, metrics, silentLogger, { version: "test" });
    runtime.start();
    const started = runtime;
    const app = createApp({
      config,
      facilitator: started.facilitator,
      metrics,
      log: silentLogger,
      readiness: () => started.readiness(),
      version: "test",
      ...(started.bazaar === undefined ? {} : { bazaar: started.bazaar }),
    });
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        resolve(info.port);
      });
    });
    url = `http://127.0.0.1:${String(port)}`;
    const deadline = Date.now() + 120_000;
    while (!(await started.readiness()).ready) {
      if (Date.now() > deadline) throw new Error("the facilitator did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }, 300_000);

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await runtime?.stop();
  });

  it("refuses an RPC that is not on this machine", () => {
    expect(() => {
      assertLocalRpc("https://soroban-testnet.stellar.org");
    }).toThrow(/local private network/);
    expect(() => {
      assertLocalRpc("http://127.0.0.1:8000/rpc");
    }).not.toThrow();
  });

  it("settles real payments during a search flood and reports their latency percentiles", async () => {
    const before = await net.tokenBalance(setup.asset, setup.payTo);
    const queries = await evalQueries();
    const samples: Sample[] = [];
    const durationMs = 6_000;
    const [flood, probe] = await Promise.all([
      runOpenLoop({
        base: url,
        rate: 50,
        durationMs,
        next: (index) => ({
          path: `/discovery/search?query=${encodeURIComponent(`${queries[index % queries.length] ?? ""} ${String(index)}`)}`,
          label: "uncached",
        }),
        onSample: (sample) => samples.push(sample),
      }),
      runSettleProbe({
        facilitator: url,
        setup,
        rate: 1,
        durationMs,
        onSample: (sample) => samples.push(sample),
      }),
    ]);
    expect(flood.sent).toBe(300);
    expect(probe).toEqual({ sent: 6, failed: 0 });

    const summary = summarize(samples);
    const settle = summary["settle"];
    expect(settle).toMatchObject({ requests: 6, errors: 0, unsent: 0, statuses: { "200": 6 } });
    expect(settle?.latencyMs.count).toBe(6);
    expect(settle?.latencyMs.p50).toBeGreaterThan(0);
    expect(settle?.latencyMs.p99).toBeGreaterThanOrEqual(settle?.latencyMs.p95 ?? Infinity);
    expect(summary["uncached"]?.requests).toBe(300);
    // Every settlement moved the asset on chain, each in its own transaction.
    const transactions = samples.filter((s) => s.label === "settle").map((s) => s.transaction);
    expect(new Set(transactions).size).toBe(6);
    expect(transactions.every((hash) => /^[0-9a-f]{64}$/.test(hash ?? ""))).toBe(true);
    expect((await net.tokenBalance(setup.asset, setup.payTo)) - before).toBe(6n * BigInt(setup.amount));
  }, 120_000);

  it("records a settlement the facilitator refuses as a failure, and an unsigned one as unsent", async () => {
    const samples: Sample[] = [];
    let calls = 0;
    const result = await runSettleProbe({
      facilitator: url,
      setup,
      rate: 2,
      durationMs: 1_000,
      leadMs: 0,
      // The first payment cannot be signed; the second pays less than the requirements ask.
      pay: async (payer, requirements) => {
        calls++;
        if (calls === 1) throw new Error("signer offline");
        return net.payment(payer, { ...requirements, amount: "1" });
      },
      onSample: (sample) => samples.push(sample),
    });
    expect(result).toEqual({ sent: 1, failed: 1 });
    const summary = summarize(samples)["settle"];
    expect(summary).toMatchObject({ requests: 2, errors: 2, unsent: 1 });
    expect(summary?.errorLatencyMs.count).toBe(1);
    expect(samples.find((s) => s.status !== 0)?.error).toMatch(/^invalid_/);
  }, 60_000);
});
