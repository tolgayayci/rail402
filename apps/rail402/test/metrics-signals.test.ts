/**
 * A scrape before the first event already shows every counter whose labels are known up front, at
 * zero, so dashboards and alerts on sequence conflicts, RPC failures or embedding failures see the
 * series (and a rate over it is defined) from the moment the service starts.
 */
import { describe, expect, it } from "vitest";
import { Metrics, metricsObserver, metricsSearchObserver, watchTransport } from "@rail402.dev/service";

const NETWORK = "stellar:testnet";

/** The value of one sample in the text exposition, or undefined when the series is absent. */
async function sample(metrics: Metrics, series: string): Promise<number | undefined> {
  const text = await metrics.registry.metrics();
  const line = text.split("\n").find((entry) => entry.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe("metrics before the first event", () => {
  it("exports the search counters and latency histogram at zero", async () => {
    const metrics = new Metrics();
    for (const stage of ["document", "query"]) {
      expect(await sample(metrics, `rail402_search_embedding_failures_total{stage="${stage}"}`)).toBe(0);
    }
    for (const outcome of ["ok", "degraded", "failed"]) {
      expect(await sample(metrics, `rail402_search_index_builds_total{outcome="${outcome}"}`)).toBe(0);
    }
    for (const method of ["hybrid", "lexical", "filter"]) {
      for (const partial of ["false", "true"]) {
        const labels = `method="${method}",partial="${partial}"`;
        expect(await sample(metrics, `rail402_search_duration_seconds_count{${labels}}`)).toBe(0);
        expect(await sample(metrics, `rail402_search_duration_seconds_bucket{le="+Inf",${labels}}`)).toBe(0);
      }
    }
  });

  it("exports a prepared network's settlement and failure counters at zero", async () => {
    const metrics = new Metrics();
    expect(
      await sample(metrics, `rail402_sequence_conflicts_total{network="${NETWORK}",kind="bad_seq"}`),
    ).toBeUndefined();
    metrics.prepareNetwork(NETWORK, ["exact", "upto"]);
    const zero = [
      `rail402_sequence_conflicts_total{network="${NETWORK}",kind="bad_seq"}`,
      `rail402_sequence_conflicts_total{network="${NETWORK}",kind="try_again_later"}`,
      `rail402_sponsor_guard_refusals_total{network="${NETWORK}",reason="reserve"}`,
      `rail402_sponsor_guard_refusals_total{network="${NETWORK}",reason="budget"}`,
      `rail402_channel_lease_timeouts_total{network="${NETWORK}"}`,
      `rail402_settlement_ledger_read_failures_total{network="${NETWORK}"}`,
      `rail402_contract_ttl_check_errors_total{network="${NETWORK}"}`,
      ...["exact", "upto"].flatMap((scheme) => [
        `rail402_settlements_total{network="${NETWORK}",scheme="${scheme}",outcome="success",reason=""}`,
        `rail402_verifications_total{network="${NETWORK}",scheme="${scheme}",outcome="valid",reason=""}`,
      ]),
    ];
    for (const series of zero) expect(await sample(metrics, series), series).toBe(0);
  });

  it("exports each watched RPC and Horizon target's transport errors at zero", async () => {
    const metrics = new Metrics();
    const stop = watchTransport(
      [
        { origin: "http://127.0.0.1:1", network: NETWORK, target: "rpc" },
        { origin: "https://horizon-testnet.stellar.org", network: NETWORK, target: "horizon" },
      ],
      metrics,
    );
    try {
      for (const target of ["rpc", "horizon"]) {
        for (const kind of ["network", "http_5xx", "http_429"]) {
          const series = `rail402_rpc_transport_errors_total{network="${NETWORK}",target="${target}",kind="${kind}"}`;
          expect(await sample(metrics, series), series).toBe(0);
        }
      }
    } finally {
      stop();
    }
  });

  it("counts on top of the zero samples", async () => {
    const metrics = new Metrics();
    metrics.prepareNetwork(NETWORK, ["exact"]);
    const observer = metricsObserver(metrics);
    observer.submission(NETWORK, { status: "TRY_AGAIN_LATER", phase: "submit" });
    metricsSearchObserver(metrics).embeddingFailure("query");
    expect(
      await sample(metrics, `rail402_sequence_conflicts_total{network="${NETWORK}",kind="try_again_later"}`),
    ).toBe(1);
    expect(
      await sample(metrics, `rail402_sequence_conflicts_total{network="${NETWORK}",kind="bad_seq"}`),
    ).toBe(0);
    expect(await sample(metrics, `rail402_search_embedding_failures_total{stage="query"}`)).toBe(1);
  });
});
