import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/evidence.ts";

/** Every file under `directory` (recursively) whose name ends with one of `extensions`. */
function filesUnder(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("install pins", () => {
  it("pins every @rail402.dev install in the docs, READMEs and Playground snippets to the workspace version", () => {
    const { version } = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    const files = [
      ...filesUnder(join(REPO_ROOT, "docs"), [".mdx", ".md"]),
      ...filesUnder(join(REPO_ROOT, "apps/playground/src/snippets"), [".txt"]),
      join(REPO_ROOT, "README.md"),
      ...readdirSync(join(REPO_ROOT, "examples")).map((name) =>
        join(REPO_ROOT, "examples", name, "README.md"),
      ),
    ];
    const pins: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/@rail402\.dev\/([a-z0-9-]+)@(\d+\.\d+\.\d+)/g)) {
        pins.push(`${relative(REPO_ROOT, file)}: @rail402.dev/${match[1] ?? ""}@${match[2] ?? ""}`);
      }
    }
    // The docs describe this version's behaviour (pubnet buyer guards among it), so they install it.
    expect(pins.length).toBeGreaterThan(5);
    expect(pins.filter((pin) => !pin.endsWith(`@${version}`))).toEqual([]);
  });
});
