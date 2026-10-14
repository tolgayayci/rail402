import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../../src/app/App.tsx";
import { createFakeEngine } from "../../src/dev/fake-engine.ts";

function messages(): string[] {
  return within(screen.getByRole("list", { name: "Messages" }))
    .queryAllByRole("button")
    .map((button) => button.getAttribute("aria-label") ?? "");
}

describe("lab page", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  it("runs a scenario and shows every message, the inspector and the outcome", async () => {
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    expect(screen.getByText(/Press/).textContent).toContain("Run on testnet");
    fireEvent.click(screen.getByRole("button", { name: "Run on testnet" }));
    await screen.findByRole("button", { name: "Run again" });
    expect(messages().map((label) => label.split(".")[0])).toEqual([
      "Inspect: GET /weather?city=Ankara",
      "Inspect: 402 Payment Required",
      "Inspect: Sign one authorization",
      "Inspect: Retry with PAYMENT-SIGNATURE",
      "Inspect: /verify → /settle",
      "Inspect: Transaction submitted",
      "Inspect: 200 OK + PAYMENT-RESPONSE",
    ]);
    expect(screen.getByRole("region", { name: "Outcome" }).textContent).toContain("Paid and delivered");

    // The inspector follows the latest row until one is picked.
    const inspector = screen.getByRole("region", { name: "Inspector" });
    expect(inspector.textContent).toContain("You get the data and a receipt");
    fireEvent.click(screen.getByRole("button", { name: /^Inspect: 402 Payment Required/ }));
    expect(inspector.textContent).toContain("The seller answers with its price");
    expect(inspector.textContent).toContain("10000 = 0.001 USDC");
  });

  it("highlights the code lines of the selected step", async () => {
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Run on testnet" }));
    await screen.findByRole("button", { name: "Run again" });
    fireEvent.click(screen.getByRole("button", { name: /^Inspect: Sign one authorization/ }));
    const code = screen.getByRole("tabpanel");
    const on = [...code.querySelectorAll('[data-on="true"]')].map((line) => line.textContent.trim());
    expect(on.some((line) => line.startsWith("maxAmount"))).toBe(true);
  });

  it("requires a valid cap before running", () => {
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    const cap = screen.getByLabelText("Cap");
    fireEvent.change(cap, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Run on testnet" })).toHaveProperty("disabled", true);
    fireEvent.change(cap, { target: { value: "5" } });
    expect(screen.getByText(/the cap used is 0.1 USDC/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run on testnet" })).toHaveProperty("disabled", false);
  });

  it("sets the low cap for the cap-below-price experiment and shows the refusal", async () => {
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Cap below the price" }));
    expect(screen.getByLabelText<HTMLInputElement>("Cap").value).toBe("0.0005");
    expect(window.location.search).toBe("?scenario=pay&experiment=low-cap");
    fireEvent.click(screen.getByRole("button", { name: "Run on testnet" }));
    await screen.findByRole("button", { name: "Run again" });
    const outcome = screen.getByRole("region", { name: "Outcome" });
    expect(outcome.textContent).toContain("Refused safely");
    expect(outcome.textContent).toContain("payment_per_call_cap_exceeded");
  });

  it("switches scenarios and their lanes", () => {
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    fireEvent.click(screen.getByRole("tab", { name: /Agent pays a tool/ }));
    expect(screen.getByRole("tab", { name: /Agent pays a tool/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Your agent")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Tool calls" })).toBeTruthy();
  });

  it("labels the agent as scripted, not a language model, before it runs", () => {
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    expect(screen.queryByText(/A scripted agent, not a language model/)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Agent pays a tool/ }));
    expect(screen.getByText(/A scripted agent, not a language model/)).toBeTruthy();
  });

  it("keeps a run when the visitor leaves the page and comes back", async () => {
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    fireEvent.click(screen.getByRole("tab", { name: /Pay per use/ }));
    fireEvent.click(screen.getByRole("button", { name: "Run on testnet" }));
    await screen.findByRole("button", { name: "Run again" });
    fireEvent.click(screen.getByRole("link", { name: "Bazaar" }));
    expect(screen.queryByRole("region", { name: "Outcome" })).toBeNull();
    // The Playground link returns to the scenario last shown, with its run.
    fireEvent.click(screen.getByRole("link", { name: "Playground" }));
    expect(window.location.search).toBe("?scenario=upto");
    expect(screen.getByRole("region", { name: "Outcome" }).textContent).toContain("Charged for usage");
  });

  it("does not run without a wallet, and says why", () => {
    render(<App engine={createFakeEngine({ stepMs: 0, wallet: "none" })} />);
    expect(screen.getByRole("button", { name: "Run on testnet" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("status").textContent).toContain("playground_wallet_missing");
  });

  it("says why Run is off before the flow, not under it", () => {
    render(<App engine={createFakeEngine({ stepMs: 0, wallet: "none" })} />);
    expect(screen.getByText("Set up a test wallet first")).toBeTruthy();
    expect(screen.getByText(/^Set up a test wallet first: it lives only in this browser/)).toBeTruthy();
    const prompt = screen.getByRole("status");
    const flow = screen.getByRole("list", { name: "Messages" });
    expect(prompt.compareDocumentPosition(flow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows what the operator turned off, with its code", () => {
    const base = createFakeEngine({ stepMs: 0 }).config;
    const config = {
      ...base,
      lab: {
        ...base.lab,
        scenarios: base.lab.scenarios.filter((id) => id !== "sell"),
        experiments: base.lab.experiments.filter((id) => id !== "overcharge"),
      },
    };
    window.history.replaceState(null, "", "/?scenario=upto&experiment=overcharge");
    render(<App engine={createFakeEngine({ stepMs: 0, config })} />);
    const notice = screen
      .getAllByRole("status")
      .find((item) => item.textContent.includes("playground_feature_disabled"));
    expect(notice?.textContent).toContain("Sell and get listed, Seller charges over the cap");
    expect(screen.getByRole("tab", { name: /Sell and get listed/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Seller charges over the cap" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Run on testnet" })).toHaveProperty("disabled", true);
  });

  it("does not render HTML from seller data", () => {
    const source = Object.values(
      import.meta.glob("../../src/**/*.tsx", { query: "?raw", import: "default", eager: true }),
    );
    expect(source.length).toBeGreaterThan(10);
    for (const text of source) expect(text).not.toContain("dangerouslySetInnerHTML");
  });
});
