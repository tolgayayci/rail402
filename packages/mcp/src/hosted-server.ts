import { AsyncLocalStorage } from "node:async_hooks";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createMcpHandler, hostHeaderValidationResponse } from "@modelcontextprotocol/server";
import type { StellarNetwork } from "@rail402.dev/sdk/discovery";
import { rpcCodes, rpcErrorData, type RpcCode } from "./codes.ts";
import {
  ClientLimiter,
  HOSTED_INSTRUCTIONS,
  HostedMetrics,
  clientKey,
  createHostedTools,
  forwardedClientId,
  hostedDiscovery,
  hostedPath,
  hostedPolicy,
  type HostedConfig,
  type HostedTools,
} from "./hosted.ts";
import { RateLimiter } from "./limits.ts";
import { bridgeRequest } from "./http.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { createServerFactory } from "./server.ts";

/** A JSON-RPC error answer for a request refused before it reached the MCP server. */
function rpcRefusal(status: number, code: RpcCode, headers: Record<string, string> = {}): Response {
  const jsonRpc = code === "rpc_method_unknown" ? -32601 : code === "rpc_batch_unsupported" ? -32600 : -32000;
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: jsonRpc,
        message: rpcCodes[code].reason,
        data: rpcErrorData(code, rpcCodes[code].reason),
      },
    }),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
}

export interface HostedHandler {
  fetch(request: Request, clientAddress: string): Promise<Response>;
  readonly metrics: HostedMetrics;
  readonly tools: ReadonlyMap<string, HostedTools>;
  close(): Promise<void>;
}

/** Reads a body of at most `limit` bytes; undefined when it is larger. */
async function boundedText(request: Request, limit: number): Promise<string | undefined> {
  if (request.body === null) return "";
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The parsed JSON-RPC body, or undefined when it is not JSON (the MCP handler answers that). */
function parsedBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The hosted endpoint's request handling, independent of the socket: path → network, method, Host,
 * per-client limit, body size, one message per request (a JSON-RPC batch is refused, so one request
 * is at most one tool call), the in-flight cap, the process-wide budget of tool calls (each at most one
 * Bazaar request), then the stateless MCP handler of that network.
 */
export async function createHostedHandler(
  config: HostedConfig,
  options: { readonly fetch?: typeof fetch; readonly logger?: Logger; readonly now?: () => number } = {},
): Promise<HostedHandler> {
  const logger = options.logger ?? silentLogger;
  const metrics = new HostedMetrics();
  const limiter = new ClientLimiter(config.limits.perClientPerMinute, 10_000, options.now);
  const upstreamBudget = new RateLimiter(config.limits.upstreamPerMinute, 60_000, options.now);
  let proxyWarned = false;
  const byPath = new Map<string, { network: StellarNetwork; handler: ReturnType<typeof createMcpHandler> }>();
  const tools = new Map<string, HostedTools>();
  // The forwarded identifier of the client each request serves, read by the upstream fetch.
  const forwarded = new AsyncLocalStorage<string>();
  for (const network of config.networks) {
    const networkTools = createHostedTools({
      network,
      discovery: hostedDiscovery(config, network, metrics, options.fetch, () => forwarded.getStore()),
      policy: await hostedPolicy(network),
      maxResults: config.limits.maxResults,
      logger,
      onCall: (tool, outcome) => {
        metrics.count("calls", { network, tool, outcome });
      },
    });
    tools.set(network, networkTools);
    const handler = createMcpHandler(
      createServerFactory(networkTools, { instructions: HOSTED_INSTRUCTIONS }),
      {
        legacy: "stateless",
        maxRequestBodySize: config.limits.maxBodyBytes,
        onerror: (error) => {
          logger.debug("mcp transport error", { error: error.message });
        },
      },
    );
    byPath.set(hostedPath(network), { network, handler });
  }
  const allowedHosts = [...config.publicHosts];
  let inflight = 0;

  const refuse = (reason: string, response: Response): Response => {
    metrics.count("refusals", { reason });
    return response;
  };

  return {
    metrics,
    tools,
    fetch: async (request, clientAddress) => {
      const route = byPath.get(new URL(request.url).pathname);
      if (route === undefined) return refuse("not_found", new Response("Not found.", { status: 404 }));
      if (request.method !== "POST") {
        // Stateless: there is no stream to open (GET) and no session to end (DELETE).
        return refuse(
          "method_not_allowed",
          new Response(
            JSON.stringify({
              error: { code: "method_not_allowed", reason: "This endpoint takes POST only." },
            }),
            {
              status: 405,
              headers: { "content-type": "application/json", allow: "POST" },
            },
          ),
        );
      }
      const hostRefusal = hostHeaderValidationResponse(request, allowedHosts);
      if (hostRefusal !== undefined) return refuse("host", hostRefusal);
      if (config.trustedProxyHops === 0 && request.headers.has("x-forwarded-for")) {
        // A proxy in front with TRUSTED_PROXY_HOPS=0 puts every client in the proxy's one bucket.
        metrics.count("warnings", { reason: "forwarded_without_trusted_proxy" });
        if (!proxyWarned) {
          proxyWarned = true;
          logger.warn(
            "requests carry X-Forwarded-For but TRUSTED_PROXY_HOPS is 0: every client behind that proxy shares one rate limit; set TRUSTED_PROXY_HOPS to the number of proxies in front",
          );
        }
      }
      const client = clientKey(clientAddress);
      if (!limiter.take(client)) {
        return refuse("rate_limited", rpcRefusal(429, "rpc_rate_limited", { "retry-after": "60" }));
      }
      const tooLarge = () => refuse("too_large", new Response("Request body too large.", { status: 413 }));
      const length = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > config.limits.maxBodyBytes) return tooLarge();
      const text = await boundedText(request, config.limits.maxBodyBytes);
      if (text === undefined) return tooLarge();
      const message = parsedBody(text);
      // One HTTP request carries one message, so the limits above bound tool calls, not just requests.
      if (Array.isArray(message)) return refuse("batch", rpcRefusal(400, "rpc_batch_unsupported"));
      if (inflight >= config.limits.maxInflight) {
        return refuse("overloaded", rpcRefusal(503, "rpc_overloaded", { "retry-after": "1" }));
      }
      const toolCall =
        typeof message === "object" &&
        message !== null &&
        (message as { method?: unknown }).method === "tools/call";
      if (toolCall && !upstreamBudget.take()) {
        return refuse("upstream_budget", rpcRefusal(503, "rpc_upstream_budget", { "retry-after": "10" }));
      }
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      const inner = new Request(request.url, {
        method: "POST",
        headers,
        body: text,
        signal: request.signal,
      });
      inflight++;
      try {
        const response =
          config.upstreamKey === undefined
            ? await route.handler.fetch(inner)
            : await forwarded.run(forwardedClientId(config.upstreamKey, client), () =>
                route.handler.fetch(inner),
              );
        // Stateless: no session is ever handed out.
        response.headers.delete("mcp-session-id");
        return response;
      } finally {
        inflight--;
      }
    },
    close: async () => {
      for (const { handler } of byPath.values()) await handler.close();
    },
  };
}

