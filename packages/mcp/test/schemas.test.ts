import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { TOOL_NAMES, createRail402Mcp } from "@rail402.dev/mcp";
import { payInput } from "../src/schemas.ts";
import { fakeBuyer } from "./helpers.ts";

/** Every key anywhere in a JSON value. */
function keys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) keys(item, found);
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      found.push(key);
      keys(item, found);
    }
  }
  return found;
}

describe("tools/list", () => {
  const { tools, factory } = createRail402Mcp({ buyer: fakeBuyer() });

  it("lists the tools in a fixed order with the published schemas (snapshot)", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = await factory({ era: "legacy" });
    await server.connect(serverSide);
    const client = new Client({ name: "snapshot", version: "1" });
    await client.connect(clientSide);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    await expect(`${JSON.stringify(listed, null, 2)}\n`).toMatchFileSnapshot(
      "./__snapshots__/tools-list.json.snap",
    );
    expect(client.getInstructions()).toContain("untrusted data");
    await client.close();
  });

  it("publishes self-contained object schemas without header mirroring or secret-like fields", () => {
    for (const definition of tools.definitions) {
      for (const schema of [definition.inputSchema, definition.outputSchema]) {
        expect(schema["type"], definition.name).toBe("object");
        const all = keys(schema);
        expect(all).not.toContain("$ref");
        expect(all).not.toContain("$defs");
        expect(all).not.toContain("$schema");
        expect(all.filter((key) => key.startsWith("x-mcp"))).toEqual([]);
        expect(all.filter((key) => /secret|seed|private|password|mnemonic/i.test(key))).toEqual([]);
      }
      expect(definition.inputSchema["additionalProperties"], definition.name).toBe(false);
    }
  });

  it("marks only pay_and_call as a spending, non-idempotent tool", () => {
    const hints = Object.fromEntries(tools.definitions.map((tool) => [tool.name, tool.annotations]));
    expect(hints).toEqual({
      search_stellar_resources: { readOnlyHint: true, openWorldHint: true },
      pay_and_call: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      get_budget: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    });
  });
});

describe("pay_and_call input", () => {
  it("refuses a resource the URL parser cannot read, before anything is fetched", () => {
    for (const resource of ["https://%", "http://[::1", "https://exa mple.com/mcp"]) {
      const parsed = payInput.safeParse({ resource, toolName: "forecast" });
      expect(parsed.success, resource).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain("resource");
    }
    expect(
      payInput
        .safeParse({ resource: "https://demo.example/mcp", toolName: "forecast" })
        .error?.issues.map((issue) => issue.path.join(".")) ?? [],
    ).not.toContain("resource");
  });
});
