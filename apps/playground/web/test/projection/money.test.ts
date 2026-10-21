/**
 * What the page says about money, against what the events prove: payments that left before a call
 * failed, settlements proven only after the run, amounts the seller claimed, events of other
 * payments, held caps released later, and the refusal checks' proof that nothing moved.
 */
import { describe, expect, it } from "vitest";
import type { LabEvent, SdkPaymentEvent } from "../../src/engine/events.ts";
import { collectFacts, flowKindOf, paidAmount } from "../../src/projection/facts.ts";
import { projectCheck } from "../../src/projection/checks.ts";
import { projectProof, projectVerdict } from "../../src/projection/proof.ts";
import { projectRows, type Row } from "../../src/projection/rows.ts";
import { projectStage } from "../../src/projection/stage.ts";
import { CONFIG } from "../fixtures/config.ts";
import { CHECK_RUNS, PAY_MCP_LISTING_RUN, scenarioRun } from "../fixtures/runs.ts";

const context = { config: CONFIG, ours: true };
const rowContext = { asset: { symbol: "USDC", decimals: 7 } };
const proofOf = (log: readonly LabEvent[]) => projectProof(log, context);
const verdictOf = (log: readonly LabEvent[]) => projectVerdict(log, context);
const stepOf = (log: readonly LabEvent[], kind: string) =>
  projectStage(log, { mode: "exact", plan: "normal", config: CONFIG }).steps.find(
    (step) => step.kind === kind,
  );
const rowOf = (log: readonly LabEvent[], step: string): Row | undefined =>
  projectRows(log, rowContext).find((row) => row.step === step);
const field = (row: Row | undefined, key: string): string | undefined =>
  row?.fields.find((item) => item.key === key)?.value;

/** The run's own call id (from its probe). */
function callIdOf(log: readonly LabEvent[]): string {
  for (const event of log)
    if (event.kind === "sdk" && event.event.type === "probe") return event.event.callId;
  throw new Error("no probe");
}

/** The log with its end replaced, and events added before or after it. */
function rewrite(
  log: readonly LabEvent[],
  options: {
    readonly end?: Partial<Extract<LabEvent, { kind: "run"; phase: "end" }>>;
    readonly map?: (event: LabEvent) => LabEvent | null;
    readonly before?: readonly LabEvent[];
    readonly after?: readonly LabEvent[];
  },
): LabEvent[] {
  const out: LabEvent[] = [];
  for (const event of log) {
    if (event.kind === "run" && event.phase === "end") {
      out.push(...(options.before ?? []), { ...event, ...options.end }, ...(options.after ?? []));
      continue;
    }
    const mapped = options.map === undefined ? event : options.map(event);
    if (mapped !== null) out.push(mapped);
  }
  return out;
}

const sdk = (log: readonly LabEvent[], event: SdkPaymentEvent): LabEvent => ({
  runId: log[0]?.runId ?? "run",
  at: 9_999,
  kind: "sdk",
  event,
});

const unverified = (event: LabEvent): LabEvent =>
  event.kind === "delivery" && event.view.receipt !== null
    ? { ...event, view: { ...event.view, receipt: { ...event.view.receipt, verifiedOnChain: false } } }
    : event;

describe("a paid call that did not end ok", () => {
  it("says the payment settled when the resource failed after it", () => {
    const log = rewrite(scenarioRun("pay", "normal"), {
      end: { status: "error", code: "payment_resource_failed", reason: "The resource answered 500." },
      before: [
        {
          runId: "r",
          at: 1,
          kind: "refusal",
          layer: "seller",
          code: "payment_resource_failed",
          reason: "The resource answered 500.",
          details: { paid: "settled" },
        },
      ],
    });
    const verdict = verdictOf(log);
    expect(verdict).toMatchObject({ title: "Paid, but the call failed", good: false });
    // The settlement is still proven and linked as this payment's.
    expect(verdict?.transactions).toEqual([expect.objectContaining({ label: "Transaction" })]);
  });

  it("says the outcome is unknown when a payment was sent and not proven", () => {
    const log = rewrite(scenarioRun("pay", "normal"), {
      map: unverified,
      end: { status: "error", code: "payment_settlement_unconfirmed", reason: "The relay was lost." },
    });
    expect(proofOf(log)).toBeUndefined();
    expect(verdictOf(log)).toMatchObject({ title: "Sent, not proven on chain yet", badge: "Not proven" });
  });

  it("reads as paid once a reconciliation proves the payment after the run", () => {
    const base = scenarioRun("pay", "normal");
    const tx = collectFacts(base).txs[0];
    if (tx === undefined) throw new Error("no transaction");
    const notYet = rewrite(base, {
      map: unverified,
      end: { status: "info", code: "payment_settlement_unconfirmed", reason: "not proven" },
    });
    expect(proofOf(notYet)).toBeUndefined();
    const later = rewrite(base, {
      map: unverified,
      end: { status: "info", code: "payment_settlement_unconfirmed", reason: "not proven" },
      after: [
        sdk(base, {
          type: "settled",
          callId: callIdOf(base),
          reservation: "res",
          transaction: tx.hash,
          amount: "10000",
        }),
      ],
    });
    expect(proofOf(later)).toMatchObject({ paid: "0.001", tx: { hash: tx.hash } });
  });
});

