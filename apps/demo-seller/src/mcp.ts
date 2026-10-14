/**
 * The seller's MCP server at `POST /mcp`: the MCP TypeScript SDK's `McpServer` over stateless
 * Streamable HTTP (a fresh server and transport per request, no sessions), with two paid tools wrapped
 * by the stock `@x402/mcp` payment wrapper and one free tool. Each paid tool is declared with the
 * Rail402 seller helpers, so its first settlement through Rail402 catalogs it as an MCP listing keyed
 * by this endpoint and the tool name, with every argument described. The metered tool
 * `hourly_forecast` (metered.ts) is paid with `upto` and settles the hours it returned; it is listed
 * only while the facilitator serves upto.
 */
import type { Request, RequestHandler } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { x402ResourceServer } from "@x402/core/server";
import { createPaymentWrapper } from "@x402/mcp";
import {
  chargeUpto,
  mcpPaymentConfig,
  mcpTool,
  meteredToolServer,
  param,
  type McpToolDeclaration,
  type PaymentOption,
} from "@rail402.dev/sdk/seller";
import { MAX_FORECAST_HOURS, declareHourlyForecast, hourlyForecastFor } from "./metered.ts";

export interface McpHandlerOptions {
  readonly resourceServer: x402ResourceServer;
  /** The payment option for a price in whole units. */
  readonly pay: (amount: string) => PaymentOption;
  /** The seller's public origin; without it, each request's scheme and host name the endpoint. */
  readonly publicUrl?: string;
  /** The metered upto tool: its own resource server (with the upto scheme), option and unit price. */
  readonly metered?: {
    readonly resourceServer: x402ResourceServer;
    /** Resolves once the facilitator serves upto; rejects (and is retried later) until then. */
    readonly ready: () => Promise<void>;
    readonly payment: PaymentOption;
    /** Base units charged per forecast hour. */
    readonly perHour: bigint;
  };
}

export interface McpHandler {
  /** JSON-RPC over `POST /mcp`. */
  readonly post: RequestHandler;
  /** Any other method on `/mcp`: stateless, so there is no stream to open or session to end. */
  readonly other: RequestHandler;
}

/** The paid tools as the helpers declare them for one endpoint. */
export interface McpTools {
  readonly forecast: McpToolDeclaration;
  readonly airQuality: McpToolDeclaration;
}

/** Each paid tool's price in whole units of the payment asset (USDC). */
export const TOOL_PRICES = { forecast: "0.001", airQuality: "0.001" } as const;

export const POLLUTANTS = ["pm25", "pm10", "o3", "no2"] as const;
type Pollutant = (typeof POLLUTANTS)[number];

/** Declares the paid tools served at `endpoint`. */
export function declareTools(endpoint: string, pay: (amount: string) => PaymentOption): McpTools {
  const city = param.string({ description: "City name", required: true, example: "Istanbul", maxLength: 80 });
  return {
    forecast: mcpTool({
      endpoint,
      toolName: "forecast",
      description: "Weather forecast for a city",
      payment: pay(TOOL_PRICES.forecast),
      arguments: { city },
      output: {
        example: {
          city: "Istanbul",
          days: [{ day: 1, high: 22, low: 14, conditions: "sunny" }],
        },
      },
      transport: "streamable-http",
    }),
    airQuality: mcpTool({
      endpoint,
      toolName: "air_quality",
      description: "Current air quality index (AQI) for a city, overall or for one pollutant",
      payment: pay(TOOL_PRICES.airQuality),
      arguments: {
        city,
        pollutant: param.enum(POLLUTANTS, {
          description: "Pollutant to report: pm25, pm10, o3 or no2; all combined when omitted",
          example: "pm25",
        }),
      },
      output: { example: { city: "Istanbul", pollutant: "pm25", aqi: 42, category: "good" } },
      transport: "streamable-http",
    }),
  };
}

/** A small, stable number for a city, so repeated calls give the same demonstration data. */
function seed(text: string): number {
  let value = 7;
  for (const char of text.toLowerCase()) value = (value * 31 + char.charCodeAt(0)) % 9973;
  return value;
}

const CONDITIONS = ["sunny", "cloudy", "rain", "windy"] as const;

export function forecastFor(city: string): Record<string, unknown> {
  const base = seed(city);
  return {
    city,
    days: [1, 2, 3].map((day) => ({
      day,
      high: 14 + ((base + day * 3) % 14),
      low: 4 + ((base + day) % 10),
      conditions: CONDITIONS[(base + day) % CONDITIONS.length],
    })),
  };
}

