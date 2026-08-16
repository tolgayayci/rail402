import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Serve the pre-built, self-contained browser bundle at `GET /lib/browser.js` so a frontend can
 * import `@rail402.dev/playground/browser` from a URL with NO build step and NO npm — the signing,
 * session, meter, attack, bazaar, and format helpers, with @stellar/stellar-sdk + the stock x402
 * SDK + a Buffer polyfill all inlined.
 *
 * The bundle is produced by `bundle/build-browser-bundle.mjs` (esbuild, platform=browser) into
 * `public/lib/browser.js`, which the Docker image copies in. Read once at boot; if it is missing
 * (someone forgot to build it) the route reports that with a coded reason rather than 404-ing
 * silently.
 */

/** `<repo>/apps/playground/public/lib/browser.js`, from both `src/server/` and `dist/server/`. */
export const DEFAULT_BUNDLE_PATH = fileURLToPath(
  new URL("../../public/lib/browser.js", import.meta.url),
);

export interface BrowserBundle {
  readonly content: string;
  readonly bytes: number;
}

export function loadBrowserBundle(bundlePath: string = DEFAULT_BUNDLE_PATH): BrowserBundle | null {
  try {
    const content = readFileSync(bundlePath, "utf8");
    return { content, bytes: Buffer.byteLength(content) };
  } catch {
    return null;
  }
}
