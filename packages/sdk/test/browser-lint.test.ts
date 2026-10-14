/**
 * The lint rules that keep browser code free of Node globals and of Buffer encodings the npm polyfill
 * lacks apply to every file a browser bundle reaches, and to none of the Node-only ones.
 */
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const eslint = new ESLint({ cwd: root });

async function restricted(file: string): Promise<{ globals: string[]; base64url: boolean }> {
  const config = (await eslint.calculateConfigForFile(file)) as {
    rules?: Record<string, unknown[] | undefined>;
  };
  const globals = (config.rules?.["no-restricted-globals"] ?? [])
    .slice(1)
    .map((entry) => (entry as { name: string }).name)
    .sort();
  const syntax = JSON.stringify(config.rules?.["no-restricted-syntax"] ?? []);
  return { globals, base64url: syntax.includes("base64url") };
}

describe("browser lint rules", () => {
  it.each([
    "packages/errors/src/index.ts",
    "packages/safe-fetch/src/shared.ts",
    "packages/safe-fetch/src/limits.ts",
    "packages/sdk/src/browser.ts",
    "packages/sdk/src/flow/scrub.ts",
    "packages/sdk/src/policy/guard.ts",
    "packages/stellar/src/auth.ts",
    "packages/upto/src/client/scheme.ts",
    "packages/mcp/src/tools.ts",
    "packages/mcp/src/tools-entry.ts",
  ])("apply to %s", async (file) => {
    await expect(restricted(file)).resolves.toEqual({
      globals: ["Buffer", "global", "process", "require"],
      base64url: true,
    });
  });

  it.each([
    "packages/safe-fetch/src/fetch.ts",
    "packages/sdk/src/buyer.ts",
    "packages/sdk/src/config.ts",
    "packages/sdk/src/seller/common.ts",
    "packages/sdk/src/sqlite/ledger.ts",
    "packages/mcp/src/logger.ts",
    "packages/mcp/src/server.ts",
  ])("leave Node-only %s alone", async (file) => {
    await expect(restricted(file)).resolves.toEqual({ globals: [], base64url: false });
  });

  it("report a global Buffer, process and a base64url encoding", async () => {
    const [result] = await eslint.lintText(
      ['export const a = Buffer.from("x").toString("base64url");', "export const b = process.env;", ""].join(
        "\n",
      ),
      { filePath: "packages/sdk/src/bytes.ts" },
    );
    const messages = (result?.messages ?? [])
      .filter((message) => message.ruleId?.startsWith("no-restricted") === true)
      .map((message) => message.ruleId)
      .sort();
    expect(messages).toEqual(["no-restricted-globals", "no-restricted-globals", "no-restricted-syntax"]);
  });
});
