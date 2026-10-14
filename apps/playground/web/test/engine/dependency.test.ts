import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = join(import.meta.dirname, "../../src");

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

const sources = files(SOURCE).map((path) => ({
  path: relative(SOURCE, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

describe("where the key can go", () => {
  it("only the wallet modules import the keystore", () => {
    const importers = sources
      .filter((file) => /from "[^"]*keystore\.ts"/.test(file.text))
      .map((file) => file.path);
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.every((path) => path.startsWith("wallet/"))).toBe(true);
  });

  it("only the wallet modules touch the key itself", () => {
    const users = sources
      .filter((file) => /exportSecret|KeyHolder\.(fromSecret|random)|keySetupSigner/.test(file.text))
      .map((file) => file.path);
    expect(users.every((path) => path.startsWith("wallet/"))).toBe(true);
  });

  it("the page's views use the engine contract; only the loader reaches the implementation", () => {
    const views = sources.filter((file) => /^(app|ui|projection)\//.test(file.path));
    const reaching = views
      .filter((file) =>
        /(from|import\() ?"(@rail402\.dev\/|@stellar\/|[^"]*\/(engine\/(?!types\.ts|events\.ts)[^"]+|wallet\/[^"]+|transport\/[^"]+))"/.test(
          file.text,
        ),
      )
      .map((file) => file.path);
    expect(reaching).toEqual(["app/load-engine.ts"]);
  });

  it("only the engine builds a signer from the vault, for its buyers", () => {
    const users = sources
      .filter((file) => /vault\.signer\(|\.signer\(\{/.test(file.text))
      .map((file) => file.path);
    expect(users).toEqual(["engine/engine.ts"]);
    const engine = sources.find((file) => file.path === "engine/engine.ts")?.text ?? "";
    // One call site: the buyer construction, which passes the signer straight to the buyer.
    expect(engine.match(/vault\.signer\(/g)).toHaveLength(1);
    expect(engine).toMatch(
      /const signer = vault\.signer\(\{[\s\S]*?\}\);\s*return \(this\.#options\.buildBuyer \?\? buildBrowserBuyer\)\(\{[\s\S]*?signer,/,
    );
  });

  it("the page never renders raw markup", () => {
    expect(sources.filter((file) => file.text.includes("dangerouslySetInnerHTML"))).toEqual([]);
  });
});
