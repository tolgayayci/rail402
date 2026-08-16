import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Keypair } from "@stellar/stellar-sdk";
import { loadConfig, type PlaygroundConfig } from "./config.js";
import { createApp } from "./app.js";
import { DEFAULT_BUNDLE_PATH, loadBrowserBundle } from "./browser-bundle.js";

/**
 * The browser bundle is the frontend's payment engine, served at /lib/browser.js so it can be
 * imported from a URL with no build step. These tests hold the route to its contract: a real,
 * self-contained ESM module with the exports the frontend imports, the right content-type for a
 * cross-origin module import, and a coded refusal (never a silent 404) when the bundle is absent.
 */

const SECRET = Keypair.random().secret();
const FIXTURE = "export const createSession = () => ({});\nexport const payExact = async () => ({});\n";

let dir: string;
let bundlePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pg-bundle-"));
  bundlePath = join(dir, "browser.js");
  writeFileSync(bundlePath, FIXTURE);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeApp(overrides: { browserBundlePath?: string } = {}) {
  const config: PlaygroundConfig = loadConfig({ PLAYGROUND_DISPENSER_SECRET: SECRET } as NodeJS.ProcessEnv);
  return createApp({ config, browserBundlePath: overrides.browserBundlePath ?? bundlePath }).app;
}

describe("loadBrowserBundle", () => {
  it("reads a bundle and returns its byte size", () => {
    const bundle = loadBrowserBundle(bundlePath);
    expect(bundle?.content).toBe(FIXTURE);
    expect(bundle?.bytes).toBe(Buffer.byteLength(FIXTURE));
  });

  it("returns null for a missing bundle, never throws", () => {
    expect(loadBrowserBundle(join(dir, "nope.js"))).toBeNull();
  });

  it("the SHIPPED bundle exists and exports the payment engine (fails here if the image lost it)", () => {
    // DEFAULT_BUNDLE_PATH is the real built artifact; a build that forgot to bundle fails this.
    const bundle = loadBrowserBundle(DEFAULT_BUNDLE_PATH);
    expect(bundle, "run `pnpm --filter @rail402.dev/playground build:browser-bundle`").not.toBeNull();
    expect(bundle!.content).toContain("createSession");
    expect(bundle!.content).toContain("payExact");
    expect(bundle!.bytes).toBeGreaterThan(100_000); // stellar-sdk + x402 SDK inlined
  });
});

describe("wire: GET /lib/browser.js", () => {
  it("serves the bundle as a JavaScript module", async () => {
    const app = makeApp();
    const res = await app.request("/lib/browser.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toBe(FIXTURE);
  });

  it("refuses with a coded 503 (not a silent 404) when the bundle is absent", async () => {
    const app = makeApp({ browserBundlePath: join(dir, "missing.js") });
    const res = await app.request("/lib/browser.js");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe("playground_invalid_request");
    expect(body.reason).toContain("bundle");
  });

  it("announces the browser lib in /session/config", async () => {
    const app = makeApp();
    const config = (await (await app.request("/session/config")).json()) as {
      demo: { browserLib: { path: string } };
    };
    expect(config.demo.browserLib.path).toBe("/lib/browser.js");
  });
});
