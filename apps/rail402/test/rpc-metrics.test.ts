import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { silentLogger } from "@rail402.dev/facilitator";
import {
  ContractTtlMonitor,
  Metrics,
  meterRpcServer,
  rpcMethodLabel,
  transportOutcome,
  watchTransport,
} from "@rail402.dev/service";

const NETWORK = "stellar:testnet";

/** A JSON-RPC endpoint on loopback: answers by method, or with a bare HTTP status. */
let server: Server;
let origin: string;
let answer: (method: string) => { status: number; body?: unknown } = () => ({ status: 200 });

beforeAll(async () => {
  server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString()));
    request.on("end", () => {
      const { method, id } = JSON.parse(text || "{}") as { method?: string; id?: number };
      const { status, body } = answer(method ?? "");
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body ?? { jsonrpc: "2.0", id, result: {} }));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** A loopback port nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => probe.once("listening", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const lines = async (metrics: Metrics, name: string) =>
  (await metrics.registry.metrics()).split("\n").filter((line) => line.startsWith(`${name}{`));

describe("meterRpcServer", () => {
  it("counts each call by method and outcome and times it, without changing the answer", async () => {
    const metrics = new Metrics();
    const client = new rpc.Server(`${origin}/rpc`, { allowHttp: true });
    meterRpcServer(client, NETWORK, metrics);

    answer = () => ({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 1,
        result: { status: "healthy", latestLedger: 7, oldestLedger: 1, ledgerRetentionWindow: 6 },
      },
    });
    expect(await client.getHealth()).toMatchObject({ latestLedger: 7 });
    answer = () => ({
      status: 200,
      body: { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "bad" } },
    });
    await expect(client.getHealth()).rejects.toMatchObject({ code: -32600 });
    answer = () => ({ status: 503, body: { message: "overloaded" } });
    await expect(client.getNetwork()).rejects.toThrow();

    const unreachable = new rpc.Server(`http://127.0.0.1:${String(await closedPort())}/rpc`, {
      allowHttp: true,
    });
    meterRpcServer(unreachable, NETWORK, metrics);
    await expect(unreachable.getHealth()).rejects.toThrow();

    expect(await lines(metrics, "rail402_rpc_requests_total")).toEqual([
      'rail402_rpc_requests_total{network="stellar:testnet",method="getHealth",outcome="ok"} 1',
      'rail402_rpc_requests_total{network="stellar:testnet",method="getHealth",outcome="rpc_error"} 1',
      'rail402_rpc_requests_total{network="stellar:testnet",method="getNetwork",outcome="http_error"} 1',
      'rail402_rpc_requests_total{network="stellar:testnet",method="getHealth",outcome="network_error"} 1',
    ]);
    expect(await lines(metrics, "rail402_rpc_request_duration_seconds_count")).toEqual([
      'rail402_rpc_request_duration_seconds_count{network="stellar:testnet",method="getHealth"} 3',
      'rail402_rpc_request_duration_seconds_count{network="stellar:testnet",method="getNetwork"} 1',
    ]);
  });

  it("labels methods from a fixed set and classifies transport failures", () => {
    expect(rpcMethodLabel("sendTransaction")).toBe("sendTransaction");
    expect(rpcMethodLabel("getLedgerEntries")).toBe("getLedgerEntries");
    expect(rpcMethodLabel("anything the caller sends")).toBe("other");
    expect(rpcMethodLabel(undefined)).toBe("other");
    expect(transportOutcome({ response: { status: 502 } })).toBe("http_error");
    expect(transportOutcome({ name: "TimeoutError", message: "" })).toBe("timeout");
    expect(transportOutcome(new Error("timeout of 1000 ms exceeded"))).toBe("timeout");
    expect(transportOutcome(new TypeError("fetch failed"))).toBe("network_error");
    expect(transportOutcome("?")).toBe("network_error");
  });
});

describe("watchTransport", () => {
  it("counts network errors, 5xx and 429 answers from any client to a watched origin only", async () => {
    const metrics = new Metrics();
    const port = await closedPort();
    const refused = `http://127.0.0.1:${String(port)}`;
    const stop = watchTransport(
      [
        { origin, network: NETWORK, target: "rpc" },
        { origin: refused, network: NETWORK, target: "horizon" },
      ],
      metrics,
    );
    try {
      for (const status of [200, 503, 500, 429, 404]) {
        answer = () => ({ status });
        await (await fetch(`${origin}/rpc`, { method: "POST", body: "{}" })).text();
      }
      await expect(fetch(`${refused}/ledgers`)).rejects.toThrow();
      // Unwatched origins are ignored.
      await expect(fetch(`http://localhost:${String(port)}/x`)).rejects.toThrow();
    } finally {
      stop();
    }
    answer = () => ({ status: 503 });
    await (await fetch(`${origin}/rpc`, { method: "POST", body: "{}" })).text();

    // Every watched target and kind is exported, at zero until it first counts.
    expect(await lines(metrics, "rail402_rpc_transport_errors_total")).toEqual([
      'rail402_rpc_transport_errors_total{network="stellar:testnet",target="rpc",kind="network"} 0',
      'rail402_rpc_transport_errors_total{network="stellar:testnet",target="rpc",kind="http_5xx"} 2',
      'rail402_rpc_transport_errors_total{network="stellar:testnet",target="rpc",kind="http_429"} 1',
      'rail402_rpc_transport_errors_total{network="stellar:testnet",target="horizon",kind="network"} 1',
      'rail402_rpc_transport_errors_total{network="stellar:testnet",target="horizon",kind="http_5xx"} 0',
      'rail402_rpc_transport_errors_total{network="stellar:testnet",target="horizon",kind="http_429"} 0',
    ]);
  });
});

describe("ContractTtlMonitor", () => {
  const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

  it("keeps its last findings and counts the failure when the ledger cannot be read", async () => {
    const metrics = new Metrics();
    let fail = false;
    const monitor = new ContractTtlMonitor({
      network: NETWORK,
      server: {
        getLedgerEntries: () =>
          fail
            ? Promise.reject(new Error("RPC unavailable"))
            : Promise.resolve({ entries: [], latestLedger: 10 }),
      },
      contracts: [{ alias: "USDC", contract: USDC }],
      metrics,
      log: silentLogger,
    });
    expect(monitor.snapshot()).toEqual({ contracts: [] });
    const first = await monitor.check();
    expect(first.contracts).toEqual([{ alias: "USDC", id: USDC, missing: true }]);
    expect(first.error).toBeUndefined();
    fail = true;
    const second = await monitor.check();
    expect(second).toMatchObject({ error: "RPC unavailable", contracts: first.contracts });
    expect(await lines(metrics, "rail402_contract_ttl_check_errors_total")).toEqual([
      'rail402_contract_ttl_check_errors_total{network="stellar:testnet"} 1',
    ]);
    expect(await lines(metrics, "rail402_contract_ttl_ledgers")).toEqual([]);
  });
});
