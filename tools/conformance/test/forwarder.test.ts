import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeBase64Json, exchangesFor, startForwarder } from "../src/forwarder.ts";

/** A facilitator stand-in that echoes what it received and sets the headers a facilitator sets. */
let upstream: Server;
let upstreamUrl: string;
const received: { method: string; path: string; body: Buffer; headers: Record<string, unknown> }[] = [];

beforeAll(async () => {
  upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      received.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body,
        headers: request.headers,
      });
      if (request.url === "/settle") {
        response.writeHead(200, {
          "content-type": "application/json",
          "extension-responses": Buffer.from(
            JSON.stringify({ rail402: { settlement: { repeat: true } } }),
          ).toString("base64"),
        });
        response.end(
          JSON.stringify({ success: true, transaction: "a".repeat(64), network: "stellar:testnet" }),
        );
        return;
      }
      if (request.url?.startsWith("/verify") === true) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ isValid: false, invalidReason: "invalid_payload", invalidMessage: "no" }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ path: request.url, bytes: body.length }));
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  upstreamUrl = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
});

afterAll(() => {
  upstream.close();
});

describe("forwarder", () => {
  it("forwards bodies byte for byte and returns status, body and headers unchanged", async () => {
    const forwarder = await startForwarder({ target: upstreamUrl });
    try {
      // Spacing and key order a re-serialisation would change.
      const raw = '{ "x402Version":2,  "paymentPayload": {"payload":{"transaction":"AAAA"}} }';
      const settle = await fetch(`${forwarder.url}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      expect(settle.status).toBe(200);
      expect(decodeBase64Json(settle.headers.get("extension-responses"))).toEqual({
        rail402: { settlement: { repeat: true } },
      });
      expect(received.at(-1)?.body.toString("utf8")).toBe(raw);

      const verify = await fetch(`${forwarder.url}/verify?x=1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(verify.status).toBe(400);
      expect(await verify.json()).toEqual({
        isValid: false,
        invalidReason: "invalid_payload",
        invalidMessage: "no",
      });

      const [recorded] = exchangesFor(forwarder.exchanges, "/settle");
      expect(recorded).toMatchObject({
        method: "POST",
        path: "/settle",
        status: 200,
        route: "forwarded",
        requestBody: { x402Version: 2, paymentPayload: { payload: { transaction: "AAAA" } } },
        responseBody: { success: true },
      });
      expect(Buffer.from(recorded?.requestBytes ?? "", "base64").toString("utf8")).toBe(raw);
      expect(recorded?.responseHeaders["extension-responses"]).toBeDefined();
      expect(exchangesFor(forwarder.exchanges, "/verify")[0]?.path).toBe("/verify?x=1");
    } finally {
      await forwarder.close();
    }
  });

  it("in hosted mode answers /health and /close itself and forwards only facilitator routes", async () => {
    let closed = 0;
    const forwarder = await startForwarder({
      target: upstreamUrl,
      hosted: true,
      onClose: () => (closed += 1),
    });
    try {
      const before = received.length;
      expect(await (await fetch(`${forwarder.url}/health`)).json()).toMatchObject({ status: "ok" });
      const close = await fetch(`${forwarder.url}/close`, { method: "POST" });
      expect(await close.json()).toEqual({ message: "closing" });
      expect(closed).toBe(1);
      const refused = await fetch(`${forwarder.url}/usage`);
      expect(refused.status).toBe(404);
      expect(received.length).toBe(before);

      for (const path of ["/supported", "/discovery/resources?limit=1", "/discovery/search?query=a"]) {
        const response = await fetch(`${forwarder.url}${path}`);
        expect(response.status).toBe(200);
        expect(((await response.json()) as { path: string }).path).toBe(path);
      }
      expect(forwarder.exchanges.map((exchange) => exchange.route)).toEqual([
        "local",
        "local",
        "refused",
        "forwarded",
        "forwarded",
        "forwarded",
      ]);
    } finally {
      await forwarder.close();
    }
  });

  it("runs as the hosted facilitator command the e2e suite starts", async () => {
    const entry = fileURLToPath(new URL("../src/forwarder.ts", import.meta.url));
    const child = spawn(process.execPath, [entry, "--target", upstreamUrl, "--port", "0", "--hosted"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const [line] = (await once(child.stdout, "data")) as [Buffer];
      const match = /^Facilitator listening on port (\d+)/.exec(line.toString("utf8"));
      expect(match).not.toBeNull();
      const url = `http://127.0.0.1:${match?.[1] ?? ""}`;
      expect((await fetch(`${url}/supported`)).status).toBe(200);
      const exited = once(child, "exit");
      await fetch(`${url}/close`, { method: "POST" });
      const [code] = (await exited) as [number];
      expect(code).toBe(0);
    } finally {
      child.kill();
    }
  });
});
