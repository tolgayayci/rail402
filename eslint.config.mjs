import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/.turbo/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],

      /**
       * Money math: amounts are bigint end to end.
       * No float ever goes near an amount. These ban the usual accidents.
       */
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Amounts are bigint. parseFloat must never touch a payment amount." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Number", property: "parseFloat", message: "Amounts are bigint; no float math near money." },
        { object: "Math", property: "round", message: "Rounding an amount is a bug. Use bigint arithmetic." },
      ],
    },
  },
  {
    // Tests may construct odd values deliberately.
    files: ["**/*.test.ts", "**/*.test.mjs"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-properties": "off",
    },
  },
);
