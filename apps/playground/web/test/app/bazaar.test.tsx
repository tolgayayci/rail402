import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../../src/app/App.tsx";
import { STEP_MS } from "../../src/app/lab/playback.ts";
import { createFakeEngine } from "../../src/dev/fake-engine.ts";
import { LISTINGS } from "../fixtures/bazaar.ts";

function open(path: string): void {
  window.history.replaceState(null, "", path);
  render(<App engine={createFakeEngine({ stepMs: 0 })} />);
}

async function wait(ms: number): Promise<void> {
  let left = ms;
  do {
    const slice = Math.min(left, 50);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(slice);
    });
    left -= slice;
  } while (left > 0);
}

function rows(): string[] {
  const list = screen.getByRole("list", { name: /^(Listings|Results for .*)$/ });
  return [...list.querySelectorAll(".listing-name-button")].map((item) => item.textContent);
}

function listingPanel(): HTMLElement {
  const found = document.querySelector<HTMLElement>(".listing-panel");
  if (found === null) throw new Error("no listing panel");
  return found;
}

describe("the Bazaar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
  });

  it("shows every listing on one page with real counts, the first one chosen", async () => {
    open("/bazaar");
    await wait(10);
    expect(screen.getByText("Bazaar · 6 listings")).toBeTruthy();
    expect(rows()).toHaveLength(6);
    const filters = screen.getByRole("group", { name: "Filters" });
    expect(within(filters).getByRole("button", { pressed: true }).textContent).toBe("All · 6");
    expect(within(filters).getByRole("button", { name: /MCP tools/ }).textContent).toBe("MCP tools · 2");
    expect(within(listingPanel()).getByRole("heading", { name: "Current weather for a city" })).toBeTruthy();
    expect(within(listingPanel()).getByText("0.001 USDC per call")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(Next|Previous)$/ })).toBeNull();
  });

  it("narrows the list with a filter and keeps it in the address", async () => {
    open("/bazaar");
    await wait(10);
    fireEvent.click(screen.getByRole("button", { name: /^Pay per use/ }));
    expect(rows()).toEqual(["hourly_forecast", "Daily weather history for a city, billed per day"]);
    expect(window.location.search).toBe("?filter=upto");
  });

  it("searches in plain words after a short pause", async () => {
    open("/bazaar");
    await wait(10);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the Bazaar" }), {
      target: { value: "air quality" },
    });
    await wait(400);
    expect(rows()[0]).toBe("air_quality");
    expect(screen.getByText(/ranked by hybrid search/)).toBeTruthy();
  });

  it("makes a form from a tool's declared arguments, pays it, and shows the result in words", async () => {
    open("/bazaar");
    await wait(10);
    fireEvent.click(screen.getByRole("button", { name: "Try air_quality" }));
    const box = listingPanel();
    expect(within(box).getByLabelText<HTMLInputElement>(/^city/).value).toBe("Istanbul");
    expect(within(box).getByLabelText<HTMLSelectElement>(/^pollutant/).value).toBe("pm25");
    expect(document.activeElement).toBe(within(box).getByLabelText(/^city/));
    fireEvent.click(within(box).getByRole("button", { name: "Pay 0.001 USDC and call" }));
    await wait(200);
    const result = within(box).getByText(/^Paid 0.001 USDC/);
    expect(result.textContent).toContain("fee by Rail402");
    const tx = box.querySelector(".try-paid a");
    expect(tx?.getAttribute("href")).toMatch(
      /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/,
    );
    expect(box.textContent).not.toMatch(/[{}]/);
    const watch = within(box).getByRole("link", { name: /Watch this payment in the Lab/ });
    expect(watch.getAttribute("href")).toBe(`/?watch=${LISTINGS.airQuality.id}`);
  });

  it("says before paying that a price above the cap will be refused", async () => {
    open(`/bazaar?listing=${LISTINGS.history.id}`);
    await wait(10);
    const box = listingPanel();
    expect(within(box).getByRole("heading", { name: /Daily weather history/ })).toBeTruthy();
    fireEvent.change(within(box).getByLabelText("Cap"), { target: { value: "0.005" } });
    expect(box.textContent).toContain("will refuse it before signing anything");
    fireEvent.change(within(box).getByLabelText(/^days/), { target: { value: "" } });
    expect(within(box).getByRole("button", { name: /^Pay up to 0.01 USDC and call$/ })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("shows a listing's version history when asked", async () => {
    open(`/bazaar?listing=${LISTINGS.sample.id}`);
    await wait(10);
    fireEvent.click(screen.getByRole("button", { name: "Version history" }));
    await wait(10);
    const history = screen.getByRole("region", { name: "Version history" });
    expect(within(history).getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("opens an old Pay page link to a listing in the Bazaar", async () => {
    open(`/pay?listing=${LISTINGS.translate.id}`);
    await wait(10);
    expect(window.location.pathname).toBe("/bazaar");
    expect(within(listingPanel()).getByRole("heading", { name: /Translate a short text/ })).toBeTruthy();
    expect(within(listingPanel()).getByLabelText(/^text/)).toBeTruthy();
  });

  it("plays a Bazaar payment in the Lab, step by step, and again on request", async () => {
    open(`/bazaar?listing=${LISTINGS.history.id}`);
    await wait(10);
    fireEvent.click(within(listingPanel()).getByRole("button", { name: /^Pay up to/ }));
    await wait(200);
    fireEvent.click(within(listingPanel()).getByRole("link", { name: /Watch this payment in the Lab/ }));
    await wait(10);
    expect(window.location.pathname).toBe("/");
    expect(
      screen.getByText(/^Paid in the Bazaar · demo\.rail402\.dev\/history\?city=Istanbul&days=7$/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Playing/ })).toBeTruthy();
    await wait(STEP_MS * 10);
    expect(screen.getByRole("region", { name: /Proof · Stellar testnet/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Watch again" }));
    await wait(10);
    expect(screen.getByRole("button", { name: /Playing/ })).toBeTruthy();
  });
});
