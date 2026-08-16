/**
 * Bundle @rail402.dev/playground/browser into ONE self-contained ESM file the frontend can import
 * from a URL with no build step and no npm — signing, session, meter, attacks, bazaar, format, all
 * inlined, with a pure-JS Buffer polyfill and browser globals shimmed for @stellar/stellar-sdk.
 *
 * Output: apps/playground/public/lib/browser.js  (served at GET /lib/browser.js — see app.ts).
 * Run:    node apps/playground/bundle/build-browser-bundle.mjs
 *
 * esbuild is already in the dependency tree (transitive); this adds no new package. The bundle is
 * platform=browser so any accidental node built-in in the import graph fails the build here rather
 * than at runtime in a tab.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, readdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const storeDir = join(here, "../../../node_modules/.pnpm");

// esbuild and buffer are transitive deps (esbuild via vite/tsx; buffer via the SDKs), not linked
// into the playground's own node_modules — resolve them from the pnpm store by name, tolerant of
// version bumps, so a lockfile change does not break the image build (and no direct dep is added,
// keeping the license-gate package count put).
function storePackage(name) {
  const dir = readdirSync(storeDir).find(d => d.startsWith(`${name}@`));
  if (!dir) throw new Error(`${name} not found in the pnpm store — run pnpm install first`);
  return join(storeDir, dir, "node_modules", name);
}

const require = createRequire(import.meta.url);
const { build } = require(require.resolve("esbuild", { paths: [storePackage("esbuild")] }));
// NOT require.resolve("buffer") — Node returns its own builtin name for that. Point at the
// polyfill's entry file directly.
const bufferEntry = join(storePackage("buffer"), "index.js");

const root = join(here, "..");
const outfile = join(root, "public", "lib", "browser.js");
mkdirSync(dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [join(root, "src", "browser", "index.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile,
  // Buffer via the pure-JS polyfill; global/process shimmed for stellar-sdk's browser paths.
  inject: [join(here, "shim-buffer.js")],
  // `buffer` lives in the pnpm store, not linked into the playground's node_modules — alias it.
  alias: { buffer: bufferEntry },
  banner: {
    js: "globalThis.global=globalThis;globalThis.process=globalThis.process||{env:{},version:'',nextTick:(f)=>Promise.resolve().then(f)};",
  },
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  sourcemap: false,
  legalComments: "none",
  metafile: true,
  logLevel: "info",
});

// Fail loudly if a node built-in slipped in (it would break silently in a tab otherwise).
const externals = Object.keys(result.metafile.inputs).filter(p => p.startsWith("node:"));
if (externals.length) {
  console.error("node built-ins in the browser bundle:", externals);
  process.exit(1);
}
console.log(`\nbrowser bundle written: ${outfile}`);
