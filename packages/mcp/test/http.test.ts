import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { localhostAllowedHostnames } from "@modelcontextprotocol/server";
import { createRail402Mcp, startHttpTransport, type RunningHttpTransport } from "@rail402.dev/mcp";
import { fakeBuyer } from "./helpers.ts";

const token = randomBytes(32).toString("base64url");
const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
});

/** A raw request, so headers such as Host can be set freely. */
function send(
  port: number,
  options: { path?: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: options.path ?? "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    outgoing.on("error", (error: NodeJS.ErrnoException) => {
      // The server may close early on an oversized body after answering.
      if (error.code === "ECONNRESET" || error.code === "EPIPE") return;
      reject(error);
    });
    outgoing.end(options.body ?? initialize);
  });
}

describe("HTTP transport", () => {
  let running: RunningHttpTransport;
  const authorization = `Bearer ${token}`;

  beforeAll(async () => {
    const { factory } = createRail402Mcp({ buyer: fakeBuyer() });
    running = await startHttpTransport(factory, {
      host: "127.0.0.1",
      port: 0,
      token,
      allowedHosts: localhostAllowedHostnames(),
      allowedOrigins: ["localhost", "127.0.0.1", "[::1]"],
    });
  });
  afterAll(() => running.close());

  it("listens on loopback and serves a client that presents the token", async () => {
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(running.url), {
        requestInit: { headers: { authorization } },
      }),
    );
    const result = await client.callTool({ name: "get_budget", arguments: {} });
    expect(result.structuredContent).toMatchObject({ ok: true, payments: "enabled" });
    await client.close();
  });

  it.each([
    ["no token", {}],
    ["a wrong token", { authorization: `Bearer ${randomBytes(32).toString("base64url")}` }],
    ["a token prefix", { authorization: `Bearer ${token.slice(0, 20)}` }],
    ["another scheme", { authorization: `Basic ${token}` }],
  ])("refuses %s with 401", async (_label, headers) => {
    const response = await send(running.port, { headers });
    expect(response.status).toBe(401);
    expect(response.body).not.toContain(token);
  });

  it("refuses a browser Origin outside the allowlist with 403", async () => {
    const response = await send(running.port, {
      headers: { authorization, origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    const allowed = await send(running.port, { headers: { authorization, origin: "http://localhost:5173" } });
    expect(allowed.status).toBe(200);
  });

  it("refuses a Host outside the allowlist (DNS rebinding) with 403", async () => {
    const response = await send(running.port, { headers: { authorization, host: "attacker.example" } });
    expect(response.status).toBe(403);
  });

  it("refuses bodies over 1 MiB with 413", async () => {
    const response = await send(running.port, {
      headers: { authorization },
      body: Buffer.alloc(1_048_577, 0x20),
    });
    expect(response.status).toBe(413);
    const chunked = await send(running.port, {
      headers: { authorization, "transfer-encoding": "chunked" },
      body: Buffer.alloc(1_100_000, 0x20),
    });
    expect(chunked.status).toBe(413);
  });

  it("answers 404 off the MCP path", async () => {
    expect((await send(running.port, { path: "/", headers: { authorization } })).status).toBe(404);
  });
});
