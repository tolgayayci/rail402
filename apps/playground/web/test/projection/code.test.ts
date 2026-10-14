import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STEP_IDS } from "../../../src/shared/lab.ts";
import { highlight, markedSteps, parseSnippet, snippetText } from "../../src/projection/code.ts";
import { DOCS, docHref } from "../../src/projection/docs.ts";
import { SNIPPET_SOURCES, fillSnippet, payTabs, scenarioTabs } from "../../src/ui/snippets.ts";
import { CONFIG } from "../fixtures/config.ts";

// Tests run from the repository root (the page's tests see an http import.meta.url).
const snippetsDir = join(process.cwd(), "apps/playground/src/snippets");
const docsDir = join(process.cwd(), "docs");

describe("snippet markers", () => {
  it("ties lines to steps and hides setup lines", () => {
    const snippet = parseSnippet(
      [
        'import x from "x"; // @hide',
        "",
        "",
        "const a = 1; // @step:request,quote",
        "",
        "",
        "a; // note // @step:deliver",
        "plain();",
        "",
      ].join("\n"),
    );
    expect(snippetText(snippet)).toBe("const a = 1;\n\na; // note\nplain();");
    expect(markedSteps(snippet)).toEqual(["request", "quote", "deliver"]);
    expect(highlight(snippet, "quote").map((line) => line.on)).toEqual([true, false, false, false]);
    expect(highlight(snippet, undefined).some((line) => line.on)).toBe(false);
  });

  it("refuses an unknown step id", () => {
    expect(() => parseSnippet("x(); // @step:nonsense")).toThrow(/unknown step id/);
  });

  it("parses every snippet file, whose markers name only known steps", () => {
    const files = readdirSync(snippetsDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(snippetsDir, file), "utf8");
      const steps = markedSteps(parseSnippet(source));
      for (const step of steps) expect(STEP_IDS).toContain(step);
    }
  });

  it("fills every placeholder from the configuration", () => {
    const values = { cap: "0.01", config: CONFIG, url: "https://api.example.com/x" };
    const all = [
      ...(["pay", "upto", "agent", "sell"] as const).flatMap((scenario) => scenarioTabs(scenario, values)),
      ...payTabs(values),
    ];
    for (const tab of all) {
      expect(tab.source, tab.label).not.toMatch(/\{\{\w+\}\}/);
      expect(() => parseSnippet(tab.source)).not.toThrow();
    }
    expect(fillSnippet(SNIPPET_SOURCES.sdkPay, values)).toContain('"https://demo.rail402.dev/weather"');
    expect(fillSnippet(SNIPPET_SOURCES.mcpConfig, values)).toContain('"RAIL402_MAX_TOTAL": "1 USDC"');
    expect(JSON.parse(snippetText(parseSnippet(fillSnippet(SNIPPET_SOURCES.mcpConfig, values))))).toBeTypeOf(
      "object",
    );
  });

  it("does not show the maintainer header of a snippet file", () => {
    expect(fillSnippet(SNIPPET_SOURCES.sdkPay, { cap: "0.01", config: CONFIG })).not.toContain(
      "Code-panel snippet",
    );
  });
});

describe("documentation links", () => {
  it("point at pages that exist in docs/", () => {
    for (const doc of Object.values(DOCS)) {
      if (doc.path.startsWith("https://")) continue;
      const page = doc.path.replace(/#.*$/, "").replace(/^\//, "");
      const found = [".mdx", ".md"].some((extension) => existsSync(join(docsDir, `${page}${extension}`)));
      expect(found, doc.path).toBe(true);
    }
  });

  it("resolve against the configured docs site", () => {
    expect(docHref(DOCS.spendingPolicy, "https://docs.rail402.dev/")).toBe(
      "https://docs.rail402.dev/reference/spending-policy",
    );
    expect(docHref(DOCS.x402, "https://docs.rail402.dev")).toBe("https://docs.x402.org");
  });
});
