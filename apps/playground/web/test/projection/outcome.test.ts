import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../../src/shared/lab.ts";
import type { LabEvent, TxView } from "../../src/engine/events.ts";
import { lanesFor } from "../../src/projection/lanes.ts";
import { inspectorFor } from "../../src/projection/inspector.ts";
import { nextScenario, projectCheck, projectOutcome } from "../../src/projection/outcome.ts";
import { projectRows } from "../../src/projection/rows.ts";
import { CHECK_RUNS, PAY_MCP_LISTING_RUN, scenarioRun } from "../fixtures/runs.ts";

const context = {
  asset: { symbol: "USDC", decimals: 7 },
  sellerLabel: "Seller",
  facilitatorLabel: "Rail402",
};
const money = (lines: readonly { who: string; delta: string }[]): string[] =>
  lines.map((line) => `${line.who}: ${line.delta}`);

describe("outcome card", () => {
  it("is absent until the run ends", () => {
    expect(projectOutcome(scenarioRun("pay", "normal").slice(0, 5), context)).toBeUndefined();
  });

  it("reads money from the balance and the transaction's transfer", () => {
    const outcome = projectOutcome(scenarioRun("pay", "normal"), context);
    expect(outcome?.badge).toBe("Paid and delivered");
    expect(outcome?.headline).toBe("You paid 0.001 USDC for /weather?city=Ankara, and needed no XLM.");
    const [fee] = scenarioRun("pay", "normal").flatMap((event) =>
      event.kind === "chain" && event.phase === "tx" ? [event.view.feeBump?.feeCharged] : [],
    );
    expect(fee).toMatch(/^\d+$/);
    expect(money(outcome?.money ?? [])).toEqual([
      "You: − 0.001 USDC",
      "Seller: + 0.001 USDC",
      `Rail402: 0 USDC · paid ${fee ?? ""} stroops in fees`,
    ]);
    expect(outcome?.tx?.explorerUrl).toMatch(
      /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/,
    );
  });

  it("shows a refusal with its code and nothing moved", () => {
    const outcome = projectOutcome(scenarioRun("pay", "low-cap"), context);
    expect(outcome).toMatchObject({
      kind: "error",
      badge: "Refused safely",
      code: "payment_per_call_cap_exceeded",
      tx: null,
    });
    expect(money(outcome?.money ?? [])).toEqual(["You: 0 USDC", "Seller: 0 USDC"]);
  });

  it("reports usage, the unused cap, an overcharge, the agent's budget and the listing", () => {
    expect(money(projectOutcome(scenarioRun("upto", "normal"), context)?.money ?? [])).toContain(
      "Unused cap: 0.0079 USDC back in your budget",
    );
    expect(projectOutcome(scenarioRun("upto", "overcharge"), context)).toMatchObject({
      badge: "Overcharge blocked",
      headline: "The seller asked for more than you authorized. Nothing moved.",
    });
    const agent = money(projectOutcome(scenarioRun("agent", "normal"), context)?.money ?? []);
    expect(agent).toContain("Unused cap: 0.0088 USDC back in your budget");
    expect(agent.at(-1)).toMatch(/^Budget left: 0\.\d+ of 1 USDC$/);
    expect(projectOutcome(scenarioRun("pay", "replay"), context)).toMatchObject({
      kind: "info",
      badge: "Paid once",
    });
    expect(projectOutcome(scenarioRun("sell", "normal"), context)?.badge).toBe("Earned and listed");
  });

  it("cycles to the next scenario", () => {
    expect(nextScenario("pay")).toBe("upto");
    expect(nextScenario("sell")).toBe("pay");
  });
});

describe("refusal checks", () => {
  it("passes every check fixture: expected code, nothing signed, balance unchanged", () => {
    for (const check of CHECK_IDS) {
      const result = projectCheck(check, CHECK_RUNS[check], 7);
      expect(result, check).toMatchObject({ finished: true, passed: true, code: result.expected });
      if (check !== "session-budget")
        expect(result).toMatchObject({ signed: 0, balance: "unchanged", paid: [] });
      else expect(result).toMatchObject({ signed: 1, balance: "changed", delta: "-0.001" });
    }
  });

  it("fails a check that ended with another code", () => {
    const log = CHECK_RUNS.network.map((event) =>
      event.kind === "run" && event.phase === "end"
        ? { ...event, code: "payment_asset_not_permitted" }
        : event,
    );
    expect(projectCheck("network", log, 7).passed).toBe(false);
  });
});

