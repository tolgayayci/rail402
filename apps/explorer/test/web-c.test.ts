/**
 * The facilitator, Bazaar, service and seller pages: real registry and report data, Bazaar listings in
 * every state, filters and paging as links, untrusted strings as text, strict CSP everywhere.
 */
import { describe, expect, it } from "vitest";
import type { SettlementRow } from "@rail402.dev/x402-index";
import type { FacilitatorStats } from "../src/api/queries-c.ts";
import { databaseOf } from "../src/api/queries-c.ts";
import type { ComputedReport } from "../src/api/report.ts";
import { SCRIPT } from "../src/web/assets.ts";
import { CONTENT_SECURITY_POLICY } from "../src/web/csp.ts";
import { NETWORK_VIEWS } from "../src/web/format.ts";
import type { PageContext } from "../src/web/pages/context.ts";
import { facilitatorPage, facilitatorsPage, usdcShort } from "../src/web/pages/facilitators.ts";
import { listingName } from "../src/web/pages/services.ts";
import { bazaarClient, reportOf, type BazaarMode, type FakeListing } from "./bazaar.ts";
import { MemoryReader, REGISTRY, TRANSACTIONS, rowOf, testApp } from "./web.ts";

const exact = rowOf(TRANSACTIONS["rail402-exact"]);
const upto = rowOf(TRANSACTIONS["rail402-upto"]);
const x402org = rowOf(TRANSACTIONS["x402org-exact-1"]);
const shaped: SettlementRow = {
  ...exact,
  txHash: "a".repeat(64),
  innerHash: null,
  ledger: exact.ledger - 10,
  attribution: { ...exact.attribution, tier: "shaped", facilitatorId: null, evidenceUrl: null },
};
const rows = [exact, upto, x402org, shaped];
const USDC = exact.asset.contract;
const WEATHER = "96eab768-fe71-47c4-9325-8907a4d6da78";
const TOOL = "a26c5676-c0f7-416c-87c1-10d776040246";
const METERED = "c3a1e0f2-0000-4000-8000-000000000001";
const PENDING = "d4b2f1e3-0000-4000-8000-000000000002";

const listings: FakeListing[] = [
  {
    id: WEATHER,
    type: "http",
    resource: "https://demo.example.org/weather",
    method: "GET",
    description: "Current weather for a city",
    payTo: exact.payTo,
    scheme: "exact",
    amount: "10000",
    asset: USDC,
    info: {
      input: { type: "http", method: "GET", queryParams: { city: "Istanbul" } },
      output: { type: "json", example: { city: "Istanbul", temperature: 21 } },
    },
    paid: [exact],
  },
  {
    id: TOOL,
    type: "mcp",
    resource: "https://demo.example.org/mcp",
    toolName: "air_quality",
    description: '<script>alert("listing")</script> quality',
    serviceName: "<b>Demo</b> seller",
    payTo: exact.payTo,
    scheme: "exact",
    amount: "2000000",
    asset: USDC,
    info: {
      input: {
        type: "mcp",
        example: { city: "Izmir" },
        inputSchema: { type: "object", required: ["city"], properties: { city: {}, pollutant: {} } },
      },
    },
    private: true,
  },
  {
    id: METERED,
    type: "http",
    resource: "https://other.example.org/history",
    method: "GET",
    description: "Weather history, metered",
    payTo: x402org.payTo,
    scheme: "upto",
    amount: "100000",
    asset: USDC,
    paid: [x402org],
  },
  {
    ...{ id: PENDING, type: "http", resource: "https://x.example.org/p", payTo: exact.payTo },
    scheme: "exact",
    amount: "10000",
    asset: USDC,
    state: "pending",
  },
];

const report = { document: reportOf(rows) } as unknown as ComputedReport;
const NOW = Date.parse(exact.closedAt) + 21 * 60_000;

function app(mode: BazaarMode | "none" = "up", data: readonly SettlementRow[] = rows) {
  const bazaar = mode === "none" ? undefined : bazaarClient(listings, mode);
  return testApp({
    reader: new MemoryReader(data),
    report: data.length === 0 ? undefined : report,
    now: () => NOW,
    ...(bazaar === undefined ? {} : { bazaar: bazaar.client }),
  });
}

async function page(target: ReturnType<typeof app>, path: string, status = 200) {
  const response = await target.request(path);
  expect(response.status, path).toBe(status);
  expect(response.headers.get("content-security-policy"), path).toBe(CONTENT_SECURITY_POLICY);
  const html = await response.text();
  const own = `<script src="${SCRIPT.path}" defer=""></script>`;
  expect(html.replace(own, ""), path).not.toMatch(/<script|<style|style="| on[a-z]+="/i);
  return html;
}

