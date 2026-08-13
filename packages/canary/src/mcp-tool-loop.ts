import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { X402Error } from "@rail402/errors";
import { CanaryRun, type CanaryReport } from "./report.js";
import { requireBazaarFacilitator } from "./supported.js";
import {
  MCP_PARAMETER_DESCRIPTION,
  MCP_QUERY,
  startSyntheticMcpSeller,
  type SyntheticMcpSeller,
} from "./mcp-seller.js";
import { NETWORK, prepareFixtures, sleep } from "./testnet.js";

/**
 * The MCP-tool loop canary.
 *
 * The Bazaar extension makes an MCP tool a first-class resource type, keyed on the pair
 * (`resource.url`, `input.toolName`) because one endpoint multiplexes many tools. Everyone specifies
 * it; nobody serves it — `type=mcp` returns `total: 0` against the largest live Bazaar's 15,332 HTTP
 * entries. This check proves the whole lane works here, on a live network:
 *
 *   1. a paid MCP tool catalogs itself from a real settled payment, with no registration step;
 *   2. it is findable through the spec's `type=mcp` filter and by natural-language search;
 *   3. an agent that has never heard of it can CALL it — `pay_and_call` speaks MCP, settles a real
 *      testnet payment, and returns the tool's output;
 *   4. the spend cap binds on this transport too, refusing without paying.
 *
 * (3) is the one that was missing. `pay_and_call` accepted a `toolName` from the day its schema was
 * written and ignored it, sending every call as an HTTP request — so an MCP tool could be discovered
 * and then not used. A unit test would not have caught it either: the failure is that a real MCP
 * server never gets spoken to.
 *
 * Everything is driven through the MCP server as an agent runtime drives it — a stdio client calling
 * the real tools — rather than by importing the implementation.
 */

const AMOUNT = "2500000"; // 0.25 units at 7 decimals. Atomic units, never a float.
const CATALOG_DEADLINE_MS = 30_000;
const POLL_MS = 250;
const RANK_CEILING = 10;

export interface McpToolLoopOptions {
  readonly facilitatorUrl: string;
  readonly runId: string;
  readonly log?: (line: string) => void;
}

interface Envelope {
  ok?: boolean;
  data?: {
    count?: number;
    searchToken?: string;
    results?: {
      resource: string;
      type?: string;
      toolName?: string;
      inputSchema?: unknown;
      price?: { amount: string };
    }[];
    transport?: string;
    toolName?: string;
    body?: unknown;
    isError?: boolean;
    paid?: { amount: string; transaction?: string };
  };
  error?: { code?: string; reason?: string };
}

