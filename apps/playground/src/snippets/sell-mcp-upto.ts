// Sell page snippet: an MCP tool that charges what a call used, up to a cap. Shown on the page (the cap
// follows the visitor's pick), type-checked here, never run.
import { chargeUpto, mcpTool, param, upto } from "@rail402.dev/sdk/seller";

const PAY_TO = process.env["PAY_TO"] ?? ""; // your G… address

export const forecast = mcpTool({
  endpoint: "https://your-api.example/mcp",
  toolName: "forecast",
  description: "Seven-day weather forecast for a city",
  payment: upto({ network: "stellar:testnet", payTo: PAY_TO, maxPrice: "$0.01", maxTimeoutSeconds: 120 }),
  arguments: { city: param.string({ description: "City name", required: true, example: "Ankara" }) },
});

// In the tool handler, with the server wrapped by meteredToolServer:
export const answer = (text: string) => chargeUpto({ content: [{ type: "text" as const, text }] }, "40%");
