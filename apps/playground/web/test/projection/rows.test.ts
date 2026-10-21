import { describe, expect, it } from "vitest";
import { projectRows, STEP_ORDER, type Row } from "../../src/projection/rows.ts";
import { SCENARIO_EXPERIMENTS, SCENARIO_IDS, STEP_IDS } from "../../../src/shared/lab.ts";
import {
  CHECK_RUNS,
  PAY_BELOW_CAP_RUN,
  PAY_MCP_LISTING_RUN,
  SCENARIO_RUNS,
  scenarioRun,
} from "../fixtures/runs.ts";

const context = { asset: { symbol: "USDC", decimals: 7 } };

/** Step, lanes, status and source of each row: the shape the swimlane draws. */
function shape(rows: readonly Row[]): string[] {
  return rows.map((row) => {
    const lane =
      "self" in row.lane
        ? `self ${String(row.lane.self)}`
        : `${String(row.lane.from)}→${String(row.lane.to)}`;
    return `${row.step} ${lane} ${row.status} ${row.source}`;
  });
}

function rowsOf(key: string): readonly Row[] {
  const log = SCENARIO_RUNS[key];
  if (log === undefined) throw new Error(`no fixture ${key}`);
  return projectRows(log, context);
}

describe("swimlane rows", () => {
  it("has a fixture for every scenario and experiment the lab offers", () => {
    for (const scenario of SCENARIO_IDS)
      for (const experiment of SCENARIO_EXPERIMENTS[scenario])
        expect(scenarioRun(scenario, experiment).length).toBeGreaterThan(0);
  });

  it("orders every step id", () => {
    expect([...STEP_ORDER].sort()).toEqual([...STEP_IDS].sort());
  });

  it("projects an exact payment", () => {
    expect(shape(rowsOf("pay:normal"))).toEqual([
      "request 0→1 done you",
      "quote 1→0 done seller",
      "sign self 0 done you",
      "paid-request 0→1 done you",
      "settle 1→2 done seller",
      "submit 2→3 done chain",
      "deliver 1→0 done you",
    ]);
    const rows = rowsOf("pay:normal");
    expect(rows.find((row) => row.step === "quote")?.sub).toBe("PAYMENT-REQUIRED: 0.001 USDC");
    expect(rows.find((row) => row.step === "sign")?.fields).toContainEqual({
      key: "cap check",
      value: "0.001 ≤ 0.01 ✓",
      source: "you",
    });
  });

  it("labels a seller row without a trace by what its response and the chain prove", () => {
    const settle = rowsOf("pay:normal").find((row) => row.step === "settle");
    expect(settle?.sub).toBe("reported in PAYMENT-RESPONSE, proven on chain");
    expect(settle?.fields.find((field) => field.key === "fee source")?.source).toBe("chain");
  });

  it("refuses a cap below the price before anything is signed", () => {
    expect(shape(projectRows(PAY_BELOW_CAP_RUN, context))).toEqual([
      "request 0→1 done you",
      "quote 1→0 done seller",
      "refused self 0 error you",
    ]);
    const refused = projectRows(PAY_BELOW_CAP_RUN, context).find((row) => row.step === "refused");
    expect(refused?.label).toBe("Refused before signing");
    expect(refused?.fields).toContainEqual({ key: "signed", value: "nothing", source: "you" });
    expect(refused?.fields).toContainEqual({ key: "your cap", value: "0.0001", source: "you" });
  });

  it("shows a resent payment refused and charged once", () => {
    expect(shape(rowsOf("pay:replay")).slice(7)).toEqual([
      "resend 0→1 done you",
      "replay-refused 1→0 error seller",
      "charged-once self 0 done chain",
    ]);
    const rows = rowsOf("pay:replay");
    expect(rows.find((row) => row.step === "replay-refused")?.sub).toBe(
      "invalid_exact_stellar_payload_nonce_already_used",
    );
    expect(rows.find((row) => row.step === "charged-once")?.label).toBe("Charged once");
  });

  it("projects an upto payment with the work and the settled usage", () => {
    expect(shape(rowsOf("upto:normal"))).toEqual([
      "request 0→1 done you",
      "quote 1→0 done seller",
      "sign self 0 done you",
      "paid-request 0→1 done you",
      "work self 1 done seller",
      "settle 1→2 done seller",
      "submit 2→3 done chain",
      "deliver 1→0 done you",
    ]);
    const rows = rowsOf("upto:normal");
    expect(rows.find((row) => row.step === "settle")?.label).toBe("/settle 0.0021 USDC");
    expect(rows.find((row) => row.step === "deliver")?.fields).toContainEqual({
      key: "released",
      value: "0.0079 USDC back in your budget",
      source: "you",
    });
  });

  it("shows an overcharge refused at /settle, with no transaction", () => {
    expect(shape(rowsOf("upto:overcharge"))).toEqual([
      "request 0→1 done you",
      "quote 1→0 done seller",
      "sign self 0 done you",
      "paid-request 0→1 done you",
      "work self 1 done seller",
      "settle 1→2 error seller",
      "overcharge-refused self 2 error seller",
      "deliver 1→0 error seller",
    ]);
    const rows = rowsOf("upto:overcharge");
    expect(rows.find((row) => row.step === "settle")?.label).toBe("/settle 0.02 USDC");
    expect(rows.find((row) => row.step === "settle")?.sub).toBe("more than you authorized");
    expect(rows.find((row) => row.step === "overcharge-refused")?.fields).toContainEqual({
      key: "moved",
      value: "nothing: no transaction",
      source: "chain",
    });
    expect(rows.find((row) => row.step === "deliver")?.fields).toContainEqual({
      key: "upstream code",
      value: "invalid_upto_stellar_payload_settlement_exceeds_amount",
      source: "seller",
    });
  });

  it("projects the agent's tool calls", () => {
    expect(shape(rowsOf("agent:normal"))).toEqual([
      "search 0→1 done you",
      "results 1→0 done bazaar",
      "pick self 0 done you",
      "budget self 0 done you",
      "call-tool 0→2 done you",
      "tool-settle 2→3 done chain",
      "tool-result 2→0 done you",
    ]);
    const callTool = rowsOf("agent:normal").find((row) => row.step === "call-tool");
    expect(callTool?.fields.map((field) => field.key)).toEqual([
      "tool",
      "arguments",
      "spending cap",
      "1. tools/call",
      "2. signature",
      "3. tools/call",
    ]);
  });

  it("orders rows by causal step, not arrival, and marks open requests live", () => {
    const log = scenarioRun("pay", "normal");
    // Deliver the chain read after everything else: its row is still drawn before the 200.
    const late = log.filter((event) => event.kind === "chain" && event.phase === "tx");
    const rest = log.filter((event) => !(event.kind === "chain" && event.phase === "tx"));
    const rows = projectRows([...rest, ...late], context);
    expect(rows.map((row) => row.step).slice(-2)).toEqual(["submit", "deliver"]);

    const sent = log.findIndex((event) => event.kind === "http") + 1;
    const firstOnly = projectRows(log.slice(0, sent), context);
    expect(shape(firstOnly)).toEqual(["request 0→1 live you"]);
    const ended = projectRows(
      [
        ...log.slice(0, sent),
        {
          runId: "run-pay",
          at: 900,
          kind: "run",
          phase: "end",
          status: "error",
          code: "playground_run_aborted",
          reason: "stopped",
        },
      ],
      context,
    );
    expect(shape(ended)).toEqual(["request 0→1 pending you"]);
  });

  it("shows a relay refusal on each request it stopped", () => {
    const rows = projectRows(CHECK_RUNS["private-address"], context);
    expect(shape(rows)).toEqual(["request 0→1 error you", "request 0→1 error you"]);
    // Recorded in local mode, where loopback is allowed and nothing listens: refused at connect.
    expect(rows.map((row) => row.sub)).toEqual([
      "refused: egress_connection_failed",
      "refused: egress_destination_not_allowed",
    ]);
  });

  it("has no rows for a run without a start, such as wallet setup", () => {
    expect(projectRows([{ runId: "w", at: 0, kind: "wallet", step: "created" }], context)).toEqual([]);
  });

  it("projects recorded runs, which hold no seed and no payment material", () => {
    for (const log of [
      ...Object.values(SCENARIO_RUNS),
      ...Object.values(CHECK_RUNS),
      PAY_MCP_LISTING_RUN,
      PAY_BELOW_CAP_RUN,
    ]) {
      expect(log[0]).toMatchObject({ kind: "run", phase: "start" });
      expect(log.at(-1)).toMatchObject({ kind: "run", phase: "end" });
      const text = JSON.stringify(log);
      expect(text).not.toMatch(/S[A-Z2-7]{55}/);
      expect(text).not.toMatch(/[A-Za-z0-9+/]{160,}/);
    }
  });

  it("never puts payment material in a row", () => {
    for (const log of [
      ...Object.values(SCENARIO_RUNS),
      ...Object.values(CHECK_RUNS),
      PAY_MCP_LISTING_RUN,
      PAY_BELOW_CAP_RUN,
    ]) {
      for (const row of projectRows(log, context)) {
        for (const field of row.fields) expect(field.value).not.toMatch(/^[A-Za-z0-9+/]{120,}={0,2}$/);
      }
    }
  });
});