const context = (): PageContext => ({
  layout: {
    view: NETWORK_VIEWS["stellar:testnet"],
    networks: [NETWORK_VIEWS["stellar:testnet"]],
    versions: { rules: "v2", registry: "test" },
  },
  registry: REGISTRY,
  report: report.document,
  now: NOW,
  bazaar: true,
});

describe("facilitator pages", () => {
  it("lists every registry facilitator and the unregistered group, with the registry's accounts", async () => {
    const html = await page(app(), "/testnet/facilitators");
    for (const entry of REGISTRY.document.facilitators)
      expect(html).toContain(`/testnet/facilitator/${entry.id}"`);
    expect(html).toContain('href="/testnet/facilitator/unregistered"');
    expect(html).toContain("Not registered");
    expect(html).toContain("Registered accounts");
    expect(html).toContain("Senders");
    expect(html).toContain("A payment counts when");
    expect(html).toContain('href="https://docs.rail402.dev/explorer"');
    // Without the database the page still renders, with no invented numbers.
    expect(html).toContain("Payments per day are not available");
  });

  it("renders each facilitator, the unregistered group, and refuses unknown ids and parameters", async () => {
    for (const id of ["rail402", "x402-org", "unregistered"]) {
      const html = await page(app(), `/testnet/facilitator/${id}`);
      expect(html).toContain("Latest payments");
      expect(html).toContain(id === "unregistered" ? "Why these are apart" : "registered");
    }
    const rail = await page(app(), "/testnet/facilitator/rail402");
    expect(rail).toContain(`/testnet/tx/${exact.txHash}`);
    expect(rail).toContain('href="/testnet/payments?facilitator=rail402"');
    const apart = await page(app(), "/testnet/facilitator/unregistered");
    expect(apart).toContain(`/testnet/tx/${shaped.txHash}`);
    expect(apart).toContain('href="/testnet/payments?facilitator=shaped"');
    expect(apart).not.toContain("Registry proof");
    expect((await app().request("/testnet/facilitator/nobody")).status).toBe(404);
    expect((await app().request("/testnet/facilitator/rail402?cursor=1")).status).toBe(400);
  });

  it("shows the index's breakdowns when the database answers", () => {
    const stats: FacilitatorStats = {
      id: "rail402",
      payments: 4,
      feeStroops: 40_000n,
      sponsored: 4,
      lastAt: exact.closedAt,
      exact: 3,
      upto: 1,
      firstAt: exact.closedAt,
      payers: 3,
      contractPayers: 1,
      sellers: 2,
      uptoAmount: 21n,
      uptoMax: 100n,
      feePayers: [{ address: exact.fee.payer, payments: 4 }],
      feePayerCount: 1,
      senders: [{ address: exact.payer, payments: 4 }],
      senderCount: 1,
      topSellers: [{ address: exact.payTo, payments: 3, payers: 2, usdc: "30000" }],
      tokens: [{ contract: USDC, code: "USDC", issuer: exact.asset.issuer, verified: true, payments: 4 }],
    };
    const day = exact.closedAt.slice(0, 10);
    const html = facilitatorPage(context(), {
      facilitator: REGISTRY.facilitator("rail402"),
      stats,
      days: [{ day, id: "rail402", payments: 4 }],
      chartEnd: day,
      latest: [exact],
    });
    expect(html).toContain("0.004 XLM");
    expect(html).toContain("21% of the max");
    expect(html).toContain("2 accounts · 1 contracts");
    expect(html).toContain("100% of payments");
    expect(html).toContain(`/testnet/account/${exact.payTo}`);
    const list = facilitatorsPage(context(), {
      summaries: [
        {
          id: "rail402",
          payments: 4,
          feeStroops: 40_000n,
          sponsored: 4,
          lastAt: exact.closedAt,
          exact: 3,
          upto: 1,
        },
      ],
      days: [{ day, id: "rail402", payments: 4 }],
      chartEnd: day,
    });
    expect(list).toContain("buyers paid 0");
    expect(list).toContain("21 min ago");
  });

  it("formats volumes for tables", () => {
    expect(usdcShort("0")).toBe("0");
    expect(usdcShort("1")).toBe("<0.01");
    expect(usdcShort("1234567890")).toBe("123.46");
    expect(databaseOf(new MemoryReader([]))).toBeUndefined();
  });
});

