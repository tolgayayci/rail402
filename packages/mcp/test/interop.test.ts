/**
 * The server with the clients agents use: the MCP SDK v2 client negotiating the 2026 protocol, the
 * same client on the 2025 handshake, and the v1 SDK client (1.31.0), over Streamable HTTP (in
 * process) and over stdio (the spawned bin, search-only against a local Bazaar double).
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Client as ClientV2,
  ProtocolError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport as StdioClientTransportV2 } from "@modelcontextprotocol/client/stdio";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport as StdioClientTransportV1 } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport as StreamableHTTPClientTransportV1 } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EmptyResultSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MCP_PATH, TOOL_NAMES, createHttpHandler, createRail402Mcp } from "@rail402.dev/mcp";
import { startFakeBazaar, type FakeBazaar } from "./bazaar.ts";
import { LISTING_ID, fakeBuyer } from "./helpers.ts";

interface AnyClient {
  listTools(): Promise<{ tools: { name: string; outputSchema?: unknown; inputSchema: unknown }[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

type Flavor = "v2 (2026)" | "v2 (2025)" | "v1 1.31.0";
const FLAVORS: readonly Flavor[] = ["v2 (2026)", "v2 (2025)", "v1 1.31.0"];

function clientFor(flavor: Flavor): ClientV2 | ClientV1 {
  const info = { name: "interop-test", version: "1.0.0" };
  if (flavor === "v1 1.31.0") return new ClientV1(info);
  return new ClientV2(info, { versionNegotiation: { mode: flavor === "v2 (2026)" ? "auto" : "legacy" } });
}

/** Asserts the protocol error for an unknown tool, whichever client raised it. */
async function expectUnknownTool(client: AnyClient): Promise<void> {
  const error = await client.callTool({ name: "transfer_everything", arguments: {} }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error instanceof ProtocolError || error instanceof McpError).toBe(true);
  expect(error).toMatchObject({ code: -32602, data: { code: "tool_unknown" } });
}

/** Requests the SDK itself refuses: each JSON-RPC error carries `data: { code, reason }`. */
async function expectCodedProtocolErrors(client: ClientV2 | ClientV1): Promise<void> {
  const cases = [
    {
      request: { method: "tools/call", params: { arguments: {} } },
      error: { code: -32602, data: { code: "rpc_params_invalid" } },
      reason: "params.name",
    },
    {
      request: { method: "tools/call", params: { name: "get_budget", arguments: "all of it" } },
      error: { code: -32602, data: { code: "rpc_params_invalid" } },
      reason: "params.arguments",
    },
    {
      request: { method: "rail402/transfer", params: {} },
      error: { code: -32601, data: { code: "rpc_method_unknown" } },
      reason: "rail402/transfer",
    },
  ];
  for (const { request, error, reason } of cases) {
    const sent =
      client instanceof ClientV1
        ? client.request(request, EmptyResultSchema)
        : client.request(request as never, z.object({}));
    const caught = await sent.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(caught instanceof ProtocolError || caught instanceof McpError).toBe(true);
    expect(caught).toMatchObject(error);
    expect((caught as { data: { reason: string } }).data.reason).toContain(reason);
  }
}

async function exercise(client: AnyClient, flavor: Flavor): Promise<void> {
  if (client instanceof ClientV2) {
    const negotiated = client.getNegotiatedProtocolVersion();
    if (flavor === "v2 (2026)") expect(negotiated).toBe("2026-07-28");
    else expect(negotiated).not.toBe("2026-07-28");
  }
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
  for (const tool of tools) expect(tool.outputSchema).toMatchObject({ type: "object" });

  const search = (await client.callTool({
    name: "search_stellar_resources",
    arguments: { query: "weather" },
  })) as { structuredContent: Record<string, unknown>; isError?: boolean };
  expect(search.isError).toBe(false);
  expect(search.structuredContent).toMatchObject({ ok: true, results: [{ listingId: LISTING_ID }] });

  const refused = (await client.callTool({
    name: "pay_and_call",
    arguments: { resource: "https://a.example" },
  })) as {
    structuredContent: Record<string, unknown>;
    isError?: boolean;
  };
  expect(refused.isError).toBe(true);
  expect(refused.structuredContent).toMatchObject({
    ok: false,
    error: { code: "tool_input_invalid", paid: "none" },
  });

  const budget = (await client.callTool({ name: "get_budget", arguments: {} })) as {
    structuredContent: Record<string, unknown>;
  };
  expect(budget.structuredContent).toMatchObject({ ok: true, network: "stellar:testnet" });

  await expectUnknownTool(client);
  await expectCodedProtocolErrors(client as ClientV2 | ClientV1);
}

describe("interop over Streamable HTTP", () => {
  const { factory } = createRail402Mcp({ buyer: fakeBuyer() });
  const handler = createHttpHandler(factory, {
    token: undefined,
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: ["127.0.0.1"],
  });
  // A fetch that never leaves the process; it sets Host as a network client would.
  const fetch = (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("host", new URL(url).host);
    return handler.fetch(new Request(url, { ...init, headers }));
  };
  const endpoint = new URL(`http://127.0.0.1${MCP_PATH}`);

  afterAll(() => handler.close());

  it.each(FLAVORS)("serves the %s client", async (flavor) => {
    const client = clientFor(flavor);
    if (client instanceof ClientV1) {
      await client.connect(new StreamableHTTPClientTransportV1(endpoint, { fetch }));
    } else {
      await client.connect(new StreamableHTTPClientTransport(endpoint, { fetch }));
    }
    await exercise(client, flavor);
    await client.close();
  });
});

describe("interop over stdio (spawned bin)", () => {
  let bazaar: FakeBazaar;
  const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

  beforeAll(async () => {
    bazaar = await startFakeBazaar();
  });
  afterAll(() => bazaar.close());

  it.each(FLAVORS)("serves the %s client", async (flavor) => {
    const params = {
      command: process.execPath,
      args: ["--conditions=@rail402/source", bin],
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        RAIL402_BAZAAR_URL: bazaar.url,
        RAIL402_BUDGET_STORE: "memory",
        RAIL402_LOG_LEVEL: "silent",
      },
      stderr: "pipe" as const,
    };
    const client = clientFor(flavor);
    if (client instanceof ClientV1) await client.connect(new StdioClientTransportV1(params));
    else await client.connect(new StdioClientTransportV2(params));
    await exercise(client, flavor);
    await client.close();
    expect(bazaar.queries.at(-1)).toContain("network=stellar%3Atestnet");
  });
});
