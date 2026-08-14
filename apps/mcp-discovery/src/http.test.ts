import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp } from "./http.js";
import type { McpConfig } from "./server.js";

/**
 * The hosted HTTP transport, exercised by a REAL MCP client over a REAL socket.
 *
 * mcp.test.ts calls the tool functions directly, so it never touches a transport. This is the only
 * test that proves the stateless Streamable HTTP path actually works end to end — that the
 * fresh-server-per-request pattern survives a full connect -> listTools -> callTool flow,
 * which is the exact thing that fails with "Server not initialized" if the pattern is wrong. If this
 * passes, the deployed endpoint speaks MCP to any stock client.
 */

// A stand-in Bazaar so search returns a deterministic hit without the network. Runs on its own socket
// because the MCP client transport itself uses global fetch — stubbing fetch would break the client.
function mockBazaar(): Hono {
  const bazaar = new Hono();
  bazaar.get("/discovery/search", c =>
    c.json({
      resources: [
        {
          resource: "https://api.example.com/geocode",
          type: "http",
          description: "Turn a postal address into latitude and longitude coordinates.",
          serviceName: "GeoResolve",
          accepts: [
            {
              scheme: "exact",
              network: "stellar:testnet",
              amount: "1000000",
              asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
              payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
              maxTimeoutSeconds: 60,
              extra: {},
            },
          ],
        },
      ],
      meta: { searchToken: "tok_test" },
    }),
  );
  return bazaar;
}

/** Start a Hono app on an ephemeral port and resolve with its port + a close fn. */
function listen(app: Hono): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () => new Promise<void>(done => server.close(() => done())),
      });
    });
  });
}

describe("hosted MCP Streamable HTTP transport", () => {
  let bazaar: Awaited<ReturnType<typeof listen>>;
  let mcp: Awaited<ReturnType<typeof listen>>;

  beforeAll(async () => {
    bazaar = await listen(mockBazaar());
    const config: McpConfig = {
      bazaarUrl: `http://127.0.0.1:${bazaar.port}`,
      network: "stellar:testnet",
      allowPrivateHosts: false,
    };
    mcp = await listen(createHttpApp(config));
  });

  afterAll(async () => {
    await mcp?.close();
    await bazaar?.close();
  });

  const connect = async () => {
    const client = new Client({ name: "http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.port}/mcp`));
    await client.connect(transport);
    return client;
  };

  it("completes the initialize handshake and lists both tools", async () => {
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name).sort()).toEqual(["pay_and_call", "search_stellar_resources"]);
    } finally {
      await client.close();
    }
  });

  it("routes a tool call through the transport and returns structured content", async () => {
    const client = await connect();
    try {
      const res = (await client.callTool({
        name: "search_stellar_resources",
        arguments: { query: "address to coordinates" },
      })) as {
        isError?: boolean;
        structuredContent?: { ok?: boolean; data?: { count?: number; results?: unknown[] } };
      };
      // A working call, not an error result — proves the stateless POST reached a fully-initialized
      // server, which is the shared-transport failure mode.
      expect(res.isError ?? false).toBe(false);
      expect(res.structuredContent?.ok).toBe(true);
      expect(res.structuredContent?.data?.count).toBe(1);
      expect(res.structuredContent?.data?.results).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("serves each request from a fresh server — a second independent client works too", async () => {
    // Statelessness, concretely: the second client shares nothing with the first, yet its own
    // handshake + call succeed. If a request ever reused another's server, this is what would break.
    const a = await connect();
    const b = await connect();
    try {
      const [ra, rb] = await Promise.all([a.listTools(), b.listTools()]);
      expect(ra.tools).toHaveLength(2);
      expect(rb.tools).toHaveLength(2);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("answers /health with the service descriptor", async () => {
    const res = await fetch(`http://127.0.0.1:${mcp.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; tools: string[] };
    expect(body.status).toBe("ok");
    expect(body.tools).toContain("pay_and_call");
  });
});