describe("events of other payments", () => {
  it("are not this run's: a release or settlement of a call the run never opened is ignored", () => {
    const base = scenarioRun("pay", "normal");
    const stray = rewrite(base, {
      before: [
        sdk(base, {
          type: "released",
          callId: "another-call",
          reservation: "old",
          reason: "settled_below_cap",
          amount: "95000",
        }),
        sdk(base, {
          type: "settled",
          callId: "another-call",
          reservation: "old",
          transaction: null,
          amount: "60000",
        }),
      ],
    });
    expect(proofOf(stray)).toEqual(proofOf(base));
    expect(collectFacts(stray).sdk).toHaveLength(collectFacts(base).sdk.length);
  });
});

describe("amounts", () => {
  it("shows what the chain proves an upto settlement moved, not what the seller claimed", () => {
    const base = scenarioRun("upto", "normal");
    const proven = paidAmount(collectFacts(base));
    expect(proven?.proven).toBe(true);
    const claimed = rewrite(base, {
      map: (event) =>
        event.kind === "sdk" && event.event.type === "settled"
          ? { ...event, event: { ...event.event, amount: "1" } }
          : event,
    });
    expect(paidAmount(collectFacts(claimed))).toEqual(proven);
    expect(proofOf(claimed)?.paid).toBe("0.0021");
    expect(field(rowOf(claimed, "settle"), "proven amount")).toBeDefined();
  });

  it("flags a settlement the seller reported differently from the chain", () => {
    const base = scenarioRun("upto", "normal");
    const reported = rewrite(base, {
      map: (event) =>
        event.kind === "http" && event.phase === "response" && event.settle !== undefined
          ? { ...event, settle: { ...event.settle, amount: "1" } }
          : event,
    });
    const settle = rowOf(reported, "settle");
    expect(field(settle, "reported amount")).toBe("0.0000001 USDC");
    expect(field(settle, "proven amount")).toBe("0.0021 USDC");
    expect(field(settle, "mismatch")).toBe("the seller reported 0.0000001 USDC, the chain shows 0.0021 USDC");
    expect(settle?.label).toBe("/settle 0.0021 USDC");
  });
});

