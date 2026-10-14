import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.data/**", "**/.models/**", "tmp/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "no-console": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    // Code that runs in browsers (the SDK's browser entry, the MCP tools, the Playground page): no Node
    // globals, and no Buffer encodings the npm polyfill lacks. Import Buffer from "buffer" explicitly.
    files: [
      "packages/errors/src/**/*.ts",
      "packages/safe-fetch/src/{codes,limits,shared}.ts",
      "packages/sdk/src/**/*.ts",
      "packages/stellar/src/**/*.ts",
      "packages/upto/src/**/*.ts",
      "packages/mcp/src/{codes,limits,logger-types,results,schemas,tools,tools-entry}.ts",
      "apps/playground/web/src/**/*.{ts,tsx}",
    ],
    ignores: ["packages/sdk/src/{buyer,config}.ts", "packages/sdk/src/{seller,sqlite}/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "Buffer", message: 'Browsers have no global Buffer: import { Buffer } from "buffer".' },
        { name: "process", message: "Browsers have no process; take configuration as a parameter." },
        { name: "require", message: "Browsers have no require; use an import." },
        { name: "global", message: "Use globalThis." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value='base64url'], TemplateElement[value.raw='base64url']",
          message: "The npm buffer polyfill has no base64url encoding: use toBase64Url from bytes.ts.",
        },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: [
      "tools/**/*.ts",
      "examples/**/*.ts",
      "**/test/**/*.ts",
      "**/*.test.ts",
      "apps/*/e2e/**/*.ts",
      "apps/*/scripts/**/*.ts",
    ],
    rules: { "no-console": "off" },
  },
);
