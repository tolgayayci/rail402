import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bazaarCodes } from "@rail402.dev/bazaar";

const rules = readFileSync(new URL("../../../docs/verification-rules.md", import.meta.url), "utf8");

describe("docs/verification-rules.md", () => {
  it("documents every cataloging and discovery code", () => {
    const missing = Object.keys(bazaarCodes).filter((code) => !rules.includes(`\`${code}\``));
    expect(missing).toEqual([]);
  });
});
