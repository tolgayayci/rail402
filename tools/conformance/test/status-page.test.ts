// @vitest-environment happy-dom
/**
 * The status page: one inline script, allowed by its own SHA-256 in the page's Content-Security-Policy
 * (the served header is built from the same script), every other file from its own origin, and data from
 * the check history written into the page only as text.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInThisContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const site = join(import.meta.dirname, "../../../deploy/status/site");
const html = readFileSync(join(site, "index.html"), "utf8");
const checks = readFileSync(join(site, "../upptimerc.yml"), "utf8");
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";

/** The parts of the simulated DOM the test reads; the project compiles without the DOM library. */
interface Node {
  readonly textContent: string | null;
  hidden?: boolean;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<Node>;
  dispatchEvent(event: unknown): boolean;
  focus(): void;
}
const { document, window } = globalThis as unknown as {
  readonly document: {
    readonly body: { innerHTML: string };
    getElementById(id: string): Node | null;
    querySelector(selector: string): Node | null;
    querySelectorAll(selector: string): ArrayLike<Node>;
  };
  readonly window: {
    readonly happyDOM: { setURL(url: string): void };
    readonly MouseEvent: new (type: string, init: { bubbles: boolean }) => unknown;
    readonly KeyboardEvent: new (type: string, init: { key: string; bubbles: boolean }) => unknown;
  };
};

const today = new Date().toISOString().slice(0, 10);
const T = "https://testnet.rail402.dev";
const M = "https://mainnet.rail402.dev";

