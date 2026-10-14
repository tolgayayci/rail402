import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import { MAX_HTTP_BODY_BYTES } from "./config.ts";
import { silentLogger, type Logger } from "./logger.ts";

export interface HttpTransportOptions {
  readonly host: string;
  readonly port: number;
  /** Bearer token every request must carry; undefined serves without one (search-only servers). */
  readonly token: string | undefined;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly logger?: Logger;
  /** Default 1 MiB. */
  readonly maxBodyBytes?: number;
}

export interface RunningHttpTransport {
  /** http://host:port/mcp */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/** The MCP endpoint's path. */
export const MCP_PATH = "/mcp";

/**
 * Serves MCP over Streamable HTTP for one operator. Every request is checked, in order: path, Host
 * (DNS rebinding), Origin (browsers), bearer token (constant-time), then body size. 2026 clients are
 * served per request; 2025 clients statelessly from the same factory.
 */
export function createHttpHandler(
  factory: McpServerFactory,
  options: Omit<HttpTransportOptions, "host" | "port">,
): { fetch(request: Request): Promise<Response>; close(): Promise<void> } {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_HTTP_BODY_BYTES;
  const handler = createMcpHandler(factory, {
    legacy: "stateless",
    maxRequestBodySize: maxBodyBytes,
    onerror: (error) => {
      (options.logger ?? silentLogger).debug("mcp transport error", { error: error.message });
    },
  });
  const expected = options.token === undefined ? undefined : digest(options.token);
  const allowedHosts = [...options.allowedHosts];
  const allowedOrigins = [...options.allowedOrigins];

  return {
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname !== MCP_PATH) return plain(404, "Not found.");
      const rejected =
        hostHeaderValidationResponse(request, allowedHosts) ??
        originValidationResponse(request, allowedOrigins);
      if (rejected !== undefined) return rejected;
      if (expected !== undefined && !authorized(request.headers.get("authorization"), expected)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="rail402-mcp"' },
        });
      }
      const length = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > maxBodyBytes) return plain(413, "Request body too large.");
      return handler.fetch(request);
    },
    close: () => handler.close(),
  };
}

/** Starts the HTTP transport on a loopback address. */
export async function startHttpTransport(
  factory: McpServerFactory,
  options: HttpTransportOptions,
): Promise<RunningHttpTransport> {
  const handler = createHttpHandler(factory, options);
  const maxBodyBytes = options.maxBodyBytes ?? MAX_HTTP_BODY_BYTES;
  const logger = options.logger ?? silentLogger;
  const server: HttpServer = createServer((incoming, outgoing) => {
    void serve(incoming, outgoing, (request) => handler.fetch(request), maxBodyBytes).catch(
      (error: unknown) => {
        logger.warn("http request failed", { error: error instanceof Error ? error.message : String(error) });
        if (!outgoing.headersSent) outgoing.writeHead(500).end();
        else outgoing.destroy();
      },
    );
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 300_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port, address } = server.address() as AddressInfo;
  const host = address.includes(":") ? `[${address}]` : address;
  return {
    url: `http://${host}:${String(port)}${MCP_PATH}`,
    port,
    close: async () => {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}

/** Bridges one node:http exchange to the fetch-style handler, reading at most `maxBodyBytes`. */
async function serve(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  fetch: (request: Request) => Promise<Response>,
  maxBodyBytes: number,
): Promise<void> {
  const aborted = new AbortController();
  outgoing.on("close", () => {
    aborted.abort();
  });
  const method = incoming.method ?? "GET";
  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of incoming) {
      size += (chunk as Buffer).byteLength;
      if (size > maxBodyBytes) {
        outgoing
          .writeHead(413, { "content-type": "text/plain", connection: "close" })
          .end("Request body too large.");
        incoming.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  const request = new Request(`http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: new Uint8Array(body) }),
    signal: aborted.signal,
  });
  const response = await fetch(request);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });
  outgoing.writeHead(response.status, responseHeaders);
  if (response.body === null) {
    outgoing.end();
    return;
  }
  outgoing.flushHeaders();
  const stream = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
  stream.on("error", () => outgoing.destroy());
  stream.pipe(outgoing);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Compares digests, so the comparison time depends on neither the token's content nor its length. */
function authorized(header: string | null, expected: Buffer): boolean {
  const match = header === null ? null : /^Bearer\s+(\S+)\s*$/i.exec(header);
  const presented = digest(match?.[1] ?? "");
  return timingSafeEqual(presented, expected) && match !== null;
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}
