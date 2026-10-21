import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS, docHref } from "../../src/projection/docs.ts";

// Tests run from the repository root (the page's tests see an http import.meta.url).
const docsDir = join(process.cwd(), "docs");

/** The anchors the docs site gives a page's headings: lower case, punctuation dropped, spaces as dashes. */
function anchorsOf(source: string): Set<string> {
  const anchors = new Set<string>();
  for (const [, heading = ""] of source.matchAll(/^#{2,4}\s+(.+)$/gm)) {
    anchors.add(
      heading
        .toLowerCase()
        .replace(/`/g, "")
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-"),
    );
  }
  return anchors;
}

describe("documentation links", () => {
  it("point at pages and headings that exist in docs/", () => {
    for (const doc of Object.values(DOCS)) {
      if (doc.path.startsWith("https://")) continue;
      const [page = "", anchor] = doc.path.replace(/^\//, "").split("#");
      const file = [".mdx", ".md"].map((extension) => join(docsDir, `${page}${extension}`)).find(existsSync);
      expect(file, doc.path).toBeDefined();
      if (anchor !== undefined && file !== undefined) {
        expect(anchorsOf(readFileSync(file, "utf8")), doc.path).toContain(anchor);
      }
    }
  });

  it("resolve against the configured docs site", () => {
    expect(docHref(DOCS.spendingPolicy, "https://docs.rail402.dev/")).toBe(
      "https://docs.rail402.dev/reference/spending-policy",
    );
    expect(docHref(DOCS.sellUpto, "https://docs.rail402.dev")).toBe(
      "https://docs.rail402.dev/sellers/helpers#charge-what-a-call-used-upto",
    );
    expect(docHref(DOCS.x402, "https://docs.rail402.dev")).toBe("https://docs.x402.org");
  });
});
