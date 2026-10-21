import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../../src/app/App.tsx";
import { AGENT_PROMPT, SNIPPET_SOURCES, snippetText } from "../../src/app/guide/snippets.ts";
import { createFakeEngine } from "../../src/dev/fake-engine.ts";
import { tokenize } from "../../src/ui/CodeBlock.tsx";

const writeText = vi.fn<(text: string) => Promise<void>>();

function open(path: string): void {
  window.history.replaceState(null, "", path);
  render(<App engine={createFakeEngine({ stepMs: 0 })} />);
}

/** The numbered steps of the setup panel, by their visible titles. */
function stepTitles(): string[] {
  const panel = screen.getByRole("region", { name: /From/ });
  return within(panel)
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent.replace(/^Step \d+: /, ""));
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
  it("walks from an API to a paid listing in four steps, with the facts beside it", () => {
    open("/sell");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sell your API to agents");
    expect(screen.getByText("Paid in USDC")).toBeTruthy();
    expect(screen.getByText("Listed automatically")).toBeTruthy();
    expect(screen.getByText("No fees to manage")).toBeTruthy();
    expect(stepTitles()).toEqual([
      "Install",
      "Get an address to be paid to",
      "Price the route and use Rail402",
      "Check it, then make one paid call",
    ]);
    const guides = screen.getByRole("navigation", { name: "Seller guides" });
    expect([...guides.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "https://docs.rail402.dev/quickstart/sellers",
      "https://docs.rail402.dev/sellers/helpers#an-mcp-tool",
      "https://docs.rail402.dev/sellers/helpers#charge-what-a-call-used-upto",
    ]);
    expect(screen.getByRole("link", { name: /Seller helpers/ }).getAttribute("href")).toBe(
      "https://docs.rail402.dev/sellers/helpers#an-http-route",
    );
    expect(screen.getByRole("link", { name: /How listing works/ }).getAttribute("href")).toBe(
      "https://docs.rail402.dev/bazaar/cataloging",
    );
  });

  it("copies the whole seller code, with the Playground's facilitator and the folded imports", async () => {
    open("/sell");
    const full = snippetText(SNIPPET_SOURCES.sellerRoute, {
      facilitator: "https://testnet.rail402.dev",
      asset: "USDC",
    });
    const code = (): HTMLElement =>
      screen.getByText(
        (_, element) => element?.tagName === "CODE" && /httpRoute\(/.test(element.textContent),
      );
    expect(code().textContent).toContain('url: "https://testnet.rail402.dev"');
    expect(code().textContent).not.toContain("import ");
    expect(code().querySelector(".code-string")).not.toBeNull();
    const fold = screen.getByRole("button", { name: "5 imports, copied with the code" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the seller code" }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(full);
    expect(screen.getAllByRole("status").map((status) => status.textContent)).toContain("Copied");
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(code().textContent).toBe(full);
  });

  it("sends a seller to the Lab to make the first paid call", () => {
    open("/sell");
    const panel = screen.getByRole("region", { name: "From an API to a paid listing" });
    fireEvent.click(within(panel).getByRole("link", { name: "Lab" }), { button: 0 });
    expect(window.location.pathname).toBe("/");
  });
});

describe("Agents", () => {
  it("shows the budget, and the four steps from zero to a paid tool call", () => {
    open("/agents");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Give your agent a budget");
    expect(screen.getByText("per call").nextElementSibling?.textContent).toBe("0.05USDC");
    expect(screen.getByText("per session").nextElementSibling?.textContent).toBe("0.50USDC");
    expect(stepTitles()).toEqual([
      "Install the MCP server and the CLI",
      "Create and fund a test wallet",
      "Add the server to your client",
      "Ask your agent",
    ]);
    expect(
      screen.getByRole("link", { name: /Fund and manage wallets with the CLI/ }).getAttribute("href"),
    ).toBe("https://docs.rail402.dev/agents/cli");
    expect(screen.getByRole("link", { name: /MCP server/ }).getAttribute("href")).toBe(
      "https://docs.rail402.dev/agents/mcp-server",
    );
  });

  it("switches the client configuration with the tabs, by click and by arrow key", () => {
    open("/agents");
    const panel = (): HTMLElement => screen.getByRole("tabpanel");
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Claude Desktop");
    expect(panel().textContent).toContain('"mcpServers"');
    expect(panel().textContent).toContain("claude_desktop_config.json");
    fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }));
    expect(panel().textContent).toContain("claude mcp add rail402");
    expect(panel().getAttribute("aria-labelledby")).toBe("agent-client-tab-claude-code");
    fireEvent.keyDown(screen.getByRole("tablist", { name: "Client" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Cursor");
    expect(panel().textContent).toContain("~/.cursor/mcp.json");
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
    expect(screen.getByRole("link", { current: "page" }).textContent).toBe("Lab");
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
  });
});
