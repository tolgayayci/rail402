import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App, Boot } from "../../src/app/App.tsx";
import { CodedFailure } from "../../src/app/engine.tsx";
import { PAGES, documentTitle, pageFor } from "../../src/app/routes.ts";
import { createFakeEngine } from "../../src/dev/fake-engine.ts";

describe("page shell", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  it("maps paths to pages, with the lab as the fallback", () => {
    expect(pageFor("/")).toBe("lab");
    expect(pageFor("/pay")).toBe("pay");
    expect(pageFor("/bazaar/")).toBe("bazaar");
    expect(pageFor("/missing")).toBe("lab");
    expect(documentTitle("sell")).toBe("Sell · Rail402 Playground");
  });

  it("renders the current page and marks it in the navigation", () => {
    window.history.replaceState(null, "", "/sell");
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Charge for your API");
    const nav = screen.getByRole("navigation", { name: "Pages" });
    const hrefs = [...nav.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([...PAGES.map((page) => page.path), "https://docs.rail402.dev/"]);
    expect(screen.getByRole("link", { current: "page" }).textContent).toBe("Sell");
  });

  it("navigates without reloading", async () => {
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    screen.getByRole("link", { name: "Bazaar" }).click();
    expect(await screen.findByRole("heading", { level: 1, name: "Bazaar" })).toBeTruthy();
    expect(window.location.pathname).toBe("/bazaar");
  });

  it("shows the network, the wallet and the session budget", () => {
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    expect(screen.getByText("Stellar testnet")).toBeTruthy();
    expect(screen.getByText("GBBU…TYQO")).toBeTruthy();
    expect(screen.getByRole("meter").getAttribute("aria-label")).toBe(
      "Session budget: 0 spent, 0 held, 1 of 1 USDC left",
    );
  });

  it("shows the code and reason when the page cannot start", async () => {
    render(
      <Boot
        load={() =>
          Promise.reject(
            new CodedFailure({
              code: "playground_config_unavailable",
              reason: "No configuration.",
              retryable: true,
            }),
          )
        }
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("playground_config_unavailable");
  });

  it("never shows an unknown error's text", async () => {
    render(<Boot load={() => Promise.reject(new Error("secret internals"))} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("playground_unexpected_error");
    expect(alert.textContent).not.toContain("secret internals");
  });
});