/** The client address: the trusted proxy's view of it when proxies are configured, else the socket's. */
export function clientAddressOf(incoming: IncomingMessage, trustedProxyHops: number): string {
  if (trustedProxyHops > 0) {
    const header = incoming.headers["x-forwarded-for"];
    const forwarded = (Array.isArray(header) ? header.join(",") : (header ?? ""))
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const address = forwarded[forwarded.length - trustedProxyHops];
    if (address !== undefined) return address;
  }
  return incoming.socket.remoteAddress ?? "unknown";
}

export interface RunningHostedServer {
  readonly url: string;
  readonly metricsUrl: string;
  readonly handler: HostedHandler;
  close(): Promise<void>;
}

/** Starts the hosted endpoint and its separate metrics listener. */
export async function startHostedServer(
  config: HostedConfig,
  options: { readonly fetch?: typeof fetch; readonly logger?: Logger } = {},
): Promise<RunningHostedServer> {
  const logger = options.logger ?? silentLogger;
  const handler = await createHostedHandler(config, options);
  const fail = (outgoing: ServerResponse, error: unknown) => {
    logger.warn("http request failed", { error: error instanceof Error ? error.message : String(error) });
    if (!outgoing.headersSent) outgoing.writeHead(500).end();
    else outgoing.destroy();
  };
  const server: HttpServer = createServer((incoming, outgoing) => {
    const address = clientAddressOf(incoming, config.trustedProxyHops);
    void bridgeRequest(
      incoming,
      outgoing,
      (request) => handler.fetch(request, address),
      config.limits.maxBodyBytes,
    ).catch((error: unknown) => {
      fail(outgoing, error);
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  const metricsServer: HttpServer = createServer((incoming, outgoing) => {
    if (incoming.url !== "/metrics" || incoming.method !== "GET") {
      outgoing.writeHead(404).end();
      return;
    }
    outgoing.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(handler.metrics.render());
  });
  const listen = (target: HttpServer, port: number) =>
    new Promise<number>((resolve, reject) => {
      target.once("error", reject);
      target.listen(port, config.host, () => {
        target.off("error", reject);
        resolve((target.address() as AddressInfo).port);
      });
    });
  const port = await listen(server, config.port);
  const metricsPort = await listen(metricsServer, config.metricsPort);
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  const close = (target: HttpServer) =>
    new Promise<void>((resolve) => {
      target.closeAllConnections();
      target.close(() => {
        resolve();
      });
    });
  return {
    url: `http://${host}:${String(port)}`,
    metricsUrl: `http://${host}:${String(metricsPort)}/metrics`,
    handler,
    close: async () => {
      await handler.close();
      await Promise.all([close(server), close(metricsServer)]);
    },
  };
}
