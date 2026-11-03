import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Counter, Registry } from "prom-client";
import { Keypair } from "@stellar/stellar-sdk";
import { silentLogger, type StellarFacilitator } from "@rail402.dev/facilitator";
import {
  Metrics,
  PUBLIC_PUBNET_METRICS,
  createApp,
  exposition,
  loadConfig,
  metricsObserver,
  publicExposition,
  type HealthSnapshot,
} from "@rail402.dev/service";

const PUBNET = "stellar:pubnet";
const TESTNET = "stellar:testnet";

/** Metrics with samples on both networks in counters, gauges and histograms. */
function sampled(): Metrics {
  const metrics = new Metrics();
  for (const network of [TESTNET, PUBNET]) {
    metrics.prepareNetwork(network, ["exact"]);
    metrics.sponsorBalance.set({ network }, 123_456_789);
    metrics.sponsorFeesCommitted.set({ network }, 48_200);
    metrics.settlements.inc({ network, scheme: "exact", outcome: "success", reason: "" });
    metrics.rpcLatestLedger.set({ network }, 1_000);
    const observer = metricsObserver(metrics);
    observer.leaseWait(network, 30, true);
    observer.finalized({
      network,
      scheme: "exact",
      state: "succeeded",
      durationMs: 4_000,
      onChainFailure: false,
      settledBy: "rail402",
      feeChargedStroops: 50_000n,
    });
  }
  return metrics;
}

describe("metrics exposure", () => {
  it("serializes exactly as prom-client does when nothing is filtered", async () => {
    const metrics = sampled();
    // Escaping of help and label values too.
    const odd = new Counter({
      name: "odd_total",
      help: 'a "help"\\ with\nnewline',
      labelNames: ["v"],
      registers: [metrics.registry],
    });
    odd.inc({ v: 'quote " backslash \\ newline \n end' });
    // Process metrics (CPU time, memory) change between two collections; compare everything else.
    const stable = (text: string) =>
      text
        .split("\n\n")
        .filter((block) => !block.includes("rail402_process_"))
        .join("\n\n");
    expect(stable(await exposition(metrics.registry))).toBe(stable(await metrics.registry.metrics()));
    const empty = new Registry();
    expect(await exposition(empty)).toBe(await empty.metrics());
  });

  it("cannot tell pubnet budget exhaustion from any other failure on the public metrics endpoint", async () => {
    const failures = (reason: string) => {
      const metrics = new Metrics();
      for (const network of [TESTNET, PUBNET]) {
        metrics.prepareNetwork(network, ["exact"]);
        metrics.settlements.inc({ network, scheme: "exact", outcome: "success", reason: "" }, 5);
        metrics.settlements.inc({ network, scheme: "exact", outcome: "failure", reason }, 3);
        metrics.settlements.inc(
          {
            network,
            scheme: "exact",
            outcome: "failure",
            reason: "invalid_exact_stellar_payload_invalid_signature",
          },
          2,
        );
        metrics.settlementsFinalized.inc({
          network,
          scheme: "exact",
          state: "failed",
          reason,
          settled_by: "rail402",
        });
      }
      return metrics;
    };
    const pubnetLines = (text: string) =>
      text
        .split("\n")
        .filter((line) => line.includes('network="stellar:pubnet"') && !line.startsWith("rail402_process_"));
    const exhausted = failures("settle_exact_stellar_sponsor_unavailable");
    const limited = failures("settle_exact_stellar_payto_rate_limited");
    const ordinary = failures("invalid_exact_stellar_payload_wrong_amount");
    const publicView = pubnetLines(await publicExposition(exhausted.registry));
    expect(publicView.join("\n")).not.toMatch(/reason=/);
    expect(pubnetLines(await publicExposition(limited.registry))).toEqual(publicView);
    expect(pubnetLines(await publicExposition(ordinary.registry))).toEqual(publicView);
    // Series that differ only in the reason are added up: 3 + 2 failures.
    expect(publicView).toContain(
      'rail402_settlements_total{network="stellar:pubnet",scheme="exact",outcome="failure"} 5',
    );
    // The private view and testnet keep the reason.
    expect(await exposition(exhausted.registry)).toMatch(
      /rail402_settlements_total\{network="stellar:pubnet",scheme="exact",outcome="failure",reason="settle_exact_stellar_sponsor_unavailable"\} 3/,
    );
    expect(await publicExposition(exhausted.registry)).toMatch(
      /rail402_settlements_total\{network="stellar:testnet",scheme="exact",outcome="failure",reason="settle_exact_stellar_sponsor_unavailable"\} 3/,
    );
  });

  it("serves no pubnet series on the public metrics endpoint outside the allow-list", async () => {
    const metrics = sampled();
    const text = await publicExposition(metrics.registry);
    const pubnetSeries = [
      ...text.matchAll(/^(rail402_\w+?)(?:_bucket|_sum|_count)?\{[^}]*network="stellar:pubnet"/gm),
    ].map((match) => match[1] ?? "");
    expect(pubnetSeries.length).toBeGreaterThan(0);
    for (const name of pubnetSeries) expect(PUBLIC_PUBNET_METRICS.has(name), name).toBe(true);
    expect(text).not.toMatch(/rail402_sponsor_balance_stroops\{network="stellar:pubnet"\}/);
    expect(text).not.toMatch(/rail402_sponsor_fees_committed_stroops\{network="stellar:pubnet"\}/);
    expect(text).not.toMatch(/rail402_channel_lease_wait_seconds_bucket\{[^}]*stellar:pubnet/);
    // Testnet stays fully public, and the private view keeps everything.
    expect(text).toMatch(/rail402_sponsor_balance_stroops\{network="stellar:testnet"\} 123456789/);
    expect(await exposition(metrics.registry)).toMatch(
      /rail402_sponsor_balance_stroops\{network="stellar:pubnet"\} 123456789/,
    );
  });

  it("drops every series labelled with an access key from the public view", async () => {
    const metrics = new Metrics();
    const perKey = new Counter({
      name: "rail402_example_requests_total",
      help: "x",
      labelNames: ["network", "key_id"],
      registers: [metrics.registry],
    });
    perKey.inc({ network: TESTNET, key_id: "acme-prod-1" });
    expect(await publicExposition(metrics.registry)).not.toContain("acme-prod-1");
    expect(await exposition(metrics.registry)).toContain("acme-prod-1");
  });
});

