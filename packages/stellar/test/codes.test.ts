import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exactStellarCodes } from "@rail402.dev/stellar";

const rules = readFileSync(new URL("../../../docs/verification-rules.md", import.meta.url), "utf8");

describe("docs/verification-rules.md", () => {
  it("documents every exact Stellar reason code", () => {
    const missing = Object.keys(exactStellarCodes).filter((code) => !rules.includes(`\`${code}\``));
    expect(missing).toEqual([]);
  });
});
