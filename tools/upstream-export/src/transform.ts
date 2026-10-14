/**
 * Rewrites the module specifiers of a TypeScript file for its place in the x402 monorepo: relative
 * imports follow the file to its new location, workspace packages become relative imports of
 * their exported sources, `@x402/stellar` becomes imports of the mechanism's own modules, and the
 * `.ts` extensions this repository uses are dropped. Anything that cannot be mapped is reported.
 */
import { dirname, join, relative } from "node:path/posix";
import ts from "typescript";

/** How the paths and packages of this repository map onto the x402 monorepo. */
export interface ImportMap {
  /** The x402 path of a file of this repository, or `undefined` when the file is not exported. */
  readonly mapPath: (path: string) => string | undefined;
  /** The source file of a workspace package specifier (e.g. `@rail402.dev/upto/client`), if known. */
  readonly packageEntry: (specifier: string) => string | undefined;
  /**
   * The x402 module (a path without extension) that exports `name` inside the Stellar mechanism,
   * replacing an import of `@x402/stellar`; `undefined` when no module exports it.
   */
  readonly stellarExport: (name: string) => string | undefined;
}

export interface Transformed {
  readonly text: string;
  /** Specifiers that could not be mapped; the text is unusable when this is not empty. */
  readonly problems: readonly string[];
}

/** Specifiers that mean the same thing in both repositories. */
const PASS_THROUGH = [/^node:/, /^vitest$/, /^@stellar\/stellar-sdk(?:\/|$)/, /^@x402\/core(?:\/|$)/];
const WORKSPACE_PACKAGE = /^@rail402\.dev\//;
const STELLAR_PACKAGE = "@x402/stellar";

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Rewrites the specifiers of `text`, the file `from` of this repository exported to `to`.
 * `from`, `to` and every path of `map` are relative to their repository roots, with `/`.
 */
