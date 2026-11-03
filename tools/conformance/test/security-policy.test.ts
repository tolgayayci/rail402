import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/evidence.ts";

describe("SECURITY.md", () => {
  it("supports the minor version the workspace ships", () => {
    const version = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string })
      .version;
    const minor = version.split(".").slice(0, 2).join(".");
    const policy = readFileSync(join(REPO_ROOT, "SECURITY.md"), "utf8");
    expect(policy).toMatch(new RegExp(`^\\| ${minor.replace(".", "\\.")}\\.x +\\| Yes +\\|$`, "m"));
  });
});
