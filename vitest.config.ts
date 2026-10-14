import { configDefaults, defineConfig } from "vitest/config";

const source = { conditions: ["@rail402/source"] };

// Records which registered codes the suites exercise, in .work/codes-coverage.json.
const codesCoverage = {
  setupFiles: ["tools/conformance/src/recorder/setup.ts"],
  globalSetup: ["tools/conformance/src/recorder/global-setup.ts"],
};

export default defineConfig({
  resolve: source,
  ssr: { resolve: source },
  test: {
    // `pnpm test:coverage`; packages with a coverage floor list it here.
    coverage: {
      provider: "v8",
      thresholds: {
        "packages/upto/src/**": { statements: 70, branches: 70, functions: 70, lines: 70 },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          ...codesCoverage,
          include: ["{apps,packages,tools}/*/test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
        },
      },
      {
        // The Playground page: components and browser code in a simulated DOM.
        extends: true,
        resolve: { conditions: ["@rail402/source", "browser"] },
        test: {
          name: "web",
          ...codesCoverage,
          environment: "happy-dom",
          include: ["apps/playground/web/test/**/*.test.{ts,tsx}"],
          exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
        },
      },
      {
        // Needs local services (Postgres, a Stellar network); see docker-compose.yml.
        extends: true,
        test: {
          name: "integration",
          ...codesCoverage,
          include: [
            "{apps,packages,tools}/*/test/**/*.integration.test.ts",
            // The Playground's engine over its server, run in Node.
            "apps/playground/web/test/**/*.integration.test.ts",
            "test/**/*.test.ts",
          ],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