describe("inspector", () => {
  const lanes = lanesFor("pay", { sellerHost: "demo.rail402.dev" });

  it("is idle without a row", () => {
    expect(inspectorFor(undefined, lanes, "pay")).toMatchObject({ route: "idle", tone: "idle", fields: [] });
  });

  it("names the route and takes the sending lane's colour, or the error colour", () => {
    const rows = projectRows(scenarioRun("pay", "normal"), { asset: context.asset });
    const quote = rows.find((row) => row.step === "quote");
    expect(inspectorFor(quote, lanes, "pay")).toMatchObject({ route: "Weather API → You", tone: "seller" });
    const sign = rows.find((row) => row.step === "sign");
    expect(inspectorFor(sign, lanes, "pay")).toMatchObject({
      route: "You",
      tone: "you",
      title: "Your wallet signs exactly this payment",
    });
    const refused = projectRows(scenarioRun("pay", "low-cap"), { asset: context.asset }).at(-1);
    expect(inspectorFor(refused, lanes, "pay").tone).toBe("error");
  });

  it("explains a seller row by whether the seller traced its facilitator calls", () => {
    const untraced = projectRows(scenarioRun("pay", "normal"), { asset: context.asset }).find(
      (row) => row.step === "settle",
    );
    expect(inspectorFor(untraced, lanes, "pay").note).toContain("does not report its facilitator calls");
    const traced = projectRows(scenarioRun("sell", "normal"), { asset: context.asset }).find(
      (row) => row.step === "settle",
    );
    expect(inspectorFor(traced, lanesFor("sell", { sellerHost: "x" }), "sell").note).toContain(
      "trace header",
    );
  });
});

/** A recorded run with some events changed: `edit` returns the replacement, or null to drop one. */
function edited(events: readonly LabEvent[], edit: (event: LabEvent) => LabEvent | null): LabEvent[] {
  return events.flatMap((event) => {
    const next = edit(event);
    return next === null ? [] : [next];
  });
}

const rowContext = { asset: { symbol: "USDC", decimals: 7 } };
const rowOf = (events: readonly LabEvent[], step: string) =>
  projectRows(events, rowContext).find((row) => row.step === step);
const field = (row: { fields: readonly { key: string; value: string }[] } | undefined, key: string) =>
  row?.fields.find((item) => item.key === key)?.value;

describe("settlement proof", () => {
  const normal = scenarioRun("pay", "normal");
  const withTx = (change: (tx: TxView) => TxView) =>
    edited(normal, (event) =>
      event.kind === "chain" && event.phase === "tx" ? { ...event, view: change(event.view) } : event,
    );

  it("never takes a reported transaction as this payment's settlement unless the chain binds it", () => {
    const unrelated: [string, LabEvent[]][] = [
      ["failed", withTx((tx) => ({ ...tx, status: "FAILED" }))],
      ["another nonce", withTx((tx) => ({ ...tx, nonces: ["42"] }))],
      ["no transfer", withTx((tx) => ({ ...tx, transfers: [] }))],
      [
        "another amount",
        withTx((tx) => ({ ...tx, transfers: tx.transfers.map((t) => ({ ...t, amount: "1" })) })),
      ],
    ];
    for (const [name, events] of unrelated) {
      const deliver = rowOf(events, "deliver");
      expect(field(deliver, "on chain"), name).toBe("seller-reported hash, not proven for this payment");
      expect(rowOf(events, "submit"), name).toMatchObject({ label: "Reported transaction", status: "error" });
      const outcome = projectOutcome(events, context);
      expect(outcome?.tx, name).toBeNull();
      expect(money(outcome?.money ?? []), name).not.toContain(expect.stringMatching(/stroops/) as string);
      expect(
        money(outcome?.money ?? []).find((line) => line.startsWith("Seller")),
        name,
      ).toBe("Seller: 0 USDC");
    }
  });

  it("takes the SDK's word when it could not prove the settlement, and says the hold stays", () => {
    // The recorded run's delivery, with the SDK's receipt saying the chain did not prove it.
    const log = edited(normal, (event) => {
      if (event.kind === "run" && event.phase === "end") {
        return { ...event, status: "info", code: "payment_settlement_unconfirmed", reason: "not proven" };
      }
      if (event.kind === "delivery" && event.view.receipt !== null) {
        return {
          ...event,
          view: { ...event.view, receipt: { ...event.view.receipt, verifiedOnChain: false } },
        };
      }
      return event;
    });
    expect(log.some((event) => event.kind === "delivery")).toBe(true);
    expect(field(rowOf(log, "deliver"), "on chain")).toBe(
      "seller-reported hash, not proven for this payment",
    );
    expect(field(rowOf(log, "deliver"), "body")).toContain('"city":"Ankara"');
    expect(projectOutcome(log, context)).toMatchObject({
      kind: "info",
      badge: "Outcome unknown",
      code: "payment_settlement_unconfirmed",
      tx: null,
    });
  });
});