export function transformImports(text: string, from: string, to: string, map: ImportMap): Transformed {
  const source = ts.createSourceFile(from, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: Edit[] = [];
  const problems: string[] = [];

  /** The x402 specifier for `specifier`, or `undefined` (and a problem) when it cannot be mapped. */
  const mapSpecifier = (specifier: string): string | undefined => {
    if (PASS_THROUGH.some((pattern) => pattern.test(specifier))) return specifier;
    let path: string | undefined;
    if (specifier.startsWith("./") || specifier.startsWith("../")) path = join(dirname(from), specifier);
    else if (WORKSPACE_PACKAGE.test(specifier)) {
      path = map.packageEntry(specifier);
      if (path === undefined) {
        problems.push(`${from}: imports ${specifier}, a package that is not exported`);
        return undefined;
      }
    } else {
      problems.push(`${from}: imports ${specifier}, which the x402 monorepo does not provide here`);
      return undefined;
    }
    const target = map.mapPath(path);
    if (target === undefined) {
      problems.push(`${from}: imports ${specifier} (${path}), which is not exported`);
      return undefined;
    }
    return relativeSpecifier(to, target);
  };

  const replaceLiteral = (literal: ts.StringLiteral, specifier: string | undefined): void => {
    if (specifier !== undefined && specifier !== literal.text) {
      edits.push({ start: literal.getStart(source), end: literal.getEnd(), text: JSON.stringify(specifier) });
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (isBufferPolyfillImport(node)) {
        // The browser build imports `Buffer` from the `buffer` package; upstream runs on Node's global one.
        const end = text.charAt(node.getEnd()) === "\n" ? node.getEnd() + 1 : node.getEnd();
        edits.push({ start: node.getStart(source), end, text: "" });
        return;
      }
      if (node.moduleSpecifier.text === STELLAR_PACKAGE) {
        const replacement = splitStellarImport(node, source, from, to, map, problems);
        if (replacement !== undefined) {
          edits.push({ start: node.getStart(source), end: node.getEnd(), text: replacement });
        }
      } else {
        replaceLiteral(node.moduleSpecifier, mapSpecifier(node.moduleSpecifier.text));
      }
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteral(argument)) {
        replaceLiteral(argument, mapSpecifier(argument.text));
      }
    }
    // `new URL("<relative path>", import.meta.url)`: a file next to this one.
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") {
      const [path, base] = node.arguments ?? [];
      if (
        path !== undefined &&
        ts.isStringLiteral(path) &&
        base !== undefined &&
        base.getText(source) === "import.meta.url"
      ) {
        const target = map.mapPath(join(dirname(from), path.text));
        if (target === undefined) {
          problems.push(`${from}: reads ${path.text}, which is not exported`);
        } else {
          const specifier = relative(dirname(to), target);
          replaceLiteral(path, specifier.startsWith(".") ? specifier : `./${specifier}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return { text: result, problems };
}

/** `import { Buffer } from "buffer"` (or its `import type` form) and nothing else: dropped on export. */
function isBufferPolyfillImport(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return false;
  if (node.moduleSpecifier.text !== "buffer") return false;
  const clause = node.importClause;
  if (clause === undefined || clause.name !== undefined) return false;
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length === 1 &&
    bindings.elements[0]?.name.text === "Buffer" &&
    bindings.elements[0].propertyName === undefined
  );
}

/**
 * Replaces one `import { … } from "@x402/stellar"` (or `export { … } from`) with one statement per
 * mechanism module that defines the names. Statement order and formatting are left to the x402
 * lint rules (`import/order`, prettier).
 */
function splitStellarImport(
  node: ts.ImportDeclaration | ts.ExportDeclaration,
  source: ts.SourceFile,
  from: string,
  to: string,
  map: ImportMap,
  problems: string[],
): string | undefined {
  const elements = namedElements(node);
  if (elements === undefined) {
    problems.push(`${from}: only named imports of ${STELLAR_PACKAGE} can be mapped`);
    return undefined;
  }
  const byModule = new Map<string, string[]>();
  for (const element of elements) {
    const name = (element.propertyName ?? element.name).text;
    const module = map.stellarExport(name);
    if (module === undefined) {
      problems.push(`${from}: no module of the x402 Stellar mechanism exports ${name}`);
      continue;
    }
    byModule.set(module, [...(byModule.get(module) ?? []), element.getText(source)]);
  }
  if (byModule.size === 0) return undefined;
  const keyword = ts.isImportDeclaration(node) ? "import" : "export";
  const typeOnly = ts.isImportDeclaration(node)
    ? node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    : node.isTypeOnly;
  return [...byModule]
    .map(
      ([module, names]) =>
        `${keyword} ${typeOnly ? "type " : ""}{ ${names.join(", ")} } from ${JSON.stringify(relativeSpecifier(to, module))};`,
    )
    .join("\n");
}

function namedElements(
  node: ts.ImportDeclaration | ts.ExportDeclaration,
): readonly (ts.ImportSpecifier | ts.ExportSpecifier)[] | undefined {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause === undefined || clause.name !== undefined) return undefined;
    const bindings = clause.namedBindings;
    return bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements : undefined;
  }
  const clause = node.exportClause;
  return clause !== undefined && ts.isNamedExports(clause) ? clause.elements : undefined;
}

/**
 * The specifier that `file` uses for `target` in the x402 monorepo: relative, without the `.ts`
 * extension, and without a trailing `/index` (the directory resolves to it).
 */
export function relativeSpecifier(file: string, target: string): string {
  let specifier = relative(dirname(file), target.replace(/\.ts$/, ""));
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  const directory = specifier.replace(/\/index$/, "");
  return directory === "." || directory === ".." ? specifier : directory;
}

/** The names each module exports at its top level: `export const|function|class|interface|type|enum` and `export { … }`. */
export function exportedNames(text: string): string[] {
  const source = ts.createSourceFile("module.ts", text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const names: string[] = [];
  for (const statement of source.statements) {
    const exported = ts.canHaveModifiers(statement)
      ? (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        names.push(...clause.elements.map((element) => element.name.text));
      }
      continue;
    }
    if (!exported) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
}
