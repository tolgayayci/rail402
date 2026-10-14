/** `@rail402.dev/mcp/tools`: the server's own tool code, without the server and its Node wiring. */
import { describe, expect, it } from "vitest";
import * as server from "@rail402.dev/mcp";
import * as tools from "@rail402.dev/mcp/tools";
import { fakeBuyer } from "./helpers.ts";

describe("@rail402.dev/mcp/tools", () => {
  it("is the tool code the server runs", () => {
    expect(tools.createTools).toBe(server.createTools);
    expect(tools.SERVER_INSTRUCTIONS).toBe(server.SERVER_INSTRUCTIONS);
    expect(tools.toolCodes).toBe(server.toolCodes);
    expect(tools.mcpServerCodes).toBe(server.mcpServerCodes);
    expect(tools.searchInput).toBe(server.searchInput);
    expect(tools.payInput).toBe(server.payInput);
  });

  it("leaves out the server, its transports and configuration", () => {
    for (const name of ["createServerFactory", "createRail402Mcp", "createLogger", "main", "loadMcpConfig"]) {
      expect(tools, name).not.toHaveProperty(name);
    }
  });

  it("answers a call with the same result as the server's tools", async () => {
    const buyer = fakeBuyer();
    const viaEntry = tools.createTools({ buyer });
    expect(viaEntry.definitions.map((definition) => definition.name)).toEqual([...tools.TOOL_NAMES]);
    const result = await viaEntry.call("get_budget", {});
    expect(result).toEqual(await server.createTools({ buyer: fakeBuyer() }).call("get_budget", {}));
  });
});
