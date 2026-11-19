import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { silentLogger, type StellarFacilitator } from "@rail402.dev/facilitator";
import { Metrics, createApp, loadConfig, startOtlpMetrics, type OtlpMetrics } from "@rail402.dev/service";

interface Received {
  readonly path: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** An OTLP/HTTP receiver on a loopback port that keeps every export it is sent. */
async function receiver(): Promise<{ endpoint: string; received: Received[] }> {
  const received: Received[] = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ path: request.url, headers: request.headers, body: Buffer.concat(chunks) });
      response.writeHead(200, { "content-type": "application/x-protobuf" }).end();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${String(port)}`, received };
}

describe("the optional OTLP metrics export", () => {
  it("pushes http.server.request.duration with the token, and no probe or scrape", async () => {
    const { endpoint, received } = await receiver();
    const otlp = startOtlpMetrics({ endpoint, token: "test-token", version: "1.2.3", intervalMs: 60_000 });
    otlp.record("POST", "/verify", 200, 0.012);
    otlp.record("POST", "/settle", 503, 0.2);
    otlp.record("BREW", undefined, 404, 0.001);
    otlp.record("GET", "/health", 200, 0.001);
    otlp.record("GET", "/metrics/private", 200, 0.001);
    await otlp.shutdown();

    expect(received).toHaveLength(1);
    const [first] = received;
    expect(first?.path).toBe("/v1/metrics");
    expect(first?.headers.authorization).toBe("Bearer test-token");
    expect(first?.headers["content-type"]).toBe("application/x-protobuf");
    // OTLP protobuf keeps strings as UTF-8, so names and values can be found in the bytes.
    const text = first?.body.toString("latin1") ?? "";
    for (const expected of [
      "http.server.request.duration",
      "/verify",
      "/settle",
      "_OTHER",
      "rail402",
      "1.2.3",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).toContain("error.type");
    expect(text).not.toContain("/health");
    expect(text).not.toContain("/metrics");
    expect(text).not.toContain("BREW");
  });

  it("is fed by every answered request with its route template, next to the Prometheus histogram", async () => {
    const records: [string, string | undefined, number][] = [];
    const otlpMetrics: OtlpMetrics = {
      record: (method, route, status) => records.push([method, route, status]),
      shutdown: () => Promise.resolve(),
    };
    const facilitator = {
      core: {
        getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
      },
      networks: new Map(),
      reconcile: () => Promise.resolve(0),
    } as unknown as StellarFacilitator;
    const metrics = new Metrics();
    const app = createApp({
      config: loadConfig({
        STORE: "memory",
        TESTNET_RPC_URL: "http://localhost:8000/rpc",
        TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
      }),
      facilitator,
      metrics,
      otlpMetrics,
      log: silentLogger,
      readiness: () => Promise.resolve({ ready: true, checks: { database: { ok: true } } }),
      version: "test",
    });

    await app.request("/supported");
    await app.request("/no-such-path");
    expect(records).toEqual([
      ["GET", "/supported", 200],
      ["GET", undefined, 404],
    ]);
    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain(
      'rail402_http_request_duration_seconds_count{method="GET",route="/supported",status="200"} 1',
    );
  });
});
