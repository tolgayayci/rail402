import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App, Boot } from "../../src/app/App.tsx";
import { CodedFailure } from "../../src/app/engine.tsx";
import { PAGES, documentTitle, labPath, movedTo, pageFor } from "../../src/app/routes.ts";
import { createFakeEngine } from "../../src/dev/fake-engine.ts";

describe("page shell", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  it("maps paths to pages, with the lab as the fallback", () => {
    expect(pageFor("/")).toBe("lab");
    expect(pageFor("/pay")).toBe("lab");
    expect(pageFor("/bazaar/")).toBe("bazaar");
    expect(pageFor("/missing")).toBe("lab");
    expect(documentTitle("sell")).toBe("Sell · Rail402 Playground");
    expect(documentTitle("lab")).toBe("Rail402 Playground");
  });

  it("sends a moved page to its new home with its query", () => {
    expect(movedTo("/pay", "?url=https%3A%2F%2Fa.example")).toBe("/?url=https%3A%2F%2Fa.example");
    expect(movedTo("/pay/", "")).toBe("/");
    expect(movedTo("/sell", "?x=1")).toBeNull();
    expect(movedTo("/pay", "?listing=abc&x=1")).toBe("/bazaar?listing=abc");
    expect(labPath("exact")).toBe("/");
    expect(labPath("upto", { url: "https://a.example/h?d=1", watch: "abc" })).toBe(
      "/?mode=upto&url=https%3A%2F%2Fa.example%2Fh%3Fd%3D1&watch=abc",
    );
    window.history.replaceState(null, "", "/pay?url=https%3A%2F%2Fa.example");
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    expect(`${window.location.pathname}${window.location.search}`).toBe("/?url=https%3A%2F%2Fa.example");
    const pages = within(screen.getByRole("navigation", { name: "Pages" }));
    expect(pages.getByRole("link", { current: "page" }).textContent).toBe("Lab");
  });

  it("renders the current page and marks it in the navigation", () => {
    window.history.replaceState(null, "", "/sell");
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Sell your API to agents");
    const nav = screen.getByRole("navigation", { name: "Pages" });
    const links = [...nav.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(PAGES.map((page) => page.path));
    expect(links.map((link) => link.textContent)).toEqual(["Lab", "Bazaar", "Sell", "Agents"]);
    expect(within(nav).getByRole("link", { current: "page" }).textContent).toBe("Sell");
    // The header: Docs, Explorer and GitHub, each opening in a new tab.
    const site = within(screen.getByRole("navigation", { name: "Rail402" }));
    const external = site.getAllByRole("link");
    expect(external.map((link) => link.textContent.replace(" (opens in a new tab)", "").trim())).toEqual([
      "Docs",
      "Explorer",
      "GitHub",
    ]);
    for (const link of external) expect(link.getAttribute("target")).toBe("_blank");
    expect(site.getByRole("link", { name: /Docs/ }).getAttribute("href")).toBe("https://docs.rail402.dev/");
    expect(site.getByRole("link", { name: /Explorer/ }).getAttribute("href")).toMatch(
      /^https:\/\/.+\/testnet$/,
    );
    expect(site.getByRole("link", { name: /GitHub/ }).getAttribute("href")).toBe(
      "https://github.com/tolgayayci/rail402",
    );
  });

  it("folds the header links into a menu that Escape closes", () => {
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    const button = screen.getByRole("button", { name: "Menu" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const menu = within(screen.getByRole("navigation", { name: "Rail402 links" }));
    expect(menu.getAllByRole("link")).toHaveLength(3);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("navigation", { name: "Rail402 links" })).toBeNull();
  });

  it("navigates without reloading", async () => {
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    within(screen.getByRole("navigation", { name: "Pages" }))
      .getByRole("link", { name: "Bazaar" })
      .click();
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Find paid APIs and tools on Stellar, and try them",
      }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe("/bazaar");
  });

  it("shows the network and the wallet", () => {
    render(<App engine={createFakeEngine({ stepMs: 0 })} />);
    expect(screen.getByTitle(/^stellar:testnet: test funds/).textContent).toBe("stellar:testnet");
    expect(screen.getByText("GBBU…TYQO")).toBeTruthy();
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

  it("does not render HTML from seller data", () => {
    const source = Object.values(
      import.meta.glob("../../src/**/*.tsx", { query: "?raw", import: "default", eager: true }),
    );
    expect(source.length).toBeGreaterThan(10);
    for (const text of source) expect(text).not.toContain("dangerouslySetInnerHTML");
  });
});
