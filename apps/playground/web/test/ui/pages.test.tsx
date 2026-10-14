import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../../src/app/App.tsx";
import { buildRequest } from "../../src/app/pages/Pay.tsx";
import { checklist } from "../../src/app/pages/Sell.tsx";
import { searchRequest } from "../../src/app/pages/Bazaar.tsx";
import { createFakeEngine } from "../../src/dev/fake-engine.ts";
import { LISTINGS, SELLER_CHECK } from "../fixtures/bazaar.ts";
import { IDS } from "../fixtures/ids.ts";

function open(path: string, wallet: "ready" | "none" = "ready"): void {
  window.history.replaceState(null, "", path);
  render(<App engine={createFakeEngine({ stepMs: 0, wallet })} />);
}

describe("pay page", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  it("pays the demo route and shows the result and what happened", async () => {
    open("/pay");
    // The demo route's price is read before paying; the button says it, the cap is beside it.
    const pay = await screen.findByRole("button", { name: "Pay 0.001 USDC and call" });
    expect(screen.getByText(/Your cap: 0.01 USDC per call/)).toBeTruthy();
    fireEvent.click(pay);
    const result = await screen.findByRole("region", { name: "Result" });
    await waitFor(() => {
      expect(result.textContent).toContain("Paid and delivered");
    });
    expect(result.textContent).toContain("Sponsored");
    expect(result.textContent).toContain("200 OK");
    expect(screen.getByText("What happened under the hood")).toBeTruthy();
  });

  it("runs every refusal check", async () => {
    open("/pay");
    fireEvent.click(screen.getByRole("button", { name: "Run all checks" }));
    await waitFor(
      () => {
        expect(document.querySelectorAll('.check[data-state="passed"]').length).toBe(7);
      },
      { timeout: 5_000 },
    );
    // Only the session check paid, once, and its row links that payment's transaction.
    const links = [...document.querySelectorAll(".check")].flatMap((row) =>
      [...row.querySelectorAll(".check-result a.tx-link")].map(
        (link) =>
          `${row.querySelector(".check-title")?.textContent ?? ""}: ${link.getAttribute("href") ?? ""}`,
      ),
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(
      /^Session budget used up: https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/,
    );
  });

  it("builds requests from the form, refusing malformed input with a code", () => {
    const values = {
      demoUrl: "https://d/weather?city=A",
      url: "",
      method: "GET" as const,
      body: "",
      params: "{}",
      cap: "0.01",
    };
    expect(buildRequest({ kind: "demo" }, values)).toEqual({
      target: "https://d/weather?city=A",
      method: "GET",
      cap: "0.01",
    });
    expect(buildRequest({ kind: "url" }, { ...values, url: "nope" })).toMatchObject({
      code: "playground_request_invalid",
    });
    expect(
      buildRequest({ kind: "url" }, { ...values, url: "https://a/x", method: "POST", body: '{"a":1}' }),
    ).toEqual({ target: "https://a/x", method: "POST", body: { a: 1 }, cap: "0.01" });
    expect(
      buildRequest({ kind: "url" }, { ...values, url: "https://a/x", method: "POST", body: "{" }),
    ).toMatchObject({
      code: "playground_request_invalid",
    });
    expect(buildRequest({ kind: "listing", id: "l1" }, { ...values, params: '{"city":"Izmir"}' })).toEqual({
      listingId: "l1",
      params: { city: "Izmir" },
      cap: "0.01",
    });
    expect(buildRequest({ kind: "listing", id: "l1" }, { ...values, params: "[1]" })).toMatchObject({
      code: "playground_request_invalid",
    });
  });

  it("loads a listing chosen in the Bazaar", async () => {
    open(`/pay?listing=${IDS.listing.forecast}`);
    expect(await screen.findByText("hourly_forecast · MCP")).toBeTruthy();
    expect(screen.getByLabelText("Tool arguments (JSON)")).toBeTruthy();
  });

  it("prefills the seller's example, but never over parameters the visitor typed", async () => {
    const withExample = {
      ...LISTINGS.forecast,
      input: { pathParams: [], example: { city: "Istanbul", hours: 12 }, required: ["city"] },
    };
    // The listing answers only when released, so the visitor can type before it loads.
    const openGated = (): (() => void) => {
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const engine = createFakeEngine({ stepMs: 0 });
      engine.listing = async () => {
        await gate;
        return withExample;
      };
      window.history.replaceState(null, "", `/pay?listing=${IDS.listing.forecast}`);
      render(<App engine={engine} />);
      return release;
    };
    const box = (): HTMLTextAreaElement => screen.getByRole<HTMLTextAreaElement>("textbox", { name: /JSON/ });

    openGated()();
    await screen.findByText("Required: city. The example comes from the seller.");
    expect(JSON.parse(box().value)).toEqual({ city: "Istanbul", hours: 12 });
    cleanup();

    const release = openGated();
    const typed = '{ "city": "Izmir", "hours": 6 }';
    fireEvent.change(box(), { target: { value: typed } });
    release();
    await screen.findByText("Required: city. The example comes from the seller.");
    expect(box().value).toBe(typed);
  });
});

