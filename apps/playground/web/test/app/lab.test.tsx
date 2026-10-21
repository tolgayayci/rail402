import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../../src/app/App.tsx";
import { STEP_MS } from "../../src/app/lab/playback.ts";
import { createFakeEngine, type FakeEngineOptions } from "../../src/dev/fake-engine.ts";

function open(path = "/", options: FakeEngineOptions = {}): ReturnType<typeof createFakeEngine> {
  window.history.replaceState(null, "", path);
  const engine = createFakeEngine({ stepMs: 0, ...options });
  render(<App engine={engine} />);
  return engine;
}

/**
 * Lets the replayed run and the playback move on, in small slices: React runs the effects that
 * schedule the next step when each slice's act ends.
 */
async function play(ms: number): Promise<void> {
  let left = ms;
  do {
    const slice = Math.min(left, 50);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(slice);
    });
    left -= slice;
  } while (left > 0);
}

function inspector(): HTMLElement {
  return screen.getByRole("complementary", { name: "Step inspector" });
}

function stepStates(): string[] {
  const list = within(inspector()).queryByRole("list", { name: "Steps" });
  if (list === null) return [];
  return [...list.querySelectorAll(".step-list-item")].map((item) => item.getAttribute("data-look") ?? "");
}

/** The value of the input a label names. */
function valueOf(label: string): string {
  const input = screen.getByLabelText(label);
  if (!(input instanceof HTMLInputElement)) throw new Error(`${label} is not an input`);
  return input.value;
}

function run(): void {
  fireEvent.click(screen.getByRole("button", { name: /^(Run|Run again)$/ }));
}