describe("runs that pay twice", () => {
  it("counts the payer's money over the whole replay run", () => {
    const outcome = projectOutcome(scenarioRun("pay", "replay"), context);
    expect(money(outcome?.money ?? []).slice(0, 2)).toEqual(["You: − 0.001 USDC", "Seller: + 0.001 USDC"]);
  });

  it("shows the balance around the resend on the charged-once row, and fails it when it moved", () => {
    const replay = scenarioRun("pay", "replay");
    const row = rowOf(replay, "charged-once");
    expect(row).toMatchObject({ label: "Charged once", status: "done" });
    expect(field(row, "your balance around the resend")).toMatch(/^0\.998 → 0\.998 USDC/);
    let seen = 0;
    const moved = edited(replay, (event) =>
      event.kind === "chain" && event.phase === "balance" && event.role === "payer" && ++seen === 2
        ? { ...event, after: "0.997" }
        : event,
    );
    expect(rowOf(moved, "charged-once")).toMatchObject({ label: "Charged again", status: "error" });
    // While the resend is in flight, the first payment's read is not shown as the resend's.
    const inFlight = replay.slice(
      0,
      replay.findIndex(
        (event) => event.kind === "http" && event.phase === "response" && event.id.endsWith("3"),
      ),
    );
    expect(field(rowOf(inFlight, "charged-once"), "your balance around the resend")).toBeUndefined();
  });

  it("reports the session check's first payment and draws its refusal after it", () => {
    const log = CHECK_RUNS["session-budget"];
    const result = projectCheck("session-budget", log, 7);
    expect(result).toMatchObject({ passed: true, signed: 1, balance: "changed", delta: "-0.001" });
    // The check row links the first payment's transaction.
    const [tx] = log.flatMap((event) => (event.kind === "chain" && event.phase === "tx" ? [event.view] : []));
    if (tx === undefined) throw new Error("the recorded check read no transaction");
    expect(result.paid).toEqual([{ hash: tx.hash, explorerUrl: tx.explorerUrl }]);
    expect(projectOutcome(log, context)?.headline).toBe(
      "The first payment of 0.001 USDC fit the room left in your session budget; the second was refused before signing.",
    );
    const steps = projectRows(log, rowContext).map((row) => row.step);
    expect(steps.indexOf("refused")).toBeGreaterThan(steps.indexOf("deliver"));
    expect(steps.indexOf("sign")).toBeLessThan(steps.indexOf("deliver"));
  });
});

describe("the private-address check", () => {
  it("shows each target's own refusal", () => {
    const requests = projectRows(CHECK_RUNS["private-address"], rowContext).filter(
      (row) => row.step === "request",
    );
    expect(requests.map((row) => `${row.label} ${row.sub}`)).toEqual([
      // Recorded in local mode, where loopback is allowed: refused only at connect, and not counted.
      "GET / refused: egress_connection_failed",
      "GET / refused: egress_destination_not_allowed",
    ]);
    expect(requests.map((row) => field(row, "url"))).toEqual([
      "https://127.0.0.1/",
      "https://169.254.169.254/",
    ]);
  });
});

