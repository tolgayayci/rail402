/**
 * The overview, search and account pages without a database behind the reader: live search answers in
 * the shape the page script reads, search pages as links, redirects for exact matches, and pages that
 * stay whole when the overview's own reads are missing.
 */
import { describe, expect, it } from "vitest";
import { prefixUpperBound } from "../src/api/queries-a.ts";
import type { ComputedReport } from "../src/api/report.ts";
import { reportCatchingUp, units, type HomeModel } from "../src/web/pages/home.ts";
import type { PageContext } from "../src/web/pages/context.ts";
import { searchKind } from "../src/web/pages/search.ts";
import { bazaarClient, reportOf, type FakeListing } from "./bazaar.ts";
import { MemoryReader, TRANSACTIONS, rowOf, testApp } from "./web.ts";

const exact = rowOf(TRANSACTIONS["rail402-exact"]);
const upto = rowOf(TRANSACTIONS["rail402-upto"]);
const x402org = rowOf(TRANSACTIONS["x402org-exact-1"]);
const rows = [exact, upto, x402org];
const USDC = exact.asset.contract;
const WEATHER = "96eab768-fe71-47c4-9325-8907a4d6da78";

const listings: FakeListing[] = Array.from({ length: 12 }, (_, index) => ({
  id: index === 0 ? WEATHER : `96eab768-fe71-47c4-9325-${String(index).padStart(12, "0")}`,
  type: "http" as const,
  resource: `https://demo.example.org/weather/${String(index)}`,
  method: "GET",
  description: index === 0 ? "Current weather for a city" : `Weather report ${String(index)}`,
  payTo: exact.payTo,
  scheme: "exact",
  amount: exact.amount,
  asset: USDC,
  ...(index === 0 ? { paid: [exact] } : {}),
}));

const report = { document: reportOf(rows) } as unknown as ComputedReport;
const NOW = Date.parse(exact.closedAt) + 30 * 60_000;
const app = (bazaar = true) =>
  testApp({
    reader: new MemoryReader(rows),
    report,
    now: () => NOW,
    ...(bazaar ? { bazaar: bazaarClient(listings).client } : {}),
  });