export function airQualityFor(city: string, pollutant: Pollutant | undefined): Record<string, unknown> {
  const aqi = 15 + ((seed(city) + (pollutant === undefined ? 0 : POLLUTANTS.indexOf(pollutant) * 17)) % 120);
  const category = aqi <= 50 ? "good" : aqi <= 100 ? "moderate" : "unhealthy for sensitive groups";
  return { city, pollutant: pollutant ?? "all", aqi, category };
}

interface JsonToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
}

const json = (value: Record<string, unknown>): JsonToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

/** At most this many endpoints' declarations are kept when the endpoint comes from requests. */
const MAX_ENDPOINTS = 8;

/** Initializes a resource server once (it reads the facilitator's /supported); a failure is retried. */
function initializer(server: x402ResourceServer): () => Promise<void> {
  let ready: Promise<void> | undefined;
  return () => {
    ready ??= server.initialize().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };
}

/** Promises cached per endpoint: at most `MAX_ENDPOINTS`, and a failed one is built again next time. */
function perEndpoint<T>(build: (endpoint: string) => Promise<T>): (endpoint: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (endpoint) => {
    let entry = cache.get(endpoint);
    if (entry === undefined) {
      if (cache.size >= MAX_ENDPOINTS) cache.clear();
      entry = build(endpoint);
      entry.catch(() => cache.delete(endpoint));
      cache.set(endpoint, entry);
    }
    return entry;
  };
}

export function mcpHandler(options: McpHandlerOptions): McpHandler {
  const initialize = initializer(options.resourceServer);

  const paidTools = perEndpoint(async (endpoint) => {
    await initialize();
    const tools = declareTools(endpoint, options.pay);
    const wrap = async (tool: McpToolDeclaration) =>
      createPaymentWrapper(options.resourceServer, await mcpPaymentConfig(options.resourceServer, tool));
    return { forecast: await wrap(tools.forecast), airQuality: await wrap(tools.airQuality), tools };
  });

  const metered = options.metered;
  const meteredTool = perEndpoint(async (endpoint) => {
    if (metered === undefined) throw new Error("not metered");
    await metered.ready();
    const tool = declareHourlyForecast(endpoint, metered.payment);
    // The stock wrapper settles an upto tool's full cap; through meteredToolServer it settles the
    // amount the handler charged with chargeUpto.
    const wrapper = createPaymentWrapper(
      meteredToolServer(metered.resourceServer),
      await mcpPaymentConfig(metered.resourceServer, tool),
    );
    return { tool, wrapper };
  });
  /** The metered tool, or undefined while the facilitator does not serve upto. */
  const meteredFor = (endpoint: string) =>
    metered === undefined ? Promise.resolve(undefined) : meteredTool(endpoint).catch(() => undefined);

  const endpointOf = (req: Request): string =>
    options.publicUrl === undefined
      ? `${req.protocol}://${req.get("host") ?? "localhost"}/mcp`
      : `${options.publicUrl.replace(/\/+$/, "")}/mcp`;

  const build = async (endpoint: string): Promise<McpServer> => {
    const [{ forecast, airQuality, tools }, hourly] = await Promise.all([
      paidTools(endpoint),
      meteredFor(endpoint),
    ]);
    const server = new McpServer({ name: "rail402-demo-seller", version: "1.0.0" });
    server.registerTool(
      tools.forecast.toolName,
      { description: tools.forecast.description, inputSchema: tools.forecast.zodShape },
      forecast((args) => json(forecastFor(String(args["city"])))),
    );
    server.registerTool(
      tools.airQuality.toolName,
      { description: tools.airQuality.description, inputSchema: tools.airQuality.zodShape },
      airQuality((args) =>
        json(airQualityFor(String(args["city"]), args["pollutant"] as Pollutant | undefined)),
      ),
    );
    if (hourly !== undefined && metered !== undefined) {
      const handler = hourly.wrapper((args) => {
        const hours = Math.min(Math.max(Math.trunc(Number(args["hours"])), 1), MAX_FORECAST_HOURS);
        return chargeUpto(
          json(hourlyForecastFor(String(args["city"]), hours, metered.perHour)),
          metered.perHour * BigInt(hours),
        );
      });
      server.registerTool(
        hourly.tool.toolName,
        { description: hourly.tool.description, inputSchema: hourly.tool.zodShape },
        handler,
      );
    }
    server.registerTool("ping", { description: "Free: answers pong. No payment needed." }, () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    return server;
  };

  return {
    post: (req, res) => {
      void (async () => {
        const server = await build(endpointOf(req));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      })().catch(() => {
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "The MCP server failed to handle the request." },
            id: null,
          });
        }
      });
    },
    other: (_req, res) => {
      res
        .status(405)
        .set("allow", "POST")
        .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    },
  };
}
