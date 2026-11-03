import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { silentLogger, type StellarFacilitator } from "@rail402.dev/facilitator";
import {
  Metrics,
  SHUTDOWN_WRITE_MS,
  createApp,
  listen,
  loadConfig,
  type ServiceServer,
} from "@rail402.dev/service";

setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;

/** Larger than every socket buffer between the server and a client on the same host. */
const LARGE_BYTES = 32 * 1024 * 1024;

/** The memory of the last `/large` response's body, held weakly to see when it is released. */
let lastLargeBody: WeakRef<ArrayBuffer> | undefined;

const app = new Hono();
app.get("/large", (c) => {
  const body = new Uint8Array(LARGE_BYTES).fill(0x61);
  lastLargeBody = new WeakRef(body.buffer);
  return c.body(body);
});
app.get("/slow", async (c) => {
  await sleep(Number(c.req.query("ms")));
  return c.text("slow done");
});
app.get("/fast", (c) => c.text("fast done"));
// A body cut off by the connection closing reads as empty.
app.post("/echo", async (c) => c.text(await c.req.text().catch(() => "")));
app.get("/slow-large", async (c) => {
  await sleep(Number(c.req.query("ms")));
  return c.body(new Uint8Array(LARGE_BYTES).fill(0x63));
});

/** A page of a pipelined backlog; every page's memory is held weakly to see when it is released. */
const PAGE_BYTES = 4 * 1024 * 1024;
const pages: WeakRef<ArrayBuffer>[] = [];
app.get("/page", (c) => {
  const body = new Uint8Array(PAGE_BYTES).fill(0x62);
  pages.push(new WeakRef(body.buffer));
  return c.body(body);
});

const running: Server[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * Serves the test app as the service does, with the server's own sockets kept for inspection and the
 * number of responses dropped by each reset for a write timeout.
 */
async function start(responseWriteTimeoutMs: number, maxPipelinedRequests = 16) {
  const sockets: Socket[] = [];
  const resets: number[] = [];
  const reasons: string[] = [];
  const service = await new Promise<ServiceServer>((resolve) => {
    const started = listen(
      app.fetch,
      {
        port: 0,
        host: "127.0.0.1",
        responseWriteTimeoutMs,
        maxPipelinedRequests,
        onReset: (reason, dropped) => {
          reasons.push(reason);
          if (reason === "write_timeout") resets.push(dropped);
        },
      },
      () => {
        resolve(started);
      },
    );
  });
  const { server } = service;
  running.push(server);
  server.on("connection", (socket: Socket) => sockets.push(socket));
  const { port } = server.address() as AddressInfo;
  return { service, server, sockets, port, resets, reasons };
}

const connections = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.getConnections((error, count) => {
      if (error === null) resolve(count);
      else reject(error);
    });
  });

/** A raw client connection: what it received so far, and whether its connection has ended. */
function client(port: number, request: string, options: { stopAfterHeaders?: boolean } = {}) {
  const state = {
    received: "",
    bytes: 0,
    headers: false,
    closed: false,
    socket: connect(port, "127.0.0.1"),
  };
  state.socket.on("connect", () => state.socket.write(request));
  state.socket.on("data", (chunk: Buffer) => {
    state.bytes += chunk.length;
    if (state.received.length < 4_096) state.received += chunk.toString("latin1");
    if (!state.headers && state.received.includes("\r\n\r\n")) {
      state.headers = true;
      // A client that reads the status and headers, then stops reading the body.
      if (options.stopAfterHeaders === true) state.socket.pause();
    }
  });
  state.socket.on("close", () => {
    state.closed = true;
  });
  state.socket.on("error", () => undefined);
  return state;
}

/** The service's own app over an in-memory store, with the metrics it records. */
function serviceApp() {
  const config = loadConfig({
    STORE: "memory",
    TESTNET_RPC_URL: "http://localhost:8000/rpc",
    TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
    API_KEY_SHA256: createHash("sha256").update("key").digest("hex"),
  });
  const metrics = new Metrics();
  const service = createApp({
    config,
    facilitator: {
      core: { getSupported: () => ({ kinds: [], extensions: [], signers: {} }) },
      networks: new Map(),
    } as unknown as StellarFacilitator,
    metrics,
    log: silentLogger,
    readiness: () => Promise.resolve({ ready: true, checks: {} }),
    version: "test",
  });
  /** How many /metrics expositions the app has built and answered. */
  const expositions = async () => {
    const text = await metrics.registry.getSingleMetricAsString("rail402_http_request_duration_seconds");
    return Number(/_count\{method="GET",route="\/metrics",status="200"\} (\d+)/.exec(text)?.[1] ?? 0);
  };
  return { service, expositions };
}

