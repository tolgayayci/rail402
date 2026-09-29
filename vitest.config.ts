import { defineConfig } from "vitest/config";

const source = { conditions: ["@rail402/source"] };

export default defineConfig({
  resolve: source,
  ssr: { resolve: source },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["{apps,packages,tools}/*/test/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts"],
        },
      },
      {
        // Needs local services (Postgres, a Stellar network); see docker-compose.yml.
        extends: true,
        test: {
          name: "integration",
          include: ["{apps,packages,tools}/*/test/**/*.integration.test.ts", "test/**/*.test.ts"],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
