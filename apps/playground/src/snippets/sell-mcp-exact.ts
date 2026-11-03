// Sell page snippet: an MCP tool at a fixed price. Shown on the page (the price follows the visitor's
// pick), type-checked here, never run.
import { exact, mcpTool, param } from "@rail402.dev/sdk/seller";

const PAY_TO = process.env["PAY_TO"] ?? ""; // your G… address

export const forecast = mcpTool({
  endpoint: "https://your-api.example/mcp",
  toolName: "forecast",
  description: "Seven-day weather forecast for a city",
  payment: exact({ network: "stellar:testnet", payTo: PAY_TO, price: "$0.01" }),
  arguments: { city: param.string({ description: "City name", required: true, example: "Ankara" }) },
});
// Register it on your MCP server with createPaymentWrapper from @x402/mcp.
