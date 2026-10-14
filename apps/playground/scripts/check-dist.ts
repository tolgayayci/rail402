/**
 * `pnpm --filter @rail402.dev/playground check:dist`: checks the built page in web/dist after
 * `vite build` and prints its size report.
 *
 * - Size: the JavaScript and CSS together stay within the budget, the first build plus 20 %.
 * - No Node code: no `__vite-browser-external` stub (a Node built-in Vite replaced with an empty
 *   module), and `node:` specifiers only for the built-ins the packages probe lazily through
 *   `process.getBuiltinModule`, which browsers do not have (key files, the home directory, code
 *   events); nothing imports them.
 * - No fake engine: the replaying engine for `dev:fake` and component tests never ships.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** The first build's JavaScript and CSS (1,403,016 bytes) plus 20 %. */
export const BUDGET_BYTES = 1_683_620;

/** Built-ins the packages reach only through a guarded `process.getBuiltinModule` lookup. */
export const LAZY_BUILTINS: readonly string[] = Object.freeze([
  "node:diagnostics_channel",
  "node:fs/promises",
  "node:os",
]);

/** Strings only the fake engine's code path contains. */
export const FAKE_MARKERS: readonly string[] = Object.freeze([
  "fake-wallet",
  "fake-fund",
  "fake-unfinished",
  "purchase-fails",
]);

export interface DistFile {
  readonly path: string;
  readonly text: string;
}

export interface DistReport {
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly gzip: number }[];
  readonly totalBytes: number;
  readonly totalGzip: number;
  readonly problems: readonly string[];
}

const NODE_SPECIFIER = /["'`](node:[a-z_/]+)["'`]/g;

/** Sizes and problems of the built page's JavaScript and CSS files. */
export function inspectDist(files: readonly DistFile[], budget = BUDGET_BYTES): DistReport {
  const problems: string[] = [];
  const sized = files.map((file) => {
    const bytes = Buffer.byteLength(file.text);
    if (file.text.includes("__vite-browser-external")) {
      problems.push(`${file.path}: a Node built-in was replaced by an empty browser stub`);
    }
    for (const match of file.text.matchAll(NODE_SPECIFIER)) {
      const specifier = match[1] ?? "";
      if (!LAZY_BUILTINS.includes(specifier)) {
        problems.push(`${file.path}: imports the Node built-in ${specifier}`);
      }
    }
    for (const marker of FAKE_MARKERS) {
      if (file.text.includes(marker)) problems.push(`${file.path}: contains the fake engine ("${marker}")`);
    }
    return { path: file.path, bytes, gzip: gzipSync(file.text).byteLength };
  });
  const totalBytes = sized.reduce((sum, file) => sum + file.bytes, 0);
  const totalGzip = sized.reduce((sum, file) => sum + file.gzip, 0);
  if (totalBytes > budget) {
    problems.push(`the page is ${String(totalBytes)} bytes, over its budget of ${String(budget)}`);
  }
  return { files: sized, totalBytes, totalGzip, problems };
}

/** The JavaScript and CSS files under a built page's directory. */
export function readDist(root: string): DistFile[] {
  const names = readdirSync(root, { recursive: true, encoding: "utf8" });
  return names
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isFile() && [".js", ".css"].includes(extname(path)))
    .sort()
    .map((path) => ({ path: relative(root, path), text: readFileSync(path, "utf8") }));
}

function main(): void {
  const root = fileURLToPath(new URL("../web/dist", import.meta.url));
  let files: DistFile[];
  try {
    files = readDist(root);
  } catch {
    console.error(`No built page in ${root}: run vite build first.`);
    process.exit(1);
  }
  if (!files.some((file) => file.path.endsWith(".js"))) {
    console.error(`No JavaScript in ${root}: run vite build first.`);
    process.exit(1);
  }
  const report = inspectDist(files);
  const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`;
  for (const file of report.files) {
    console.log(`${file.path.padEnd(40)} ${kb(file.bytes).padStart(10)} ${kb(file.gzip).padStart(10)} gzip`);
  }
  console.log(
    `${"total".padEnd(40)} ${kb(report.totalBytes).padStart(10)} ${kb(report.totalGzip).padStart(10)} gzip` +
      ` (budget ${kb(BUDGET_BYTES)})`,
  );
  if (report.problems.length > 0) {
    for (const problem of report.problems) console.error(problem);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