describe("search kinds and key ranges", () => {
  it("tells hashes, addresses, their parts and words apart", () => {
    expect(searchKind("")).toBe("empty");
    expect(searchKind("ab")).toBe("short");
    expect(searchKind(exact.txHash)).toBe("tx");
    expect(searchKind(exact.payer)).toBe("address");
    expect(searchKind(exact.payer.toLowerCase())).toBe("address");
    expect(searchKind("0aab2a")).toBe("hash part");
    expect(searchKind("GBSV")).toBe("address part");
    expect(searchKind("gb3y")).toBe("address part");
    expect(searchKind("gold")).toBe("words");
    expect(searchKind("weather")).toBe("words");
    expect(searchKind("L3ELYP")).toBe("address part");
  });

  it("bounds a prefix range over its alphabet", () => {
    expect(prefixUpperBound("ab", "0123456789abcdef")).toBe("ac");
    expect(prefixUpperBound("af", "0123456789abcdef")).toBe("b");
    expect(prefixUpperBound("ff", "0123456789abcdef")).toBeUndefined();
    expect(prefixUpperBound("GA7", "234567ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toBe("GAA");
  });

  it("rounds 7-decimal amounts", () => {
    expect(units(18_107_123n)).toBe("1.81");
    expect(units(10_000n, 4)).toBe("0.001");
    expect(units(123_456_780_000_000n)).toBe("12,345,678");
  });
});

describe("live search", () => {
  const suggest = async (q: string, bazaar = true) => {
    const response = await app(bazaar).request(`/testnet/suggest?q=${encodeURIComponent(q)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toContain("max-age=15");
    return (await response.json()) as Record<string, unknown>;
  };

  it("offers ready searches for the empty box and asks for more on two characters", async () => {
    const empty = await suggest("");
    expect(empty["kind"]).toBe("empty");
    const tries = empty["tries"] as { q: string; icon: string; title: string; sub: string }[];
    expect(tries.some((entry) => entry.sub === "latest payment")).toBe(true);
    expect(tries.every((entry) => entry.icon.startsWith("M"))).toBe(true);
    const short = await suggest("ab");
    expect(short["kind"]).toBe("short");
    expect(short["hint"]).toContain("3 characters");
  });

  it("lists at most three of a group, with its whole count and the search page link", async () => {
    const found = await suggest("weather");
    expect(found["kind"]).toBe("words");
    expect(found["kindLabel"]).toBe("words");
    expect(found["searchHref"]).toBe("/testnet/search?q=weather");
    const groups = found["groups"] as { label: string; n: number; items: Record<string, unknown>[] }[];
    const services = groups.find((group) => group.label === "Services");
    expect(services?.n).toBe(12);
    expect(services?.items).toHaveLength(3);
    const first = services?.items[0];
    expect(first?.["title"]).toBe("Current weather for a city");
    expect(first?.["mark"]).toEqual([8, 15]);
    expect(first?.["href"]).toBe(`/testnet/resource/${WEATHER}`);
    expect(found["total"]).toBe(groups.reduce((sum, group) => sum + group.n, 0));
  });

  it("names registry facilitators and accounts, and says where else to look when nothing matches", async () => {
    const facilitator = await suggest("rail402");
    const groups = facilitator["groups"] as { label: string; items: { href: string }[] }[];
    expect(groups.find((group) => group.label === "Facilitators")?.items[0]?.href).toBe(
      "/testnet/facilitator/rail402",
    );
    const sponsor = await suggest(exact.fee.payer.slice(0, 6));
    const accounts = (
      sponsor["groups"] as { label: string; items: { href: string; badges: { cls: string }[] }[] }[]
    ).find((group) => group.label === "Accounts");
    expect(accounts?.items[0]?.href).toBe(`/testnet/account/${exact.fee.payer}`);
    expect(accounts?.items[0]?.badges.some((entry) => /\bfac\b/.test(entry.cls))).toBe(true);
    const none = await suggest("zzzzqq");
    expect(none["total"]).toBe(0);
    expect(none["noneTitle"]).toBe("No match on testnet");
    expect((none["links"] as { href: string }[]).map((link) => link.href)).toContain("/testnet/services");
  });
});

describe("search page", () => {
  it("redirects an exact hash, an address and a single named listing", async () => {
    const target = app();
    const hash = await target.request(`/testnet/search?q=${exact.txHash.toUpperCase()}`);
    expect(hash.headers.get("location")).toBe(`/testnet/tx/${exact.txHash}`);
    const account = await target.request(`/testnet/search?q=${exact.payer.toLowerCase()}`);
    expect(account.headers.get("location")).toBe(`/testnet/account/${exact.payer}`);
    const url = await target.request(
      `/testnet/search?q=${encodeURIComponent("https://demo.example.org/weather/0")}`,
    );
    expect(url.headers.get("location")).toBe(`/testnet/resource/${WEATHER}`);
  });

  it("lists results ten a page with type tabs and a pager as links", async () => {
    const response = await app().request("/testnet/search?q=weather");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("looks like: words");
    expect(html).toContain('href="/testnet/search?q=weather&amp;type=services"');
    expect(html).toContain("Services · 12");
    expect(html.match(/class="srow"/g)).toHaveLength(10);
    expect(html).toContain('href="/testnet/search?q=weather&amp;page=2"');
    expect(html).toContain("<mark>weather</mark>");
    const second = await (await app().request("/testnet/search?q=weather&page=2")).text();
    expect(second.match(/class="srow"/g)).toHaveLength(2);
    const typed = await (await app().request("/testnet/search?q=weather&type=services")).text();
    expect(typed).not.toContain('class="shd"');
  });

  it("answers no match with the other network, stellar.expert and the Bazaar", async () => {
    const response = await testApp({ reader: new MemoryReader(rows), report, pubnet: true }).request(
      "/testnet/search?q=zzzzqq",
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const html = await response.text();
    expect(html).toContain("No match on testnet");
    expect(html).toContain('href="/search?q=zzzzqq"');
    expect(html).toContain("https://stellar.expert/explorer/testnet");
    expect(html).toContain('href="/testnet/services"');
  });

  it("opens with starting points when empty", async () => {
    const html = await (await app().request("/testnet/search")).text();
    expect(html).toContain("Latest payment");
    expect(html).toContain('class="mnc"');
  });
});

describe("overview and account without the page reads", () => {
  it("renders the overview with its search box, range and top-list links", async () => {
    const html = await (await app().request("/testnet?range=7d&top=buyers")).text();
    expect(html).toContain('data-suggest="/testnet/suggest"');
    expect(html).toContain('action="/testnet/search"');
    expect(html).toContain('href="/testnet?top=buyers#per-day"');
    expect(html).toContain('href="/testnet?range=7d#top"');
    expect(html).toContain("Who settles");
    expect(html).toContain("Current weather for a city");
    expect(html).toContain("In the Bazaar");
    const mainnet = await (
      await testApp({ reader: new MemoryReader(rows), report, pubnet: true, now: () => NOW }).request("/")
    ).text();
    expect(mainnet).toContain("x402 payments on Stellar mainnet");
    expect(mainnet).not.toContain("In the Bazaar");
  });

  it("shows an account's roles and refuses unknown parameters", async () => {
    const target = app();
    const html = await (await target.request(`/testnet/account/${exact.payTo}`)).text();
    expect(html).toContain(">seller<");
    expect(html).toContain("Payments received");
    expect(html).toContain(`data-copy="${exact.payTo}"`);
    expect(html).toContain(`https://stellar.expert/explorer/testnet/account/${exact.payTo}`);
    expect((await target.request(`/testnet/account/${exact.payTo}?cursor=1`)).status).toBe(400);
    expect((await target.request(`/testnet/account/${exact.payTo}?page=0`)).status).toBe(400);
    const sponsor = await (await target.request(`/testnet/account/${exact.fee.payer}`)).text();
    expect(sponsor).toContain("Rail402 fee payer");
  });
});

describe("who settles", () => {
  const context = (detachedFrom: number | null, to: number) =>
    ({ report: { detachedFrom, range: { from: 2, to } } }) as unknown as PageContext;
  const model = (ledger: number | null) =>
    ({ overview: { state: { ledger, closedAt: null, pending: true } } }) as unknown as HomeModel;

  it("says catching up only while the report stops well before the newest indexed ledger", () => {
    expect(reportCatchingUp(context(null, 1_000), model(5_000))).toBe(false);
    expect(reportCatchingUp(context(1_001, 1_000), model(1_500))).toBe(false);
    expect(reportCatchingUp(context(1_001, 1_000), model(1_000 + 721))).toBe(true);
    expect(reportCatchingUp(context(1_001, 1_000), model(null))).toBe(true);
  });
});
