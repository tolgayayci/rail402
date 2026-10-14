import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSafeFetch, finalRequestOf, type EgressError, type SafeFetch } from "@rail402.dev/safe-fetch";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

/** A local server that records requests and answers from a route table. */
describe("createSafeFetch", () => {
  const seen: Seen[] = [];
  const routes: Record<string, (request: IncomingMessage, response: ServerResponse) => void> = {
    "/json": (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    },
    "/echo": (_request, response) => {
      response.writeHead(200).end(seen.at(-1)?.body ?? "");
    },
    "/cookies": (_request, response) => {
      response.setHeader("set-cookie", ["a=1", "b=2"]);
      response.setHeader("x-multi", ["one", "two"]);
      response.writeHead(200).end("ok");
    },
    "/empty": (_request, response) => {
      response.writeHead(204).end();
    },
    "/gzip": (_request, response) => {
      response.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync("hello, compressed"));
    },
    "/bomb": (_request, response) => {
      response.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(Buffer.alloc(8 * 1024 * 1024)));
    },
    "/zstd": (_request, response) => {
      response.writeHead(200, { "content-encoding": "zstd" }).end("x");
    },
    "/big": (_request, response) => {
      response.writeHead(200).end(Buffer.alloc(2_000_000, 97));
    },
    "/huge-header": (_request, response) => {
      response.writeHead(200, { "x-huge": "a".repeat(100_000) }).end("ok");
    },
    "/hang": () => undefined,
    "/late": (_request, response) => {
      setTimeout(() => response.writeHead(200).end("late"), 600);
    },
    "/stall": (_request, response) => {
      response.writeHead(200);
      response.write("partial");
    },
    "/redirect": (_request, response) => {
      response.writeHead(302, { location: "/json" }).end();
    },
    "/see-other": (_request, response) => {
      response.writeHead(303, { location: "/echo" }).end();
    },
    "/temporary": (_request, response) => {
      response.writeHead(307, { location: "/echo" }).end();
    },
    "/loop": (_request, response) => {
      response.writeHead(302, { location: "/loop" }).end();
    },
    "/cross": (_request, response) => {
      response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    },
    "/not-modified": (_request, response) => {
      response.writeHead(304).end();
    },
  };
  let server: Server;
  let port: number;
  let origin: string;
  let fetch: SafeFetch;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const path = request.url ?? "";
        seen.push({
          method: request.method ?? "",
          path,
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        const route = routes[path];
        if (route === undefined) response.writeHead(404).end();
        else route(request, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${String(port)}`;
    fetch = createSafeFetch({ schemes: ["http:"], ports: [port], allowPrivateNetwork: "loopback" });
  });

  afterAll(async () => {
    fetch.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    seen.length = 0;
  });

  const failure = async (promise: Promise<unknown>): Promise<EgressError> => {
    try {
      await promise;
    } catch (error) {
      return error as EgressError;
    }
    throw new Error("expected a rejection");
  };

  it("returns a native Response with the final URL", async () => {
    const response = await fetch(`${origin}/json`);
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.url).toBe(`${origin}/json`);
    expect(response.redirected).toBe(false);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("sends its user agent, accept and identity encoding, and drops connection headers", async () => {
    await (
      await fetch(`${origin}/json`, {
        headers: {
          host: "evil.example",
          "transfer-encoding": "chunked",
          "x-custom": "1",
          "proxy-authorization": "x",
        },
      })
    ).text();
    const headers = seen[0]?.headers ?? {};
    expect(headers["user-agent"]).toMatch(/^rail402\//);
    expect(headers["accept"]).toBe("*/*");
    expect(headers["accept-encoding"]).toBe("identity");
    expect(headers["host"]).toBe(`127.0.0.1:${String(port)}`);
    expect(headers["x-custom"]).toBe("1");
    expect(headers["proxy-authorization"]).toBeUndefined();
  });

  it("sends string and byte bodies with their length", async () => {
    const response = await fetch(`${origin}/echo`, { method: "post", body: "héllo" });
    expect(await response.text()).toBe("héllo");
    expect(seen[0]).toMatchObject({ method: "POST" });
    expect(seen[0]?.headers["content-type"]).toBe("text/plain;charset=UTF-8");
    expect(seen[0]?.headers["content-length"]).toBe("6");
    const bytes = await fetch(`${origin}/echo`, { method: "PUT", body: new Uint8Array([104, 105]) });
    expect(await bytes.text()).toBe("hi");
  });

  it("refuses oversized requests before sending anything", async () => {
    const small = createSafeFetch({
      schemes: ["http:"],
      ports: [port],
      allowPrivateNetwork: "loopback",
      limits: { requestBodyBytes: 10, requestHeaderBytes: 64 },
    });
    expect((await failure(small(`${origin}/echo`, { method: "POST", body: "x".repeat(11) }))).code).toBe(
      "egress_request_too_large",
    );
    expect((await failure(small(`${origin}/echo`, { headers: { "x-long": "y".repeat(100) } }))).code).toBe(
      "egress_request_too_large",
    );
    // The payment header is large by design and does not count against the budget.
    const paid = await small(`${origin}/json`, { headers: { "payment-signature": "z".repeat(4_000) } });
    expect(paid.status).toBe(200);
    await paid.text();
    expect(seen.map((request) => request.path)).toEqual(["/json"]);
    small.close();
  });

  it("refuses bodies on GET and forbidden methods", async () => {
    await expect(fetch(`${origin}/echo`, { body: "x" })).rejects.toThrow(TypeError);
    await expect(fetch(`${origin}/echo`, { method: "TRACE" })).rejects.toThrow(TypeError);
    await expect(fetch(`${origin}/echo`, { method: "bad method" })).rejects.toThrow(TypeError);
    expect(seen).toEqual([]);
  });

  it("keeps multi-value headers", async () => {
    const response = await fetch(`${origin}/cookies`);
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(response.headers.get("x-multi")).toBe("one, two");
    await response.text();
  });

  it("has no body for 204, 304 and HEAD", async () => {
    expect((await fetch(`${origin}/empty`)).body).toBeNull();
    expect((await fetch(`${origin}/not-modified`)).body).toBeNull();
    const head = await fetch(`${origin}/json`, { method: "HEAD" });
    expect(head.body).toBeNull();
    expect(head.status).toBe(200);
  });

  it("decodes gzip and counts the limit after decoding", async () => {
    const response = await fetch(`${origin}/gzip`);
    expect(await response.text()).toBe("hello, compressed");
    expect(response.headers.get("content-encoding")).toBeNull();

    const bomb = await fetch(`${origin}/bomb`);
    const error = await failure(bomb.arrayBuffer());
    expect(error.code).toBe("egress_response_too_large");
    expect(error.stage).toBe("response");
  });

  it("refuses unsupported content encodings", async () => {
    expect((await failure(fetch(`${origin}/zstd`))).code).toBe("egress_response_too_large");
  });

  it("caps the body and the headers", async () => {
    const big = await fetch(`${origin}/big`);
    expect((await failure(big.text())).code).toBe("egress_response_too_large");
    const small = createSafeFetch({
      schemes: ["http:"],
      ports: [port],
      allowPrivateNetwork: "loopback",
      limits: { responseHeaderBytes: 16_384 },
    });
    expect((await failure(small(`${origin}/huge-header`))).code).toBe("egress_response_too_large");
    small.close();
  });

  it("times out waiting for headers, on an idle body, and in total", async () => {
    const quick = createSafeFetch({
      schemes: ["http:"],
      ports: [port],
      allowPrivateNetwork: "loopback",
      timeouts: { headersMs: 200 },
    });
    const headers = await failure(quick(`${origin}/hang`));
    expect(headers.code).toBe("egress_timeout");

    const stalled = await quick(`${origin}/stall`, { timeouts: { idleMs: 200 } });
    expect((await failure(stalled.text())).code).toBe("egress_timeout");

    const total = await failure(quick(`${origin}/hang`, { timeouts: { headersMs: 10_000, totalMs: 200 } }));
    expect(total.code).toBe("egress_timeout");
    quick.close();
  });

  it("lets a server stay silent until the headers timeout, then applies the idle timeout", async () => {
    const patient = createSafeFetch({
      schemes: ["http:"],
      ports: [port],
      allowPrivateNetwork: "loopback",
      timeouts: { idleMs: 200, headersMs: 2_000 },
    });
    // Longer than idleMs before the headers, within headersMs: the answer arrives.
    expect(await (await patient(`${origin}/late`)).text()).toBe("late");
    // Once the headers arrived, a silent body still ends at idleMs.
    const stalled = await patient(`${origin}/stall`);
    expect((await failure(stalled.text())).code).toBe("egress_timeout");
    patient.close();
  });

  it("rejects with the caller's reason on abort", async () => {
    const controller = new AbortController();
    const pending = fetch(`${origin}/hang`, { signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 50);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const aborted = AbortSignal.abort(new Error("stop"));
    await expect(fetch(`${origin}/json`, { signal: aborted })).rejects.toThrow("stop");
  });

  it("refuses redirects by default", async () => {
    const error = await failure(fetch(`${origin}/redirect`));
    expect(error.code).toBe("egress_redirect_not_allowed");
    expect(seen.map((request) => request.path)).toEqual(["/redirect"]);
  });

  it("follows same-origin redirects when asked, with fetch's method rules", async () => {
    const response = await fetch(`${origin}/redirect`, { redirect: "same-origin" });
    expect(response.url).toBe(`${origin}/json`);
    expect(response.redirected).toBe(true);
    expect(await response.json()).toEqual({ ok: true });

    expect(finalRequestOf(response)).toEqual({ method: "GET", bodyDropped: false });

    seen.length = 0;
    const seeOther = await fetch(`${origin}/see-other`, {
      method: "POST",
      body: "data",
      redirect: "same-origin",
    });
    expect(finalRequestOf(seeOther)).toEqual({ method: "GET", bodyDropped: true });
    await seeOther.text();
    expect(seen.map((request) => [request.method, request.path, request.body])).toEqual([
      ["POST", "/see-other", "data"],
      ["GET", "/echo", ""],
    ]);
    expect(seen[1]?.headers["content-type"]).toBeUndefined();

    seen.length = 0;
    const temporary = await fetch(`${origin}/temporary`, {
      method: "POST",
      body: "data",
      redirect: "same-origin",
    });
    expect(finalRequestOf(temporary)).toEqual({ method: "POST", bodyDropped: false });
    await temporary.text();
    expect(seen.map((request) => [request.method, request.body])).toEqual([
      ["POST", "data"],
      ["POST", "data"],
    ]);
  });

  it("stops redirect loops and cross-origin hops", async () => {
    expect((await failure(fetch(`${origin}/loop`, { redirect: "same-origin" }))).code).toBe(
      "egress_too_many_redirects",
    );
    expect(seen).toHaveLength(4);
    expect((await failure(fetch(`${origin}/cross`, { redirect: "same-origin" }))).code).toBe(
      "egress_redirect_not_allowed",
    );
  });

  it("maps a refused connection", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const other = createSafeFetch({
      schemes: ["http:"],
      ports: [closedPort],
      allowPrivateNetwork: "loopback",
    });
    const error = await failure(other(`http://127.0.0.1:${String(closedPort)}/`));
    expect(error.code).toBe("egress_connection_failed");
    expect(error.retryable).toBe(true);
    expect(error.reason).not.toContain("127.0.0.1");
    other.close();
  });

  it("opens at most maxSocketsPerHost connections to one host", async () => {
    const open = new Set<unknown>();
    let peak = 0;
    const slow = createServer((_request, response) => {
      setTimeout(() => response.writeHead(200).end("ok"), 50);
    });
    slow.on("connection", (socket) => {
      open.add(socket);
      peak = Math.max(peak, open.size);
      socket.on("close", () => open.delete(socket));
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const slowPort = (slow.address() as AddressInfo).port;
    const peakWith = async (maxSocketsPerHost: number): Promise<number> => {
      peak = 0;
      open.clear();
      const limited = createSafeFetch({
        schemes: ["http:"],
        ports: [slowPort],
        allowPrivateNetwork: "loopback",
        maxSocketsPerHost,
      });
      try {
        const texts = await Promise.all(
          Array.from({ length: 3 }, async () =>
            (await limited(`http://127.0.0.1:${String(slowPort)}/`)).text(),
          ),
        );
        expect(texts).toEqual(["ok", "ok", "ok"]);
        return peak;
      } finally {
        limited.close();
        slow.closeAllConnections();
      }
    };
    try {
      expect(await peakWith(3)).toBe(3);
      expect(await peakWith(1)).toBe(1);
    } finally {
      await new Promise((resolve) => slow.close(resolve));
    }
  });

  it("closes kept connections that sit unused and caps connections across hosts", async () => {
    const open = new Set<unknown>();
    let active = 0;
    let peak = 0;
    const keepAlive = createServer((_request, response) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        response.writeHead(200).end("ok");
      }, 30);
    });
    keepAlive.keepAliveTimeout = 60_000;
    keepAlive.on("connection", (socket) => {
      open.add(socket);
      socket.on("close", () => open.delete(socket));
    });
    await new Promise<void>((resolve) => keepAlive.listen(0, "127.0.0.1", resolve));
    const keepPort = (keepAlive.address() as AddressInfo).port;
    // Every name resolves to the local server: each is its own connection pool.
    const pooled = createSafeFetch({
      schemes: ["http:"],
      ports: [keepPort],
      allowPrivateNetwork: "loopback",
      resolve: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
      maxTotalSockets: 3,
      idleSocketMs: 200,
    });
    try {
      const texts = await Promise.all(
        Array.from({ length: 9 }, async (_, index) =>
          (await pooled(`http://host-${String(index)}.example:${String(keepPort)}/`)).text(),
        ),
      );
      expect(texts.every((text) => text === "ok")).toBe(true);
      expect(peak).toBeLessThanOrEqual(3);
      expect(open.size).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(open.size).toBe(0);
    } finally {
      pooled.close();
      keepAlive.closeAllConnections();
      await new Promise((resolve) => keepAlive.close(resolve));
    }
  });

  it("closes every connection after its answer when keepAlive is off", async () => {
    const open = new Set<unknown>();
    const server2 = createServer((_request, response) => response.writeHead(200).end("ok"));
    server2.keepAliveTimeout = 60_000;
    server2.on("connection", (socket) => {
      open.add(socket);
      socket.on("close", () => open.delete(socket));
    });
    await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", resolve));
    const port2 = (server2.address() as AddressInfo).port;
    const once = createSafeFetch({
      schemes: ["http:"],
      ports: [port2],
      allowPrivateNetwork: "loopback",
      keepAlive: false,
    });
    try {
      expect(await (await once(`http://127.0.0.1:${String(port2)}/`)).text()).toBe("ok");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(open.size).toBe(0);
    } finally {
      once.close();
      server2.closeAllConnections();
      await new Promise((resolve) => server2.close(resolve));
    }
  });

  it("maps DNS failures", async () => {
    const other = createSafeFetch({
      schemes: ["http:"],
      ports: [port],
      resolve: () => Promise.reject(new Error("NXDOMAIN")),
    });
    const error = await failure(other(`http://missing.example.com:${String(port)}/`));
    expect(error).toMatchObject({ code: "egress_dns_failed", stage: "dns", retryable: true });
    other.close();
  });

  describe("the connected-address check", () => {
    /**
     * Makes every client socket opened during `run` report `remote` as its peer, the way a socket
     * would if the connection landed somewhere other than the address the lookup handed out.
     */
    const reportingPeer = async <T>(remote: string, run: () => Promise<T>): Promise<T> => {
      const onSocket = (message: unknown) => {
        const { socket } = message as { socket: Socket };
        Object.defineProperty(socket, "remoteAddress", { get: () => remote });
      };
      subscribe("net.client.socket", onSocket);
      try {
        return await run();
      } finally {
        unsubscribe("net.client.socket", onSocket);
      }
    };
    const pinned = () =>
      createSafeFetch({
        schemes: ["http:"],
        ports: [port],
        allowPrivateNetwork: "loopback",
        keepAlive: false,
        resolve: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
      });

    it("accepts a connection to the address the lookup validated, in either spelling", async () => {
      const other = pinned();
      for (const remote of ["127.0.0.1", "::ffff:127.0.0.1"]) {
        const response = await reportingPeer(remote, () =>
          other(`http://api.example.com:${String(port)}/json`),
        );
        expect(await response.json()).toEqual({ ok: true });
      }
      other.close();
    });

    it("refuses a connection that reached an allowed address the lookup never validated", async () => {
      const other = pinned();
      const error = await reportingPeer("127.0.0.2", () =>
        failure(other(`http://api.example.com:${String(port)}/json`)),
      );
      expect(error).toMatchObject({
        code: "egress_destination_not_allowed",
        stage: "connect",
        retryable: false,
      });
      expect(error.reason).toContain("api.example.com");
      expect(error.reason).not.toContain("127.0.0");
      // The check runs before the request is written: the server never saw it.
      expect(seen).toHaveLength(0);
      other.close();
    });

    it("refuses a connection that reached a private address, even for an IP-literal URL", async () => {
      const other = pinned();
      for (const remote of ["10.0.0.7", "169.254.169.254"]) {
        const error = await reportingPeer(remote, () => failure(other(`${origin}/json`)));
        expect(error).toMatchObject({ code: "egress_destination_not_allowed", stage: "connect" });
        expect(error.reason).not.toContain(remote);
      }
      expect(seen).toHaveLength(0);
      other.close();
    });
  });
});
