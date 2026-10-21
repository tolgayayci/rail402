import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../../src/app/App.tsx";
import { SETUP_DONE_MS, summaryError } from "../../src/app/wallet-setup.tsx";
import {
  FAKE_PURCHASE_FAILURE,
  createFakeEngine,
  type FakeEngineOptions,
} from "../../src/dev/fake-engine.ts";
import { IDS } from "../fixtures/ids.ts";

function open(options: FakeEngineOptions = {}): ReturnType<typeof createFakeEngine> {
  const engine = createFakeEngine({ stepMs: 0, ...options });
  render(<App engine={engine} />);
  return engine;
}

function pill(): HTMLElement {
  const element = document.getElementById("wallet-pill");
  if (element === null) throw new Error("no wallet pill");
  return element;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: /wallet|setup/i });
}

function menu(): HTMLElement {
  return screen.getByRole("dialog", { name: "Test wallet" });
}

function stepStates(root: HTMLElement): (string | null)[] {
  return [...root.querySelectorAll(".setup-step")].map((step) => step.getAttribute("data-state"));
}

const TX = /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/;

describe("first visit", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  it("creates and funds a wallet on its own, step by step, then closes the dialog", async () => {
    const engine = open({ wallet: "none" });
    const created = dialog();
    expect(created.getAttribute("aria-modal")).toBe("true");
    expect(within(created).getByRole("heading").textContent).toBe("Creating your test wallet");
    expect(created.textContent).toContain("kept in this browser");
    expect(pill().getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector(".app")?.hasAttribute("inert")).toBe(true);

    await waitFor(() => {
      expect(within(dialog()).getByRole("heading").textContent).toBe("Your test wallet is ready");
    });
    expect(stepStates(dialog())).toEqual(["done", "done", "done"]);
    const links = within(dialog())
      .getAllByRole("link", { name: /transaction/ })
      .map((link) => link.getAttribute("href"));
    expect(links).toHaveLength(2);
    for (const href of links) expect(href).toMatch(TX);
    expect(engine.state().wallet.status).toBe("ready");

    await waitFor(
      () => {
        expect(screen.queryByRole("dialog")).toBeNull();
      },
      { timeout: SETUP_DONE_MS + 1_000 },
    );
    expect(document.querySelector(".app")?.hasAttribute("inert")).toBe(false);
    expect(pill().textContent).toContain("GBBU…TYQO");
    expect(pill().textContent).toContain("1 USDC");
  });

  it("leaves a stored, funded wallet alone", () => {
    open();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pill().getAttribute("aria-label")).toBe(`Test wallet ${IDS.buyer}`);
    expect(pill().textContent).toBe("GBBU…TYQO1 USDC");
  });

  it("finishes the setup of a stored wallet that has no test funds", async () => {
    open({ wallet: "unfunded" });
    expect(within(dialog()).getByRole("heading").textContent).toBe("Adding test funds to your wallet");
    await waitFor(() => {
      expect(stepStates(dialog())).toEqual(["done", "done", "done"]);
    });
  });

  it("stops on a failed purchase with its code and the faucet, and waits for the visitor", async () => {
    const engine = open({ wallet: "none", fund: "purchase-fails" });
    const retry = await within(dialog()).findByRole("button", { name: "Try again" });
    const alert = within(dialog()).getByRole("alert").textContent;
    expect(alert).toContain(FAKE_PURCHASE_FAILURE.code);
    expect(alert).toContain(FAKE_PURCHASE_FAILURE.reason);
    expect(stepStates(dialog())).toEqual(["done", "done", "error"]);
    expect(
      within(dialog())
        .getByRole("link", { name: /testnet faucet/ })
        .getAttribute("href"),
    ).toBe("https://faucet.circle.com/");
    const fund = vi.spyOn(engine.wallet, "fund");
    fireEvent.click(retry);
    expect(fund).toHaveBeenCalledTimes(1);
    await within(dialog()).findByRole("button", { name: "Close" });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Closed, it does not start again on its own.
    expect(fund).toHaveBeenCalledTimes(1);
  });

  it("says when the browser cannot keep the key", () => {
    open({ wallet: "memory" });
    expect(dialog().textContent).toContain("this tab only");
  });

  it("does nothing while another tab holds the wallet, and says so", () => {
    open({ wallet: "locked" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pill().textContent).toBe("Open in another tab");
    fireEvent.click(pill());
    expect(within(menu()).getByRole("status").textContent).toContain("playground_wallet_locked");
  });
});

describe("wallet menu", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("opens from the pill with the balance and the full address, and closes with Escape", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    open();
    fireEvent.click(pill());
    expect(pill().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.textContent).toBe("Test wallet");
    expect(menu().querySelector(".wallet-balance")?.textContent).toBe("1USDC9,989.9 XLM");
    expect(within(menu()).getByText(IDS.buyer)).toBeTruthy();
    expect(
      within(menu())
        .getByRole("link", { name: /stellar\.expert/ })
        .getAttribute("href"),
    ).toBe(`https://stellar.expert/explorer/testnet/account/${IDS.buyer}`);
    fireEvent.click(within(menu()).getByRole("button", { name: "Copy address" }));
    expect(writeText).toHaveBeenCalledWith(IDS.buyer);
    await within(menu()).findByText("Copied");
    fireEvent.keyDown(menu(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(pill());
  });

  it("adds test funds on request", async () => {
    const engine = open();
    fireEvent.click(pill());
    fireEvent.click(within(menu()).getByRole("button", { name: "Add test USDC" }));
    await within(menu()).findByText("Added 1 test USDC.");
    expect(engine.state().balances?.asset).toBe("2");
    expect(pill().textContent).toContain("2 USDC");
  });

  it("resets the wallet only after a confirmation, then makes a new one", async () => {
    const engine = open();
    const forget = vi.spyOn(engine.wallet, "forget");
    const create = vi.spyOn(engine.wallet, "create");
    fireEvent.click(pill());
    fireEvent.click(within(menu()).getByRole("button", { name: "Reset wallet" }));
    expect(forget).not.toHaveBeenCalled();
    const confirm = within(menu()).getByRole("group", { name: "Confirm the reset" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Reset wallet" }));
    expect(forget).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(1);
    });
    expect(within(dialog()).getByRole("heading").textContent).toMatch(/Creating your test wallet|is ready/);
  });

  it("downloads the key file only after a confirmation that names the testnet", async () => {
    const engine = open();
    const exportFile = vi.spyOn(engine.wallet, "exportFile");
    fireEvent.click(pill());
    fireEvent.click(within(menu()).getByRole("button", { name: /download the key file/ }));
    const confirm = within(menu()).getByRole("group", { name: "Confirm the key download" });
    expect(confirm.textContent).toContain("testnet");
    expect(exportFile).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Download the key file" }));
    expect(exportFile).toHaveBeenCalledTimes(1);
    expect((await within(menu()).findByText(/Saved as/)).textContent).toContain("stellar-testnet.key");
    // The confirmation went away with the focus in it: Escape still closes the menu.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(pill());
  });
});

describe("wallet helpers", () => {
  it("turns a failed run into its code, and an uncoded one into the generic code", () => {
    expect(summaryError({ runId: "r", status: "ok" })).toBeNull();
    expect(summaryError({ runId: "r", status: "error", code: "key_invalid", reason: "Bad key." })).toEqual({
      code: "key_invalid",
      reason: "Bad key.",
      retryable: false,
    });
    expect(summaryError({ runId: "r", status: "error" })?.code).toBe("playground_unexpected_error");
  });
});
