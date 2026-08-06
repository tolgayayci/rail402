import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * An agent that discovers an MCP **tool** it has never heard of, and calls it — paying on the way.
 *
 * The distinction from the other MCP example is the thing being sold. There the agent discovers an
 * HTTP endpoint and `pay_and_call` issues an HTTP request. Here it discovers a *tool* on somebody
 * else's MCP server, and `pay_and_call` speaks MCP to it: the 402 challenge arrives as a JSON-RPC
 * error, the payment travels in `_meta`, and the settlement response comes back the same way. The
 * agent does not know or care — it passes `toolName` back exactly as search returned it, and the
 * transport follows.
 *
 * Read what this file does NOT contain: no seller URL, no price, no `payTo`, no Stellar import, no
 * MCP client pointed at the seller. It knows a task in English and a spending limit.
 */

const TASK = process.env.TASK ?? "tide times and sea conditions at a coastal port";
const MAX_SPEND = process.env.MAX_SPEND ?? "5000000";

async function main(): Promise<void> {
  const client = new Client({ name: "mcp-tool-example-agent", version: "0.1.0" });

  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: [new URL("../../../apps/mcp-discovery/dist/index.js", import.meta.url).pathname],
      env: {
        ...process.env,
        BAZAAR_URL: process.env.BAZAAR_URL ?? "http://localhost:4022",
        CLIENT_STELLAR_PRIVATE_KEY: process.env.CLIENT_STELLAR_PRIVATE_KEY ?? "",
        MAX_AMOUNT_CEILING: MAX_SPEND,
        // The seller runs on localhost in this example. A hosted deployment must not set this.
        MCP_ALLOW_PRIVATE_HOSTS: "1",
      } as Record<string, string>,
    }),
  );

  // ── Find an MCP tool ────────────────────────────────────────────────────
  // `type: "mcp"` is one of the spec's seven filters. The largest live Bazaar returns 0 for it.
  const found = unwrap(
    await client.callTool({
      name: "search_stellar_resources",
      arguments: { query: TASK, type: "mcp", maxPrice: MAX_SPEND, limit: 5 },
    }),
  );

  if (!found.ok || !found.data?.results?.length) {
    console.error(`[agent] no MCP tool found: ${found.error?.reason ?? "no matches"}`);
    process.exit(1);
  }

  const pick = found.data.results[0]!;
  console.log(`[agent] found ${found.data.count} MCP tool(s); best match:`);
  console.log(`          endpoint ${pick.resource}`);
  console.log(`          tool     ${pick.toolName}`);
  console.log(`          ${pick.description ?? "(no description)"}`);
  if (pick.price) {
    // amountDecimal and assetIdentity are only present when the catalog can PROVE what the token is.
    const priced = pick.price.amountDecimal
      ? `${pick.price.amountDecimal} ${pick.price.assetIdentity?.code}`
      : `${pick.price.amount} atomic units`;
    console.log(`          price    ${priced}${pick.price.feesSponsored ? " (gasless)" : ""}`);
    if (pick.price.payToTrustline && pick.price.payToTrustline.state !== "ok") {
      console.log(`          WARNING  payee trustline: ${pick.price.payToTrustline.state}`);
    }
  }

  if (!pick.toolName) {
    console.error("[agent] the result is not an MCP tool — it carries no toolName");
    process.exit(1);
  }

  // The agent learns the tool's arguments from its published schema. It was never told them.
  const properties = (pick.inputSchema as { properties?: Record<string, { description?: string }> })
    ?.properties;
  if (properties) {
    for (const [name, spec] of Object.entries(properties)) {
      console.log(`          arg      ${name} — ${spec.description ?? "(undescribed)"}`);
    }
  }

  // ── Pay for it, over MCP ────────────────────────────────────────────────
  // Passing toolName is what makes this an MCP tool call rather than an HTTP request.
  const paid = unwrap(
    await client.callTool({
      name: "pay_and_call",
      arguments: {
        resource: pick.resource,
        toolName: pick.toolName,
        toolArguments: { harbour: "Dover" },
        maxAmount: MAX_SPEND,
        ...(found.data.searchToken ? { searchToken: found.data.searchToken } : {}),
      },
    }),
  );

  if (!paid.ok) {
    console.error(`[agent] refused [${paid.error?.code}] ${paid.error?.reason}`);
    process.exit(1);
  }

  console.log(`[agent] transport ${paid.data?.transport}`);
  console.log(`[agent] paid ${paid.data?.paid?.amount} — tx ${paid.data?.paid?.transaction}`);
  console.log(`[agent] result: ${JSON.stringify(paid.data?.body)}`);

  // ── The spend cap binds on this transport too ───────────────────────────
  const refused = unwrap(
    await client.callTool({
      name: "pay_and_call",
      arguments: {
        resource: pick.resource,
        toolName: pick.toolName,
        toolArguments: { harbour: "Dover" },
        maxAmount: "1",
      },
    }),
  );
  console.log(
    refused.ok
      ? "[agent] UNEXPECTED: a 1-unit budget was accepted"
      : `[agent] budget enforced [${refused.error?.code}]: ${refused.error?.reason}`,
  );

  await client.close();
}

interface ToolEnvelope {
  ok: boolean;
  data?: {
    count?: number;
    searchToken?: string;
    results?: Array<{
      resource: string;
      toolName?: string;
      description?: string;
      inputSchema?: unknown;
      price?: {
        amount: string;
        amountDecimal?: string;
        feesSponsored?: boolean;
        assetIdentity?: { code: string };
        payToTrustline?: { state: string };
      };
    }>;
    transport?: string;
    body?: unknown;
    paid?: { amount: string; transaction?: string };
  };
  error?: { code: string; reason: string };
}

/** Our tools return the structured envelope in both `structuredContent` and a text block. */
function unwrap(result: unknown): ToolEnvelope {
  const structured = (result as { structuredContent?: ToolEnvelope }).structuredContent;
  if (structured) return structured;
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  const text = content.find(c => c.type === "text")?.text;
  if (!text) return { ok: false, error: { code: "mcp_upstream_error", reason: "empty tool result" } };
  try {
    return JSON.parse(text) as ToolEnvelope;
  } catch {
    return {
      ok: false,
      error: { code: "mcp_upstream_error", reason: `unparseable tool result: ${text.slice(0, 200)}` },
    };
  }
}

main().catch(error => {
  console.error("[agent] fatal:", error);
  process.exit(1);
});