const get = (path: string) => `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`;

/**
 * A raw client connection that reads at most `bytesPerSecond`: fast enough to take any one page well
 * within a deadline, too slow to take a whole backlog of them.
 */
function throttledClient(port: number, request: string, bytesPerSecond: number) {
  const state = { bytes: 0, closed: false, socket: connect(port, "127.0.0.1") };
  const tick = 50;
  let allowed = 0;
  const refill = setInterval(() => {
    allowed += (bytesPerSecond * tick) / 1_000;
    if (state.bytes < allowed) state.socket.resume();
  }, tick);
  state.socket.on("connect", () => state.socket.write(request));
  state.socket.on("data", (chunk: Buffer) => {
    state.bytes += chunk.length;
    if (state.bytes >= allowed) state.socket.pause();
  });
  state.socket.on("close", () => {
    state.closed = true;
    clearInterval(refill);
  });
  state.socket.on("error", () => undefined);
  return state;
}

describe("the service's HTTP server", () => {
  it(
    "resets the connection of a client that stops reading, and releases the response it held",
    { timeout: 15_000 },
    async () => {
      const { server, sockets, port, resets } = await start(1_000);
      const stalled = client(port, get("/large"), { stopAfterHeaders: true });
      await expect.poll(() => stalled.headers).toBe(true);
      expect(stalled.received).toMatch(/^HTTP\/1\.1 200 /);
      // Within the deadline the connection is open and the unsent body is still held for it.
      collect();
      expect(lastLargeBody?.deref()).toBeDefined();
      expect(sockets.filter((socket) => !socket.destroyed)).toHaveLength(1);

      await expect.poll(() => sockets[0]?.destroyed, { timeout: 5_000, interval: 50 }).toBe(true);
      expect(resets).toEqual([1]);
      expect(await connections(server)).toBe(0);
      // Released once the server has closed the connection (and the test lets go of the closed
      // socket, which the server itself no longer holds).
      sockets.length = 0;
      await expect
        .poll(() => {
          collect();
          return lastLargeBody?.deref() === undefined;
        })
        .toBe(true);
      // Reading again, the client finds its connection gone before the body ended.
      stalled.socket.resume();
      await expect.poll(() => stalled.closed, { timeout: 5_000, interval: 50 }).toBe(true);
      expect(stalled.bytes).toBeLessThan(LARGE_BYTES);
    },
  );

  it("does not cut a request whose handler answers after the deadline", async () => {
    const { port } = await start(300);
    const response = await fetch(`http://127.0.0.1:${String(port)}/slow?ms=1000`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("slow done");
  });

  it("delivers a large response in full to a client that reads it", async () => {
    const { port } = await start(5_000);
    const response = await fetch(`http://127.0.0.1:${String(port)}/large`);
    expect((await response.arrayBuffer()).byteLength).toBe(LARGE_BYTES);
  });

  it("leaves a kept-alive connection open for a later slow request", async () => {
    const { port } = await start(300);
    const connection = client(port, get("/fast"));
    await expect.poll(() => connection.received).toContain("fast done");
    // Idle for longer than the deadline, then a request whose handler takes longer than it.
    await sleep(700);
    connection.socket.write(get("/slow?ms=600"));
    await expect.poll(() => connection.received, { timeout: 5_000 }).toContain("slow done");
    expect(connection.closed).toBe(false);
    connection.socket.destroy();
  });

  it(
    "resets a connection whose pipelined responses are not all taken within one deadline of being ready",
    { timeout: 15_000 },
    async () => {
      const { sockets, port, resets } = await start(2_000);
      // Ten pages, all ready at once. Each takes about half a second at this rate, the backlog five.
      const backlog = 10;
      const reader = throttledClient(port, get("/page").repeat(backlog), 8 * 1024 * 1024);
      const started = performance.now();
      await expect.poll(() => sockets[0]?.destroyed, { timeout: 4_000, interval: 50 }).toBe(true);
      expect(performance.now() - started).toBeGreaterThanOrEqual(1_900);
      // The reader took the first page in full and never the whole backlog.
      expect(reader.bytes).toBeGreaterThan(PAGE_BYTES);
      expect(reader.bytes).toBeLessThan(backlog * PAGE_BYTES);
      expect(resets).toHaveLength(1);
      expect(resets[0]).toBeGreaterThan(1);
      // Every page is released once the server has closed the connection (and the test lets go of
      // the closed socket, which the server itself no longer holds).
      sockets.length = 0;
      await expect
        .poll(() => {
          collect();
          return pages.filter((page) => page.deref() !== undefined).length;
        })
        .toBe(0);
      reader.socket.destroy();
    },
  );

  it("does not start a pipelined response's deadline while a response ahead of it is being prepared", async () => {
    const { port } = await start(300);
    // The second response is ready at once but waits for the first, whose handler takes 1 s.
    const connection = client(port, get("/slow?ms=1000") + get("/fast"));
    await expect.poll(() => connection.received, { timeout: 5_000 }).toContain("fast done");
    expect(connection.received).toContain("slow done");
    expect(connection.received.indexOf("slow done")).toBeLessThan(connection.received.indexOf("fast done"));
    connection.socket.destroy();
  });

  it("lets requests in progress finish at shutdown, then waits on a client that does not read for one short window", async () => {
    const { service, sockets, port } = await start(30_000);
    // Both handlers are still at work when shutdown begins; one client will not read its answer.
    const stalled = client(port, get("/slow-large?ms=300"), { stopAfterHeaders: true });
    const answering = fetch(`http://127.0.0.1:${String(port)}/slow?ms=500`);
    await expect.poll(() => sockets.length).toBe(2);

    const closing = performance.now();
    const closed = new Promise<number>((resolve) => {
      service.close(() => {
        resolve(performance.now() - closing);
      });
    });
    const answered = await answering;
    expect(answered.status).toBe(200);
    expect(answered.headers.get("connection")).toBe("close");
    expect(await answered.text()).toBe("slow done");
    await expect.poll(() => stalled.headers).toBe(true);
    expect(stalled.received).toMatch(/^HTTP\/1\.1 200 /);
    // Far sooner than the 30 s deadline: the stalled answer gets one shutdown window after it is ready.
    const elapsed = await closed;
    expect(elapsed).toBeGreaterThanOrEqual(300 + SHUTDOWN_WRITE_MS - 100);
    expect(elapsed).toBeLessThan(300 + SHUTDOWN_WRITE_MS + 2_000);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  it("caps the requests one connection may have waiting for their answers, on every route", async () => {
    const { service, expositions } = serviceApp();
    const sockets: Socket[] = [];
    const resets: string[] = [];
    const served = listen(service.fetch, {
      port: 0,
      host: "127.0.0.1",
      responseWriteTimeoutMs: 30_000,
      maxPipelinedRequests: 4,
      onReset: (reason) => {
        resets.push(reason);
      },
    });
    running.push(served.server);
    served.server.on("connection", (socket: Socket) => sockets.push(socket));
    await new Promise((resolve) => served.server.once("listening", resolve));
    const { port } = served.server.address() as AddressInfo;
    // Public and exempt from the rate limits: thousands of expositions, pipelined on one connection
    // that never reads.
    const flood = connect(port, "127.0.0.1", () => {
      flood.pause();
      flood.write(get("/metrics").repeat(2_000));
    });
    flood.on("error", () => undefined);
    await expect.poll(() => sockets[0]?.destroyed, { timeout: 3_000, interval: 50 }).toBe(true);
    expect(resets).toEqual(["backlog"]);
    // Only the requests within the cap were ever answered; the rest were never built.
    await sleep(200);
    expect(await expositions()).toBeLessThanOrEqual(4);
    flood.destroy();
  });

  it("serves a kept-alive client's requests one after another, and a client that pipelines within the cap", async () => {
    const { port } = await start(30_000);
    const sequential = client(port, get("/fast"));
    for (let answered = 1; answered <= 20; answered++) {
      await expect.poll(() => sequential.received.split("fast done").length - 1).toBe(answered);
      if (answered < 20) sequential.socket.write(get("/fast"));
    }
    expect(sequential.closed).toBe(false);
    sequential.socket.destroy();
    const pipelined = client(port, get("/fast").repeat(4));
    await expect.poll(() => pipelined.received.split("fast done").length - 1).toBe(4);
    expect(pipelined.closed).toBe(false);
    pipelined.socket.destroy();
  });

  it("lets a client that is reading an answer when shutdown begins go on reading for one short window", async () => {
    const { service, sockets, port } = await start(30_000);
    // About four seconds for the whole body at this rate.
    const reader = throttledClient(port, get("/large"), 8 * 1024 * 1024);
    await expect.poll(() => reader.bytes, { timeout: 5_000 }).toBeGreaterThan(2 * 1024 * 1024);
    const atShutdown = reader.bytes;
    const closing = performance.now();
    const elapsed = await new Promise<number>((resolve) => {
      service.close(() => {
        resolve(performance.now() - closing);
      });
    });
    expect(elapsed).toBeGreaterThanOrEqual(SHUTDOWN_WRITE_MS - 100);
    expect(elapsed).toBeLessThan(SHUTDOWN_WRITE_MS + 3_000);
    expect(reader.bytes).toBeGreaterThan(atShutdown);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    reader.socket.destroy();
  });

  it("drops a connection whose request has not fully arrived when shutdown begins", async () => {
    const { service, sockets, port } = await start(30_000);
    const partial = connect(port, "127.0.0.1", () =>
      partial.write("GET /fast HTTP/1.1\r\nHost: 127.0.0.1\r\n"),
    );
    partial.on("error", () => undefined);
    await expect.poll(() => sockets.length).toBe(1);
    const closing = performance.now();
    const elapsed = await new Promise<number>((resolve) => {
      service.close(() => {
        resolve(performance.now() - closing);
      });
    });
    expect(elapsed).toBeLessThan(2_000);
    partial.destroy();
  });

  describe.each([
    ["an invalid Host, refused before the app is reached", "GET /fast HTTP/1.1\r\nHost: bad host\r\n\r\n"],
    [
      "an expectation the server cannot meet, answered 417 by Node",
      "GET /fast HTTP/1.1\r\nHost: 127.0.0.1\r\nExpect: foo\r\n\r\n",
    ],
  ])("answers given without the app: %s", (_label, request) => {
    /** A connection that pipelines `count` such requests and never reads an answer. */
    const flood = (port: number, count: number) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.pause();
        socket.write(request.repeat(count));
      });
      socket.on("error", () => undefined);
      return socket;
    };

    it(
      "are timed: a connection that does not read them is reset within the deadline",
      { timeout: 90_000 },
      async () => {
        const { sockets, port, reasons } = await start(1_000, 1_000_000);
        const socket = flood(port, 100_000);
        await expect.poll(() => sockets[0]?.destroyed, { timeout: 60_000, interval: 50 }).toBe(true);
        expect(reasons).toEqual(["write_timeout"]);
        socket.destroy();
      },
    );

    it("count toward the requests one connection may have waiting", { timeout: 30_000 }, async () => {
      const { sockets, port, reasons } = await start(30_000, 4);
      const socket = flood(port, 1_000);
      await expect.poll(() => sockets[0]?.destroyed, { timeout: 20_000, interval: 50 }).toBe(true);
      expect(reasons).toEqual(["backlog"]);
      socket.destroy();
    });
  });

  it("drops a request whose body is still arriving when shutdown begins", async () => {
    const { service, sockets, port } = await start(30_000);
    const trickle = connect(port, "127.0.0.1", () =>
      trickle.write("POST /echo HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\nhello"),
    );
    trickle.on("error", () => undefined);
    await expect.poll(() => sockets.length).toBe(1);
    await sleep(100);
    const closing = performance.now();
    const elapsed = await new Promise<number>((resolve) => {
      service.close(() => {
        resolve(performance.now() - closing);
      });
    });
    expect(elapsed).toBeLessThan(2_000);
    expect(sockets[0]?.destroyed).toBe(true);
    trickle.destroy();
  });
});
