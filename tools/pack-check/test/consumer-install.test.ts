/**
 * pack-check installs the tarballs with npm, which resolves their dependencies from the registry, and
 * then runs the installed code: neither npm nor that code may see this process's environment, and no
 * dependency's install script may run.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

describe("the consumer install", () => {
  it("runs npm with install scripts off and the allow-listed toolchain environment only", () => {
    expect(source).toMatch(/"install",\s*\.\.\.NPM_INSTALL_FLAGS,/);
    expect(source).toMatch(/const npmEnv = \{\s*\.\.\.toolchainEnvironment\(process\.env\),/);
    expect(source).not.toContain("...process.env");
  });

  it("runs every entry point, bin and the compiler in the consumer project with a path and a home only", () => {
    expect(source).toMatch(/const consumerEnv = \{ PATH: process\.env\["PATH"\] \?\? "", HOME: home \};/);
    const environments = [...source.matchAll(/cwd: project,?\s*(?:env: (\w+))?/g)].map((match) => match[1]);
    // npm, the entry point imports, the two bins and the compiler.
    expect(environments.length).toBeGreaterThanOrEqual(4);
    for (const env of environments) expect(["npmEnv", "consumerEnv"]).toContain(env);
  });
});
