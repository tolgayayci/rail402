import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * An agent that pays for a service it has never seen before.
 *
 * The claim it has to prove is narrow and specific:
 * **no pre-baked integration.** So read what this file does NOT contain:
 *
 *   - no seller URL
 *   - no price, asset, or `payTo` address
 *   - no knowledge that the seller exists
 *   - no x402 code, no Stellar SDK import, no payment logic
 *
 * It knows two things: a task in English, and a spending limit. Everything else — finding a service,
 * reading its price, deciding it is affordable, signing a Stellar authorization, settling on-ledger,
 * retrying the request — happens behind two MCP tools.
 *
 * The agent is a plain MCP client, which is the point: any agent runtime that speaks MCP gets this
 * without knowing anything about x402 or Stellar.
 */

const TASK = process.env.TASK ?? "current price of a commodity by ticker symbol";
const MAX_SPEND = process.env.MAX_SPEND ?? "5000000"; // 0.5 units at 7 decimals

async function main(): Promise<void> {
  const client = new Client({ name: "example-agent", version: "0.1.0" });

  // Launch the MCP discovery server as a subprocess over stdio — how agent runtimes normally do it.
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [new URL("../../../apps/mcp-discovery/dist/index.js", import.meta.url).pathname],
      env: {
        ...process.env,
        BAZAAR_URL: process.env.BAZAAR_URL ?? "http://localhost:4022",
        CLIENT_STELLAR_PRIVATE_KEY: process.env.CLIENT_STELLAR_PRIVATE_KEY ?? "",
        MAX_AMOUNT_CEILING: MAX_SPEND,
        // This example runs its seller on localhost, which `pay_and_call` refuses by default
        // because it fetches caller-supplied URLs. A hosted deployment must not set this.
        MCP_ALLOW_PRIVATE_HOSTS: "1",
      } as Record<string, string>,
    }),
  );

  const tools = await client.listTools();
  console.log(`[agent] tools available: ${tools.tools.map(t => t.name).join(", ")}`);

  // ── Step 1: find something that can do the job ──────────────────────────
  console.log(`[agent] task: "${TASK}"`);
  console.log(`[agent] budget: ${MAX_SPEND} atomic units`);

  const found = unwrap(
    await client.callTool({
      name: "search_stellar_resources",
      arguments: { query: TASK, maxPrice: MAX_SPEND, limit: 5 },
    }),
  );

  if (!found.ok || !found.data?.results?.length) {
    console.error(`[agent] nothing found: ${found.error?.reason ?? "no matches"}`);
    process.exit(1);
  }

  const pick = found.data.results[0]!;
  console.log(`[agent] found ${found.data.count} candidate(s); best match:`);
  console.log(`          ${pick.resource}`);
  console.log(`          ${pick.description ?? "(no description)"}`);
  console.log(`          price ${pick.price?.amount} of ${pick.price?.asset}`);
  if (pick.usage) {
    console.log(`          used by ${pick.usage.uniquePayers} distinct payer(s)`);
  }

  // The agent learns how to call the endpoint from its published input schema — it was never told.
  if (pick.inputSchema) {
    const props = Object.keys(
      (pick.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );
    console.log(`          parameters: ${props.join(", ") || "(none)"}`);
  }

  // ── Step 2: pay for it ──────────────────────────────────────────────────
  const paid = unwrap(
    await client.callTool({
      name: "pay_and_call",
      arguments: {
        resource: pick.resource,
        queryParams: { symbol: "XLM" },
        maxAmount: MAX_SPEND,
      },
    }),
  );

  if (!paid.ok) {
    // A refusal is structured, so the agent can reason about it rather than parse prose.
    console.error(`[agent] refused [${paid.error?.code}] ${paid.error?.reason}`);
    process.exit(1);
  }

  console.log(`[agent] paid ${paid.data?.paid?.amount} — tx ${paid.data?.paid?.transaction}`);
  console.log(`[agent] result: ${JSON.stringify(paid.data?.body)}`);

  // ── Step 3: prove the spend cap is real ─────────────────────────────────
  // Ask for the same resource with a budget of 1 atomic unit. Nothing should be paid.
  const refused = unwrap(
    await client.callTool({
      name: "pay_and_call",
      arguments: { resource: pick.resource, queryParams: { symbol: "XLM" }, maxAmount: "1" },
    }),
  );
  console.log(
    refused.ok
      ? `[agent] UNEXPECTED: a 1-unit budget was accepted`
      : `[agent] budget enforced [${refused.error?.code}]: ${refused.error?.reason}`,
  );

  await client.close();
}

/** MCP tool results arrive as text content; our tools always return the structured envelope. */
interface ToolEnvelope {
  ok: boolean;
  data?: {
    count?: number;
    results?: Array<{
      resource: string;
      description?: string;
      price?: { amount: string; asset: string };
      inputSchema?: unknown;
      usage?: { uniquePayers: number };
    }>;
    body?: unknown;
    paid?: { amount: string; transaction?: string };
  };
  error?: { code: string; reason: string };
}

function unwrap(result: unknown): ToolEnvelope {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content.find(c => c.type === "text")?.text;
  if (!text) return { ok: false, error: { code: "mcp_upstream_error", reason: "empty tool result" } };
  try {
    return JSON.parse(text) as ToolEnvelope;
  } catch {
    return { ok: false, error: { code: "mcp_upstream_error", reason: `unparseable tool result: ${text.slice(0, 200)}` } };
  }
}

main().catch(error => {
  console.error("[agent] fatal:", error);
  process.exit(1);
});
