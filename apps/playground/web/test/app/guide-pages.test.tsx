import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../../src/app/App.tsx";
import { AGENT_PROMPT, SNIPPET_SOURCES, sellCode, snippetText } from "../../src/app/guide/snippets.ts";
import { createFakeEngine } from "../../src/dev/fake-engine.ts";
import { tokenize } from "../../src/ui/CodeBlock.tsx";

const writeText = vi.fn<(text: string) => Promise<void>>();

function open(path: string): void {
  window.history.replaceState(null, "", path);
  render(<App engine={createFakeEngine({ stepMs: 0 })} />);
}

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("Sell", () => {
  it("hands the job to a coding agent, with the docs written for one", () => {
    open("/sell");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sell your API to agents");
    const box = within(
      screen.getByRole("region", { name: "Ask your coding agent to add Rail402 to your API" }),
    );
    expect(box.getByRole("link", { name: /llms\.txt/ }).getAttribute("href")).toBe(
      "https://docs.rail402.dev/llms.txt",
    );
    expect(box.getByRole("link", { name: /Agent instructions/ }).getAttribute("href")).toBe(
      "https://docs.rail402.dev/coding-agents/overview",
    );
  });

  it("shows the 402 an agent receives for the picked scheme and price", () => {
    open("/sell");
    const value = (key: string): string | undefined =>
      screen.getByText(key, { selector: "dt" }).nextElementSibling?.textContent;
    expect(value("scheme")).toBe("exact");
    expect(value("amount")).toBe("100000");
    expect(screen.queryByText("maxTimeoutSeconds")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^upto/ }));
    fireEvent.click(screen.getByRole("button", { name: "$0.10" }));
    expect(screen.getByRole("button", { name: "$0.10" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Most one call can cost")).toBeTruthy();
    expect(value("scheme")).toBe("upto");
    expect(value("amount")).toBe("1000000");
    expect(value("maxTimeoutSeconds")).toBe("120");
  });

  it("shows and copies the code for the pick, with the picked price and folded imports", async () => {
    open("/sell");
    fireEvent.click(screen.getByRole("tab", { name: "Your code" }));
    fireEvent.click(screen.getByRole("button", { name: "$0.001" }));
    const expected = sellCode("http", "exact", "0.001", {
      facilitator: "https://testnet.rail402.dev",
      asset: "USDC",
    });
    expect(expected).toContain('price: "$0.001"');
    const fold = screen.getByRole("button", { name: /imports, copied with the code$/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the seller code" }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(expected);
    fireEvent.click(screen.getByRole("button", { name: /^An MCP tool/ }));
    fireEvent.click(screen.getByRole("button", { name: /^upto/ }));
    expect(screen.getByText("mcp-server.ts")).toBeTruthy();
    const code = screen.getByRole("tabpanel").querySelector("code")?.textContent ?? "";
    expect(code).toContain("mcpTool(");
    expect(code).toContain('maxPrice: "$0.001"');
    expect(screen.getByRole("link", { name: /Sell an MCP tool/ }).getAttribute("href")).toBe(
      "https://docs.rail402.dev/sellers/helpers#an-mcp-tool",
    );
  });

  it("tells one paid call step by step", () => {
    open("/sell");
    expect(screen.getByRole("heading", { level: 3, name: "Answers with a price" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Settles on Stellar/ }));
    expect(screen.getByRole("heading", { level: 3, name: "Settles on Stellar" })).toBeTruthy();
    expect(screen.getByText(/Rail402 submits the transfer and pays the network fee/)).toBeTruthy();
  });

  it("checks a seller's own route: the CLI command follows the URL, and the Lab opens it", () => {
    open("/sell");
    const input = screen.getByLabelText("Route URL");
    fireEvent.change(input, { target: { value: "https://api.example.com/forecast/Izmir" } });
    const command = screen.getByRole("button", { name: "Copy the check command" }).closest(".code-block");
    expect(command?.textContent).toContain("rail402 seller check https://api.example.com/forecast/Izmir");
    fireEvent.click(screen.getByRole("button", { name: "Open it in the Lab" }));
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      `/?${new URLSearchParams({ url: "https://api.example.com/forecast/Izmir" }).toString()}`,
    );
  });
});

describe("Agents", () => {
  it("tries the picked limits against Bazaar listings and fills them into the client setup", async () => {
    open("/agents");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Give your agent a budget");
    const list = await screen.findByRole("list", { name: "Listings tried against your limits" });
    expect(within(list).getAllByText("Can pay").length).toBe(within(list).getAllByRole("listitem").length);
    fireEvent.click(screen.getByRole("button", { name: "0.01 USDC" }));
    fireEvent.click(screen.getByRole("button", { name: "1.00 USDC" }));
    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).toContain('"RAIL402_MAX_PER_CALL": "0.01 USDC"');
    expect(panel.textContent).toContain('"RAIL402_MAX_TOTAL": "1.00 USDC"');
    expect(screen.getByText("claude_desktop_config.json")).toBeTruthy();
  });

  it("switches the client configuration with the tabs, by click and by arrow key", () => {
    open("/agents");
    const panel = (): HTMLElement => screen.getByRole("tabpanel");
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Claude Desktop");
    expect(panel().textContent).toContain('"mcpServers"');
    fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(panel().textContent).toContain("claude mcp add rail402");
    expect(panel().getAttribute("aria-labelledby")).toBe("agent-client-tab-claude-code");
    fireEvent.keyDown(screen.getByRole("tablist", { name: "Client" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Cursor");
    expect(panel().textContent).toContain("~/.cursor/mcp.json");
  });

  it("explains the three tools with examples", () => {
    open("/agents");
    expect(screen.getByRole("heading", { level: 3, name: "It pays and calls in one step" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /get_budget/ }));
    expect(screen.getByRole("heading", { level: 3, name: "It checks what it has left" })).toBeTruthy();
    expect(screen.getByText("get_budget · example")).toBeTruthy();
  });

  it("copies the prompt, and plays an agent payment in the Lab", async () => {
    open("/agents");
    expect(screen.getByText(`“${AGENT_PROMPT}”`)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the prompt" }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(AGENT_PROMPT);
    fireEvent.click(screen.getByRole("link", { name: /Watch an agent pay/ }), { button: 0 });
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?mode=agent");
    const pages = within(screen.getByRole("navigation", { name: "Pages" }));
    expect(pages.getByRole("link", { current: "page" }).textContent).toBe("Lab");
  });
});

describe("code colouring", () => {
  it("colours strings, comments and keywords without changing the text", () => {
    const shell = snippetText(SNIPPET_SOURCES.agentWallet, {
      facilitator: "https://f.example",
      asset: "USDC",
    });
    const parts = tokenize(shell, "shell");
    expect(parts.map((part) => (typeof part === "string" ? part : part[1])).join("")).toBe(shell);
    expect(parts.filter((part) => typeof part !== "string" && part[0] === "comment")).toHaveLength(2);
    expect(tokenize('const url = "https://a.example"; // note', "ts")).toEqual([
      ["keyword", "const"],
      " url = ",
      ["string", '"https://a.example"'],
      "; ",
      ["comment", "// note"],
    ]);
    expect(tokenize('{ "ok": true, "n": 2 }', "json")).toEqual([
      "{ ",
      ["key", '"ok"'],
      ": ",
      ["keyword", "true"],
      ", ",
      ["key", '"n"'],
      ": ",
      ["number", "2"],
      " }",
    ]);
  });
});
