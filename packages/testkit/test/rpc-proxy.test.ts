import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sequenceConflicts, startRpcProxy, type HeldEvent, type RpcProxy } from "@rail402.dev/testkit";

/** A stand-in RPC that answers every method from a table and records what reached it. */
async function fakeRpc() {
  const received: string[] = [];
  const results: Record<string, unknown> = {
    sendTransaction: { status: "PENDING", hash: "a".repeat(64) },
    getTransaction: {
      status: "SUCCESS",
      latestLedger: 10,
      latestLedgerCloseTime: "1000",
      oldestLedger: 1,
      oldestLedgerCloseTime: "100",
      resultXdr: "AAAA",
    },
    getHealth: { status: "healthy", latestLedger: 10, oldestLedger: 1 },
    getLatestLedger: { id: "x", sequence: 10, protocolVersion: 23 },
  };
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      received.push(method);
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id, result: results[method] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, received, results, server };
}

async function call(proxy: RpcProxy, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(proxy.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) return { http: response.status };
  return ((await response.json()) as { result: Record<string, unknown> }).result;
}

describe("RPC fault proxy", () => {
  let target: Awaited<ReturnType<typeof fakeRpc>>;
  let proxy: RpcProxy;

  beforeAll(async () => {
    target = await fakeRpc();
    proxy = await startRpcProxy(target.url);
  });
  afterEach(() => {
    proxy.reset();
    target.received.length = 0;
  });
  afterAll(async () => {
    await proxy.close();
    target.server.closeAllConnections();
    await new Promise((resolve) => target.server.close(resolve));
  });

  it("forwards by default, records envelopes and counts statuses", async () => {
    expect(await call(proxy, "sendTransaction", { transaction: "ENV1" })).toMatchObject({
      status: "PENDING",
    });
    expect(await call(proxy, "getTransaction", { hash: "a".repeat(64) })).toMatchObject({
      status: "SUCCESS",
    });
    expect(proxy.sent).toEqual(["ENV1"]);
    expect(target.received).toEqual(["sendTransaction", "getTransaction"]);
    expect(proxy.statuses.get("sendTransaction")?.get("PENDING")).toBe(1);
    expect(proxy.statuses.get("getTransaction")?.get("SUCCESS")).toBe(1);
    expect(proxy.answers).toEqual([{ transaction: "ENV1", status: "PENDING" }]);
  });

  it("holds a submission unforwarded, then forwards or discards it", async () => {
    proxy.onSendTransaction = () => "hold";
    const heldEvent = once(proxy.events, "held") as Promise<[HeldEvent]>;
    const pending = call(proxy, "sendTransaction", { transaction: "ENV2" }).catch(() => "closed");
    const [event] = await heldEvent;
    expect(event).toEqual({ method: "sendTransaction", phase: "request", transaction: "ENV2" });
    expect(target.received).toEqual([]);
    await proxy.releaseHeld();
    expect(await pending).toMatchObject({ status: "PENDING" });
    expect(target.received).toEqual(["sendTransaction"]);

    const discarded = call(proxy, "sendTransaction", { transaction: "ENV3" }).catch(() => "closed");
    await once(proxy.events, "held");
    proxy.discardHeld();
    expect(await discarded).toBe("closed");
    expect(target.received).toEqual(["sendTransaction"]);
    expect(proxy.sent).toEqual(["ENV2", "ENV3"]);
  });

  it("drops a submission before broadcast", async () => {
    proxy.onSendTransaction = (transaction) => (transaction === "BAD" ? "drop" : "forward");
    expect(await call(proxy, "sendTransaction", { transaction: "BAD" })).toEqual({ http: 502 });
    expect(await call(proxy, "sendTransaction", { transaction: "GOOD" })).toMatchObject({
      status: "PENDING",
    });
    expect(target.received).toEqual(["sendTransaction"]);
    expect(proxy.statuses.get("sendTransaction")?.get("HTTP_502")).toBe(1);
  });

  it("forwards a request but holds its answer back until released", async () => {
    proxy.holdResponses("sendTransaction");
    const heldEvent = once(proxy.events, "held") as Promise<[HeldEvent]>;
    const pending = call(proxy, "sendTransaction", { transaction: "ENV4" });
    const [event] = await heldEvent;
    expect(event.phase).toBe("response");
    expect(target.received).toEqual(["sendTransaction"]);
    await proxy.releaseHeld();
    expect(await pending).toMatchObject({ status: "PENDING" });
    // Releasing stops holding: the next answer is immediate.
    expect(await call(proxy, "sendTransaction", { transaction: "ENV5" })).toMatchObject({
      status: "PENDING",
    });
  });

  it("hides transactions until a condition holds, keeping the ledger range", async () => {
    let visible = false;
    proxy.hideTransactionsUntil(() => visible);
    expect(await call(proxy, "getTransaction")).toEqual({
      status: "NOT_FOUND",
      latestLedger: 10,
      latestLedgerCloseTime: "1000",
      oldestLedger: 1,
      oldestLedgerCloseTime: "100",
    });
    visible = true;
    expect(await call(proxy, "getTransaction")).toMatchObject({ status: "SUCCESS" });
    visible = false;
    // Once shown, the predicate is no longer consulted.
    expect(await call(proxy, "getTransaction")).toMatchObject({ status: "SUCCESS" });
  });

  it("runs an injection before forwarding a method", async () => {
    const order: string[] = [];
    proxy.injectBefore("sendTransaction", (params) => {
      order.push(`inject:${(params as { transaction: string }).transaction}`);
      return Promise.resolve();
    });
    await call(proxy, "sendTransaction", { transaction: "ENV6" });
    order.push(...target.received);
    expect(order).toEqual(["inject:ENV6", "sendTransaction"]);
  });

  it("pins the latest ledger in health and latest-ledger answers only", async () => {
    proxy.pinLedger(42);
    expect(await call(proxy, "getHealth")).toEqual({ status: "healthy", latestLedger: 42, oldestLedger: 1 });
    expect(await call(proxy, "getLatestLedger")).toEqual({ id: "x", sequence: 42, protocolVersion: 23 });
    expect(await call(proxy, "getTransaction")).toMatchObject({ latestLedger: 10 });
    proxy.pinLedger(undefined);
    expect(await call(proxy, "getLatestLedger")).toMatchObject({ sequence: 10 });
    proxy.pinLedger(7);
    proxy.reset();
    expect(await call(proxy, "getHealth")).toMatchObject({ latestLedger: 10 });
  });

  it("answers requests with an HTTP status without forwarding them, per method or all", async () => {
    proxy.failRequests(503, "getHealth");
    expect(await call(proxy, "getHealth")).toEqual({ http: 503 });
    expect(await call(proxy, "getLatestLedger")).toMatchObject({ sequence: 10 });
    proxy.failRequests(429);
    expect(await call(proxy, "getLatestLedger")).toEqual({ http: 429 });
    proxy.failRequests(undefined);
    expect(await call(proxy, "getHealth")).toMatchObject({ status: "healthy" });
    expect(target.received).toEqual(["getLatestLedger", "getHealth"]);
    expect(proxy.statuses.get("getHealth")).toEqual(
      new Map([
        ["HTTP_503", 1],
        ["healthy", 1],
      ]),
    );
  });

  it("tells sequence conflicts from rebroadcasts of the same bytes", () => {
    expect(
      sequenceConflicts([
        { transaction: "A", status: "PENDING" },
        { transaction: "A", status: "DUPLICATE" },
        { transaction: "A", status: "ERROR:txFeeBumpInnerFailed:txBadSeq" },
        { transaction: "A", status: "TRY_AGAIN_LATER" },
        { transaction: "B", status: "PENDING" },
      ]),
    ).toEqual([]);
    expect(
      sequenceConflicts([
        { transaction: "C", status: "ERROR:txFeeBumpInnerFailed:txBadSeq" },
        { transaction: "D", status: "PENDING" },
        { transaction: "D", status: "ERROR:txInsufficientFee" },
        { transaction: "E", status: "TRY_AGAIN_LATER" },
      ]),
    ).toEqual([
      { transaction: "C", status: "ERROR:txFeeBumpInnerFailed:txBadSeq", first: true },
      { transaction: "D", status: "ERROR:txInsufficientFee", first: false },
      { transaction: "E", status: "TRY_AGAIN_LATER", first: true },
    ]);
  });
});
