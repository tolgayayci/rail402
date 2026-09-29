/**
 * Licence policy for Rail402's dependency tree.
 *
 * Rail402 is Apache-2.0 and is meant to be run as a network service by anyone, so every package in
 * the production closure must carry a permissive licence, and no copyleft licence may appear
 * anywhere — not even in development tooling — unless it is listed below with a reason.
 */

/** Licences accepted anywhere in the tree, including production. */
export const PERMISSIVE = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "PostgreSQL",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

/** Licence families that must never enter the tree. Matched as prefixes of an SPDX identifier. */
export const FORBIDDEN_PREFIXES = [
  "AGPL",
  "GPL",
  "LGPL",
  "SSPL",
  "EUPL",
  "OSL",
  "CPAL",
  "CC-BY-SA",
  "CC-BY-NC",
  "BUSL",
  "Elastic",
  "Commons-Clause",
];

/** Packages refused regardless of their declared licence. */
export const DENIED_PACKAGES = new Map<string, string>([
  ["@openzeppelin/relayer-sdk", "AGPL-3.0-or-later; copyleft, never allowed"],
  ["@openzeppelin/relayer-plugin-x402-facilitator", "AGPL-3.0-or-later; copyleft, never allowed"],
  ["sharp", "ships LGPL-3.0-or-later libvips binaries"],
]);

export interface DevException {
  readonly name: string;
  readonly license: string;
  readonly reason: string;
}

/**
 * Non-permissive, non-forbidden licences tolerated in development tooling only. They never ship in
 * the service image or in published packages; the production check ignores this list.
 */
export const DEV_EXCEPTIONS: readonly DevException[] = [
  {
    name: "lightningcss",
    license: "MPL-2.0",
    reason: "vite (via vitest) CSS transformer; file-level copyleft, test tooling only, never distributed",
  },
  {
    name: "lightningcss-linux-x64-gnu",
    license: "MPL-2.0",
    reason: "platform binary of lightningcss; test tooling only, never distributed",
  },
];

export type Verdict = { ok: true } | { ok: false; problem: string };

export interface PackageLicense {
  readonly name: string;
  readonly version: string;
  readonly license: string;
}

/** Decides whether a package is acceptable in the given scope. */
export function judge(pkg: PackageLicense, scope: "production" | "development"): Verdict {
  const denied = DENIED_PACKAGES.get(pkg.name);
  if (denied !== undefined) return { ok: false, problem: `denied package: ${denied}` };

  let expression: Expression;
  try {
    expression = parseSpdx(pkg.license);
  } catch (error) {
    return { ok: false, problem: `unparseable licence "${pkg.license}": ${(error as Error).message}` };
  }

  const ids = identifiers(expression);
  const forbidden = ids.find((id) => FORBIDDEN_PREFIXES.some((prefix) => id.startsWith(prefix)));
  if (forbidden !== undefined && !satisfies(expression, (id) => PERMISSIVE.has(id))) {
    return { ok: false, problem: `copyleft licence ${forbidden}` };
  }

  if (satisfies(expression, (id) => PERMISSIVE.has(id))) return { ok: true };

  if (scope === "development") {
    const exception = DEV_EXCEPTIONS.find((e) => e.name === pkg.name && e.license === pkg.license);
    if (exception !== undefined) return { ok: true };
  }
  return { ok: false, problem: `licence "${pkg.license}" is not on the permissive allowlist` };
}

// --- minimal SPDX expression support: identifiers, WITH, AND, OR, parentheses -------------------

export type Expression =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "and" | "or"; readonly left: Expression; readonly right: Expression };

export function parseSpdx(input: string): Expression {
  const tokens = input
    .replace(/[()]/g, (paren) => ` ${paren} `)
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
  if (tokens.length === 0) throw new Error("empty licence");
  let position = 0;

  const peek = (): string | undefined => tokens[position];
  const next = (): string => {
    const token = tokens[position++];
    if (token === undefined) throw new Error("unexpected end of expression");
    return token;
  };

  const parseOr = (): Expression => {
    let left = parseAnd();
    while (peek()?.toUpperCase() === "OR") {
      next();
      left = { kind: "or", left, right: parseAnd() };
    }
    return left;
  };
  const parseAnd = (): Expression => {
    let left = parseAtom();
    while (peek()?.toUpperCase() === "AND") {
      next();
      left = { kind: "and", left, right: parseAtom() };
    }
    return left;
  };
  const parseAtom = (): Expression => {
    const token = next();
    if (token === "(") {
      const inner = parseOr();
      if (next() !== ")") throw new Error("missing closing parenthesis");
      return inner;
    }
    if (/^(AND|OR|WITH|\))$/i.test(token)) throw new Error(`unexpected "${token}"`);
    // A licence exception (e.g. "Apache-2.0 WITH LLVM-exception") only adds permissions.
    if (peek()?.toUpperCase() === "WITH") {
      next();
      next();
    }
    return { kind: "id", id: token.replace(/\+$/, "") };
  };

  const expression = parseOr();
  if (position !== tokens.length) throw new Error(`unexpected "${tokens[position] ?? ""}"`);
  return expression;
}

function satisfies(expression: Expression, allowed: (id: string) => boolean): boolean {
  switch (expression.kind) {
    case "id":
      return allowed(expression.id);
    case "and":
      return satisfies(expression.left, allowed) && satisfies(expression.right, allowed);
    case "or":
      return satisfies(expression.left, allowed) || satisfies(expression.right, allowed);
  }
}

function identifiers(expression: Expression): string[] {
  return expression.kind === "id"
    ? [expression.id]
    : [...identifiers(expression.left), ...identifiers(expression.right)];
}
