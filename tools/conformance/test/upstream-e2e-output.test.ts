import { describe, expect, it } from "vitest";
import {
  catalogOutcomes,
  githubRepository,
  missingResources,
  releaseTagFor,
} from "../src/upstream-e2e-output.ts";

// Abridged from a run in which the per-payer quota refused the last five listings.
const FAILED = `📋 Expected Discoverable Endpoints: 15 (from executed tests)
   • typescript/http/express + rail402: 6 test(s)
📍 rail402:
   Discovered: 10/15
  🛑 Stopping facilitator: rail402
   ❌ Missing: 2
      • GET http://localhost:4025/api/upto/stellar/withx402
      • tool mcp://tool/upto_stellar
❌ Discovery Validation: FAILED
`;

describe("upstream e2e output", () => {
  it("lists only the resources the discovery validation reported missing", () => {
    expect(missingResources(FAILED)).toEqual([
      "GET http://localhost:4025/api/upto/stellar/withx402",
      "tool mcp://tool/upto_stellar",
    ]);
    expect(missingResources("   Discovered: 15/15\n✅ Discovery Validation: PASSED\n")).toEqual([]);
  });

  it("reads the catalog's outcome counters by their labels", () => {
    expect(
      catalogOutcomes(
        [
          'rail402_catalog_outcomes_total{phase="settle",status="rejected",code="bazaar_rate_limited"} 5',
          'rail402_catalog_outcomes_total{phase="settle",status="success",code="cataloged"} 3',
          "rail402_other_total 1",
        ].join("\n"),
      ),
    ).toEqual({ "settle/rejected/bazaar_rate_limited": 5, "settle/success/cataloged": 3 });
  });
});

describe("upstream provenance", () => {
  it("cites the Stellar package's release tag among the tags of a release commit", () => {
    const tags = ["npm-@x402/axios@v2.27.0", "npm-@x402/fastify@v2.27.0", "npm-@x402/stellar@v2.27.0"];
    expect(releaseTagFor(tags, "2.27.0")).toBe("npm-@x402/stellar@v2.27.0");
    expect(releaseTagFor(tags.slice(0, 2), "2.27.0")).toBe("npm-@x402/axios@v2.27.0");
    expect(releaseTagFor(["v1"], "2.27.0")).toBe("v1");
    expect(releaseTagFor([], "2.27.0")).toBeUndefined();
  });

  it("reads owner/name from GitHub remote URLs only", () => {
    expect(githubRepository("https://github.com/x402-foundation/x402")).toBe("x402-foundation/x402");
    expect(githubRepository("git@github.com:someone/x402.git\n")).toBe("someone/x402");
    expect(githubRepository("https://gitlab.com/someone/x402")).toBeUndefined();
  });
});
