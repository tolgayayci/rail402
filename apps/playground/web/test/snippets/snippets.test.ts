/**
 * The Sell and Agents pages show only commands and configuration the real tools accept: CLI lines go
 * through the CLI's own argument parser, the MCP client configuration through the server's own
 * configuration reader, and install lines name the versions this repository builds. The TypeScript
 * snippet is type-checked by the root configuration.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCommandLine } from "@rail402.dev/cli";
import { TOOL_NAMES, USAGE, resolveMcpCommand } from "@rail402.dev/mcp";
import {
  AGENT_LIMITS,
  AGENT_PROMPT,
  AGENT_TOOLS,
  CLIENTS,
  SNIPPET_SOURCES,
  snippetText,
} from "../../src/app/guide/snippets.ts";

// Tests run from the repository root.
const root = process.cwd();
const VALUES = { facilitator: "https://testnet.rail402.dev/", asset: "USDC" };
const text = (source: string): string => snippetText(source, VALUES);

function packageOf(name: string): { readonly version: string; readonly bin?: Record<string, string> } {
  return JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8")) as {
    version: string;
    bin?: Record<string, string>;
  };
}

/** The `@x402/*` versions the workspace catalog pins. */
function catalogVersion(name: string): string | undefined {
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  return new RegExp(`"${name.replace("/", "\\/")}":\\s*([\\d.]+)`).exec(workspace)?.[1];
}

/**
 * Splits shell text into commands of words, for the quoting these snippets use: double quotes and a
 * backslash at a line end. Comments are dropped.
 */
function shellCommands(source: string): string[][] {
  return source
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? ""));
}

const RAIL402_SNIPPETS = {
  sellerKeys: SNIPPET_SOURCES.sellerKeys,
  sellerCheck: SNIPPET_SOURCES.sellerCheck,
  agentWallet: SNIPPET_SOURCES.agentWallet,
};

describe("setup commands", () => {
  it.each(Object.entries(RAIL402_SNIPPETS))("%s parses with the CLI's own parser", (_, source) => {
    const commands = shellCommands(text(source));
    expect(commands.length).toBeGreaterThan(0);
    for (const [program, ...argv] of commands) {
      expect(program).toBe("rail402");
      expect(() => parseCommandLine(argv)).not.toThrow();
    }
  });

  it("is refused by the parser when a flag is misspelt, so the check has teeth", () => {
    expect(() => parseCommandLine(["account", "setup", "--usdcc", "1"])).toThrow();
  });

  it("installs the versions this repository builds", () => {
    const sdk = packageOf("sdk").version;
    const cli = packageOf("cli").version;
    const mcp = packageOf("mcp").version;
    const [seller] = shellCommands(text(SNIPPET_SOURCES.sellerInstall));
    expect(seller?.slice(0, 2)).toEqual(["npm", "install"]);
    for (const spec of seller?.slice(2) ?? []) {
      const at = spec.lastIndexOf("@");
      const name = spec.slice(0, at);
      const version = spec.slice(at + 1);
      expect(version, spec).toBe(name === "@rail402.dev/sdk" ? sdk : catalogVersion(name));
    }
    expect(shellCommands(text(SNIPPET_SOURCES.agentInstall))).toEqual([
      ["npm", "install", "-g", `@rail402.dev/mcp@${mcp}`, `@rail402.dev/cli@${cli}`],
    ]);
    expect(Object.keys(packageOf("mcp").bin ?? {})).toContain("rail402-mcp");
  });
});

describe("seller code", () => {
  it("shows the imports and the route, never the type-checking scaffolding", () => {
    const code = text(SNIPPET_SOURCES.sellerRoute);
    expect(code).not.toMatch(/@hide|declare |\{\{|Sell page snippet/);
    expect(code.split("\n")[0]).toBe(
      'import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";',
    );
    expect(code).toContain('import { exact, httpRoute, param } from "@rail402.dev/sdk/seller";');
    expect(code).toContain('new HTTPFacilitatorClient({ url: "https://testnet.rail402.dev" })');
    expect(code).toContain("app.use(paymentMiddleware({ [forecast.key]: forecast.config }, server));");
    expect(code).not.toMatch(/\n\n\n/);
  });
});

describe("MCP client setup", () => {
  it("offers Claude Desktop, Cursor and Claude Code", () => {
    expect(CLIENTS.map((client) => client.label)).toEqual(["Claude Desktop", "Cursor", "Claude Code"]);
  });

  it("configures the server with settings it reads and the suggested limits", () => {
    for (const client of CLIENTS.filter((item) => item.language === "json")) {
      const config = JSON.parse(text(client.source)) as {
        mcpServers: { rail402: { command: string; args?: string[]; env: Record<string, string> } };
      };
      const server = config.mcpServers.rail402;
      expect(server.command).toBe("rail402-mcp");
      expect(server.args).toBeUndefined();
      for (const name of Object.keys(server.env)) expect(USAGE).toContain(name);
      const command = resolveMcpCommand([], { ...server.env });
      if (command.kind !== "serve") throw new Error("expected a server command");
      expect(command.config.agent.network).toBe("stellar:testnet");
      expect(command.config.agent.key).toBeDefined();
      const policy = JSON.stringify(command.config.agent.policy);
      expect(policy).toContain(`"${AGENT_LIMITS.perCall}"`);
      expect(policy).toContain(`"${AGENT_LIMITS.total}"`);
    }
  });

  it("adds the same server to Claude Code from the command line", () => {
    const claudeCode = CLIENTS.find((client) => client.id === "claude-code");
    const desktop = CLIENTS.find((client) => client.id === "claude-desktop");
    const [command = []] = shellCommands(text(claudeCode?.source ?? ""));
    expect(command.slice(0, 4)).toEqual(["claude", "mcp", "add", "rail402"]);
    expect(command.slice(-2)).toEqual(["--", "rail402-mcp"]);
    const env: Record<string, string> = {};
    const flags = command.slice(4, -2);
    for (let index = 0; index < flags.length; index += 2) {
      expect(flags[index]).toBe("-e");
      const pair = flags[index + 1] ?? "";
      env[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1);
    }
    const json = JSON.parse(text(desktop?.source ?? "")) as {
      mcpServers: { rail402: { env: Record<string, string> } };
    };
    expect(env).toEqual(json.mcpServers.rail402.env);
  });

  it("suggests a prompt within the per-call limit, served by the server's tools", () => {
    expect(AGENT_PROMPT).toContain(`at most ${AGENT_LIMITS.perCall} USDC`);
    expect(AGENT_TOOLS).toEqual(TOOL_NAMES);
  });
});
