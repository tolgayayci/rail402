/**
 * Formats exported TypeScript with the x402 checkout's own ESLint installation and configuration
 * (`import/order`, prettier, jsdoc), so the exported files are exactly what its lint check accepts.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Formatter } from "./export.ts";
import { MECHANISM } from "./layout.ts";

interface LintMessage {
  readonly severity: number;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly ruleId: string | null;
}

interface LintEngine {
  lintText(
    code: string,
    options: { filePath: string },
  ): Promise<{ readonly output?: string; readonly messages: readonly LintMessage[] }[]>;
}

const FIXABLE: ReadonlySet<string> = new Set(["import/order", "prettier/prettier"]);

/** A formatter backed by the ESLint that the checkout's mechanism package resolves. */
export function checkoutFormatter(target: string): Formatter {
  const packageDirectory = join(target, MECHANISM);
  let module: {
    ESLint: new (options: {
      cwd: string;
      overrideConfig: readonly { files: readonly string[] }[];
      fix: (message: LintMessage) => boolean;
    }) => LintEngine;
  };
  try {
    module = createRequire(join(packageDirectory, "package.json"))("eslint") as typeof module;
  } catch {
    throw new Error(
      `ESLint is not installed in ${packageDirectory}: run \`pnpm install\` in ${join(target, "typescript")} first`,
    );
  }
  // Only layout is fixed automatically; the other fixers (jsdoc stubs, for one) would hide findings.
  const engine = new module.ESLint({
    cwd: packageDirectory,
    // What the checkout's `eslint . --ext .ts` adds: every .ts file is linted, including the test
    // helpers that only its `test/**/*` configuration block covers.
    overrideConfig: [{ files: ["**/*.ts"] }],
    fix: (message) => message.ruleId !== null && FIXABLE.has(message.ruleId),
  });
  return async (text, path) => {
    // eslint-plugin-prettier reads `.prettierignore` from the working directory, which must be the
    // checkout's, not this repository's. Files are formatted one at a time.
    const cwd = process.cwd();
    process.chdir(packageDirectory);
    let result: Awaited<ReturnType<LintEngine["lintText"]>>[number] | undefined;
    try {
      [result] = await engine.lintText(text, { filePath: join(target, path) });
    } finally {
      process.chdir(cwd);
    }
    return {
      text: result?.output ?? text,
      problems: (result?.messages ?? [])
        .filter((message) => message.severity >= 2)
        .map(
          (message) => `${message.line}:${message.column} ${message.message} (${message.ruleId ?? "parse"})`,
        ),
    };
  };
}