describe("bazaar page", () => {
  afterEach(cleanup);

  it("searches on load and links each result to the Pay page", async () => {
    open("/bazaar");
    const link = (await screen.findAllByRole("link", { name: "Try" }))[0];
    expect(link?.getAttribute("href")).toMatch(/^\/pay\?listing=lst_/);
    expect(screen.getByText("Ranked by hybrid search")).toBeTruthy();
  });

  it("maps filters to the search request", () => {
    expect(searchRequest("q", "mcp")).toEqual({ query: "q", limit: 10, type: "mcp" });
    expect(searchRequest("q", "verified", "10")).toEqual({
      query: "q",
      limit: 10,
      minimumTrust: "domain_verified",
      cursor: "10",
    });
    expect(searchRequest("q", "upto")).toEqual({ query: "q", limit: 10 });
  });

  it("shows seller text as text", async () => {
    open("/bazaar");
    await screen.findAllByRole("link", { name: "Try" });
    expect(document.querySelector("table img, table script")).toBeNull();
  });
});

describe("sell page", () => {
  afterEach(cleanup);

  it("checks an endpoint and lists what passed", async () => {
    open("/sell");
    fireEvent.change(screen.getByLabelText("Endpoint URL"), {
      target: { value: "https://demo.rail402.dev/weather?city=Ankara" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Answers 402 with an x402 price")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Pay it once from here" }).getAttribute("href")).toBe(
      "/pay?url=https%3A%2F%2Fdemo.rail402.dev%2Fweather%3Fcity%3DAnkara",
    );
  });

  it("derives the checklist from the check's facts", () => {
    expect(checklist(SELLER_CHECK, "USDC").map((item) => item.state)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    const failing = checklist(
      { ...SELLER_CHECK, status: 200, required: null, validation: null, receivable: [], domain: null },
      "USDC",
    );
    expect(failing.map((item) => item.state)).toEqual(["fail", "fail", "unknown", "optional"]);
  });

  it("shows a listing by its payTo with its trust", async () => {
    open("/sell");
    fireEvent.change(screen.getByLabelText("Your payTo address"), { target: { value: IDS.playgroundPayTo } });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText("GET /lab/sell/forecast/:city")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Version history" }));
    expect(await screen.findByText("v2")).toBeTruthy();
  });

  it("keeps looking for a listing that is not published yet", async () => {
    open("/sell");
    fireEvent.change(screen.getByLabelText("Your payTo address"), {
      target: { value: `G${"A".repeat(55)}` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText(/No listing for this address yet/)).toBeTruthy();
    expect(screen.getByText("This refreshes every few seconds for two minutes.")).toBeTruthy();
  });
});

describe("agents page", () => {
  afterEach(cleanup);

  it("lists the tools and runs the example", async () => {
    open("/agents");
    expect(screen.getByText("search_stellar_resources")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run it on testnet" }));
    expect(await screen.findByText("paid 0.0012 USDC")).toBeTruthy();
    expect(screen.getByText(/"city":"Izmir"/)).toBeTruthy();
  });
});
