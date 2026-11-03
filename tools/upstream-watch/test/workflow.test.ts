import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = readFileSync(`${ROOT}.github/workflows/upstream-watch.yml`, "utf8");
const lines = workflow.split("\n").filter((line) => !/^\s*#/.test(line));

/** The indented block under a top-level key, as `key: value` lines. */
function block(key: string): string[] {
  const start = lines.indexOf(`${key}:`);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== "" && !line.startsWith(" ")) break;
    if (line.trim() !== "") out.push(line.trim());
  }
  return out;
}

describe("the upstream-watch workflow", () => {
  it("grants only contents read and issues write and pins every action by SHA", () => {
    expect(block("permissions")).toEqual(["contents: read", "issues: write"]);
    // No job widens them.
    expect(lines.filter((line) => /^\s+permissions:/.test(line))).toEqual([]);
    const uses = lines.filter((line) => /^\s*-?\s*uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line, line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d/);
    // The same pins as the CI workflow.
    const ci = readFileSync(`${ROOT}.github/workflows/ci.yml`, "utf8");
    for (const line of uses) expect(ci, line).toContain(line.replace(/^\s*-?\s*/, ""));
  });

  it("runs weekly and on demand, in this repository only", () => {
    expect(block("on")).toEqual([
      "schedule:",
      '- cron: "17 6 * * 1"',
      "workflow_dispatch:",
      "inputs:",
      "dry_run:",
      "description: Print the issue it would write instead of writing it",
      "type: boolean",
      "default: true",
    ]);
    expect(workflow).toContain("if: github.repository == 'tolgayayci/rail402'");
  });

  it("uses no secret but its own token and never fetches or runs upstream code", () => {
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).toContain("GITHUB_TOKEN: ${{ github.token }}");
    expect(workflow).toContain("persist-credentials: false");
    // Only this repository is checked out, and only the watcher's dependencies are installed.
    expect(workflow).not.toMatch(/^\s+repository:/m);
    expect(workflow).toContain(
      "pnpm install --frozen-lockfile --ignore-scripts --filter @rail402.dev/upstream-watch",
    );
    expect(workflow).not.toMatch(/x402-foundation|git clone|npx |pnpm dlx|curl /);
    // Workflow inputs reach the shell through the environment, never by interpolation into the script.
    const run = workflow.slice(workflow.indexOf("run: |"));
    expect(run).not.toContain("${{");
  });
});