describe("the Bazaar", () => {
  it("lists published services with paid calls, filters as links and the search as a GET form", async () => {
    const html = await page(app(), "/testnet/services");
    expect(html).toContain("3 services<");
    expect(html).toContain("2 sellers<");
    expect(html).not.toContain("x.example.org");
    expect(html).toContain(`href="/testnet/resource/${WEATHER}"`);
    expect(html).toContain('action="/testnet/services"');
    expect(html).toContain('href="/testnet/services?type=mcp"');
    expect(html).toContain('href="/testnet/services?sort=cheap"');
    expect(html).toContain('href="/testnet/services?view=cards"');
    expect(html).toContain('for="oc-ftog"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;Demo&lt;/b&gt; seller");
  });

  it("narrows by filters and words, shows chips that remove them, and pages ten at a time", async () => {
    const tools = await page(app(), "/testnet/services?type=mcp&view=cards");
    expect(tools).toContain(`href="/testnet/resource/${TOOL}"`);
    expect(tools).not.toContain(`href="/testnet/resource/${WEATHER}"`);
    expect(tools).toContain('aria-label="Remove filter Agent tools"');
    expect(tools).toContain('class="lc"');
    const upto = await page(app(), "/testnet/services?scheme=upto&q=history");
    expect(upto).toContain(`href="/testnet/resource/${METERED}"`);
    expect(upto).not.toContain(`href="/testnet/resource/${TOOL}"`);
    const none = await page(app(), "/testnet/services?q=nothing-matches");
    expect(none).toContain("No services match");
    expect((await app().request("/testnet/services?cursor=x")).status).toBe(400);
  });

  it("says so in one line when there is no Bazaar or it is down", async () => {
    expect(await page(app("none"), "/testnet/services")).toContain("has no Bazaar yet");
    expect(await page(app("down"), "/testnet/services")).toContain("The Bazaar did not answer");
  });

  it("names listings from their own words, bounded", () => {
    expect(
      listingName({
        id: WEATHER,
        type: "http",
        resource: "https://a.example/x",
        method: "GET",
        payTo: "G",
        scheme: "exact",
        amount: "1",
        asset: "C",
        network: "n",
        lastUpdated: "",
        description: "Daily weather history for a city, metered: 0.0003",
      }),
    ).toBe("Daily weather history for a city");
    expect(
      listingName({
        id: WEATHER,
        type: "mcp",
        resource: "https://a.example/mcp",
        toolName: "peek",
        payTo: "G",
        scheme: "exact",
        amount: "1",
        asset: "C",
        network: "n",
        lastUpdated: "",
      }),
    ).toBe("peek");
  });
});

describe("service and seller pages", () => {
  it("shows how to call a service, its trust, history and the seller's other services", async () => {
    const html = await page(app(), `/testnet/resource/${WEATHER}`);
    expect(html).toContain(`href="/testnet/seller/${exact.payTo}"`);
    expect(html).toContain("In the address");
    expect(html).toContain("Istanbul");
    expect(html).toContain("Domain names this seller");
    expect(html).toContain("Service checked");
    expect(html).toContain(`/testnet/tx/${exact.txHash}`);
    expect(html).toContain("More from");
    expect(html).toContain(`href="/testnet/resource/${TOOL}"`);
    expect(html).toContain('href="https://playground.rail402.dev/"');
    const tool = await page(app(), `/testnet/resource/${TOOL}`);
    expect(tool).toContain("As tool arguments");
    expect(tool).toContain("pollutant · optional");
    expect(tool).toContain("Usage is private");
  });

  it("shows a pending listing's state and history only", async () => {
    const html = await page(app(), `/testnet/resource/${PENDING}`);
    expect(html).toContain("not published: pending");
    for (const text of ["How to call", "Try in Playground", "More from"]) expect(html).not.toContain(text);
  });

  it("lists a seller's services with its totals, and refuses accounts that sell nothing", async () => {
    const html = await page(app(), `/testnet/seller/${exact.payTo}`);
    expect(html).toContain(`href="/testnet/account/${exact.payTo}"`);
    expect(html).toContain(`href="/testnet/resource/${WEATHER}"`);
    expect(html).toContain(`href="/testnet/resource/${TOOL}"`);
    expect(html).not.toContain(`href="/testnet/resource/${METERED}"`);
    expect(html).toContain("Services by this seller");
    expect((await app().request(`/testnet/seller/${x402org.payer}`)).status).toBe(404);
    expect((await app().request("/testnet/seller/nope")).status).toBe(404);
    expect((await app("none").request(`/testnet/seller/${exact.payTo}`)).status).toBe(404);
    expect((await app().request(`/testnet/seller/${exact.payTo}?x=1`)).status).toBe(400);
  });
});
