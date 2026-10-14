import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The routes the Playground server answers; the dev server forwards them to it. */
export const SERVER_ROUTES: readonly string[] = Object.freeze([
  "/api",
  "/lab",
  "/.well-known",
  "/health",
  "/ready",
]);

/** Where the dev server finds the Playground server (`pnpm dev` starts both). */
export const DEFAULT_DEV_SERVER = "http://127.0.0.1:8787";

/**
 * The Playground page, built from web/ into web/dist. Workspace packages resolve to their TypeScript
 * sources, and the strict CSP the server sends (no inline script) needs Vite's module-preload
 * polyfill off.
 *
 * In development the page is served by Vite and the server's routes are forwarded to
 * `PLAYGROUND_DEV_SERVER` unchanged, `Origin` included, so the server's PUBLIC_URL must be the page's
 * own origin. The `fake` mode forwards nothing: its engine never calls the server.
 */
export default defineConfig(({ mode }) => {
  const target = process.env["PLAYGROUND_DEV_SERVER"] ?? DEFAULT_DEV_SERVER;
  return {
    root: fileURLToPath(new URL("web", import.meta.url)),
    plugins: [react()],
    resolve: { conditions: ["@rail402/source", "browser", "module", "import", "default"] },
    server: {
      proxy:
        mode === "fake"
          ? {}
          : Object.fromEntries(SERVER_ROUTES.map((route) => [route, { target, ws: false }])),
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      modulePreload: { polyfill: false },
      target: "es2024",
    },
  };
});
