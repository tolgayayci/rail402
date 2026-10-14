/**
 * An MCP client that pays for what it needs without knowing any endpoint in advance. It starts
 * rail402-mcp over stdio, asks the Stellar Bazaar for a resource in plain language, and pays the
 * first result that is callable and within the spending policy, bound to that listing's owner. There
 * is no model in the loop, so every run takes the same steps.
 *
 *   node src/index.ts ["what you need"]
 *
 * rail402-mcp reads its configuration from the RAIL402_* variables passed through below, for example
 * RAIL402_SECRET_KEY_FILE (the payer's key file) and RAIL402_MAX_PER_CALL / RAIL402_MAX_TOTAL (caps).
 * RAIL402_MCP_COMMAND overrides how the server is started (default: rail402-mcp on the PATH).
 */
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

interface SearchResult {
  listingId: string | null;
  type: string;
  resource: string;
  method: string | null;
  toolName: string | null;
  callable: boolean;
  withinPolicy: boolean;
  prices: { amount: string | null; asset: string }[];
  input: { example?: unknown };
}

const query = process.argv[2] ?? "air quality for a city";
const spendingCap = {
  amount: process.env["SPENDING_CAP"] ?? "0.01",
  asset: process.env["SPENDING_CAP_ASSET"] ?? "USDC",
};

const [command = "rail402-mcp", ...args] = (process.env["RAIL402_MCP_COMMAND"] ?? "rail402-mcp").split(/\s+/);
const env: Record<string, string> = { ...getDefaultEnvironment() };
for (const [name, value] of Object.entries(process.env)) {
  if (value !== undefined && (name.startsWith("RAIL402_") || name === "NODE_EXTRA_CA_CERTS"))
    env[name] = value;
}
delete env["RAIL402_MCP_COMMAND"];

const client = new Client(
  { name: "rail402-example-agent", version: "1.0.0" },
  { versionNegotiation: { mode: "auto" } },
);
await client.connect(new StdioClientTransport({ command, args, env, stderr: "inherit" }));

const call = async (name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const result = await client.callTool({ name, arguments: input });
  return (result.structuredContent ?? {}) as Record<string, unknown>;
};

try {
  const found = await call("search_stellar_resources", { query });
  if (found["ok"] !== true) throw new Error(`search failed: ${JSON.stringify(found["error"])}`);
  const results = found["results"] as SearchResult[];
  const chosen = results.find(
    (result) => result.callable && result.withinPolicy && result.listingId !== null,
  );
  console.log(
    JSON.stringify({
      step: "search",
      query,
      results: results.map(({ listingId, type, resource, toolName, callable, withinPolicy, prices }) => ({
        listingId,
        type,
        resource,
        toolName,
        callable,
        withinPolicy,
        prices: prices.map((price) => `${price.amount ?? "?"} ${price.asset}`),
      })),
      chosen: chosen?.listingId ?? null,
    }),
  );
  if (chosen === undefined) throw new Error("no result is callable within the spending policy");

  // The listing's own example input is a valid call; an agent with a model would fill it from the task.
  const example = (chosen.input.example ?? {}) as Record<string, unknown>;
  const input =
    chosen.type === "mcp"
      ? { arguments: example }
      : ["POST", "PUT", "PATCH"].includes(chosen.method ?? "GET")
        ? { body: example }
        : { query: example };
  const paid = await call("pay_and_call", {
    listingId: chosen.listingId,
    ...input,
    spendingCap,
    idempotencyKey: `example-${randomUUID()}`,
  });
  console.log(JSON.stringify({ step: "pay_and_call", result: paid }));
  if (paid["ok"] !== true) {
    process.exitCode = 1;
  } else {
    const payment = paid["payment"] as { transaction: string | null; explorerUrl: string | null } | null;
    console.log(
      JSON.stringify({
        step: "done",
        transaction: payment?.transaction ?? null,
        explorerUrl: payment?.explorerUrl ?? null,
      }),
    );
  }
} finally {
  await client.close();
}