describe("rows that describe what was sent", () => {
  it("names an upto payload as authorizations and an exact one as a transaction", () => {
    expect(rowOf(scenarioRun("upto", "normal"), "paid-request")?.sub).toBe(
      "payload: { authorization, signerAuthorizations }",
    );
    expect(rowOf(scenarioRun("pay", "normal"), "paid-request")?.sub).toBe("payload: { transaction }");
  });

  it("says upto_settled only when that event was read", () => {
    const base = scenarioRun("upto", "normal");
    expect(rowOf(base, "submit")?.sub).toContain("emits upto_settled");
    const without = rewrite(base, {
      map: (event) =>
        event.kind === "chain" && event.phase === "tx"
          ? { ...event, view: { ...event.view, uptoSettled: null } }
          : event,
    });
    expect(rowOf(without, "submit")?.sub ?? "").not.toContain("emits upto_settled");
  });

  it("reads the MCP payment's price and terms from the tool call's error", () => {
    const quote = rowOf(PAY_MCP_LISTING_RUN, "quote");
    expect(quote?.sub).toMatch(/^tools\/call error with the price: (up to )?\d/);
    expect(field(quote, "scheme")).toBeDefined();
    expect(field(quote, "payTo")).toBeDefined();
    const flow = flowKindOf(collectFacts(PAY_MCP_LISTING_RUN));
    expect(flow.mcp).toBe(true);
    const paid = stepOf(PAY_MCP_LISTING_RUN, "paid");
    expect(paid?.chip).toBe("retry + payment");
    expect(paid?.explain).toContain('_meta["x402/payment"]');
    expect(paid?.facts[0]).toEqual({ label: "Carries", value: '_meta["x402/payment"]', mono: true });
    expect(stepOf(PAY_MCP_LISTING_RUN, "quote")?.explain).toMatch(
      /^It answers with a payment-required error/,
    );
    expect(stepOf(PAY_MCP_LISTING_RUN, "request")?.chip).toBe("tools/call hourly_forecast");
  });

  it("explains a refused settlement and an unproven transaction as what they are", () => {
    const overcharge = scenarioRun("upto", "overcharge");
    expect(stepOf(overcharge, "settle")).toMatchObject({
      title: "Rail402 refuses to settle",
      state: "error",
    });
    const unproven = rewrite(scenarioRun("pay", "normal"), { map: unverified });
    expect(rowOf(unproven, "submit")?.label).toBe("Reported transaction");
    expect(stepOf(unproven, "submit")).toMatchObject({
      title: "The reported transaction is not this payment",
      state: "error",
    });
  });

  it("calls the replay check what it read, not a chain-wide count", () => {
    const charged = rowOf(scenarioRun("pay", "replay"), "charged-once");
    expect(field(charged, "transactions read")).toContain("Soroban accepts a nonce once");
  });
});

describe("the facilitator's name", () => {
  it("is Rail402 only when /supported advertises the fee payer", () => {
    const base = scenarioRun("pay", "normal");
    expect(proofOf(base)?.facilitator).toBe("Rail402");
    const notAdvertised = rewrite(base, {
      map: (event) =>
        event.kind === "chain" && event.phase === "tx"
          ? { ...event, view: { ...event.view, feeSourceAdvertised: false } }
          : event,
    });
    expect(proofOf(notAdvertised)?.facilitator).toBe("Facilitator");
    expect(proofOf(notAdvertised)?.parties.map((party) => party.role)).toContain("Facilitator");
    expect(
      projectStage(notAdvertised, { mode: "exact", plan: "normal", config: CONFIG }).lanes[2]?.label,
    ).toBe("Facilitator");
  });
});

describe("a held cap released later", () => {
  it("replaces the hold with what came back on the row", () => {
    const base = scenarioRun("upto", "overcharge");
    const released = rewrite(base, {
      after: [
        sdk(base, {
          type: "released",
          callId: callIdOf(base),
          reservation: "res",
          reason: "expired_unused",
          amount: "100000",
        }),
      ],
    });
    expect(field(rowOf(base, "deliver"), "hold")).toContain("kept until the authorization expires");
    expect(field(rowOf(released, "deliver"), "hold")).toContain("0.01 USDC back in your budget");
  });
});

describe("refusal checks", () => {
  it("pass only with a balance read proving nothing moved", () => {
    const log = CHECK_RUNS.network;
    expect(projectCheck("network", log, 7).passed).toBe(true);
    const unread = log.filter((event) => !(event.kind === "chain" && event.phase === "balance"));
    expect(projectCheck("network", unread, 7)).toMatchObject({ passed: false, balance: "unknown" });
  });

  it("pass the session check only when exactly its one price moved", () => {
    const log = CHECK_RUNS["session-budget"];
    expect(projectCheck("session-budget", log, 7).passed).toBe(true);
    const doubled = log.map((event) =>
      event.kind === "chain" && event.phase === "balance" && event.role === "payer"
        ? { ...event, after: "0" }
        : event,
    );
    expect(projectCheck("session-budget", doubled, 7).passed).toBe(false);
  });

  it("show the verdict and cap of the policy that actually ran", () => {
    expect(field(rowOf(CHECK_RUNS.recipient, "quote"), "your policy")).toBe(
      "refuses it: payment_recipient_not_permitted",
    );
    expect(rowOf(CHECK_RUNS["session-budget"], "sign")?.sub).toBe("checked against your 0.001 cap");
  });

  it("label a later refusal of the session check as refused before signing that call", () => {
    const refused = rowOf(CHECK_RUNS["session-budget"], "refused");
    expect(refused?.label).toBe("Refused before signing");
  });
});
