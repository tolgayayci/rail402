import { describe, expect, it } from "vitest";
import { checkEvidence } from "../src/evidence.ts";
import {
  CaseRecorder,
  buildEvidence,
  explorerUrl,
  jsonSafe,
  modeOf,
  supportedSigners,
} from "../src/harness.ts";

describe("CaseRecorder", () => {
  it("records passed, failed and skipped cases with what they observed", async () => {
    const recorder = new CaseRecorder();
    await recorder.run({ id: "ok", title: "passes", checks: ["supported"], payer: "G" }, async (context) => {
      context.rejection({
        surface: "http",
        operation: "POST /verify",
        httpStatus: 415,
        code: "unsupported_media_type",
        reason: "JSON only.",
      });
      context.observe("amount", 5n);
      await Promise.resolve();
    });
    await recorder.run({ id: "broken", title: "throws", checks: ["scheme-exact"] }, () =>
      Promise.reject(new Error("boom")),
    );
    recorder.skip({ id: "later", title: "not here", checks: ["mcp"] }, "no MCP server was given");

    expect(recorder.failed).toBe(1);
    expect(recorder.cases.map((entry) => [entry.id, entry.status])).toEqual([
      ["ok", "passed"],
      ["broken", "failed"],
      ["later", "skipped"],
    ]);
    expect(recorder.cases[0]).toMatchObject({
      payer: "G",
      observations: { amount: "5" },
      rejections: [{ code: "unsupported_media_type" }],
    });
    expect(recorder.cases[1]?.observations).toEqual({ error: "boom" });
    expect(recorder.cases[2]?.skipReason).toBe("no MCP server was given");
  });

  it("runs only the selected cases", async () => {
    const recorder = new CaseRecorder(["b"]);
    let ran = "";
    for (const id of ["a", "b"]) {
      await recorder.run({ id, title: id, checks: ["supported"] }, () => {
        ran += id;
        return Promise.resolve();
      });
    }
    recorder.skip({ id: "c", title: "c", checks: ["supported"] }, "unselected");
    expect(ran).toBe("b");
    expect(recorder.cases.map((entry) => entry.id)).toEqual(["b"]);
  });
});

describe("buildEvidence", () => {
  it("builds a document the writer rules accept, with the summary counted from the cases", async () => {
    const recorder = new CaseRecorder();
    await recorder.run({ id: "one", title: "one", checks: ["rejection-codes"] }, () => Promise.resolve());
    recorder.skip({ id: "two", title: "two", checks: ["rejection-codes"] }, "why not");
    const evidence = buildEvidence(
      {
        kind: "rejection-audit",
        provenance: { commit: "f".repeat(40), dirty: false, branch: "rehearsal" },
        network: "stellar:testnet",
        target: {
          mode: "local",
          facilitatorUrl: "http://127.0.0.1:8080",
          healthVersion: "dev",
          supported: {},
        },
        packages: {},
        command: "node tools/conformance/src/rejection-audit.ts",
        config: {},
        accounts: {},
        startedAt: recorder.startedAt,
      },
      recorder.cases,
    );
    expect(evidence.summary).toEqual({ total: 2, passed: 1, failed: 0, skipped: 1 });
    expect(evidence.harness).toEqual({ commit: "f".repeat(40), dirty: false, branch: "rehearsal" });
    expect(checkEvidence(evidence).problems).toEqual([]);
  });
});

describe("helpers", () => {
  it("tells local from hosted targets and reads signers and explorer links", () => {
    expect(modeOf("http://127.0.0.1:8080")).toBe("local");
    expect(modeOf("http://localhost:1")).toBe("local");
    expect(modeOf("https://testnet.rail402.dev")).toBe("hosted");
    expect(supportedSigners({ signers: { "stellar:*": ["GA", 3, "GB"] } })).toEqual(["GA", "GB"]);
    expect(supportedSigners(undefined)).toEqual([]);
    expect(explorerUrl("ab")).toBe("https://stellar.expert/explorer/testnet/tx/ab");
    expect(explorerUrl("ab", "stellar:pubnet")).toBe("https://stellar.expert/explorer/public/tx/ab");
    expect(jsonSafe({ a: 1n, b: undefined, c: [2n] })).toEqual({ a: "1", c: ["2"] });
  });
});
