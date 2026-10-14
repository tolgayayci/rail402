import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../../src/app/App.tsx";
import { summaryError, utcTime } from "../../src/app/WalletPanel.tsx";
import {
  FAKE_PURCHASE_FAILURE,
  createFakeEngine,
  type FakeEngineOptions,
} from "../../src/dev/fake-engine.ts";

function open(options: FakeEngineOptions = {}, path = "/"): ReturnType<typeof createFakeEngine> {
  window.history.replaceState(null, "", path);
  const engine = createFakeEngine({ stepMs: 0, ...options });
  render(<App engine={engine} />);
  return engine;
}

function chip(): HTMLElement {
  return screen.getByRole("button", { expanded: false, name: /wallet|G[A-Z2-7]{3}…/i });
}

function panel(): HTMLElement {
  return screen.getByRole("region", { name: "Test wallet" });
}

describe("wallet panel", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  it("opens from the header chip and closes with Escape", () => {
    open();
    const button = chip();
    expect(button.getAttribute("aria-controls")).toBe("wallet-panel");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.textContent).toBe("Test wallet");
    fireEvent.keyDown(panel(), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Test wallet" })).toBeNull();
  });

  it("creates a wallet and sets it up with test funds, each step with its transaction", async () => {
    open({ wallet: "none" });
    const prompt = screen.getByRole("status");
    expect(prompt.textContent).toContain("playground_wallet_missing");
    fireEvent.click(within(prompt).getByRole("button", { name: "Set up a test wallet" }));
    fireEvent.click(within(panel()).getByRole("button", { name: "Create a test wallet" }));
    const fund = await within(panel()).findByRole("button", { name: "Set up test funds" });
    expect(screen.getByRole("button", { name: "Run on testnet" })).toHaveProperty("disabled", false);
    expect(screen.getByText(/has no test funds yet/)).toBeTruthy();

    fireEvent.click(fund);
    await waitFor(() => {
      expect(panel().querySelectorAll('.setup-step[data-state="done"]').length).toBe(3);
    });
    const links = within(panel()).getAllByRole("link");
    const explorer = links.filter((link) => link.getAttribute("href")?.includes("/tx/"));
    expect(explorer).toHaveLength(3);
    for (const link of explorer) {
      expect(link.getAttribute("href")).toMatch(
        /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/,
      );
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
    await waitFor(() => {
      expect(within(panel()).queryByRole("button", { name: "Set up test funds" })).toBeNull();
    });
    expect(panel().textContent).toContain("9989.9 XLM");
    expect(screen.queryByText(/has no test funds yet/)).toBeNull();
  });

  it("shows the faucet when the purchase fails, with its code, and keeps the steps that worked", async () => {
    open({ wallet: "unfunded", fund: "purchase-fails" });
    fireEvent.click(chip());
    fireEvent.click(within(panel()).getByRole("button", { name: "Set up test funds" }));
    await within(panel()).findByRole("button", { name: "Try the setup again" });
    const alert = within(panel()).getByRole("alert").textContent;
    expect(alert).toContain(FAKE_PURCHASE_FAILURE.code);
    expect(alert).toContain(FAKE_PURCHASE_FAILURE.reason);
    expect(
      within(panel())
        .getByRole("link", { name: /testnet faucet/ })
        .getAttribute("href"),
    ).toBe("https://faucet.circle.com/");
    expect(
      [...panel().querySelectorAll(".setup-step")].map((step) => step.getAttribute("data-state")),
    ).toEqual(["done", "done", "error"]);
  });

  it("imports a key from a password field it clears at once, and refuses a malformed key with a code", async () => {
    open({ wallet: "none" });
    fireEvent.click(chip());
    const field = within(panel()).getByLabelText(/Secret key/);
    expect(field.getAttribute("type")).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("off");

    fireEvent.change(field, { target: { value: "not-a-seed" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Import" }));
    expect((field as HTMLInputElement).value).toBe("");
    expect((await within(panel()).findByRole("alert")).textContent).toContain("key_invalid");

    fireEvent.change(field, { target: { value: `S${"A".repeat(55)}` } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Import" }));
    expect((field as HTMLInputElement).value).toBe("");
    expect(await within(panel()).findByText("Address")).toBeTruthy();
    expect(panel().textContent).not.toContain(`S${"A".repeat(55)}`);
  });

  it("downloads the key file only after a confirmation that names the testnet", async () => {
    const engine = open();
    const exportFile = vi.spyOn(engine.wallet, "exportFile");
    fireEvent.click(chip());
    fireEvent.click(within(panel()).getByRole("button", { name: "Download key file…" }));
    expect(exportFile).not.toHaveBeenCalled();
    const confirm = within(panel()).getByRole("group", { name: "Confirm the key download" });
    expect(confirm.textContent).toContain("testnet");
    fireEvent.click(within(confirm).getByRole("button", { name: "Download the key file" }));
    expect(exportFile).toHaveBeenCalledTimes(1);
    expect((await within(panel()).findByText(/Saved as/)).textContent).toContain("stellar-testnet.key");
  });

  it("forgets the wallet after a confirmation", async () => {
    open();
    fireEvent.click(chip());
    fireEvent.click(within(panel()).getByRole("button", { name: "Forget wallet…" }));
    expect(within(panel()).getByRole("group", { name: "Confirm forgetting the wallet" })).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: "Cancel" }));
    expect(within(panel()).getByText("Address")).toBeTruthy();
    fireEvent.click(within(panel()).getByRole("button", { name: "Forget wallet…" }));
    fireEvent.click(within(panel()).getByRole("button", { name: "Forget this wallet" }));
    expect(await within(panel()).findByRole("button", { name: "Create a test wallet" })).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("lowers the session budget and refuses raising it", async () => {
    open();
    fireEvent.click(chip());
    const field = within(panel()).getByLabelText("Lower the session budget");
    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Lower" }));
    expect(within(panel()).getByRole("alert").textContent).toContain("playground_request_invalid");

    fireEvent.change(field, { target: { value: "0.25" } });
    fireEvent.click(within(panel()).getByRole("button", { name: "Lower" }));
    expect(await within(panel()).findByText("The session budget is now 0.25 USDC.")).toBeTruthy();
    expect(screen.getByRole("meter").getAttribute("aria-label")).toBe(
      "Session budget: 0 spent, 0 held, 0.25 of 0.25 USDC left",
    );
  });

  it("proves pending payments on request", async () => {
    open({ unfinished: 1 });
    fireEvent.click(chip());
    expect(panel().textContent).toContain("1 payment(s) still wait for proof on chain");
    fireEvent.click(within(panel()).getByRole("button", { name: "Check the chain now" }));
    await waitFor(() => {
      expect(within(panel()).queryByRole("button", { name: "Check the chain now" })).toBeNull();
    });
  });

  it("says when the wallet is in another tab, or cannot be stored", () => {
    open({ wallet: "locked" });
    expect(screen.getByRole("status").textContent).toContain("playground_wallet_locked");
    fireEvent.click(screen.getByRole("button", { name: "Wallet in another tab" }));
    expect(panel().textContent).toContain("playground_wallet_locked");
    expect(within(panel()).queryByRole("button", { name: "Create a test wallet" })).toBeNull();
    cleanup();

    open({ wallet: "memory" });
    fireEvent.click(screen.getByRole("button", { name: "Set up a test wallet", expanded: false }));
    expect(panel().textContent).toContain("playground_wallet_storage_unavailable");
    expect(within(panel()).getByRole("button", { name: "Create a test wallet" })).toBeTruthy();
  });
});

describe("wallet helpers", () => {
  it("turns a failed run into its code, and an uncoded one into the generic code", () => {
    expect(summaryError(null)).toBeNull();
    expect(summaryError({ runId: "r", status: "ok" })).toBeNull();
    expect(
      summaryError({ runId: "r", status: "error", code: "account_friendbot_failed", reason: "down" }),
    ).toEqual({
      code: "account_friendbot_failed",
      reason: "down",
      retryable: false,
    });
    expect(summaryError({ runId: "r", status: "error" })?.code).toBe("playground_unexpected_error");
  });

  it("shows times in UTC", () => {
    expect(utcTime("2026-10-03T11:58:00Z")).toBe("2026-10-03 11:58 UTC");
    expect(utcTime("soon")).toBe("soon");
  });
});