describe("the Lab", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
  });

  it("starts ready on a fixed price, with the demo URL and every step to come", () => {
    open();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Watch a payment, step by step");
    const tiles = screen.getByRole("group", { name: "Payment mode" });
    expect(within(tiles).getByRole("button", { pressed: true }).textContent).toContain("Pay a fixed price");
    expect(valueOf("URL to pay")).toBe("demo.rail402.dev/weather?city=Ankara");
    expect(valueOf("Cap")).toBe("0.01");
    expect(within(inspector()).getByText(/Ready · 7 steps/)).toBeTruthy();
    expect(stepStates()).toEqual(Array(7).fill("pending"));
  });

  it("plays a payment one step at a time, then shows the proof", async () => {
    open();
    run();
    await play(0);
    expect(within(inspector()).getByText(/Step 01 \/ 07/).textContent).toContain("now");
    expect(within(inspector()).getByRole("heading", { name: "You ask for the data" })).toBeTruthy();
    // The run is already over in the fake engine; the page still shows one step at a time.
    await play(STEP_MS - 50);
    expect(stepStates().filter((state) => state === "pending")).toHaveLength(6);
    await play(100);
    expect(within(inspector()).getByRole("heading", { name: "The API names its price" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Running/ })).toBeTruthy();
    // The last step gets its turn as the current one like every other, then the proof replaces it.
    await play(STEP_MS * 5);
    expect(within(inspector()).getByRole("heading", { name: "You get data + receipt" })).toBeTruthy();
    expect(stepStates().at(-1)).toBe("current");
    expect(within(inspector()).queryByRole("region", { name: /Proof/ })).toBeNull();
    await play(STEP_MS);
    const proof = within(inspector()).getByRole("region", { name: /Proof/ });
    expect(proof.textContent).toContain("0.001 USDC");
    expect(proof.textContent).toContain("paid to the seller, in one transaction");
    expect(proof.textContent).toContain("from you, fee by Rail402");
    expect(
      within(proof)
        .getByRole("link", { name: /Open transaction/ })
        .getAttribute("href"),
    ).toMatch(/^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/);
    expect(within(proof).getByRole("list", { name: "Who did what" }).children).toHaveLength(4);
    // What came back reads as pairs, never as JSON.
    expect(proof.textContent).not.toMatch(/[{}"]/);
    expect(screen.getByRole("button", { name: "Run again" })).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Run progress" }).getAttribute("aria-valuenow")).toBe("7");
  });

  it("saves the finished run's report, built from its events", async () => {
    const engine = open();
    const exportRun = vi.spyOn(engine, "exportRun");
    // jsdom has no object URLs: stand them in for this test only.
    const saved = {
      create: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
      revoke: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
    };
    const createObjectURL = vi.fn(() => "blob:report");
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    // jsdom would follow the download link; the browser saves it instead.
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    run();
    await play(STEP_MS * 10);
    fireEvent.click(within(inspector()).getByRole("button", { name: "Save the run report" }));
    expect(exportRun).toHaveBeenCalledTimes(1);
    expect(exportRun.mock.results[0]?.value).toMatchObject({ format: "rail402-playground-run" });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
    for (const [name, descriptor] of [
      ["createObjectURL", saved.create],
      ["revokeObjectURL", saved.revoke],
    ] as const) {
      if (descriptor === undefined) Reflect.deleteProperty(URL, name);
      else Object.defineProperty(URL, name, descriptor);
    }
  });

  it("lets you step through a finished run and come back to the proof", async () => {
    open();
    run();
    await play(STEP_MS * 10);
    fireEvent.click(within(inspector()).getByRole("button", { name: "See each step" }));
    expect(within(inspector()).getByText(/Step 01 \/ 07/)).toBeTruthy();
    fireEvent.click(within(inspector()).getByRole("button", { name: /Step 6:/ }));
    expect(within(inspector()).getByRole("heading", { name: "The transfer lands" })).toBeTruthy();
    expect(within(inspector()).getByRole("link", { name: /^[0-9a-f]{6}…[0-9a-f]{6}/ })).toBeTruthy();
    fireEvent.click(within(inspector()).getByRole("button", { name: "Back to proof" }));
    expect(within(inspector()).getByRole("region", { name: /Proof/ })).toBeTruthy();
  });

  it("switches modes from the tiles and pays for what is used", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /Pay for what you use/ }));
    expect(window.location.search).toBe("?mode=upto");
    expect(valueOf("URL to pay")).toBe("demo.rail402.dev/history?city=Berlin&days=7");
    run();
    await play(STEP_MS * 10);
    const proof = within(inspector()).getByRole("region", { name: /Proof/ });
    expect(proof.textContent).toContain("0.0021 USDC");
    expect(proof.textContent).toContain("0.0079of your cap never taken");
    expect(proof.textContent).toContain("checked 0.0021 ≤ 0.01");
  });

  it("lets the scripted agent find a tool and pay it, with its prompt", async () => {
    open("/?mode=agent");
    expect(screen.queryByLabelText("URL to pay")).toBeNull();
    expect(screen.getByText("rail402-mcp · search_stellar_resources → pay_and_call")).toBeTruthy();
    expect(
      within(inspector()).getByText(/What is the air quality in Istanbul\? Spend at most 0.05 USDC/),
    ).toBeTruthy();
    expect(within(inspector()).getByText(/scripted agent, not a language model/)).toBeTruthy();
    run();
    await play(STEP_MS * 12);
    expect(within(inspector()).getByRole("region", { name: /Proof/ }).textContent).toContain("0.001 USDC");
  });

  it("runs a refusal from the menu and shows it refused before signing", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /Try a refusal/ }));
    const menu = screen.getByRole("group", { name: "Payments that must be refused" });
    fireEvent.click(within(menu).getByRole("button", { name: /Cap below the price/ }));
    expect(window.location.search).toBe("?try=per-call-cap");
    await play(STEP_MS * 4);
    const verdict = within(inspector()).getByRole("region", { name: "Refused before signing" });
    expect(verdict.textContent).toContain("Refused as expected");
    expect(verdict.textContent).toContain("payment_per_call_cap_exceeded");
    expect(verdict.textContent).toContain("Signednothing");
    expect(verdict.textContent).toContain("Your balanceunchanged");
    // Back to the mode's own payment.
    fireEvent.click(screen.getByRole("button", { name: "Back to pay a fixed price" }));
    expect(window.location.search).toBe("");
    expect(screen.getByLabelText("URL to pay")).toBeTruthy();
  });

  it("pays a pasted URL as typed, and refuses to run what is not a URL or a cap", () => {
    const engine = open();
    const pay = vi.spyOn(engine, "pay");
    const scenario = vi.spyOn(engine, "run");
    const url = screen.getByLabelText("URL to pay");
    fireEvent.change(url, { target: { value: "ftp://example.org" } });
    expect(screen.getByRole("alert").textContent).toMatch(/^Enter an http\(s\) URL/);
    expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(url, { target: { value: "api.example.org/paid" } });
    fireEvent.change(screen.getByLabelText("Cap"), { target: { value: "0.12345678" } });
    expect(screen.getByRole("alert").textContent).toBe("Use at most 7 decimal places.");
    fireEvent.change(screen.getByLabelText("Cap"), { target: { value: "0.02" } });
    run();
    expect(pay).toHaveBeenCalledWith({ target: "https://api.example.org/paid", cap: "0.02" });
    expect(scenario).not.toHaveBeenCalled();
  });

  it("fills a linked URL without paying it, and says where it came from", () => {
    const engine = open("/?url=https%3A%2F%2Fapi.example.org%2Fpaid");
    const pay = vi.spyOn(engine, "pay");
    expect(valueOf("URL to pay")).toBe("https://api.example.org/paid");
    expect(screen.getByText(/This URL came from the link you opened/)).toBeTruthy();
    expect(pay).not.toHaveBeenCalled();
  });

  it("waits for the wallet when it is open in another tab", () => {
    open("/", { wallet: "locked" });
    expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("playground_wallet_locked")).toBeTruthy();
  });

  it("keeps a run when you leave the Lab and come back, without replaying it", async () => {
    open();
    run();
    await play(STEP_MS * 10);
    fireEvent.click(screen.getByRole("link", { name: "Bazaar" }));
    await play(0);
    fireEvent.click(screen.getByRole("link", { name: "Lab" }));
    await play(0);
    expect(within(inspector()).getByRole("region", { name: /Proof/ })).toBeTruthy();
  });
});
