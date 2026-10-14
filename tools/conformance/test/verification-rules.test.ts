import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/evidence.ts";

// docs/verification-rules.md names the tests behind each rule by short names defined in its tables of
// test files; a name used without a definition sends readers nowhere.
const PAGE = readFileSync(join(REPO_ROOT, "docs/verification-rules.md"), "utf8");

/** Every Markdown table of the page: its header cells and its rows' cells. */
function tables(text: string): { header: string[]; rows: string[][] }[] {
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((cell) => cell.trim());
  const found: { header: string[]; rows: string[][] }[] = [];
  const lines = text.split("\n");
  for (let index = 0; index + 1 < lines.length; index++) {
    if (!lines[index]?.startsWith("|") || !/^\|[\s:|-]+\|$/.test(lines[index + 1]?.trim() ?? "")) continue;
    const header = cells(lines[index] ?? "");
    const rows: string[][] = [];
    for (index += 2; lines[index]?.startsWith("|") === true; index++) rows.push(cells(lines[index] ?? ""));
    found.push({ header, rows });
  }
  return found;
}

const all = tables(PAGE);
const defined = new Map(
  all
    .filter((table) => table.header[0] === "Short name")
    .flatMap((table) => table.rows.map((row) => [row[0] ?? "", row[1] ?? ""] as const)),
);

describe("docs/verification-rules.md", () => {
  it("defines every short name it cites under Tested by", () => {
    const used = new Set<string>();
    for (const table of all) {
      const column = table.header.indexOf("Tested by");
      if (column === -1) continue;
      for (const row of table.rows) {
        for (const part of (row[column] ?? "").split(",")) {
          // A file named in backticks and a parenthesised remark are not short names.
          const name = part.replace(/\([^)]*\)/g, "").trim();
          if (name === "" || name.startsWith("`")) continue;
          used.add(name);
        }
      }
    }
    expect(used.size).toBeGreaterThan(10);
    for (const name of used) expect(defined.has(name), `"${name}" is not in a short-name table`).toBe(true);
  });

  it("points every short name at files that exist", () => {
    expect(defined.size).toBeGreaterThan(10);
    for (const [name, files] of defined) {
      for (const [, path] of files.matchAll(/`([^`]+\.(?:ts|rs)|[^`]+\/)`/g)) {
        expect(existsSync(join(REPO_ROOT, path ?? "")), `${name}: ${path ?? ""} does not exist`).toBe(true);
      }
    }
  });
});
