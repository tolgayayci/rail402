import { describe, it, expect } from "vitest";
import { describeEndpoint, describeTool } from "./declare.js";

describe("describeEndpoint", () => {
  it("returns the extensions map directly, already keyed under `bazaar`", () => {
    // The raw SDK helper returns { bazaar: … } and is easy to double-wrap; doing so nests it twice
    // and the facilitator silently refuses to catalog the listing. That mistake cost a debugging
    // cycle here, so this asserts the shape callers actually need.
    const ext = describeEndpoint({ params: { symbol: { description: "Ticker symbol such as XLM." } } }) as Record<
      string,
      { info?: { input?: Record<string, unknown> } }
    >;
    expect(Object.keys(ext)).toEqual(["bazaar"]);
    expect(ext["bazaar"]!.info!.input!["type"]).toBe("http");
    expect((ext as Record<string, unknown>)["bazaar"]).not.toHaveProperty("bazaar");
  });

  it("refuses a parameter with no description", () => {
    // An undescribed parameter is invisible to search and useless to an agent, so this is an error
    // rather than a warning.
    expect(() => describeEndpoint({ params: { q: { description: "" } } })).toThrow(/no description/i);
    expect(() => describeEndpoint({ params: { q: { description: "   " } } })).toThrow(/no description/i);
  });

  it("explains what to do in the error message", () => {
    try {
      describeEndpoint({ params: { ticker: { description: "" } } });
      throw new Error("expected throw");
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain("ticker");
      expect(m).toMatch(/search/i);
      expect(m).toMatch(/e\.g\./i);
    }
  });

  // Per-parameter descriptions land in the JSON Schema that validates `info`, under
  // schema.properties.input.properties.queryParams.properties.<name> — not in info itself.
  type QueryParamSchema = { properties: Record<string, Record<string, unknown>>; required?: string[] };
  type Declared = Record<
    string,
    { schema: { properties: { input: { properties: { queryParams: QueryParamSchema } } } } }
  >;
  const queryParamSchema = (ext: unknown): QueryParamSchema =>
    (ext as Declared)["bazaar"]!.schema.properties.input.properties.queryParams;

  it("carries per-parameter descriptions into the JSON Schema", () => {
    const qp = queryParamSchema(
      describeEndpoint({
        params: {
          symbol: { description: "Ticker symbol such as XLM.", example: "XLM" },
          currency: { description: "ISO 4217 code.", required: false, example: "USD" },
        },
      }),
    );
    expect(qp.properties["symbol"]!["description"]).toBe("Ticker symbol such as XLM.");
    expect(qp.properties["currency"]!["description"]).toBe("ISO 4217 code.");
    // Optional parameters must not land in `required`.
    expect(qp.required).toEqual(["symbol"]);
  });

  it("propagates types and enums", () => {
    const qp = queryParamSchema(
      describeEndpoint({
        params: {
          depth: { description: "How deep to analyze.", type: "integer" },
          mode: { description: "Analysis mode.", enum: ["quick", "deep"] },
        },
      }),
    );
    expect(qp.properties["depth"]!["type"]).toBe("integer");
    expect(qp.properties["mode"]!["enum"]).toEqual(["quick", "deep"]);
  });

  it("uses examples as the concrete input shown in the 402 challenge", () => {
    const ext = describeEndpoint({
      params: { symbol: { description: "Ticker.", example: "XLM" } },
      outputExample: { symbol: "XLM", price: 0.12 },
    }) as Record<string, { info?: { input?: Record<string, unknown>; output?: { example?: unknown } } }>;
    expect(ext["bazaar"]!.info!.input!["queryParams"]).toEqual({ symbol: "XLM" });
    expect(ext["bazaar"]!.info!.output!.example).toEqual({ symbol: "XLM", price: 0.12 });
  });

  it("switches to the body shape when bodyType is given", () => {
    const ext = describeEndpoint({
      params: { query: { description: "Search text.", example: "hello" } },
      bodyType: "json",
    }) as Record<string, { info?: { input?: Record<string, unknown> } }>;
    expect(ext["bazaar"]!.info!.input!["bodyType"]).toBe("json");
  });

  it("does not set `method` — that is the server extension's job at request time", () => {
    const ext = describeEndpoint({ params: { a: { description: "A thing." } } }) as Record<
      string,
      { info?: { input?: Record<string, unknown> } }
    >;
    expect(ext["bazaar"]!.info!.input).not.toHaveProperty("method");
  });
});

describe("describeTool", () => {
  it("produces an MCP declaration keyed on toolName", () => {
    const ext = describeTool({
      toolName: "financial_analysis",
      description: "Fundamental analysis of a public company.",
      params: { ticker: { description: "Company ticker symbol.", example: "AAPL" } },
    }) as Record<string, { info?: { input?: Record<string, unknown> } }>;

    const input = ext["bazaar"]!.info!.input!;
    expect(input["type"]).toBe("mcp");
    expect(input["toolName"]).toBe("financial_analysis");
    expect(input["description"]).toBe("Fundamental analysis of a public company.");
  });

  it("requires a tool description", () => {
    // For MCP resources the description is the primary ranking signal — without it the tool is
    // effectively undiscoverable.
    expect(() =>
      describeTool({ toolName: "t", description: "", params: { a: { description: "A." } } }),
    ).toThrow(/no description/i);
  });

  it("still requires every parameter to be described", () => {
    expect(() =>
      describeTool({ toolName: "t", description: "Does a thing.", params: { a: { description: "" } } }),
    ).toThrow(/no description/i);
  });

  it("carries the transport when specified", () => {
    const ext = describeTool({
      toolName: "t",
      description: "Does a thing.",
      params: { a: { description: "A." } },
      transport: "sse",
    }) as Record<string, { info?: { input?: Record<string, unknown> } }>;
    expect(ext["bazaar"]!.info!.input!["transport"]).toBe("sse");
  });
});
