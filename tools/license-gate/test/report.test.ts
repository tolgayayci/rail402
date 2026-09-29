import { describe, expect, it } from "vitest";
import { renderReport } from "../src/report.ts";

const pkg = (name: string, license = "MIT", version = "1.0.0") => ({ name, version, license });

describe("renderReport", () => {
  const report = renderReport({
    service: [pkg("hono"), pkg("hono"), pkg("abc", "Apache-2.0")],
    production: [pkg("hono"), pkg("abc", "Apache-2.0"), pkg("express")],
    everything: [
      pkg("hono"),
      pkg("abc", "Apache-2.0"),
      pkg("express"),
      pkg("vitest"),
      pkg("type-fest", "(MIT OR CC0-1.0)"),
      pkg("lightningcss", "MPL-2.0"),
    ],
  });

  it("counts each closure once, service first", () => {
    expect(report).toContain("| Service (the container image) | 2 |");
    expect(report).toContain("| Other workspace tools (conformance runs, evaluation) | 1 |");
    expect(report).toContain("| Development only (build, lint, test) | 3 |");
    expect(report.indexOf("| abc | 1.0.0 | Apache-2.0 |")).toBeLessThan(
      report.indexOf("| hono | 1.0.0 | MIT |"),
    );
  });

  it("flags denied packages, installed development exceptions and compound licences", () => {
    expect(report).toMatch(/\| @openzeppelin\/relayer-sdk \| .* \| no \|/);
    expect(report).toContain("| lightningcss | MPL-2.0 |");
    expect(report).not.toContain("| lightningcss-linux-x64-gnu | MPL-2.0 |");
    expect(report).toContain("| type-fest@1.0.0 | (MIT OR CC0-1.0) |");
  });

  it("marks a denied package that is present", () => {
    expect(renderReport({ service: [], production: [], everything: [pkg("sharp", "Apache-2.0")] })).toMatch(
      /\| sharp \| .* \| \*\*yes\*\* \|/,
    );
  });
});
