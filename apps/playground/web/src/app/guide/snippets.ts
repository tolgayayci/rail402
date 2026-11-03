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
import sellHttpExact from "../../../../src/snippets/sell-http-exact.ts?raw";
import sellHttpUpto from "../../../../src/snippets/sell-http-upto.ts?raw";
import sellMcpExact from "../../../../src/snippets/sell-mcp-exact.ts?raw";
import sellMcpUpto from "../../../../src/snippets/sell-mcp-upto.ts?raw";

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

/** What a seller sells and how it charges, as the Sell page lets the visitor pick them. */
export type SellKind = "http" | "mcp";
export type SellScheme = "exact" | "upto";

/** The prices the Sell page offers, in dollars. Every snippet is written at the middle one. */
export const SELL_PRICES = Object.freeze(["0.001", "0.01", "0.10"] as const);
export type SellPrice = (typeof SELL_PRICES)[number];
const SNIPPET_PRICE = '"$0.01"';

export const SELL_SNIPPETS: Readonly<Record<SellKind, Readonly<Record<SellScheme, string>>>> = Object.freeze({
  http: { exact: sellHttpExact, upto: sellHttpUpto },
  mcp: { exact: sellMcpExact, upto: sellMcpUpto },
});

/** The seller code for a pick: the snippet with the visitor's price (or cap) in place of the written one. */
export function sellCode(
  kind: SellKind,
  scheme: SellScheme,
  price: SellPrice,
  values: SnippetValues,
): string {
  return snippetText(SELL_SNIPPETS[kind][scheme], values).replace(SNIPPET_PRICE, `"$${price}"`);
}

/** The spending limits the Agents page suggests: per paid call and per 24-hour budget window. */
export const AGENT_LIMITS = Object.freeze({ perCall: "0.05", total: "0.50" });

/** The limits the Agents page lets the visitor pick from; the suggested ones are among them. */
export const AGENT_PER_CALL = Object.freeze(["0.01", "0.05", "0.10"] as const);
export const AGENT_TOTAL = Object.freeze(["0.25", "0.50", "1.00"] as const);

/** What the Agents page suggests asking. It names a real listed tool and stays inside the limits. */
export const AGENT_PROMPT = `Find a paid tool on Stellar and get the air quality in Istanbul. Spend at most ${AGENT_LIMITS.perCall} USDC.`;

/** The tools rail402-mcp gives the agent. */
export const AGENT_TOOLS = Object.freeze(["search_stellar_resources", "pay_and_call", "get_budget"] as const);

export interface SnippetValues {
  /** The facilitator sellers settle through. */
  readonly facilitator: string;
  /** The asset symbol of the caps, such as USDC. */
  readonly asset: string;
  /** Spending limits other than the suggested ones, as decimal amounts. */
  readonly perCall?: string;
  readonly total?: string;
}

/**
 * The text a snippet shows: the maintainer header (leading `//` lines) and `@hide` lines dropped, runs of
 * blank lines left by them collapsed, and `{{name}}` filled. Unknown placeholders stay as they are.
 */
export function snippetText(source: string, values: SnippetValues): string {
  const fills: Readonly<Record<string, string>> = {
    facilitator: values.facilitator.replace(/\/+$/, ""),
    asset: values.asset,
    perCall: values.perCall ?? AGENT_LIMITS.perCall,
    total: values.total ?? AGENT_LIMITS.total,
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
  /** The code panel's title: the file it goes in, or the terminal. */
  readonly file: string;
  readonly language: "json" | "shell";
  readonly source: string;
}

export const CLIENTS: readonly [ClientSetup, ...ClientSetup[]] = Object.freeze([
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    where: "Settings → Developer → Edit Config opens claude_desktop_config.json",
    file: "claude_desktop_config.json",
    language: "json",
    source: mcpConfig,
  },
  {
    id: "cursor",
    label: "Cursor",
    where: "In ~/.cursor/mcp.json, or .cursor/mcp.json in a project",
    file: "~/.cursor/mcp.json",
    language: "json",
    source: mcpConfig,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    where: "Run it once in your terminal",
    file: "Terminal",
    language: "shell",
    source: mcpClaudeCode,
  },
]);
