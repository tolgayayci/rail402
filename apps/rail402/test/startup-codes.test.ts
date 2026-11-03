import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCES = join(ROOT, "apps/rail402/src");

/**
 * The codes every `new ConfigError(…)` in the service's sources can stop startup with. A code is a
 * string literal, a conditional between literals, a property of a constant object of literals, or a
 * function parameter (its default and the literals its callers pass).
 */
function emittedCodes(): { codes: Set<string>; unreadable: string[] } {
  const files = readdirSync(SOURCES)
    .filter((name) => name.endsWith(".ts"))
    .map((name) =>
      ts.createSourceFile(name, readFileSync(join(SOURCES, name), "utf8"), ts.ScriptTarget.Latest, true),
    );
  const constants = new Map<string, string>();
  const calls: ts.CallExpression[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      let value: ts.Expression = node.initializer;
      if (ts.isAsExpression(value)) value = value.expression;
      if (ts.isObjectLiteralExpression(value)) {
        for (const property of value.properties) {
          if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.initializer)) {
            constants.set(`${node.name.text}.${property.name.getText()}`, property.initializer.text);
          }
        }
      }
    }
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, collect);
  };
  for (const file of files) collect(file);

  const literals = (node: ts.Expression): string[] | undefined => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isParenthesizedExpression(node)) return literals(node.expression);
    if (ts.isConditionalExpression(node)) {
      const [whenTrue, whenFalse] = [literals(node.whenTrue), literals(node.whenFalse)];
      return whenTrue === undefined || whenFalse === undefined ? undefined : [...whenTrue, ...whenFalse];
    }
    if (ts.isPropertyAccessExpression(node)) {
      const value = constants.get(node.getText());
      return value === undefined ? undefined : [value];
    }
    if (ts.isIdentifier(node)) return parameterCodes(node);
    return undefined;
  };
  // A parameter: its default, and what every call of its function passes in its place.
  const parameterCodes = (identifier: ts.Identifier): string[] | undefined => {
    const scope = ts.findAncestor(identifier, ts.isFunctionDeclaration);
    if (scope?.name === undefined) return undefined;
    const name = scope.name.text;
    const index = scope.parameters.findIndex(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text,
    );
    const parameter = scope.parameters[index];
    if (parameter === undefined) return undefined;
    const found: string[] = [];
    if (parameter.initializer !== undefined) {
      const fallback = literals(parameter.initializer);
      if (fallback === undefined) return undefined;
      found.push(...fallback);
    }
    for (const call of calls.filter((candidate) => candidate.expression.getText() === name)) {
      const argument = call.arguments[index];
      if (argument === undefined) continue;
      const passed = literals(argument);
      if (passed === undefined) return undefined;
      found.push(...passed);
    }
    return found;
  };

  const codes = new Set<string>();
  const unreadable: string[] = [];
  for (const source of files) {
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && node.expression.getText(source) === "ConfigError") {
        const code = node.arguments?.[1];
        const found = code === undefined ? ["config_invalid"] : literals(code);
        if (found === undefined) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          unreadable.push(`${source.fileName}:${String(line + 1)}`);
        } else {
          for (const value of found) codes.add(value);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { codes, unreadable };
}

/** The codes `createStellarFacilitator` can refuse a setup with: each `new FacilitatorSetupError("…"`. */
function librarySetupCodes(): Set<string> {
  const directory = join(ROOT, "packages/facilitator/src");
  const codes = new Set<string>();
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".ts"))) {
    const text = readFileSync(join(directory, name), "utf8");
    for (const match of text.matchAll(/new FacilitatorSetupError\(\s*"([a-z0-9_]+)"/g))
      codes.add(match[1] ?? "");
  }
  return codes;
}

/** The codes of the startup-check table of a docs page. */
function documentedCodes(path = "docs/configuration.md"): Set<string> {
  const page = readFileSync(join(ROOT, path), "utf8");
  const start = page.indexOf("## Startup checks");
  const section = page.slice(start, page.indexOf("\n## ", start + 1));
  const codes = new Set<string>();
  for (const row of section.split("\n").filter((line) => line.startsWith("| `"))) {
    const first = row.split("|")[1] ?? "";
    for (const match of first.matchAll(/`([a-z0-9_]+)`/g)) codes.add(match[1] ?? "");
  }
  return codes;
}

describe("startup codes", () => {
  it("documents every code startup can stop with, and nothing else", () => {
    const { codes, unreadable } = emittedCodes();
    // A code built at run time could not be checked against the documentation.
    expect(unreadable).toEqual([]);
    expect(codes.size).toBeGreaterThan(20);
    expect([...documentedCodes()].sort()).toEqual([...codes].sort());
  });

  it("documents every code the in-process facilitator refuses a setup with, and nothing else", () => {
    const codes = librarySetupCodes();
    expect(codes.size).toBeGreaterThan(5);
    expect([...documentedCodes("docs/facilitator/in-process.mdx")].sort()).toEqual([...codes].sort());
    // A setting both refuse is refused with the same code by the service.
    const service = emittedCodes().codes;
    for (const code of [
      "config_rpc_missing",
      "config_sponsor_secret_missing",
      "config_pubnet_assets_missing",
    ]) {
      expect(codes.has(code) && service.has(code), code).toBe(true);
    }
  });
});
