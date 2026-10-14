/**
 * The browser entries build for browsers and load without Node: a Vite build of what a page imports
 * (`fixtures/browser/entry.ts`) must not reach a Node built-in module, and the bundle must run in a
 * context that has the web platform's globals but none of Node's (`process`, `Buffer`, `require`,
 * `global`). Inside that context, the npm `buffer` polyfill is the Buffer the code gets, so the
 * paths that once relied on Node-only encodings are exercised as a browser runs them.
 */
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Keypair } from "@stellar/stellar-sdk";
import { build, type Rolldown } from "vite";
import { beforeAll, describe, expect, it } from "vitest";
import type * as SafeFetchShared from "@rail402.dev/safe-fetch/shared";
import type * as Sdk from "@rail402.dev/sdk/browser";
import type * as Stellar from "@rail402.dev/stellar";
import type * as UptoClient from "@rail402.dev/upto/client";
import type * as McpTools from "../../mcp/src/tools-entry.ts";

const fixture = (name: string) => fileURLToPath(new URL(`fixtures/browser/${name}`, import.meta.url));
/** Node's built-in modules; `buffer` is the npm polyfill's name too, and resolves to it in browsers. */
const NODE_BUILTINS = new Set(builtinModules.filter((name) => name !== "buffer"));
/** Globals only Node has; everything else on Node's global object is web platform or JavaScript. */
const NODE_GLOBALS = new Set([
  "process",
  "Buffer",
  "global",
  "require",
  "module",
  "exports",
  "__filename",
  "__dirname",
  "setImmediate",
  "clearImmediate",
]);

interface BrowserExports {
  readonly sdk: typeof Sdk;
  readonly stellar: typeof Stellar;
  readonly uptoClient: typeof UptoClient;
  readonly safeFetch: typeof SafeFetchShared;
  readonly mcpTools: typeof McpTools;
}

function isNodeBuiltin(id: string): boolean {
  if (id.startsWith("node:")) return true;
  const [name = ""] = id.split("/");
  return NODE_BUILTINS.has(id) || NODE_BUILTINS.has(name);
}

/** The bundle of `entry` for browsers, and every Node built-in it reached (`specifier <- importer`). */
async function buildForBrowsers(entry: string): Promise<{ code: string; reached: string[] }> {
  const reached: string[] = [];
  const result = await build({
    configFile: false,
    logLevel: "silent",
    root: fileURLToPath(new URL("..", import.meta.url)),
    resolve: { conditions: ["@rail402/source", "browser", "module", "import", "default"] },
    plugins: [
      {
        name: "rail402:no-node-builtins",
        enforce: "pre",
        resolveId(id, importer) {
          if (!isNodeBuiltin(id)) return null;
          reached.push(`${id} <- ${importer ?? "?"}`);
          // Resolved to an empty module so the build finishes and reports every offender at once.
          return "\0node-builtin";
        },
        load(id) {
          return id === "\0node-builtin" ? "export default {};" : null;
        },
      },
    ],
    build: {
      write: false,
      minify: true,
      target: "es2024",
      emptyOutDir: false,
      lib: { entry, formats: ["iife"], name: "rail402" },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const code = outputs
    .flatMap((output) => output.output)
    .map((file) => (file.type === "chunk" ? file.code : ""))
    .join("\n");
  return { code, reached };
}

/** Runs the bundle in a fresh context with the web platform's globals and none of Node's. */
function loadInBrowserContext(code: string): BrowserExports {
  const context = vm.createContext({});
  const intrinsic = new Set(vm.runInContext("Object.getOwnPropertyNames(globalThis)", context) as string[]);
  const scope = context as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (NODE_GLOBALS.has(name) || intrinsic.has(name)) continue;
    scope[name] = (globalThis as Record<string, unknown>)[name];
  }
  vm.runInContext(code, context);
  for (const name of NODE_GLOBALS) {
    expect(vm.runInContext(`typeof ${name}`, context), name).toBe("undefined");
  }
  return scope["rail402"] as BrowserExports;
}

describe("browser bundle", () => {
  let code: string;
  let reached: string[];
  let loaded: BrowserExports;

  beforeAll(async () => {
    ({ code, reached } = await buildForBrowsers(fixture("entry.ts")));
    loaded = loadInBrowserContext(code);
  }, 120_000);

  it("reaches no Node built-in module", () => {
    expect(reached).toEqual([]);
  });

  it("would catch a Node built-in or global", async () => {
    const planted = await buildForBrowsers(fixture("node-only.ts"));
    expect(planted.reached.map((line) => line.split(" <- ")[0]).sort()).toEqual(["crypto", "node:fs"]);
    expect(() => {
      (loadInBrowserContext(planted.code) as unknown as { home(): unknown }).home();
    }).toThrow(/process is not defined/);
  });

  it("keeps no Node global, require or empty browser stub", () => {
    expect(code).not.toMatch(/\brequire\(/);
    expect(code).not.toContain("__vite-browser-external");
    // stellar-sdk feature-detects Node (`typeof process<"u"&&process.versions…`); nothing else may
    // touch `process` unguarded.
    for (const match of code.matchAll(/\bprocess\./g)) {
      expect(code.slice(Math.max(0, match.index - 80), match.index)).toContain("typeof process");
    }
  });

  it("loads every entry", () => {
    expect(Object.keys(loaded).sort()).toEqual(["mcpTools", "safeFetch", "sdk", "stellar", "uptoClient"]);
    expect(typeof loaded.sdk.createBrowserBuyer).toBe("function");
    expect(typeof loaded.mcpTools.createTools).toBe("function");
    expect(typeof loaded.uptoClient.UptoStellarScheme).toBe("function");
  });

  it("derives payment identifiers with the npm Buffer as with Node's", () => {
    expect(loaded.sdk.paymentIdentifier("window-1", "order_12345678")).toBe(
      "rail402_QbqP6lQxkEkcKMt5psdKUOw3n2QxI74z",
    );
  });

  it("signs and verifies an authorization preimage", async () => {
    const { sdk } = loaded;
    const key = sdk.KeyHolder.random();
    const preimage = Buffer.from("rail402 bundle check").toString("base64");
    const { signedAuthEntry } = await key.signAuthEntry(preimage);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Buffer.from(preimage, "base64")));
    expect(
      Keypair.fromPublicKey(key.address).verify(Buffer.from(digest), Buffer.from(signedAuthEntry, "base64")),
    ).toBe(true);
    await expect(sdk.KeyHolder.fromFile("~/key")).rejects.toMatchObject({ code: "key_not_found" });
  });

  it("reports codes without Node's diagnostics channel", () => {
    const error = loaded.sdk.paymentError("payment_cap_required");
    expect(error.code).toBe("payment_cap_required");
    expect(error.reason).not.toBe("");
  });
});