describe("the private endpoints", () => {
  const token = "private-token";
  const make = (privateToken: boolean) => {
    const metrics = sampled();
    const snapshot = {
      status: "ok",
      version: "test",
      state: "healthy",
      checkedAt: null,
      warnings: [],
      networks: {
        [PUBNET]: {
          state: "serving",
          holdReason: null,
          servingSince: null,
          status: "healthy",
          rpc: { ok: true, latestLedger: 1, ledgerAgeSeconds: 1, transportErrors1h: 0 },
          sponsor: {
            address: "GSPONSOR",
            funded: true,
            balanceStroops: "123456789",
            committed1hStroops: "1",
            wasted1hStroops: "0",
          },
          channels: { total: 2, inUse: 0, leaseWaitP95Ms: null, leaseTimeouts1h: 0 },
          settlements: { last1h: null, unfinished: null, unresolvable: 0, repeats1h: 0 },
          sequenceConflicts1h: 0,
          contracts: {},
        },
      },
    } satisfies HealthSnapshot;
    return createApp({
      config: loadConfig({
        STORE: "memory",
        TESTNET_RPC_URL: "http://localhost:8000/rpc",
        TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
        ...(privateToken
          ? { METRICS_PRIVATE_TOKEN_SHA256: createHash("sha256").update(token).digest("hex") }
          : {}),
      }),
      facilitator: {
        core: { getSupported: () => ({ kinds: [], extensions: [], signers: {} }) },
        networks: new Map(),
      } as unknown as StellarFacilitator,
      metrics,
      log: silentLogger,
      readiness: () => Promise.resolve({ ready: true, checks: {} }),
      health: () => snapshot,
      version: "test",
    });
  };
  const bearer = (value: string) => ({ headers: { authorization: `Bearer ${value}` } });

  it("requires the private token for /metrics/private and /health/private", async () => {
    const app = make(true);
    for (const path of ["/metrics/private", "/health/private"]) {
      const anonymous = await app.request(path);
      expect(anonymous.status, path).toBe(401);
      expect(((await anonymous.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
      expect((await app.request(path, bearer("wrong"))).status, path).toBe(401);
      // The token is a bearer token only.
      expect((await app.request(path, { headers: { "x-api-key": token } })).status, path).toBe(401);
    }
    const metrics = await app.request("/metrics/private", bearer(token));
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toMatch(
      /rail402_sponsor_balance_stroops\{network="stellar:pubnet"\} 123456789/,
    );
    const health = await app.request("/health/private", bearer(token));
    expect(((await health.json()) as HealthSnapshot).networks[PUBNET]?.sponsor.balanceStroops).toBe(
      "123456789",
    );
    // The public paths keep the pubnet balance out.
    expect(await (await app.request("/metrics")).text()).not.toMatch(
      /sponsor_balance_stroops\{network="stellar:pubnet"/,
    );
    expect(JSON.stringify(await (await app.request("/health")).json())).not.toContain("123456789");
  });

  it("serves no private path without a private token configured", async () => {
    const app = make(false);
    expect((await app.request("/metrics/private", bearer(token))).status).toBe(404);
    expect((await app.request("/health/private", bearer(token))).status).toBe(404);
  });

  it("requires the private token whenever pubnet is enabled", () => {
    expect(() => loadConfig({ NETWORKS: "stellar:pubnet", STORE: "memory" })).toThrow(
      /METRICS_PRIVATE_TOKEN_SHA256|PUBNET/,
    );
  });
});
