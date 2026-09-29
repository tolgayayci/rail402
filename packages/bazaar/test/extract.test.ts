import { afterAll, describe, expect, it } from "vitest";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  MAX_TOOL_NAME_LENGTH,
  SchemaSandbox,
  extractCandidate,
  settledPayment,
  type Extraction,
} from "@rail402.dev/bazaar";

const sandbox = new SchemaSandbox();
afterAll(async () => {
  await sandbox.close();
});

const extract = (extension: unknown, url = "https://api.example.com/weather"): Promise<Extraction> =>
  extractCandidate(settledPayment({ url, extension }), { sandbox, allowLoopback: false });

/**
 * An HTTP extension as a seller would hand-write it, with a schema that leaves `method` optional.
 * (The schema upstream's declareDiscoveryExtension produces requires `method`.)
 */
function undeclaredMethod(input: Record<string, unknown>): unknown {
  return { info: { input: { type: "http", ...input } }, schema: { type: "object" } };
}

function mcpExtension(toolName: string): unknown {
  return declareDiscoveryExtension({
    toolName,
    description: "Forecast tool",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
  })["bazaar"];
}

function candidate(extraction: Extraction) {
  if (extraction.kind !== "candidate") throw new Error(`expected a candidate: ${JSON.stringify(extraction)}`);
  return extraction.candidate;
}

describe("HTTP method inference", () => {
  it("infers GET when the input has neither a method nor a bodyType", async () => {
    const found = candidate(await extract(undeclaredMethod({ queryParams: { city: "Izmir" } })));
    expect(found.identity.method).toBe("GET");
    expect(found.content.method).toBe("GET");
  });

  it("infers POST when the input has a bodyType but no method", async () => {
    const found = candidate(await extract(undeclaredMethod({ bodyType: "json", body: { text: "hello" } })));
    expect(found.identity.method).toBe("POST");
    expect(found.content.method).toBe("POST");
  });

  it("uses a declared method over the inference", async () => {
    const put = candidate(await extract(undeclaredMethod({ method: "PUT", bodyType: "json", body: {} })));
    expect(put.identity.method).toBe("PUT");
    const remove = candidate(await extract(undeclaredMethod({ method: "DELETE", queryParams: {} })));
    expect(remove.identity.method).toBe("DELETE");
  });
});

describe("MCP tool names", () => {
  it.each([
    ["one visible character", "!"],
    ["the longest allowed name", "~".repeat(MAX_TOOL_NAME_LENGTH)],
    ["punctuation and digits", "weather.forecast_v2-beta"],
  ])("accepts %s", async (_label, toolName) => {
    const found = candidate(await extract(mcpExtension(toolName), "mcp://tool/forecast"));
    expect(found.identity.toolName).toBe(toolName);
  });

  it.each([
    ["an empty name", ""],
    ["a space", "get forecast"],
    ["a control character", "get\u0007forecast"],
    ["a DEL character", "get\u007fforecast"],
    ["a non-ASCII character", "prévision"],
    ["a name one character too long", "a".repeat(MAX_TOOL_NAME_LENGTH + 1)],
  ])("rejects %s with bazaar_info_unsupported", async (_label, toolName) => {
    const extraction = await extract(mcpExtension(toolName), "mcp://tool/forecast");
    expect(extraction).toMatchObject({ kind: "rejected", code: "bazaar_info_unsupported" });
    expect(extraction.kind === "rejected" ? extraction.reason.trim() : "").not.toBe("");
  });

  it("allows names of 1 to 128 characters", () => {
    expect(MAX_TOOL_NAME_LENGTH).toBe(128);
  });
});
