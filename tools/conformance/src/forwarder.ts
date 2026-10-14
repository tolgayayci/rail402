/**
 * A transparent HTTP forwarder in front of a facilitator, recording what crosses the wire.
 *
 * Request bodies are forwarded byte for byte, and responses come back with their status, body and
 * headers (`EXTENSION-RESPONSES` included) unchanged; only hop-by-hop and transfer-encoding headers
 * are left to each connection. Every exchange is recorded, so a harness can assert that what a
 * seller sent to `/verify` and `/settle` is what the buyer signed.
 *
 * As a command it stands in for a hosted facilitator in the upstream x402 e2e suite: it forwards
 * `/verify`, `/settle`, `/supported` and `/discovery/*`, answers `/health` and `/close` itself, and
 * prints "Facilitator listening" once it accepts connections.
 *
 *   node tools/conformance/src/forwarder.ts --target https://… --port 4022 [--hosted]
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";

export interface Exchange {
  readonly method: string;
  /** Path and query, as the client sent them. */
  readonly path: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  /** The request body as sent: parsed JSON when it is JSON, otherwise text (empty when there is none). */
  readonly requestBody: unknown;
  /** The request body bytes, base64, exactly as forwarded. */
  readonly requestBytes: string;
  readonly status: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly responseBody: unknown;
  /** `forwarded` to the target, answered `local`ly, or `refused` as not forwardable. */
  readonly route: "forwarded" | "local" | "refused";
  readonly elapsedMs: number;
}

export interface ForwarderOptions {
  /** The facilitator to forward to, e.g. `http://127.0.0.1:8080`. */
  readonly target: string;
  readonly host?: string;
  /** 0 (the default) picks a free port. */
  readonly port?: number;
  /**
   * Forward only what a hosted facilitator serves to the e2e suite (`/verify`, `/settle`,
   * `/supported`, `/discovery/*`) and answer `/health` and `/close` locally. Otherwise every
   * request is forwarded.
   */
  readonly hosted?: boolean;
  /** Called after `/close` was answered (hosted mode). */
  readonly onClose?: () => void;
}

export interface Forwarder {
  readonly url: string;
  /** Every exchange so far, in the order responses were sent. */
  readonly exchanges: Exchange[];
  close(): Promise<void>;
}

/** Headers that belong to one connection, or that no longer describe a body re-sent decoded. */
const CONNECTION_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
  "content-length",
  "content-encoding",
  "accept-encoding",
]);

const HOSTED_ROUTES = [/^\/verify$/, /^\/settle$/, /^\/supported$/, /^\/discovery\/[^?]*$/];

/** Largest request body forwarded. The facilitator's own limit is lower. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export async function startForwarder(options: ForwarderOptions): Promise<Forwarder> {
  const target = new URL(options.target.replace(/\/*$/, "/"));
  const exchanges: Exchange[] = [];

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "forwarder_upstream_error", reason: messageOf(error) }));
      } else {
        response.destroy();
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = performance.now();
    const method = request.method ?? "GET";
    const path = request.url ?? "/";
    const bytes = await readBody(request);
    const pathname = path.split("?")[0] ?? "/";
    const record = (
      status: number,
      headers: Record<string, string>,
      body: Buffer,
      route: Exchange["route"],
    ) => {
      exchanges.push({
        method,
        path,
        requestHeaders: flatten(request.headers),
        requestBody: decode(bytes, request.headers["content-type"]),
        requestBytes: bytes.toString("base64"),
        status,
        responseHeaders: headers,
        responseBody: decode(body, headers["content-type"]),
        route,
        elapsedMs: Math.round(performance.now() - started),
      });
    };
    const answer = (status: number, body: unknown, route: Exchange["route"]) => {
      const text = Buffer.from(JSON.stringify(body));
      const headers = { "content-type": "application/json" };
      record(status, headers, text, route);
      response.writeHead(status, headers);
      response.end(text);
    };

    if (options.hosted === true) {
      if (pathname === "/health") {
        answer(200, { status: "ok", forwardsTo: target.origin }, "local");
        return;
      }
      if (pathname === "/close") {
        answer(200, { message: "closing" }, "local");
        options.onClose?.();
        return;
      }
      if (!HOSTED_ROUTES.some((route) => route.test(pathname))) {
        answer(
          404,
          { error: "not_found", reason: `${pathname} is not forwarded to the facilitator.` },
          "refused",
        );
        return;
      }
    }

    const upstream = await fetch(new URL(path.replace(/^\/+/, ""), target), {
      method,
      headers: forwardable(request.headers),
      ...(bytes.length === 0 || method === "GET" || method === "HEAD" ? {} : { body: bytes }),
      redirect: "manual",
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const headers: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!CONNECTION_HEADERS.has(name)) headers[name] = value;
    });
    record(upstream.status, headers, body, "forwarded");
    response.writeHead(upstream.status, headers);
    response.end(body);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${String(address.port)}`,
    exchanges,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The recorded exchanges for one path (query ignored), in order. */
export function exchangesFor(exchanges: readonly Exchange[], pathname: string): Exchange[] {
  return exchanges.filter((exchange) => exchange.path.split("?")[0] === pathname);
}

/** A base64 JSON header such as `EXTENSION-RESPONSES` or `PAYMENT-RESPONSE`, decoded; `undefined` if absent or invalid. */
export function decodeBase64Json(header: string | undefined | null): unknown {
  if (header === undefined || header === null || header === "") return undefined;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function forwardable(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || CONNECTION_HEADERS.has(name)) continue;
    for (const item of Array.isArray(value) ? value : [value]) result.append(name, item);
  }
  return result;
}

function flatten(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

function decode(bytes: Buffer, contentType: string | undefined): unknown {
  const text = bytes.toString("utf8");
  if (text === "") return "";
  if (contentType?.includes("json") === true) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${String(MAX_BODY_BYTES)} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      port: { type: "string", default: "4022" },
      host: { type: "string", default: "127.0.0.1" },
      hosted: { type: "boolean", default: false },
    },
  });
  if (values.target === undefined) throw new Error("--target <facilitator URL> is required");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be a TCP port");
  const forwarder: Forwarder = await startForwarder({
    target: values.target,
    port,
    host: values.host,
    hosted: values.hosted,
    onClose: () => setTimeout(stop, 100),
  });
  function stop() {
    void forwarder.close().then(() => process.exit(0));
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const listening = new URL(forwarder.url).port;
  process.stdout.write(`Facilitator listening on port ${listening} (forwarding to ${values.target})\n`);
}