describe("experiments that did not run", () => {
  const ended = (
    events: readonly LabEvent[],
    end: Partial<Extract<LabEvent, { kind: "run"; phase: "end" }>>,
  ) =>
    edited(events, (event) => (event.kind === "run" && event.phase === "end" ? { ...event, ...end } : event));
  const asVariant = (
    events: readonly LabEvent[],
    scenario: "pay" | "upto",
    variant: "replay" | "overcharge",
  ) =>
    edited(events, (event) =>
      event.kind === "run" && event.phase === "start" ? { ...event, scenario, variant } : event,
    );

  it("does not claim a replay result when the first payment was refused", () => {
    const refused = asVariant(
      ended(scenarioRun("pay", "low-cap"), { status: "refused", code: "payment_insufficient_funds" }),
      "pay",
      "replay",
    );
    expect(projectOutcome(refused, context)?.badge).toBe("The experiment did not run");
  });

  it("does not claim an overcharge was blocked when the run stopped for another reason", () => {
    const otherCode = ended(scenarioRun("upto", "overcharge"), { code: "payment_payer_trustline_missing" });
    expect(projectOutcome(otherCode, context)).toMatchObject({
      badge: "The experiment did not run",
      code: "payment_payer_trustline_missing",
    });
    const unpaid = asVariant(
      ended(scenarioRun("pay", "low-cap"), {
        status: "info",
        reason: "The seller answered without asking for payment.",
      }),
      "upto",
      "overcharge",
    ).map((event) => (event.kind === "run" && event.phase === "end" ? { ...event, code: undefined } : event));
    expect(projectOutcome(unpaid as LabEvent[], context)?.badge).toBe("The experiment did not run");
  });

  it("says the Bazaar refused a listing instead of suggesting to wait", () => {
    const sell = edited(scenarioRun("sell", "normal"), (event) => {
      if (event.kind === "http" && event.phase === "response" && event.trace?.bazaar !== undefined) {
        return {
          ...event,
          trace: {
            ...event.trace,
            bazaar: {
              status: "rejected",
              code: "bazaar_resource_unsafe",
              reason: "The resource is a loopback URL.",
            },
          },
        };
      }
      if (event.kind === "run" && event.phase === "end") {
        return { ...event, status: "refused", code: "bazaar_resource_unsafe", reason: "Paid, but refused." };
      }
      return event.kind === "bazaar" ? null : event;
    });
    expect(projectOutcome(sell, context)).toMatchObject({
      badge: "Earned, listing refused",
      code: "bazaar_resource_unsafe",
    });
    expect(projectOutcome(sell, context)?.headline).toContain("the Bazaar refused to list this route");
  });
});

describe("an MCP listing paid from the Pay page", () => {
  const agent = scenarioRun("agent", "normal");
  const payRun = edited(agent, (event) => {
    if (event.kind === "run" && event.phase === "start")
      return { ...event, scenario: "pay", variant: "normal", target: "mcp" };
    return event.kind === "tool" || event.kind === "bazaar" ? null : event;
  });

  it("draws the tool calls, not the transport's stream probe", () => {
    const rows = projectRows(payRun, rowContext);
    expect(rows.map((row) => `${row.step} ${row.status}`)).toEqual([
      "request done",
      "quote done",
      "sign done",
      "paid-request done",
      "settle done",
      "submit done",
      "deliver done",
    ]);
    expect(rows[0]?.label).toBe("tools/call hourly_forecast");
    expect(rows.map((row) => row.label).join(" ")).not.toMatch(/405|GET \/mcp/);
    // The same projection, without the run saying what it pays: the exchanges say it.
    const unmarked = edited(payRun, (event) =>
      event.kind === "run" && event.phase === "start" ? { ...event, target: undefined } : event,
    );
    expect(projectRows(unmarked, rowContext).map((row) => row.step)).toEqual(rows.map((row) => row.step));
  });

  it("projects the recorded payment of an MCP listing from the Pay page", () => {
    const rows = projectRows(PAY_MCP_LISTING_RUN, rowContext);
    expect(rows.map((row) => `${row.step} ${row.status} ${row.source}`)).toEqual([
      "request done you",
      "quote done seller",
      "sign done you",
      "paid-request done you",
      "settle done seller",
      "submit done chain",
      "deliver done you",
    ]);
    expect(rows[0]?.label).toBe("tools/call hourly_forecast");
    expect(field(rowOf(PAY_MCP_LISTING_RUN, "deliver"), "on chain")).toMatch(/^verified ✓/);
    expect(field(rowOf(PAY_MCP_LISTING_RUN, "deliver"), "body")).toContain("Izmir");
    const outcome = projectOutcome(PAY_MCP_LISTING_RUN, context);
    expect(outcome).toMatchObject({ kind: "ok", badge: "Paid and delivered" });
    expect(outcome?.headline).toMatch(/for hourly_forecast/);
    expect(money(outcome?.money ?? []).slice(0, 2)).toEqual(["You: − 0.0012 USDC", "Seller: + 0.0012 USDC"]);
  });

  it("names the tool in the outcome and links the proven settlement", () => {
    const outcome = projectOutcome(payRun, context);
    expect(outcome?.badge).toBe("Paid and delivered");
    expect(outcome?.headline).toMatch(/^You paid 0\.0012 USDC for hourly_forecast/);
    expect(outcome?.tx).not.toBeNull();
  });
});
