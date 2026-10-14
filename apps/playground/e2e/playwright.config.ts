/**
 * Browser tests of the Playground: the production build, served with its real CSP by the Playground
 * server, driven in Chromium against the local stack (e2e/stack.ts) on the private Stellar network
 * (docker compose --profile stellar up -d --wait). Run with `pnpm --filter @rail402.dev/playground
 * test:e2e`, which builds the page first.
 *
 * The tests share one wallet and run in order, in one worker. Outside CI a stack that is already
 * running (started by hand with `node --conditions=@rail402/source e2e/stack.ts`) is reused.
 */
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { E2E_CONTROL, E2E_ORIGIN } from "./ports.ts";

const ci = process.env["CI"] !== undefined && process.env["CI"] !== "";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: fileURLToPath(new URL("../test-results", import.meta.url)),
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: ci ? [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: E2E_ORIGIN,
    // The local RPC is an https proxy with a throwaway certificate.
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "node --conditions=@rail402/source e2e/stack.ts",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    url: `${E2E_CONTROL}/ready`,
    timeout: 300_000,
    reuseExistingServer: !ci,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
  },
});
