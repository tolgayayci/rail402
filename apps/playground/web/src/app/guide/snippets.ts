/**
 * The commands and code the Sell and Agents pages show. The sources live in `src/snippets/`, where the
 * TypeScript is type-checked against the real packages and the tests run every command line through
 * the CLI's own parser and the MCP configuration through the server's own reader. The page imports
 * them as text and fills `{{…}}` from the configuration.
 */
import agentInstall from "../../../../src/snippets/agent-install.txt?raw";
import agentWallet from "../../../../src/snippets/agent-wallet.txt?raw";
import mcpClaudeCode from "../../../../src/snippets/mcp-claude-code.txt?raw";
import mcpConfig from "../../../../src/snippets/mcp-config.json?raw";
import sellerCheck from "../../../../src/snippets/seller-check.txt?raw";
import sellerInstall from "../../../../src/snippets/seller-install.txt?raw";
import sellerKeys from "../../../../src/snippets/seller-keys.txt?raw";
import sellerRoute from "../../../../src/snippets/seller-route.ts?raw";

export const SNIPPET_SOURCES = Object.freeze({
  agentInstall,
  agentWallet,
  mcpClaudeCode,
  mcpConfig,
  sellerCheck,
  sellerInstall,
  sellerKeys,
  sellerRoute,
});

/** The spending limits the Agents page suggests: per paid call and per 24-hour budget window. */
export const AGENT_LIMITS = Object.freeze({ perCall: "0.05", total: "0.50" });

/** What the Agents page suggests asking. It names a real listed tool and stays inside the limits. */
export const AGENT_PROMPT = `Find a paid tool on Stellar and get the air quality in Istanbul. Spend at most ${AGENT_LIMITS.perCall} USDC.`;

/** The tools rail402-mcp gives the agent. */
export const AGENT_TOOLS = Object.freeze(["search_stellar_resources", "pay_and_call", "get_budget"] as const);

export interface SnippetValues {
  /** The facilitator sellers settle through. */
  readonly facilitator: string;
  /** The asset symbol of the caps, such as USDC. */
  readonly asset: string;
}

/**
 * The text a snippet shows: the maintainer header (leading `//` lines) and `@hide` lines dropped, runs of
 * blank lines left by them collapsed, and `{{name}}` filled. Unknown placeholders stay as they are.
 */
export function snippetText(source: string, values: SnippetValues): string {
  const fills: Readonly<Record<string, string>> = {
    facilitator: values.facilitator.replace(/\/+$/, ""),
    asset: values.asset,
    perCall: AGENT_LIMITS.perCall,
    total: AGENT_LIMITS.total,
  };
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length && /^\/\//.test(lines[start] ?? "")) start += 1;
  return lines
    .slice(start)
    .filter((line) => !/(?:\/\/|#)\s*@hide\s*$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\{\{(\w+)\}\}/g, (whole, name: string) => fills[name] ?? whole);
}

/** An MCP client the Agents page configures, and how its configuration is added. */
export interface ClientSetup {
  readonly id: "claude-desktop" | "cursor" | "claude-code";
  readonly label: string;
  /** Where the snippet goes, in a few words. */
  readonly where: string;
  readonly language: "json" | "shell";
  readonly source: string;
}

export const CLIENTS: readonly [ClientSetup, ...ClientSetup[]] = Object.freeze([
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    where: "Settings → Developer → Edit Config opens claude_desktop_config.json",
    language: "json",
    source: mcpConfig,
  },
  {
    id: "cursor",
    label: "Cursor",
    where: "In ~/.cursor/mcp.json, or .cursor/mcp.json in a project",
    language: "json",
    source: mcpConfig,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    where: "Run it once in your terminal",
    language: "shell",
    source: mcpClaudeCode,
  },
]);
