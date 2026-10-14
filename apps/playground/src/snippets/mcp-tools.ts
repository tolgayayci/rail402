// Code-panel snippet: the scripted agent's rail402-mcp tool calls. Any MCP client sends the same
// inputs. Shown on the page (with `{{…}}` filled in), type-checked here, never run.
import type { z } from "zod"; // @hide
import type { payInput, searchInput } from "@rail402.dev/mcp"; // @hide
declare function search_stellar_resources(input: z.input<typeof searchInput>): void; // @hide
declare function get_budget(input: Record<string, never>): void; // @hide
declare function pay_and_call(input: z.input<typeof payInput>): void; // @hide
declare const listingId: string; // @hide

search_stellar_resources({
  // @step:search,results
  query: "hourly weather forecast", // @step:search
  type: "mcp", // @step:search
  maxPrice: { amount: "0.05", asset: "{{asset}}" }, // @step:search
}); // @step:search,results

get_budget({}); // @step:budget

pay_and_call({
  // @step:call-tool
  listingId, // the best callable match // @step:pick,call-tool
  arguments: { city: "Izmir", hours: 6 }, // @step:call-tool,tool-result
  spendingCap: { amount: "{{cap}}", asset: "{{asset}}" }, // @step:call-tool,tool-settle
}); // @step:call-tool,tool-result
