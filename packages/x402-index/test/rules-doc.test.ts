import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RULES_VERSION } from "../src/index.ts";

const rules = readFileSync(new URL("../rules/v2.md", import.meta.url), "utf8");
const previous = readFileSync(new URL("../rules/v1.md", import.meta.url), "utf8");
const page = readFileSync(new URL("../../../docs/reference/indexing-rules.mdx", import.meta.url), "utf8");

describe("the published rules", () => {
  it("are the version the classifier stamps on rows", () => {
    expect(RULES_VERSION).toBe("2");
    expect(rules).toMatch(/^# x402 Stellar indexing rules, version 2\n/);
    expect(rules).toContain("- Rules version: `2`");
  });

  it("keep the previous version documented", () => {
    expect(previous).toMatch(/^# x402 Stellar indexing rules, version 1\n/);
    expect(previous).toContain("- Rules version: `1`");
  });

  it("read the same on the documentation page as in the package", () => {
    const body = rules.split("\n").slice(2).join("\n");
    const pageBody = page.slice(page.indexOf("*/}\n\n") + "*/}\n\n".length);
    expect(pageBody).toBe(body);
  });
});
