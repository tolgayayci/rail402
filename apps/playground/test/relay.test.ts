import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  RELAY_PATH,
  encodeRelayRequest,
  parseRelayResponseMeta,
  type RelayRequest,
} from "../src/shared/relay-protocol.ts";
import { testApp, testConfig, type TestApp } from "./support.ts";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

/** A payment-shaped header: the relay counts only these as paid; the facilitator judges the rest. */
const PAYMENT = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    accepted: { scheme: "exact", network: "stellar:testnet" },
    payload: { transaction: "payment-canary" },
  }),
).toString("base64");

/** A local seller that records requests and answers from a route table. */
describe("relay", () => {
  const seen: Seen[] = [];
  const closed: string[] = [];
  const routes: Record<string, (request: IncomingMessage, response: ServerResponse) => void> = {
    "/paid": (_request, response) => {
      response.setHeader("set-cookie", "session=cookie-canary");
      response.writeHead(402, "Payment Required", {
        "content-type": "application/json",
        "payment-required": "eyJ4NDAyVmVyc2lvbiI6Mn0",
        location: "https://elsewhere.example/",
        "x-internal": "hidden",
        "cache-control": "no-store",
      });
      response.end('{"error":"pay first"}');
    },
    "/echo": (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(seen.at(-1)));
    },
    "/stream": (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "session-1" });
      response.write("event: message\ndata: one\n\n");
      setTimeout(() => response.end("event: message\ndata: two\n\n"), 50);
    },
    "/redirect": (_request, response) => {
      response.writeHead(302, { location: "/echo" }).end();
    },
    "/big": (_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.alloc(1_100_000, 97));
    },
    "/hang": (request) => {
      request.on("close", () => closed.push("/hang"));
    },
  };
  let server: Server;
  let origin: string;
  let app: TestApp | undefined;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://seller");
        seen.push({
          method: request.method ?? "",
          path: url.pathname + url.search,
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        const route = routes[url.pathname];
        if (route === undefined) response.writeHead(404).end();
        else route(request, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  afterEach(() => {
    app?.close();
    app = undefined;
  });

  /** The app in local mode, so the relay may reach the loopback seller. */
  function localApp(env: Record<string, string> = {}): TestApp {
    app = testApp(
      testConfig({
        PLAYGROUND_MODE: "local",
        PUBLIC_URL: "http://127.0.0.1:1",
        TRUSTED_PROXY_HOPS: "1",
        ...env,
      }),
    );
    return app;
  }

  function relay(
    target: string,
    options: Partial<RelayRequest> & {
      body?: string;
      extra?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const headers = encodeRelayRequest({
      target,
      method: options.method ?? "GET",
      redirect: options.redirect ?? "error",
      timeouts: options.timeouts,
      headers: options.headers ?? {},
    });
    if (app === undefined) throw new Error("no app");
    return app.request(RELAY_PATH, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.1", ...headers, ...options.extra },
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async function relayError(
    response: Response,
  ): Promise<{ code: string; reason: string; details?: { stage?: string } }> {
    expect(response.headers.get("x-relay")).toBe("error");
    const body = (await response.json()) as {
      error: { code: string; reason: string; details?: { stage?: string } };
    };
    expect(body.error.reason).not.toBe("");
    return body.error;
  }

  it("passes a seller's answer back with its status and allowlisted headers only", async () => {
    localApp();
    const response = await relay(`${origin}/paid?city=Ankara`, { headers: { accept: "application/json" } });
    expect(response.status).toBe(200);
    const parsed = parseRelayResponseMeta((name) => response.headers.get(name));
    expect(parsed).toEqual({
      kind: "upstream",
      meta: {
        status: 402,
        statusText: "Payment Required",
        url: `${origin}/paid?city=Ankara`,
        method: "GET",
        redirected: false,
        bodyDropped: false,
        ttfbMs: expect.any(Number) as number,
        headers: {
          "content-type": "application/json",
          "payment-required": "eyJ4NDAyVmVyc2lvbiI6Mn0",
          "cache-control": "no-store",
        },
      },
    });
    for (const dropped of ["set-cookie", "location", "x-internal"]) {
      expect(response.headers.get(`x-relay-h-${dropped}`)).toBeNull();
      expect(response.headers.get(dropped)).toBeNull();
    }
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.text()).toBe('{"error":"pay first"}');
  });

  it("forwards the method, body and allowlisted headers, with its own user agent", async () => {
    localApp();
    const response = await relay(`${origin}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": PAYMENT, "mcp-session-id": "s-1" },
      body: '{"jsonrpc":"2.0"}',
      extra: { cookie: "session=cookie-canary", authorization: "Bearer token-canary" },
    });
    expect(response.headers.get("x-relay-status")).toBe("200");
    const echoed = (await response.json()) as Seen;
    expect(echoed.method).toBe("POST");
    expect(echoed.body).toBe('{"jsonrpc":"2.0"}');
    expect(echoed.headers["payment-signature"]).toBe(PAYMENT);
    expect(echoed.headers["mcp-session-id"]).toBe("s-1");
    expect(echoed.headers["content-type"]).toBe("application/json");
    expect(echoed.headers["user-agent"]).toBe("rail402-playground/0.3.0 (+http://127.0.0.1:1)");
    for (const name of ["cookie", "authorization", "x-forwarded-for", "x-relay-target"]) {
      expect(echoed.headers[name]).toBeUndefined();
    }
  });

  it("streams an event stream through as it arrives", async () => {
    localApp();
    const response = await relay(`${origin}/stream`, { headers: { accept: "text/event-stream" } });
    expect(response.headers.get("x-relay-h-content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-relay-h-mcp-session-id")).toBe("session-1");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("event: message\ndata: one\n\n");
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe("event: message\ndata: two\n\n");
  });

  it("refuses headers off the allowlist, unknown methods and bad targets", async () => {
    localApp();
    const header = await relayError(await relay(`${origin}/echo`, { extra: { "x-relay-h-cookie": "a=1" } }));
    expect(header.code).toBe("playground_relay_header_not_allowed");
    const method = await relay(`${origin}/echo`, { extra: { "x-relay-method": "TRACE" } });
    expect(method.status).toBe(405);
    expect((await relayError(method)).code).toBe("playground_relay_method_not_allowed");
    const target = await relay("not a url");
    expect(target.status).toBe(400);
    expect((await relayError(target)).code).toBe("playground_relay_target_invalid");
    const long = await relay(`${origin}/${"a".repeat(2_100)}`);
    expect((await relayError(long)).code).toBe("playground_relay_target_invalid");
    const body = await relay(`${origin}/echo`, { method: "GET", body: "x" });
    expect((await relayError(body)).code).toBe("playground_request_invalid");
    const get = await app?.request(RELAY_PATH);
    expect(get?.status).toBe(400);
    expect(get?.headers.get("allow")).toBe("POST");
  });

  it("answers only same-origin requests from the page", async () => {
    localApp();
    const crossSite = await relay(`${origin}/echo`, { extra: { "sec-fetch-site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    expect((await relayError(crossSite)).code).toBe("playground_origin_not_allowed");
    const otherOrigin = await relay(`${origin}/echo`, { extra: { origin: "https://evil.example" } });
    expect((await relayError(otherOrigin)).code).toBe("playground_origin_not_allowed");
    const page = await relay(`${origin}/echo`, {
      extra: { origin: "http://127.0.0.1:1", "sec-fetch-site": "same-origin" },
    });
    expect(page.headers.get("x-relay")).toBe("upstream");
  });

  it("never calls the Playground itself, the facilitator, the Bazaar or a denied host", async () => {
    localApp({
      FACILITATOR_URL: "http://localhost:4021",
      BAZAAR_URL: "http://127.0.0.1:4022",
      RELAY_DENY_HOSTS: "blocked.example",
    });
    const loop = await relay("http://localhost:1/lab/sell/forecast/Ankara");
    expect(loop.status).toBe(403);
    expect((await relayError(loop)).code).toBe("playground_relay_loop");
    for (const target of ["http://127.0.0.1:4021/verify", "http://localhost:4022/discovery/search"]) {
      expect((await relayError(await relay(target))).code).toBe("playground_relay_target_denied");
    }
    expect((await relayError(await relay("https://Blocked.Example./x"))).code).toBe(
      "playground_relay_target_denied",
    );
    expect(seen.some((request) => request.path.startsWith("/lab/"))).toBe(false);
  });

  it("refuses a body over 64 KiB before contacting the seller", async () => {
    localApp();
    const before = seen.length;
    const response = await relay(`${origin}/echo`, { method: "POST", body: "a".repeat(65_537) });
    expect(response.status).toBe(413);
    expect((await relayError(response)).code).toBe("playground_request_too_large");
    expect(seen.length).toBe(before);
  });

  it("follows same-origin redirects only for unpaid requests that ask for them", async () => {
    localApp();
    const refused = await relay(`${origin}/redirect`);
    expect(refused.status).toBe(403);
    expect(await relayError(refused)).toMatchObject({
      code: "egress_redirect_not_allowed",
      details: { stage: "redirect" },
    });
    const followed = await relay(`${origin}/redirect`, { redirect: "same-origin" });
    expect(followed.headers.get("x-relay-redirected")).toBe("true");
    expect(followed.headers.get("x-relay-url")).toBe(`${origin}/echo`);
    await followed.body?.cancel();
    const paid = await relay(`${origin}/redirect`, {
      redirect: "same-origin",
      headers: { "payment-signature": PAYMENT },
    });
    expect((await relayError(paid)).code).toBe("egress_redirect_not_allowed");
  });

  it("cuts a seller body past 1 MiB", async () => {
    localApp();
    const response = await relay(`${origin}/big`);
    expect(response.headers.get("x-relay")).toBe("upstream");
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it("applies the page's timeouts and reports the egress stage", async () => {
    localApp();
    const response = await relay(`${origin}/hang`, { timeouts: { headersMs: 200 } });
    expect(response.status).toBe(504);
    expect(await relayError(response)).toMatchObject({ code: "egress_timeout" });
  });

  it("aborts the upstream request when the page goes away", async () => {
    localApp();
    const controller = new AbortController();
    const pending = relay(`${origin}/hang`, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toContain("/hang");
  });

  it("limits unpaid and paid calls per client, with Retry-After", async () => {
    localApp({ RELAY_UNPAID_PER_MINUTE: "60", RELAY_UNPAID_BURST: "2", RELAY_PAID_PER_MINUTE: "1" });
    for (let index = 0; index < 2; index++) await (await relay(`${origin}/echo`)).text();
    const limited = await relay(`${origin}/echo`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    expect((await relayError(limited)).code).toBe("playground_rate_limited");
    const otherClient = await relay(`${origin}/echo`, { extra: { "x-forwarded-for": "198.51.100.2" } });
    expect(otherClient.headers.get("x-relay")).toBe("upstream");
    await otherClient.text();

    const paid = { headers: { "payment-signature": PAYMENT } };
    await (await relay(`${origin}/echo`, { ...paid, extra: { "x-forwarded-for": "198.51.100.3" } })).text();
    const paidLimited = await relay(`${origin}/echo`, {
      ...paid,
      extra: { "x-forwarded-for": "198.51.100.3" },
    });
    expect(paidLimited.status).toBe(429);
    expect(Number(paidLimited.headers.get("retry-after"))).toBeGreaterThanOrEqual(59);
  });

  it("limits requests per destination host across clients", async () => {
    localApp({ RELAY_HOST_PER_MINUTE: "1", RELAY_TRUSTED_HOSTS: "" });
    await (await relay(`${origin}/echo`)).text();
    const busy = await relay(`${origin}/echo`, { extra: { "x-forwarded-for": "198.51.100.9" } });
    expect(busy.status).toBe(429);
    expect((await relayError(busy)).code).toBe("playground_relay_host_busy");
  });

  it("refuses a payment header that holds no payment before any limit counts it", async () => {
    localApp({ RELAY_PAID_PER_MINUTE: "1", RELAY_PAID_GLOBAL_PER_MINUTE: "1" });
    for (const junk of ["junk", "e30", Buffer.from('{"x402Version":2}').toString("base64")]) {
      const refused = await relay(`${origin}/echo`, { headers: { "payment-signature": junk } });
      expect(refused.status).toBe(400);
      expect((await relayError(refused)).code).toBe("playground_request_invalid");
    }
    // The junk took no paid token: a real payment still goes through.
    const paid = await relay(`${origin}/echo`, { headers: { "payment-signature": PAYMENT } });
    expect(paid.headers.get("x-relay")).toBe("upstream");
    await paid.text();
  });

  it("gives one network at most its share of the global paid budget", async () => {
    localApp({ RELAY_PAID_PER_MINUTE: "1", RELAY_PAID_GLOBAL_PER_MINUTE: "16", TRUSTED_PROXY_HOPS: "1" });
    const paidFrom = (address: string) =>
      relay(`${origin}/echo`, {
        headers: { "payment-signature": PAYMENT },
        extra: { "x-forwarded-for": address },
      });
    // Sixteen /56 prefixes inside one /48: two (16 / 8) get through, the rest wait for their share.
    const statuses: number[] = [];
    for (let index = 0; index < 16; index++) {
      const response = await paidFrom(`2001:db8:1:${(index * 256).toString(16)}::1`);
      statuses.push(response.headers.get("x-relay") === "upstream" ? 200 : response.status);
      await response.text();
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(2);
    expect(statuses.filter((status) => status === 429)).toHaveLength(14);
    // Another network still has the rest of the global budget.
    const other = await paidFrom("198.51.100.77");
    expect(other.headers.get("x-relay")).toBe("upstream");
    await other.text();
  });

  it("returns the client's tokens when the destination host is busy", async () => {
    localApp({ RELAY_HOST_PER_MINUTE: "1", RELAY_TRUSTED_HOSTS: "", RELAY_PAID_PER_MINUTE: "1" });
    await (await relay(`${origin}/echo`, { extra: { "x-forwarded-for": "198.51.100.40" } })).text();
    const paid = { headers: { "payment-signature": PAYMENT }, extra: { "x-forwarded-for": "198.51.100.41" } };
    const busy = await relay(`${origin}/echo`, paid);
    expect((await relayError(busy)).code).toBe("playground_relay_host_busy");
    const again = await relay(`${origin}/echo`, paid);
    // Still host-busy, not rate-limited: the first refusal took no paid token from the client.
    expect((await relayError(again)).code).toBe("playground_relay_host_busy");
  });

  it("limits requests in flight per client", async () => {
    localApp({ RELAY_IN_FLIGHT_PER_IP: "1" });
    const controller = new AbortController();
    const hanging = relay(`${origin}/hang`, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const busy = await relay(`${origin}/echo`);
    expect(busy.status).toBe(503);
    expect((await relayError(busy)).code).toBe("playground_relay_busy");
    controller.abort();
    await hanging.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const free = await relay(`${origin}/echo`);
    expect(free.headers.get("x-relay")).toBe("upstream");
    await free.text();
  });

  it("gives back the slots of an upload the client abandons", async () => {
    localApp({ RELAY_IN_FLIGHT_PER_IP: "1", RELAY_IN_FLIGHT_GLOBAL: "1" });
    if (app === undefined) throw new Error("no app");
    const headers = encodeRelayRequest({
      target: `${origin}/echo`,
      method: "POST",
      redirect: "error",
      headers: {},
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      let sent = false;
      // A body that sends a few bytes and then breaks, as a client that hangs up mid-upload does.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) {
            controller.error(new Error("connection reset"));
            return;
          }
          sent = true;
          controller.enqueue(new TextEncoder().encode("{"));
        },
      });
      const abandoned = await app.request(RELAY_PATH, {
        method: "POST",
        headers: { "x-forwarded-for": "198.51.100.60", ...headers },
        body,
        duplex: "half",
      });
      expect(abandoned.status).toBe(499);
    }
    const next = await relay(`${origin}/echo`, { extra: { "x-forwarded-for": "198.51.100.60" } });
    expect(next.headers.get("x-relay")).toBe("upstream");
    await next.text();
    expect(app.logs.text()).not.toContain("unexpected error");
  });

  it("forwards a body only as JSON, text or octet-stream", async () => {
    localApp();
    const form = await relay(`${origin}/echo`, {
      method: "POST",
      body: "a=1",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(400);
    expect((await relayError(form)).reason).toMatch(/application\/json/);
    const json = await relay(`${origin}/echo`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    expect(json.headers.get("x-relay")).toBe("upstream");
    await json.text();
  });

  it("counts an MCP tool call carrying a payment in its body as paid", async () => {
    localApp({ RELAY_PAID_PER_MINUTE: "1" });
    const decoded = JSON.parse(Buffer.from(PAYMENT, "base64").toString("utf8")) as unknown;
    const call = (meta: unknown) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "hourly_forecast", arguments: {}, _meta: { "x402/payment": meta } },
      });
    const send = (body: string) =>
      relay(`${origin}/echo`, {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
        extra: { "x-forwarded-for": "198.51.100.70" },
      });
    const first = await send(call(decoded));
    expect(first.headers.get("x-relay")).toBe("upstream");
    await first.text();
    const second = await send(call(decoded));
    expect(second.status).toBe(429);
    expect((await relayError(second)).code).toBe("playground_rate_limited");
    const junk = await send(call("junk"));
    expect(junk.status).toBe(400);
    expect((await relayError(junk)).code).toBe("playground_request_invalid");
  });

  it("keeps a paid pool of its own for the trusted hosts", async () => {
    localApp({ RELAY_TRUSTED_HOSTS: "127.0.0.1", RELAY_PAID_GLOBAL_PER_MINUTE: "1" });
    const port = new URL(origin).port;
    const paidFrom = (target: string, address: string) =>
      relay(target, { headers: { "payment-signature": PAYMENT }, extra: { "x-forwarded-for": address } });
    const other = await paidFrom(`http://localhost:${port}/echo`, "198.51.100.80");
    expect(other.headers.get("x-relay")).toBe("upstream");
    await other.text();
    const drained = await paidFrom(`http://localhost:${port}/echo`, "198.51.100.81");
    expect(drained.status).toBe(429);
    await drained.text();
    // The other hosts' pool is empty; the trusted host's is not.
    const trusted = await paidFrom(`${origin}/echo`, "198.51.100.82");
    expect(trusted.headers.get("x-relay")).toBe("upstream");
    await trusted.text();
  });

  it("gives one network at most its share of a destination host's budget", async () => {
    localApp({ RELAY_HOST_PER_MINUTE: "16", RELAY_UNPAID_PER_MINUTE: "1", RELAY_TRUSTED_HOSTS: "" });
    const outcomes: string[] = [];
    for (let index = 0; index < 8; index++) {
      const response = await relay(`${origin}/echo`, {
        extra: { "x-forwarded-for": `2001:db8:2:${(index * 256).toString(16)}::1` },
      });
      outcomes.push(
        response.headers.get("x-relay") === "upstream" ? "upstream" : (await relayError(response)).code,
      );
      await response.text().catch(() => undefined);
    }
    expect(outcomes.filter((outcome) => outcome === "upstream")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome === "playground_relay_host_busy")).toHaveLength(6);
    const other = await relay(`${origin}/echo`, { extra: { "x-forwarded-for": "198.51.100.90" } });
    expect(other.headers.get("x-relay")).toBe("upstream");
    await other.text();
  });

  it("limits unpaid calls per network across its clients", async () => {
    localApp({ RELAY_UNPAID_PER_NETWORK_PER_MINUTE: "3" });
    const statuses: number[] = [];
    for (let index = 0; index < 5; index++) {
      const response = await relay(`${origin}/echo`, {
        extra: { "x-forwarded-for": `2001:db8:3:${(index * 256).toString(16)}::1` },
      });
      statuses.push(response.headers.get("x-relay") === "upstream" ? 200 : response.status);
      await response.text();
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("stops every client once the relay's daily transfer budget is used up", async () => {
    localApp({ RELAY_BYTES_GLOBAL_PER_DAY: "1048576" });
    for (let index = 0; index < 2; index++) {
      await (
        await relay(`${origin}/big`, { extra: { "x-forwarded-for": `198.51.100.${String(100 + index)}` } })
      )
        .arrayBuffer()
        .catch(() => undefined);
    }
    const limited = await relay(`${origin}/echo`, { extra: { "x-forwarded-for": "198.51.100.120" } });
    expect(limited.status).toBe(429);
    expect((await relayError(limited)).reason).toMatch(/relay used up its daily/);
  });

  it("stops a client past its daily transfer budget", async () => {
    localApp({ RELAY_BYTES_PER_IP_PER_DAY: "1048576" });
    // Each cut body passes on just under 1 MiB; two of them use up the budget.
    for (let index = 0; index < 2; index++) {
      await (await relay(`${origin}/big`)).arrayBuffer().catch(() => undefined);
    }
    const limited = await relay(`${origin}/echo`);
    expect(limited.status).toBe(429);
    expect((await relayError(limited)).reason).toMatch(/daily relay transfer budget/);
  });

  it("is refused while switched off", async () => {
    localApp({ RELAY_ENABLED: "false" });
    const response = await relay(`${origin}/echo`);
    expect(response.status).toBe(503);
    expect((await relayError(response)).code).toBe("playground_feature_disabled");
  });

  it("logs the host and outcome, never the target path, query, headers or body", async () => {
    localApp();
    await (
      await relay(`${origin}/echo?q=query-canary`, {
        method: "POST",
        headers: { "payment-signature": PAYMENT },
        body: "body-canary",
      })
    ).text();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const line = app?.logs.lines.find((entry) => entry["route"] === RELAY_PATH);
    expect(line).toMatchObject({ host: "127.0.0.1", paid: true, upstreamStatus: 200, status: 200 });
    expect(line?.["bytes"]).toBeGreaterThan(0);
    const text = app?.logs.text() ?? "";
    for (const canary of ["query-canary", "body-canary", PAYMENT, "/echo"])
      expect(text).not.toContain(canary);
  });

  describe("in hosted mode", () => {
    function hostedApp(
      resolve?: (host: string) => Promise<{ address: string; family: 4 | 6 }[]>,
      env: Record<string, string> = {},
    ): TestApp {
      app = testApp(testConfig(env), resolve === undefined ? {} : { egress: { resolve } });
      return app;
    }

    it("refuses http, other ports, and private, loopback, mapped and metadata addresses before any lookup", async () => {
      hostedApp(() => Promise.reject(new Error("no lookup expected")));
      const cases: [string, string][] = [
        ["http://seller.example/", "egress_scheme_not_allowed"],
        ["https://seller.example:8443/", "egress_port_not_allowed"],
        ["https://127.0.0.1/", "egress_destination_not_allowed"],
        ["https://169.254.169.254/latest/meta-data/", "egress_destination_not_allowed"],
        ["https://10.1.2.3/", "egress_destination_not_allowed"],
        ["https://[::ffff:127.0.0.1]/", "egress_destination_not_allowed"],
        ["https://[::1]/", "egress_destination_not_allowed"],
        ["https://localhost/", "egress_destination_not_allowed"],
        ["https://user:pass@seller.example/", "egress_url_invalid"],
      ];
      for (const [target, code] of cases) {
        const error = await relayError(await relay(target));
        expect(error, target).toMatchObject({ code, details: { stage: "url" } });
      }
    });

    it("refuses a host whose name resolves to a private address", async () => {
      hostedApp((host) =>
        Promise.resolve(
          host === "rebind.example"
            ? [
                { address: "203.0.113.10", family: 4 },
                { address: "10.0.0.1", family: 4 },
              ]
            : [],
        ),
      );
      const error = await relayError(await relay("https://rebind.example/"));
      expect(error).toMatchObject({ code: "egress_destination_not_allowed", details: { stage: "dns" } });
    });

    it("treats the Playground's own host as a loop and the hosted Rail402 as denied", async () => {
      hostedApp();
      expect((await relayError(await relay("https://playground.example/lab/greedy/history"))).code).toBe(
        "playground_relay_loop",
      );
      expect((await relayError(await relay("https://testnet.rail402.dev/settle"))).code).toBe(
        "playground_relay_target_denied",
      );
    });

    it("treats the platform's generated domain as the Playground itself", async () => {
      hostedApp(undefined, { RAILWAY_PUBLIC_DOMAIN: "Playground-Production.up.railway.app" });
      expect((await relayError(await relay("https://playground-production.up.railway.app/lab/x"))).code).toBe(
        "playground_relay_loop",
      );
    });

    it("gives the shared paid pool its token back when nothing reached a seller", async () => {
      hostedApp(() => Promise.reject(new Error("NXDOMAIN")), {
        TRUSTED_PROXY_HOPS: "1",
        RELAY_PAID_PER_MINUTE: "1",
        RELAY_PAID_GLOBAL_PER_MINUTE: "1",
      });
      // Each client spends its own paid token; the pool every visitor shares is not drained.
      for (let index = 0; index < 3; index++) {
        const failed = await relay(`https://missing-${String(index)}.example/`, {
          headers: { "payment-signature": PAYMENT },
          extra: { "x-forwarded-for": `198.51.100.${String(130 + index)}` },
        });
        expect((await relayError(failed)).code).toBe("egress_dns_failed");
      }
      const again = await relay("https://missing.example/", {
        headers: { "payment-signature": PAYMENT },
        extra: { "x-forwarded-for": "198.51.100.130" },
      });
      expect((await relayError(again)).code).toBe("playground_rate_limited");
    });
  });
});
