import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createLogger, createTools } from "@rail402.dev/mcp";
import { fakeBuyer } from "./helpers.ts";

describe("logger", () => {
  it("writes JSON lines at or above its level, redacting secrets in the message and nested fields", () => {
    const lines: string[] = [];
    const logger = createLogger("info", (line) => lines.push(line));
    const seed = Keypair.random().secret();
    logger.debug("hidden");
    logger.info(`loaded ${seed}`, { nested: { xdr: "A".repeat(80) }, count: 2n });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "info",
      msg: "loaded [redacted]",
      nested: { xdr: "[redacted]" },
      count: "2",
    });
    expect(lines.join("")).not.toContain(seed);
  });

  it("logs each tool call's outcome without its arguments", async () => {
    const lines: string[] = [];
    const tools = createTools({
      buyer: fakeBuyer(),
      logger: createLogger("info", (line) => lines.push(line)),
    });
    await tools.call("search_stellar_resources", { query: "private query text" });
    await tools.call("pay_and_call", { resource: "https://a.example" });
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toMatchObject([
      { msg: "tool call", tool: "search_stellar_resources", ok: true },
      { msg: "tool call", tool: "pay_and_call", ok: false, code: "tool_input_invalid", paid: "none" },
    ]);
    expect(lines.join("")).not.toContain("private query text");
  });
});