/** Runs the page as status.rail402.dev, where it reads the served history (null: the fetch fails). */
async function load(
  summary: unknown[] | null,
  incidents: unknown[] = [],
  lastModified?: string,
): Promise<void> {
  vi.stubGlobal("fetch", (url: string) => {
    if (url.startsWith("history/") && summary === null) {
      return Promise.resolve(new Response("", { status: 503 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(url.startsWith("history/") ? summary : incidents), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(lastModified === undefined ? {} : { "last-modified": lastModified }),
        },
      }),
    );
  });
  window.happyDOM.setURL("https://status.rail402.dev/");
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? "";
  document.body.innerHTML = body.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  runInThisContext(scripts[0]?.[2] ?? "");
  await vi.waitFor(() => {
    expect(document.getElementById("overall")?.textContent).not.toBe("Loading status…");
  });
}
const text = (id: string): string => document.getElementById(id)?.textContent ?? "";
const all = (selector: string): Node[] => Array.from(document.querySelectorAll(selector));
/** The rows of one network's section, in order: name and badge. */
const rowsOf = (net: "pubnet" | "testnet"): [string, string][] =>
  all(`#ledger-${net} .row`).map((row) => [
    row.querySelectorAll(".who-name")[0]?.textContent ?? "",
    Array.from(row.querySelectorAll(".r4-badge")).at(-1)?.textContent ?? "",
  ]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the status page", () => {
  it("allows its one inline script by hash and nothing else", () => {
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.[1]?.trim()).toBe("");
    const hash = createHash("sha256")
      .update(scripts[0]?.[2] ?? "", "utf8")
      .digest("base64");
    expect(policy).toContain(`script-src 'sha256-${hash}'`);
    expect(policy).toMatch(/default-src 'self'/);
    expect(policy).toMatch(/object-src 'none'; base-uri 'none'; form-action 'none'/);
    expect(policy).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
  });

  it("loads its styles, fonts and images from its own origin only", () => {
    for (const directive of ["style-src 'self'", "font-src 'self'", "img-src 'self'", "connect-src 'self'"]) {
      expect(policy).toContain(`${directive};`);
    }
    expect(policy).not.toMatch(/https?:|unsafe-inline|data:/);
    // Inline styles would need 'unsafe-inline'; inline handlers are refused at install.
    expect(html).not.toMatch(/<style\b|\sstyle\s*=|\son[a-z]+\s*=/i);
    const local = [...html.matchAll(/\s(?:href|src)="([^"#:]+)"/g)].map((match) => match[1] ?? "");
    expect(local).toEqual(expect.arrayContaining(["design/tokens.css", "design/rail402.css", "status.css"]));
    for (const path of local) expect(existsSync(join(site, path)), path).toBe(true);
    // The design system's stylesheets name their source and find their fonts next to them.
    for (const sheet of ["design/tokens.css", "design/rail402.css"]) {
      const css = readFileSync(join(site, sheet), "utf8");
      expect(css.split("\n")[0], sheet).toMatch(/^\/\* Copied verbatim from the Rail402 design system/);
      for (const [, url] of css.matchAll(/url\("([^"]+)"\)/g)) {
        expect(existsSync(join(site, dirname(sheet), url ?? "")), url).toBe(true);
      }
    }
  });

  it("shows a row for every configured check", () => {
    const configured = [...checks.matchAll(/^ {4}url: (\S+)$/gm)].map((match) => match[1] ?? "");
    expect(configured.length).toBeGreaterThan(15);
    for (const url of configured) {
      // The page writes the two facilitator hosts as T and M.
      const written = url
        .replace(/^https:\/\/testnet\.rail402\.dev(.*)$/, 'T + "$1"')
        .replace(/^https:\/\/mainnet\.rail402\.dev(.*)$/, 'M + "$1"');
      expect(html, url).toContain(written.startsWith("https://") ? `"${written}"` : written);
    }
  });

  it("writes the check history into the page as text only", async () => {
    const hostile = '"><img src=x id=injected onerror=alert(1)>';
    const summary = [
      {
        name: "Facilitator",
        url: `${T}/supported`,
        status: "down",
        uptime: "99.00%",
        uptimeWeek: "98.00%",
        timeDay: hostile,
        dailyMinutesDown: { [today]: hostile },
      },
    ];
    await load(summary, [{ title: hostile, start: "2026-10-26T10:00Z", summary: hostile }]);
    expect(text("overall")).toBe("Testnet facilitator is down");
    expect(document.getElementById("injected")).toBeNull();
    // The header's mark is the only image.
    expect(all("img").map((img) => img.getAttribute("src"))).toEqual(["design/logos/rail402-mark.svg"]);
    // Not a number: no minutes are claimed for the day.
    const facilitator = all("#ledger-testnet .bars")[0];
    const cells = Array.from(facilitator?.querySelectorAll(".day") ?? []);
    expect(cells.at(-1)?.getAttribute("class")).toBe("day");
    expect(text("incident-list")).toContain(hostile);
  });

  it("shows recorded uptime cut to two decimals, never rounded up", async () => {
    await load([
      { url: `${T}/supported`, status: "up", uptime: "99.999%", uptimeWeek: "98.959%", dailyMinutesDown: {} },
      { url: `${T}/health`, status: "up", uptime: "100.00%", uptimeWeek: "99.5%", dailyMinutesDown: {} },
      { url: `${M}/supported`, status: "up", uptime: "100%", uptimeWeek: "99.995%", dailyMinutesDown: {} },
    ]);
    expect(text("fig-testnet")).toBe("98.95%");
    expect(text("fig-mainnet")).toBe("99.99%");
    expect(text("ledger-testnet")).toContain("99.99%");
    expect(text("ledger-testnet")).toContain("99.50%");
    expect(text("ledger-testnet")).not.toContain("98.96%");
  });

  it("shows mainnet first with the same checks and figures as testnet", async () => {
    await load([
      { url: `${M}/supported`, status: "down", uptimeWeek: "98.95%", dailyMinutesDown: { [today]: 64 } },
      { url: `${M}/mcp/pubnet`, status: "up", uptimeWeek: "100.00%", dailyMinutesDown: {} },
      {
        url: "https://explorer.rail402.dev/health",
        status: "up",
        uptimeWeek: "100.00%",
        dailyMinutesDown: {},
      },
    ]);
    // The band's strips and the board's groups both put mainnet first.
    expect(all("#strips .strip-title").map((title) => title.textContent)).toEqual(["Mainnet", "Testnet"]);
    expect(all(".board .group").map((group) => group.getAttribute("id"))).toEqual([
      "group-pubnet",
      "group-testnet",
    ]);
    expect(rowsOf("pubnet")).toEqual([
      ["Facilitator", "Down"],
      ["Network readiness", "No data"],
      ["Service health", "No data"],
      ["Bazaar catalog", "No data"],
      ["Bazaar search", "No data"],
      ["Hosted MCP", "Up"],
      ["Demo seller", "No data"],
      ["Explorer", "Up"],
      ["Documentation", "No data"],
    ]);
    // The Explorer serves both networks: its one check shows in both sections.
    expect(rowsOf("testnet")).toContainEqual(["Explorer", "Up"]);
    expect(text("overall")).toBe("Mainnet facilitator is down");
    expect(text("sum-pubnet")).toBe("9 checks · 1 down");
    expect(text("fig-mainnet")).toBe("98.95%");
    expect(text("ledger-pubnet")).not.toMatch(/not live/i);
  });

  it("says every state in words, and a day's state in its shape as well as its colour", async () => {
    await load([
      { url: `${T}/supported`, status: "down", uptimeWeek: "98.95%", dailyMinutesDown: { [today]: 64 } },
      {
        url: `${T}/ready/testnet`,
        status: "degraded",
        uptimeWeek: "99.90%",
        dailyMinutesDown: { [today]: 12 },
      },
      { url: `${T}/health`, status: "up", uptimeWeek: "100.00%", dailyMinutesDown: {} },
    ]);
    expect(rowsOf("testnet").slice(0, 4)).toEqual([
      ["Facilitator", "Down"],
      ["Network readiness", "Slow"],
      ["Service health", "Up"],
      ["Bazaar catalog", "No data"],
    ]);
    expect(text("overall-badge")).toBe("Major outage");
    const latest = all("#ledger-testnet .bars").map((bars) =>
      Array.from(bars.querySelectorAll(".day")).at(-1)?.getAttribute("class"),
    );
    expect(latest.slice(0, 4)).toEqual(["day down", "day partial", "day", "day nodata"]);
    expect(all("#ledger-testnet .bars")[0]?.getAttribute("aria-label")).toContain("1 with more");
  });

  it("shows a day's date, minutes down and related incident on hover and from the keyboard", async () => {
    await load(
      [{ url: `${T}/supported`, status: "down", uptimeWeek: "98.95%", dailyMinutesDown: { [today]: 64 } }],
      [{ title: "Testnet facilitator does not answer", start: `${today}T09:40Z` }],
    );
    const tip = document.getElementById("day-tip");
    const bars = all("#ledger-testnet .bars")[0];
    const cells = Array.from(bars?.querySelectorAll(".cell") ?? []);
    cells.at(-1)?.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
    expect(tip?.hidden).toBe(false);
    expect(tip?.textContent).toContain("Major outage1 h 4 min down");
    expect(tip?.textContent).toContain("RelatedTestnet facilitator does not answer");

    bars?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(tip?.textContent).toContain("No downtime0 min down");
    expect(tip?.textContent).not.toContain("Related");
    bars?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(tip?.hidden).toBe(true);
  });

  it("says plainly when the data could not be fetched, and when no check has run yet", async () => {
    await load([]);
    expect(text("overall")).toBe("No checks recorded yet");
    expect(rowsOf("pubnet").every(([, badge]) => badge === "No data")).toBe(true);

    await load(null);
    expect(text("overall")).toBe("Status could not be fetched");
    expect(text("overall-notice")).toContain("data_unavailable");
    // Every row stays, with no figure and no state claimed for it.
    expect(rowsOf("pubnet").every(([, badge]) => badge === "Unknown")).toBe(true);
    expect(all(".row .day:not(.nodata)")).toHaveLength(0);
    expect(text("ledger-testnet")).not.toMatch(/\d+\.\d\d%/);
    expect(text("fig-mainnet")).toBe("—");
    expect(text("fig-open")).toBe("—");
    expect(text("incident-list")).toContain("Incidents could not be fetched with the check data.");
  });

  it("shows each incident as a card with its state, title, description and times", async () => {
    await load(
      [],
      [
        { title: "Open", start: "2026-10-26T10:00Z", summary: "What is affected." },
        { title: "Closed", start: "2026-10-25T10:00Z", end: "2026-10-25T11:20Z" },
      ],
    );
    const cards = all("#incident-list .incident").map((card) => [
      Array.from(card.querySelectorAll(".r4-badge"))[0]?.textContent,
      Array.from(card.querySelectorAll(".r4-card-title"))[0]?.textContent,
      Array.from(card.querySelectorAll(".r4-card-body"))[0]?.textContent ?? null,
      Array.from(card.querySelectorAll("dd")).map((dd) => dd.textContent),
    ]);
    expect(cards[0]?.slice(0, 3)).toEqual(["Ongoing", "Open", "What is affected."]);
    expect(cards[0]?.[3]?.slice(0, 2)).toEqual(["10:00 UTC", "not yet"]);
    expect(cards[0]?.[3]?.[2]).toMatch(/ so far$/);
    expect(cards[1]).toEqual(["Resolved", "Closed", null, ["10:00 UTC", "11:20 UTC", "1 h 20 min"]]);
    // Grouped by month, dated in words; an ongoing one is also named in the band.
    expect(all("#incident-list .month-name").map((name) => name.textContent)).toContain("October 2026");
    expect(all("#incident-list .incident-date").map((date) => date.textContent)).toEqual([
      "26 October 2026",
      "25 October 2026",
    ]);
    expect(text("fig-open")).toBe("1");
    expect(text("overall-notice")).toContain("OngoingOpensince 26 October 2026, 10:00 UTC");
  });

  it("names the one affected check, the network it spares and when the checks last ran", async () => {
    await load(
      [
        { url: `${T}/supported`, status: "down", uptimeWeek: "98.95%", dailyMinutesDown: { [today]: 64 } },
        { url: `${M}/supported`, status: "up", uptimeWeek: "100.00%", dailyMinutesDown: {} },
      ],
      [],
      "Wed, 04 Nov 2026 14:05:00 GMT",
    );
    expect(text("overall")).toBe("Testnet facilitator is down");
    expect(text("overall-sub")).toMatch(
      /^1 of \d+ checks down · mainnet is not affected · last run 4 November 2026, 14:05 UTC$/,
    );
    expect(text("sum-testnet")).toBe("10 checks · 1 down");
    expect(all("#ledger-testnet .row")[0]?.getAttribute("data-state")).toBe("down");

    await load([{ url: `${T}/supported`, status: "up", uptimeWeek: "100.00%", dailyMinutesDown: {} }]);
    expect(text("overall")).toBe("All systems operational");
    // Without a Last-Modified header no run time is claimed.
    expect(text("overall-sub")).not.toContain("last run");
    expect(text("incident-list")).toContain("No incidents posted.");
  });

  it("offers a GitHub issue and an email from its help dialog", () => {
    const dialog = /<dialog\b[\s\S]*?<\/dialog>/.exec(html)?.[0] ?? "";
    expect(dialog).toContain('href="https://github.com/tolgayayci/rail402/issues/new"');
    expect(dialog).toContain('href="mailto:tolga@yk-labs.com"');
    // Links that leave the page open a new tab without handing it this page.
    for (const [link] of html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) {
      expect(link).toContain('rel="noopener"');
    }
  });
});
