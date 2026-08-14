import { NETWORK } from "../config.js";
import type { PlaygroundConfig } from "../config.js";
import { stroopsToDisplay } from "../../shared/amounts.js";

/**
 * The "run this agent in your own editor" exit ramp: a copy-paste MCP server config that plugs the
 * same discover→pay loop into Claude Code, Cursor, or any MCP client, using the user's session
 * wallet and the same spend cap.
 *
 * Env var names are exactly what `@rail402/mcp-discovery` reads (`BAZAAR_URL`,
 * `CLIENT_STELLAR_PRIVATE_KEY`, `STELLAR_NETWORK`, `MAX_AMOUNT_CEILING`). The package is reserved
 * but not yet published, so the command is the intended published form and `note` says so.
 *
 * The session secret is a testnet key the browser generated; the warning travels with it.
 */
export function buildMcpConfig(
  config: PlaygroundConfig,
  sessionSecret: string,
  budgetStroops?: bigint,
): { json: string; warning: string; note: string } {
  const env: Record<string, string> = {
    STELLAR_NETWORK: NETWORK,
    BAZAAR_URL: config.facilitatorUrl,
    CLIENT_STELLAR_PRIVATE_KEY: sessionSecret,
  };
  if (budgetStroops !== undefined) {
    // The MCP paid-call tool's hard spend ceiling — the same budget, enforced client-side too.
    env["MAX_AMOUNT_CEILING"] = stroopsToDisplay(budgetStroops);
  }

  const mcp = {
    mcpServers: {
      "rail402-stellar": {
        command: "npx",
        args: ["-y", "@rail402/mcp-discovery"],
        env,
      },
    },
  };
  return {
    json: JSON.stringify(mcp, null, 2),
    warning:
      "This is a testnet key generated in your browser. It holds only test USDC and XLM. Do not reuse it for real funds.",
    note: "@rail402/mcp-discovery is not published to npm yet; until it is, run it from a clone: replace command/args with node and the path to apps/mcp-discovery/dist/index.js.",
  };
}