export async function runMcpToolLoop(options: McpToolLoopOptions): Promise<CanaryReport> {
  const run = new CanaryRun(
    "mcp-tool-loop",
    NETWORK,
    options.facilitatorUrl,
    options.log ?? (line => console.error(line)),
  );
  let seller: SyntheticMcpSeller | undefined;
  let agent: Client | undefined;

  try {
    await run.step("facilitator-reachable", async () => {
      const extensions = await requireBazaarFacilitator(options.facilitatorUrl);
      return { detail: `/supported advertises ${extensions.join(", ")}` };
    });

    const fixtures = await run.step("testnet-fixtures", async () => {
      const f = await prepareFixtures(assetCodeFor(options.runId));
      return { detail: `asset ${f.assetCode} · buyer ${short(f.buyer.publicKey())}`, f };
    });

    seller = (
      await run.step("mcp-seller-online", async () => {
        const s = await startSyntheticMcpSeller({
          facilitatorUrl: options.facilitatorUrl,
          network: NETWORK,
          payTo: fixtures.f.seller.publicKey(),
          asset: fixtures.f.assetContractId,
          amount: AMOUNT,
          runId: options.runId,
        });
        return { detail: `${s.endpointUrl} · tool ${s.toolName}`, s };
      })
    ).s;

    // The agent side: the real MCP discovery server, launched over stdio exactly as an agent runtime
    // launches it. Nothing below imports our implementation.
    agent = (
      await run.step("agent-connected", async () => {
        const client = new Client({ name: "mcp-tool-loop-canary", version: "0.1.0" });
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [new URL("../../../apps/mcp-discovery/dist/index.js", import.meta.url).pathname],
            env: {
              ...process.env,
              BAZAAR_URL: options.facilitatorUrl,
              CLIENT_STELLAR_PRIVATE_KEY: fixtures.f.buyer.secret(),
              // The synthetic seller binds 127.0.0.1, which `pay_and_call` refuses by default
              // because it fetches caller-supplied URLs. Opting in is what a local development
              // deployment does; a hosted one must not.
              MCP_ALLOW_PRIVATE_HOSTS: "1",
            } as Record<string, string>,
          }),
        );
        const tools = await client.listTools();
        return { detail: `tools: ${tools.tools.map(t => t.name).join(", ")}`, client };
      })
    ).client;

    // ── 1 & 3: pay for the tool, over MCP ───────────────────────────────────
    //
    // No prior settlement, so nothing is catalogued yet — the agent is handed the endpoint the way a
    // buyer who already knows a seller would be. What is under test here is the transport and the
    // payment; discovery is tested below, from the listing this payment creates.
    const paid = await run.step("paid-mcp-tool-call", async () => {
      const result = await callTool(agent!, "pay_and_call", {
        resource: seller!.endpointUrl,
        toolName: seller!.toolName,
        toolArguments: { harbour: "Dover" },
        maxAmount: "10000000",
        network: NETWORK,
      });
      if (!result.ok) {
        throw new X402Error("canary_settlement_failed", {
          reason: `pay_and_call refused the MCP tool call: [${result.error?.code}] ${result.error?.reason}`,
          details: { result },
        });
      }
      if (result.data?.transport !== "mcp") {
        throw new X402Error("canary_settlement_failed", {
          reason: `The call reported transport "${result.data?.transport}". Supplying toolName must route over MCP — reporting http means the tool name was ignored again and an HTTP request went out instead.`,
          details: { transport: result.data?.transport },
        });
      }
      const transaction = result.data.paid?.transaction;
      if (!transaction) {
        throw new X402Error("canary_settlement_failed", {
          reason:
            "The MCP tool call succeeded but reported no settlement transaction, so nothing proves a payment was made. The settlement response travels in the MCP result's _meta; losing it there is invisible to the caller.",
          details: { paid: result.data.paid ?? null },
        });
      }
      // The tool's own output has to come back too — a paid call that settles and returns nothing
      // useful is a worse outcome than a refusal.
      const text = JSON.stringify(result.data.body ?? null);
      if (!text.includes("Dover")) {
        throw new X402Error("canary_settlement_failed", {
          reason: `The tool's output did not reach the agent (got ${text.slice(0, 200)}). The argument passed was harbour="Dover".`,
        });
      }
      run.observe("transaction", transaction);
      run.observe("amount", result.data.paid?.amount ?? AMOUNT);
      run.observe("toolName", seller!.toolName);
      return { detail: `settled ${short(transaction)} · tool output returned`, settledAt: Date.now() };
    });

    // ── 2: it catalogued itself, as an MCP resource, keyed on the pair ──────
    const listed = await run.step("catalogued-as-mcp", async () => {
      const deadline = paid.settledAt + CATALOG_DEADLINE_MS;
      for (;;) {
        // `type=mcp` is one of the spec's seven filters, exercised here on live data.
        const url = new URL("/discovery/resources", options.facilitatorUrl);
        url.searchParams.set("type", "mcp");
        url.searchParams.set("payTo", fixtures.f.seller.publicKey());
        const body = (await (await fetch(url)).json()) as {
          items?: { resource: string; type?: string; extensions?: Record<string, unknown> }[];
        };
        const found = (body.items ?? []).find(r => r.resource === seller!.catalogKey);
        if (found) {
          if (found.type !== "mcp") {
            throw new X402Error("canary_resource_not_indexed", {
              reason: `The listing was cataloged with type "${found.type}" rather than "mcp", so the spec's type filter cannot find it.`,
            });
          }
          const serialized = JSON.stringify(found.extensions ?? {});
          if (!serialized.includes(seller!.toolName)) {
            throw new X402Error("canary_resource_not_indexed", {
              reason: `The cataloged MCP listing does not carry its toolName, so its identity is incomplete — MCP resources are keyed on (resource.url, toolName) because one endpoint serves many tools.`,
            });
          }
          if (!serialized.includes(MCP_PARAMETER_DESCRIPTION)) {
            throw new X402Error("canary_parameter_descriptions_lost", {
              reason:
                "The cataloged MCP tool lost its per-parameter description, so an agent reading the catalog cannot tell what to pass it.",
            });
          }
          const lagMs = Date.now() - paid.settledAt;
          run.observe("indexingLagMs", lagMs);
          return { detail: `type=mcp, toolName and parameter prose intact (${lagMs}ms)` };
        }
        if (Date.now() >= deadline) {
          throw new X402Error("canary_resource_not_indexed", {
            reason: `The MCP tool settled a payment but never appeared under GET /discovery/resources?type=mcp within ${CATALOG_DEADLINE_MS}ms.`,
            details: { resource: seller!.catalogKey },
          });
        }
        await sleep(POLL_MS);
      }
    });
    void listed;

    // ── 2b: an agent can FIND it by describing what it wants ────────────────
    await run.step("discoverable-by-an-agent", async () => {
      const result = await callTool(agent!, "search_stellar_resources", {
        query: MCP_QUERY,
        type: "mcp",
        limit: RANK_CEILING,
      });
      const results = result.data?.results ?? [];
      const rank = results.findIndex(r => r.resource === seller!.catalogKey) + 1;
      if (rank === 0) {
        throw new X402Error("canary_resource_not_ranked", {
          reason: `A natural-language search for "${MCP_QUERY}" over MCP tools returned ${results.length} result(s), none of them the tool just catalogued.`,
          details: { query: MCP_QUERY, resultCount: results.length },
        });
      }
      const hit = results[rank - 1]!;
      if (hit.toolName !== seller!.toolName) {
        throw new X402Error("canary_resource_not_ranked", {
          reason: `The search result carries toolName ${JSON.stringify(hit.toolName)}, so an agent cannot call it — the tool name is half the identity and pay_and_call needs it.`,
        });
      }
      run.observe("searchRank", rank);
      run.observe("searchQuery", MCP_QUERY);
      return { detail: `rank ${rank} of ${results.length}, toolName returned` };
    });

    // ── 4: the spend cap binds on this transport too ────────────────────────
    await run.step("spend-cap-enforced", async () => {
      const result = await callTool(agent!, "pay_and_call", {
        resource: seller!.endpointUrl,
        toolName: seller!.toolName,
        toolArguments: { harbour: "Dover" },
        maxAmount: "1",
        network: NETWORK,
      });
      if (result.ok) {
        throw new X402Error("canary_rejection_accepted", {
          reason: `A budget of 1 atomic unit was accepted for a tool priced at ${AMOUNT}. The spend cap does not bind on the MCP transport.`,
          details: { result },
        });
      }
      if (result.error?.code !== "mcp_budget_exceeded") {
        throw new X402Error("canary_rejection_wrong_code", {
          reason: `The over-budget MCP call was refused under "${result.error?.code}" rather than mcp_budget_exceeded, so an agent branching on the code cannot tell a price refusal from an outage.`,
          details: { error: result.error ?? null },
        });
      }
      if (!result.error.reason?.includes(AMOUNT)) {
        throw new X402Error("canary_rejection_uncoded", {
          reason: `The refusal does not name the price it refused (${AMOUNT}), so the agent cannot decide whether to raise its budget. Got: ${result.error.reason}`,
        });
      }
      return { detail: `refused [${result.error.code}], naming the real price` };
    });

    run.observe("resource", seller.catalogKey);
    return run.finish();
  } catch (error) {
    run.observe("resource", seller?.catalogKey ?? null);
    return run.finish(error);
  } finally {
    await agent?.close().catch(() => undefined);
    await seller?.close();
  }
}

/** Call one of our MCP tools and read the structured envelope back. */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Envelope> {
  const result = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 180_000,
  })) as { structuredContent?: Envelope; content?: { type: string; text?: string }[] };

  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find(c => c.type === "text")?.text;
  if (!text) {
    return { ok: false, error: { code: "mcp_upstream_error", reason: "empty tool result" } };
  }
  return JSON.parse(text) as Envelope;
}

/** Derive a valid Stellar asset code from the run id. Codes are 1–12 alphanumerics. */
function assetCodeFor(runId: string): string {
  const suffix = runId.replace(/[^a-zA-Z0-9]/g, "").slice(-6).toUpperCase() || "0";
  return `MCPT${suffix}`.slice(0, 12);
}

function short(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}
