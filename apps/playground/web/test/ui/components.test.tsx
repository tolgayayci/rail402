import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import type { BudgetView } from "../../src/engine/types.ts";
import { inspectorFor } from "../../src/projection/inspector.ts";
import { lanesFor } from "../../src/projection/lanes.ts";
import { projectOutcome } from "../../src/projection/outcome.ts";
import { projectRows } from "../../src/projection/rows.ts";
import { CapInput } from "../../src/ui/CapInput.tsx";
import { BudgetMeter, WalletChip, budgetShares } from "../../src/ui/header.tsx";
import { Inspector } from "../../src/ui/Inspector.tsx";
import { OutcomeCard } from "../../src/ui/OutcomeCard.tsx";
import { Swimlane } from "../../src/ui/Swimlane.tsx";
import { Tabs } from "../../src/ui/Tabs.tsx";
import { CONFIG } from "../fixtures/config.ts";
import { IDS } from "../fixtures/ids.ts";
import { CHECK_RUNS, scenarioRun } from "../fixtures/runs.ts";

const context = { asset: { symbol: "USDC", decimals: 7 } };
const lanes = lanesFor("pay", { sellerHost: "demo.rail402.dev" });

afterEach(() => {
  cleanup();
});

describe("swimlane", () => {
  it("draws an open request as live, with a travelling dot", () => {
    const log = scenarioRun("pay", "normal");
    const rows = projectRows(log.slice(0, log.findIndex((event) => event.kind === "http") + 1), context);
    render(<Swimlane lanes={lanes} rows={rows} selectedId={null} onSelect={() => undefined} />);
    const row = screen.getByRole("button", { name: /^Inspect: GET \/weather/ });
    expect(row.getAttribute("data-status")).toBe("live");
    expect(row.getAttribute("aria-label")).toContain("in progress");
    expect(row.querySelector(".row-dot.travel-right")).not.toBeNull();
  });

  it("draws a refused row in the error colour and says so", () => {
    const rows = projectRows(scenarioRun("pay", "low-cap"), context);
    render(<Swimlane lanes={lanes} rows={rows} selectedId={null} onSelect={() => undefined} />);
    const refused = screen.getByRole("button", { name: /^Inspect: Refused before signing/ });
    expect(refused.getAttribute("data-status")).toBe("error");
    expect(refused.getAttribute("aria-label")).toContain("failed or refused");
    expect(refused.querySelector('[data-tone="error"]')).not.toBeNull();
  });

  it("reports the picked row and marks it pressed", () => {
    const rows = projectRows(scenarioRun("pay", "normal"), context);
    const onSelect = vi.fn();
    render(<Swimlane lanes={lanes} rows={rows} selectedId={rows[1]?.id ?? null} onSelect={onSelect} />);
    const buttons = within(screen.getByRole("list", { name: "Messages" })).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual(
      rows.map((_, index) => String(index === 1)),
    );
    fireEvent.click(buttons[2] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith(rows[2]);
  });

  it("shows the idle text only before the first row", () => {
    render(
      <Swimlane
        lanes={lanes}
        rows={[]}
        selectedId={null}
        onSelect={() => undefined}
        idle={<p>idle text</p>}
      />,
    );
    expect(screen.getByText("idle text")).toBeTruthy();
  });
});

describe("inspector", () => {
  it("lists each field with the colour and name of its source", () => {
    const rows = projectRows(scenarioRun("pay", "normal"), context);
    const quote = rows.find((row) => row.step === "quote");
    render(<Inspector view={inspectorFor(quote, lanes, "pay")} docsUrl={CONFIG.urls.docs} />);
    const inspector = screen.getByRole("region", { name: "Inspector" });
    expect(inspector.textContent).toContain("10000 = 0.001 USDC");
    const key = within(inspector).getByRole("list", { name: "Where these facts come from" });
    expect(key.textContent).toContain(quote?.source === "seller" ? "seller" : "");
    for (const dot of inspector.querySelectorAll("dt .source-dot")) {
      expect(["you", "seller", "stellar", "bazaar"]).toContain(dot.getAttribute("data-tone"));
    }
    const doc = within(inspector).getByRole("link");
    expect(doc.getAttribute("href")?.startsWith(CONFIG.urls.docs.replace(/\/$/, ""))).toBe(true);
  });
});

describe("outcome card", () => {
  it("shows money, the transaction link and the next step", () => {
    const outcome = projectOutcome(scenarioRun("pay", "normal"), {
      asset: CONFIG.asset,
      sellerLabel: "Weather API",
      facilitatorLabel: "Rail402",
    });
    if (outcome === undefined) throw new Error("expected an outcome");
    const go = vi.fn();
    render(
      <OutcomeCard outcome={outcome} docsUrl={CONFIG.urls.docs} next={{ label: "Next: pay per use", go }} />,
    );
    const card = screen.getByRole("region", { name: "Outcome" });
    expect(within(card).getByRole("list", { name: "Money" }).textContent).toContain("0.001 USDC");
    const tx = within(card)
      .getAllByRole("link")
      .find((link) => link.getAttribute("href")?.includes("/tx/"));
    expect(tx?.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(screen.getByRole("button", { name: "Next: pay per use" }));
    expect(go).toHaveBeenCalledTimes(1);
  });

  it("shows a refusal's code and reason", () => {
    const outcome = projectOutcome(CHECK_RUNS["per-call-cap"], {
      asset: CONFIG.asset,
      sellerLabel: "Weather API",
      facilitatorLabel: "Rail402",
    });
    if (outcome === undefined) throw new Error("expected an outcome");
    render(<OutcomeCard outcome={outcome} docsUrl={CONFIG.urls.docs} />);
    expect(screen.getByRole("region", { name: "Outcome" }).textContent).toContain(
      "payment_per_call_cap_exceeded",
    );
  });
});

function Cap({ initial }: { readonly initial: string }): ReactElement {
  const [value, setValue] = useState(initial);
  return (
    <CapInput
      value={value}
      onChange={setValue}
      ceiling="0.1"
      decimals={7}
      symbol="USDC"
      presets={[{ label: "Low cap", value: "0.0005" }]}
    />
  );
}

describe("cap input", () => {
  it("is required, explains a bad value, clamps above the ceiling, and offers presets", () => {
    render(<Cap initial="" />);
    const input = screen.getByLabelText("Spending cap");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Enter a spending cap: it is required.");

    fireEvent.change(input, { target: { value: "0.00000001" } });
    expect(screen.getByRole("alert").textContent).toBe("Use at most 7 decimal places.");

    fireEvent.change(input, { target: { value: "5" } });
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(screen.getByText(/Above the 0.1 USDC ceiling: the cap used is 0.1 USDC./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Low cap" }));
    expect((input as HTMLInputElement).value).toBe("0.0005");
    expect(screen.getByRole("button", { name: "Low cap" }).getAttribute("aria-pressed")).toBe("true");
  });
});

function TabsHarness(): ReactElement {
  const [selected, setSelected] = useState<"a" | "b" | "c">("a");
  return (
    <Tabs
      label="Code"
      idPrefix="t"
      selected={selected}
      onSelect={setSelected}
      items={[
        { id: "a", label: "SDK" },
        { id: "b", label: "CLI" },
        { id: "c", label: "MCP" },
      ]}
    />
  );
}

describe("tabs", () => {
  it("moves with the arrow keys, Home and End, keeping one tab in the tab order", () => {
    render(<TabsHarness />);
    const list = screen.getByRole("tablist", { name: "Code" });
    const selected = (): string | undefined =>
      screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent ??
      undefined;
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(selected()).toBe("CLI");
    fireEvent.keyDown(list, { key: "End" });
    expect(selected()).toBe("MCP");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(selected()).toBe("SDK");
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(selected()).toBe("MCP");
    fireEvent.keyDown(list, { key: "Home" });
    expect(selected()).toBe("SDK");
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.getAllByRole("tab")[0]?.getAttribute("aria-controls")).toBe("t-panel");
  });
});

const BUDGET: BudgetView = {
  session: "default",
  window: "default",
  startedAt: "2026-10-03T11:58:00Z",
  expiresAt: "2026-10-04T11:58:00Z",
  perCallCap: "0.01",
  sessionCap: "1",
  spent: "0.25",
  pending: "0.5",
  remaining: "0.25",
  awaitingProof: 2,
  falseClaims: 0,
};

describe("budget meter and wallet chip", () => {
  it("splits the session budget into spent and held, exactly", () => {
    expect(budgetShares(BUDGET)).toEqual({ spent: 0.25, pending: 0.5 });
    expect(budgetShares({ ...BUDGET, spent: "2", pending: "1" })).toEqual({ spent: 1, pending: 0 });
    expect(budgetShares({ ...BUDGET, sessionCap: "0" })).toEqual({ spent: 0, pending: 0 });
  });

  it("names the amounts and the payments awaiting proof", () => {
    render(<BudgetMeter budget={BUDGET} symbol="USDC" />);
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe("0.75");
    expect(meter.getAttribute("aria-label")).toBe(
      "Session budget: 0.25 spent, 0.5 held, 0.25 of 1 USDC left",
    );
    expect(screen.getByText(/2 awaiting proof/)).toBeTruthy();
  });

  it("shows each wallet state, as a toggle when it opens the panel", () => {
    const { rerender } = render(<WalletChip wallet={{ status: "loading" }} balances={null} symbol="USDC" />);
    expect(screen.getByText("Loading wallet…").getAttribute("aria-busy")).toBe("true");
    rerender(<WalletChip wallet={{ status: "locked" }} balances={null} symbol="USDC" />);
    expect(screen.getByText("Wallet in another tab")).toBeTruthy();
    const onToggle = vi.fn();
    rerender(
      <WalletChip
        wallet={{
          status: "ready",
          address: IDS.buyer,
          network: "stellar:testnet",
          createdAt: "2026-10-03T11:58:00Z",
          storage: "persistent",
          setup: { account: true, trustline: false, funded: false },
        }}
        balances={{ xlm: "100", asset: null, readAt: 0 }}
        symbol="USDC"
        expanded={false}
        onToggle={onToggle}
        controls="wallet-panel"
      />,
    );
    const chip = screen.getByRole("button", { expanded: false });
    expect(chip.textContent).toContain("no USDC yet");
    fireEvent.click(chip);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
