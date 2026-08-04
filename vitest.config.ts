import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Cover both the workspace packages and the repo-level tooling under scripts/.
    // The license gate is security-relevant code (it is what keeps AGPL out of the tree),
    // so it is tested on every run rather than treated as "just a script".
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts", "scripts/**/*.test.mjs"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["packages/*/src/**", "apps/*/src/**", "scripts/lib/**"],
      exclude: ["**/*.test.*", "**/dist/**"],
    },
  },
});
