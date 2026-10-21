import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../../src/shared/lab.ts";
import type { LabEvent, TxView } from "../../src/engine/events.ts";
import { projectCheck } from "../../src/projection/checks.ts";
import { projectProof, projectVerdict } from "../../src/projection/proof.ts";
import { projectRows } from "../../src/projection/rows.ts";
import { CONFIG } from "../fixtures/config.ts";
import { CHECK_RUNS, PAY_BELOW_CAP_RUN, PAY_MCP_LISTING_RUN, scenarioRun } from "../fixtures/runs.ts";

const context = { config: CONFIG, ours: true };
const proofOf = (events: readonly LabEvent[]) => projectProof(events, context);
const verdictOf = (events: readonly LabEvent[]) => projectVerdict(events, context);

describe("how a run ends", () => {
  it("has no proof or verdict until the run ends", () => {
    const partial = scenarioRun("pay", "normal").slice(0, 5);
    expect(proofOf(partial)).toBeUndefined();
    expect(verdictOf(partial)).toBeUndefined();
  });

  it("proves a payment from the chain: the amount, the fee payer and the transaction", () => {
    const proof = proofOf(scenarioRun("pay", "normal"));
    const [fee] = scenarioRun("pay", "normal").flatMap((event) =>
      event.kind === "chain" && event.phase === "tx" ? [event.view.feeBump?.feeCharged] : [],
    );
    expect(fee).toMatch(/^\d+$/);
    expect(proof).toMatchObject({ paid: "0.001", feeSponsored: true, facilitator: "Rail402" });
    expect(proof?.parties.map((party) => `${party.role}: ${party.did}`)).toContain(
      `Rail402: paid the network fee (${fee ?? ""} stroops)`,
    );
    expect(proof?.tx.url).toMatch(/^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/);
  });

  it("shows a refusal with its code and nothing moved", () => {
    expect(proofOf(PAY_BELOW_CAP_RUN)).toBeUndefined();
    expect(verdictOf(PAY_BELOW_CAP_RUN)).toMatchObject({
      tone: "refused",
      good: true,
      title: "Refused before signing",
      code: "payment_per_call_cap_exceeded",
      transactions: [],
      balance: "unchanged",
    });
  });

  it("reports usage against the cap, an overcharge, the agent's payment and a replay", () => {
    expect(proofOf(scenarioRun("upto", "normal"))).toMatchObject({ paid: "0.0021", untaken: "0.0079" });
    expect(verdictOf(scenarioRun("upto", "overcharge"))).toMatchObject({
      title: "The overcharge was refused",
      good: true,
      transactions: [],
    });
    expect(proofOf(scenarioRun("agent", "normal"))).toMatchObject({
      scheme: "exact",
      paid: "0.001",
      cap: "0.05",
    });
    expect(verdictOf(scenarioRun("pay", "replay"))).toMatchObject({
      tone: "info",
      good: true,
      title: "Paid once, the copy was refused",
    });
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
      // No proof, and the verdict does not call the reported transaction this payment's.
      expect(proofOf(events), name).toBeUndefined();
      const verdict = verdictOf(events);
      expect(verdict, name).toMatchObject({ good: false, title: "Sent, not proven on chain yet" });
      expect(
        verdict?.transactions.every((tx) => tx.label === "Reported transaction"),
        name,
      ).toBe(true);
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
    expect(proofOf(log)).toBeUndefined();
    expect(verdictOf(log)).toMatchObject({
      tone: "info",
      badge: "Not proven",
      code: "payment_settlement_unconfirmed",
    });
  });
});

describe("runs that pay twice", () => {
  it("counts the payer's money over the whole replay run", () => {
    expect(verdictOf(scenarioRun("pay", "replay"))).toMatchObject({ balance: "changed", delta: "-0.001" });
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
    expect(verdictOf(log)).toMatchObject({
      title: "Refused before signing",
      check: { id: "session-budget", passed: true },
      transactions: [{ hash: tx.hash, url: tx.explorerUrl, label: "Transaction" }],
    });
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
      ended(PAY_BELOW_CAP_RUN, { status: "refused", code: "payment_insufficient_funds" }),
      "pay",
      "replay",
    );
    expect(verdictOf(refused)).toMatchObject({ title: "The experiment did not run", good: false });
  });

  it("does not claim an overcharge was blocked when the run stopped for another reason", () => {
    const otherCode = ended(scenarioRun("upto", "overcharge"), { code: "payment_payer_trustline_missing" });
    expect(verdictOf(otherCode)).toMatchObject({
      title: "The experiment did not run",
      code: "payment_payer_trustline_missing",
    });
    const unpaid = asVariant(
      ended(PAY_BELOW_CAP_RUN, {
        status: "info",
        reason: "The seller answered without asking for payment.",
      }),
      "upto",
      "overcharge",
    ).map((event) => (event.kind === "run" && event.phase === "end" ? { ...event, code: undefined } : event));
    expect(verdictOf(unpaid as LabEvent[])?.title).toBe("The experiment did not run");
  });
});

describe("an MCP listing paid from the Bazaar", () => {
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
    expect(rows[0]?.label).toBe("tools/call air_quality");
    expect(rows.map((row) => row.label).join(" ")).not.toMatch(/405|GET \/mcp/);
    // The same projection, without the run saying what it pays: the exchanges say it.
    const unmarked = edited(payRun, (event) =>
      event.kind === "run" && event.phase === "start" ? { ...event, target: undefined } : event,
    );
    expect(projectRows(unmarked, rowContext).map((row) => row.step)).toEqual(rows.map((row) => row.step));
  });

  it("projects the recorded payment of an MCP listing from the Bazaar", () => {
    const rows = projectRows(PAY_MCP_LISTING_RUN, rowContext);
    expect(rows.map((row) => `${row.step} ${row.status} ${row.source}`)).toEqual([
      "request done you",
      "quote done seller",
      "sign done you",
      "paid-request done you",
      "work done seller",
      "settle done seller",
      "submit done chain",
      "deliver done you",
    ]);
    expect(rows[0]?.label).toBe("tools/call hourly_forecast");
    expect(field(rowOf(PAY_MCP_LISTING_RUN, "deliver"), "on chain")).toMatch(/^verified ✓/);
    expect(field(rowOf(PAY_MCP_LISTING_RUN, "deliver"), "body")).toContain("Izmir");
    const proof = proofOf(PAY_MCP_LISTING_RUN);
    expect(proof).toMatchObject({ paid: "0.0012" });
    expect(proof?.parties.slice(0, 2).map((party) => `${party.role}: ${party.did}`)).toEqual([
      "You: signed once, up to 0.01",
      "Seller: received 0.0012 USDC",
    ]);
  });

  it("links the proven settlement", () => {
    expect(proofOf(payRun)?.tx.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
