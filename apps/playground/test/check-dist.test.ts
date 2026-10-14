import { describe, expect, it } from "vitest";
import { BUDGET_BYTES, inspectDist } from "../scripts/check-dist.ts";

const clean = {
  path: "assets/engine.js",
  text: 'const os=globalThis.process?.getBuiltinModule?.("node:os");export const a={node:1};',
};

describe("built page check", () => {
  it("passes a page with only lazily probed built-ins, within the budget", () => {
    const report = inspectDist([clean, { path: "assets/index.css", text: "body{margin:0}" }]);
    expect(report.problems).toEqual([]);
    expect(report.totalBytes).toBe(Buffer.byteLength(clean.text) + 14);
    expect(report.files.map((file) => file.path)).toEqual(["assets/engine.js", "assets/index.css"]);
  });

  it("refuses a Node built-in import and Vite's empty browser stub", () => {
    const report = inspectDist([
      { path: "a.js", text: 'import{readFileSync}from"node:fs";' },
      { path: "b.js", text: "export default {};//__vite-browser-external" },
    ]);
    expect(report.problems).toEqual([
      "a.js: imports the Node built-in node:fs",
      "b.js: a Node built-in was replaced by an empty browser stub",
    ]);
  });

  it("refuses the fake engine", () => {
    const report = inspectDist([{ path: "a.js", text: 'q.get("fake-wallet")' }]);
    expect(report.problems).toEqual(['a.js: contains the fake engine ("fake-wallet")']);
  });

  it("refuses a page over its budget", () => {
    expect(inspectDist([clean], 10).problems).toEqual([
      `the page is ${String(Buffer.byteLength(clean.text))} bytes, over its budget of 10`,
    ]);
    expect(BUDGET_BYTES).toBeGreaterThan(1_000_000);
  });
});
