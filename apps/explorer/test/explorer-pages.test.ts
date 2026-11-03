/**
 * Every page in every state it can be in: with the Bazaar up, down, or without the usage routes;
 * with no data, with upto, unattributed and muxed rows. Pages never break without the Bazaar, never
 * count its data, and never render its strings as markup.
 */
import { describe, expect, it } from "vitest";
import type { SettlementRow } from "@rail402.dev/x402-index";
import type { ComputedReport } from "../src/api/report.ts";
import { SCRIPT } from "../src/web/assets.ts";
import { CONTENT_SECURITY_POLICY } from "../src/web/csp.ts";
import { BazaarClient } from "../src/web/bazaar.ts";
import { HoldingsClient, parseHoldings } from "../src/web/holdings.ts";
import { bazaarClient, reportOf, type BazaarMode, type FakeListing } from "./bazaar.ts";
import { MemoryReader, TRANSACTIONS, rowOf, testApp } from "./web.ts";

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
const muxed: SettlementRow = {
  ...exact,
  txHash: "b".repeat(64),
  innerHash: null,
  ledger: exact.ledger - 20,
  payToMuxedId: "42",
};
const rows = [exact, upto, x402org, shaped, muxed];
const USDC = exact.asset.contract;
const WEATHER = "96eab768-fe71-47c4-9325-8907a4d6da78";
const TOOL = "a26c5676-c0f7-416c-87c1-10d776040246";
const HISTORY = "c3a1e0f2-0000-4000-8000-000000000001";

const listings: FakeListing[] = [
  {
    id: WEATHER,
    type: "http",
    resource: "https://demo.example.org/weather",
    method: "GET",
    description: "Current weather for a city",
    payTo: exact.payTo,
    scheme: "exact",
    amount: exact.amount,
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
    description: '<script>alert("listing")</script>',
    serviceName: "<b>Demo</b> seller",
    payTo: exact.payTo,
    scheme: "exact",
    amount: "10000",
    asset: USDC,
    info: { input: { type: "mcp", toolName: "air_quality", arguments: { city: "Izmir" } } },
    private: true,
  },
  {
    id: HISTORY,
    type: "http",
    resource: "https://demo.example.org/users/:id",
    method: "GET",
    payTo: upto.payTo,
    scheme: "upto",
    amount: "100000",
    asset: USDC,
    routeTemplate: "/users/:id",
    info: { input: { type: "http", method: "GET", pathParams: { id: "42" } } },
    paid: [upto],
  },
];

const report = { document: reportOf(rows) } as unknown as ComputedReport;
const NOW = Date.parse(exact.closedAt) + 21 * 60_000;

function app(mode: BazaarMode | "none" = "up", data: readonly SettlementRow[] = rows) {
  const bazaar = mode === "none" ? undefined : bazaarClient(listings, mode);
  return {
    app: testApp({
      reader: new MemoryReader(data),
      report: data.length === 0 ? undefined : report,
      now: () => NOW,
      ...(bazaar === undefined ? {} : { bazaar: bazaar.client }),
    }),
    paths: bazaar?.paths ?? [],
  };
}

async function page(target: ReturnType<typeof app>, path: string, status = 200) {
  const response = await target.app.request(path);
  expect(response.status, path).toBe(status);
  expect(response.headers.get("content-security-policy"), path).toBe(CONTENT_SECURITY_POLICY);
  const html = await response.text();
  const own = `<script src="${SCRIPT.path}" defer=""></script>`;
  expect(html.replace(own, ""), path).not.toMatch(/<script|<style|style="| on[a-z]+="/i);
  return html;
}

const PAGES = [
  "/testnet",
  "/testnet?scheme=upto",
  "/testnet/payments",
  "/testnet/payments?scheme=exact&time=7d",
  "/testnet/payments?facilitator=shaped",
  `/testnet/tx/${exact.txHash}`,
  `/testnet/tx/${upto.txHash}`,
  `/testnet/tx/${shaped.txHash}`,
  `/testnet/account/${exact.payTo}`,
  `/testnet/account/${exact.payTo}?muxed=42`,
  `/testnet/account/${upto.payTo}`,
  `/testnet/account/${exact.payer}`,
  "/testnet/services",
  "/testnet/facilitators",
  "/testnet/facilitator/rail402",
  "/testnet/facilitator/x402-org",
  "/testnet/ecosystem",
  "/methodology",
];

describe("explorer pages with the Bazaar", () => {
  it("renders every page with the Bazaar up, down, without usage routes and without a Bazaar", async () => {
    for (const mode of ["up", "down", "no-usage-routes", "none"] as const) {
      const target = app(mode);
      for (const path of PAGES) await page(target, path);
      for (const path of [`/testnet/resource/${WEATHER}`, `/testnet/resource/${TOOL}`]) {
        await page(
          target,
          path,
          mode === "up" || mode === "no-usage-routes" ? 200 : mode === "down" ? 503 : 404,
        );
      }
    }
  });

  it("renders every page with nothing indexed", async () => {
    const target = app("up", []);
    for (const path of PAGES.filter((path) => !path.includes("/tx/"))) await page(target, path);
  });

  it("says what a payment paid for, first-party from the Bazaar, or that it is not cataloged", async () => {
    const target = app("up");
    const paid = await page(target, `/testnet/tx/${exact.txHash}`);
    expect(paid).toContain("for GET demo.example.org/weather");
    expect(paid).toContain(`href="/testnet/resource/${WEATHER}"`);
    expect(paid).toContain("First-party");
    expect(paid).toContain("“Paid for” comes from the Rail402 Bazaar (off chain).");
    expect(paid).toContain("Non-custodial");
    expect(paid).toContain("Don&#39;t trust us, check it");
    const other = await page(target, `/testnet/tx/${x402org.txHash}`);
    expect(other).toContain("Not cataloged");
    expect(other).not.toContain("First-party");
    // Both hashes of a fee bump are asked for.
    expect(
      target.paths.some((path) => path.includes(exact.txHash) && path.includes(exact.innerHash ?? "-")),
    ).toBe(true);
  });

  it("caches a payment page briefly when the Bazaar did not answer", async () => {
    const down = await app("down").app.request(`/testnet/tx/${exact.txHash}`);
    expect(down.headers.get("cache-control")).toContain("max-age=15");
    expect(await down.text()).toContain("The Bazaar did not answer");
    const up = await app("up").app.request(`/testnet/tx/${exact.txHash}`);
    expect(up.headers.get("cache-control")).toContain("max-age=3600");
  });

  it("treats missing usage routes as no data, not as an error", async () => {
    const target = app("no-usage-routes");
    const html = await page(target, `/testnet/tx/${exact.txHash}`);
    expect(html).toContain("Not cataloged");
    const resource = await page(target, `/testnet/resource/${WEATHER}`);
    expect(resource).toContain("usage not published by the Bazaar");
  });

  it("shows a private listing's usage as private", async () => {
    const html = await page(app("up"), `/testnet/resource/${TOOL}`);
    expect(html).toContain("usage private");
    expect(html).toContain("&lt;script&gt;alert(&quot;listing&quot;)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;Demo&lt;/b&gt; seller");
  });

  it("shows a seller's listings with linked payments and the remainder from the ledger", async () => {
    const html = await page(app("up"), `/testnet/account/${exact.payTo}`);
    expect(html).toContain("listings in the Bazaar");
    expect(html).toContain("Not linked to a public listing");
    expect(html).toContain("The ledger count covers the current epoch");
    expect(html).toContain("GET /weather");
    // The Bazaar links the seller's paid listings; the rest of what the ledger shows it received is
    // the remainder.
    const received = rows.filter((row) => row.payTo === exact.payTo).length;
    const linked = listings
      .filter((listing) => listing.payTo === exact.payTo && listing.private !== true)
      .reduce((sum, listing) => sum + (listing.paid?.length ?? 0), 0);
    expect(html).toContain(`ledger&#39;s ${String(received)} received payments minus the ${String(linked)}`);
    const plain = await page(app("down"), `/testnet/account/${exact.payTo}`);
    expect(plain).toContain("The Bazaar did not answer");
    expect(plain).not.toContain("Not linked to a public listing");
  });

  it("shows upto payments as charged against authorized", async () => {
    const html = await page(app("up"), `/testnet/account/${upto.payTo}`);
    expect(html).toContain("charged vs authorized");
    expect(html).toContain(upto.txHash.slice(0, 6));
  });

  it("filters the payments list, binds cursors to filters and refuses unknown filters", async () => {
    const target = app("up");
    const all = await page(target, "/testnet/payments");
    expect(all).toContain(x402org.txHash.slice(0, 6));
    expect(all).not.toContain(`/testnet/tx/${shaped.txHash}`);
    const onlyShaped = await page(target, "/testnet/payments?facilitator=shaped");
    expect(onlyShaped).toContain(`/testnet/tx/${shaped.txHash}`);
    expect(onlyShaped).not.toContain(`/testnet/tx/${x402org.txHash}`);
    const rail402 = await page(target, "/testnet/payments?facilitator=x402-org");
    expect(rail402).not.toContain(`/testnet/tx/${exact.txHash}`);
    const uptoOnly = await page(target, "/testnet/payments?scheme=upto");
    expect(uptoOnly).toContain(`/testnet/tx/${upto.txHash}`);
    expect(uptoOnly).not.toContain(`/testnet/tx/${exact.txHash}`);
    for (const bad of [
      "scheme=both",
      "facilitator=nobody",
      "asset=USDC",
      "time=1y",
      "colour=red",
      "offset=5",
    ]) {
      const response = await target.app.request(`/testnet/payments?${bad}`);
      expect(response.status, bad).toBe(400);
    }
    const page1 = (await (await target.app.request("/api/v1/testnet/settlements?limit=1")).json()) as {
      nextCursor: string;
      items: SettlementRow[];
    };
    expect(page1.items).toHaveLength(1);
    const wrong = await target.app.request(
      `/api/v1/testnet/settlements?limit=1&scheme=upto&cursor=${page1.nextCursor}`,
    );
    expect(wrong.status).toBe(400);
    const next = await target.app.request(`/api/v1/testnet/settlements?limit=1&cursor=${page1.nextCursor}`);
    expect(next.status).toBe(200);
  });

  it("downloads the filtered payments as CSV, with formulas defused", async () => {
    const response = await app("up").app.request("/testnet/payments.csv?scheme=exact");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const text = await response.text();
    const [header, ...lines] = text.trim().split("\r\n");
    expect(header?.split(",")[0]).toBe("transaction");
    expect(lines.length).toBeGreaterThan(0);
    expect(text).not.toContain(upto.txHash);
    expect(text).toContain(`${WEATHER},GET demo.example.org/weather`);
    expect((await app("up").app.request("/testnet/payments.csv?cursor=1-1-0000000000")).status).toBe(400);
  });

  it("resolves endpoint URLs, route templates and MCP tool names from search", async () => {
    const target = app("up");
    const cases: [string, string][] = [
      ["https://demo.example.org/weather", WEATHER],
      ["https://demo.example.org/weather?city=Ankara", WEATHER],
      ["https://demo.example.org/users/7", HISTORY],
      ["air_quality", TOOL],
    ];
    for (const [q, id] of cases) {
      const response = await target.app.request(`/testnet/search?scope=all&q=${encodeURIComponent(q)}`);
      if (q === "air_quality") {
        expect(await response.text()).toContain(`/testnet/resource/${id}`);
      } else {
        expect(response.status, q).toBe(302);
        expect(response.headers.get("location"), q).toBe(`/testnet/resource/${id}`);
      }
    }
    const tools = await target.app.request("/testnet/search?scope=tools&q=air_quality");
    expect(tools.headers.get("location")).toBe(`/testnet/resource/${TOOL}`);
    const none = await target.app.request("/testnet/search?q=nothing-matches-this");
    expect(none.status).toBe(404);
    const hash = await target.app.request(`/testnet/search?q=${exact.txHash}`);
    expect(hash.headers.get("location")).toBe(`/testnet/tx/${exact.txHash}`);
  });

  it("shows call snippets for a listing from the documented clients", async () => {
    const html = await page(app("up"), `/testnet/resource/${WEATHER}`);
    expect(html).toContain("rail402 pay &#39;https://demo.example.org/weather?city=Istanbul&#39;");
    expect(html).toContain("--max 0.001");
    expect(html).not.toContain("Not published");
    expect(html).toContain("wrapFetchWithPaymentFromConfig");
    expect(html).toContain("pay_and_call");
    expect(html).toContain("Listing history");
    const template = await page(app("up"), `/testnet/resource/${HISTORY}`);
    expect(template).toContain("https://demo.example.org/users/42");
    expect(template).toContain("createBuyer");
    const tool = await page(app("up"), `/testnet/resource/${TOOL}`);
    expect(tool).toContain("--tool air_quality");
  });

  it("lists services by seller with ledger payment counts", async () => {
    const html = await page(app("up"), "/testnet/services");
    const sellers = new Set(listings.map((listing) => listing.payTo)).size;
    expect(html).toContain(`${String(sellers)} seller${sellers === 1 ? "" : "s"}, 3 listings`);
    expect(html).toContain("payments on the ledger");
    const home = await page(app("up"), "/testnet");
    expect(home).toContain("Services in the Bazaar");
    expect(home).toContain("3 listings · by payments");
    expect(home).toContain("Who paid, what for, and the proof.");
    expect(home).toContain("Distinct payers");
  });

  it("labels attributed totals as registered facilitators, never as the whole network", async () => {
    const ecosystem = await page(app("up"), "/testnet/ecosystem");
    expect(ecosystem).toContain("Registered facilitators (Rail402 included)");
    expect(ecosystem).toContain(
      "payments settled by a facilitator outside the registry are not counted here",
    );
    for (const path of PAGES) {
      expect(await page(app("up"), path), path).not.toMatch(/network-wide/i);
    }
    expect(await page(app("up"), "/testnet")).toContain("Registered facilitators · 30 days");
  });

  it("labels the shaped count a lower bound wherever it appears", async () => {
    for (const path of ["/testnet", "/testnet/facilitators"]) {
      expect(await page(app("up"), path)).toContain("as a lower bound");
    }
  });
});

describe("live holdings", () => {
  const body = {
    _embedded: {
      records: [
        {
          kind: "trustline",
          code: "USDC",
          issuer: exact.asset.issuer,
          contract_id: USDC,
          balance: "0.4626100",
          verified: true,
          flags: [],
        },
        { kind: "native", code: "XLM", issuer: null, balance: "9999.9999800", verified: true, flags: [] },
        {
          kind: "contract",
          code: "USDC",
          issuer: null,
          balance: "1000.0",
          verified: true,
          flags: ["impersonation_risk"],
        },
        {
          kind: "trustline",
          code: "ZERO",
          issuer: exact.asset.issuer,
          balance: "0.0000000",
          verified: true,
          flags: [],
        },
        { kind: "contract", symbol: "FAKE", balance: "5.0", verified: false, flags: [] },
      ],
    },
    read_view: { as_of_ledger: 5_400_895, as_of_closed_at: "2026-10-26T15:21:02Z" },
  };

  it("keeps only verified, unflagged, non-zero balances, XLM first", () => {
    const parsed = parseHoldings(body);
    expect(parsed?.items.map((item) => item.code)).toEqual(["XLM", "USDC"]);
    expect(parsed?.asOfLedger).toBe(5_400_895);
  });

  it("shows them labelled live and fails soft, within a call budget", async () => {
    let calls = 0;
    const holdings = (fail: boolean) =>
      new HoldingsClient({
        network: "stellar:testnet",
        apiKey: `lum_test_${"k".repeat(32)}`,
        perMinute: 2,
        fetch: () => {
          calls++;
          return Promise.resolve(
            fail ? new Response("", { status: 500 }) : new Response(JSON.stringify(body)),
          );
        },
      });
    const ok = testApp({ reader: new MemoryReader(rows), holdings: holdings(false), now: () => NOW });
    const html = await (await ok.request(`/testnet/account/${exact.payTo}`)).text();
    expect(html).toContain("Live · not audited");
    expect(html).toContain("9999.9999800");
    expect(html).not.toContain("1000.0");
    await ok.request(`/testnet/account/${exact.payTo}`);
    expect(calls).toBe(1);
    const down = testApp({ reader: new MemoryReader(rows), holdings: holdings(true), now: () => NOW });
    const soft = await down.request(`/testnet/account/${exact.payTo}`);
    expect(soft.status).toBe(200);
    expect(await soft.text()).toContain("did not answer");
  });
});

describe("the Bazaar client", () => {
  it("refuses a non-https Bazaar", () => {
    expect(() => bazaarClient(listings).client).not.toThrow();
    expect(
      () => new BazaarClient({ network: "stellar:testnet", baseUrl: "http://bazaar.example.org" }),
    ).toThrow(/https/);
  });

  it("caches answers, shares them, and keeps a failure only briefly", async () => {
    let now = 0;
    let calls = 0;
    let fail = true;
    const client = new BazaarClient({
      network: "stellar:testnet",
      baseUrl: "https://bazaar.example.org",
      now: () => now,
      fetch: () => {
        calls++;
        return Promise.resolve(
          fail ? new Response("", { status: 503 }) : new Response(JSON.stringify({ items: [], asOf: "x" })),
        );
      },
    });
    expect((await client.paidFor([exact.txHash])).status).toBe("down");
    expect((await client.paidFor([exact.txHash])).status).toBe("down");
    expect(calls).toBe(1);
    fail = false;
    now += 6_000;
    expect((await client.paidFor([exact.txHash])).status).toBe("ok");
    await client.paidFor([exact.txHash]);
    expect(calls).toBe(2);
  });

  it("drops oversized and malformed answers", async () => {
    const big = new BazaarClient({
      network: "stellar:testnet",
      baseUrl: "https://bazaar.example.org",
      maxBytes: 100,
      fetch: () => Promise.resolve(new Response(JSON.stringify({ items: "x".repeat(500) }))),
    });
    expect((await big.listings()).status).toBe("down");
    const odd = new BazaarClient({
      network: "stellar:testnet",
      baseUrl: "https://bazaar.example.org",
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                { transaction: exact.txHash, listing: { id: 7 }, observedAt: "x" },
                { transaction: "not-a-hash", listing: {}, observedAt: "2026-10-26T00:00:00Z" },
              ],
            }),
          ),
        ),
    });
    const answer = await odd.paidFor([exact.txHash]);
    expect(answer.status === "ok" && answer.value.size).toBe(0);
  });

  it("tells a private listing's usage from a missing route", async () => {
    const { client } = bazaarClient(listings);
    expect((await client.resourceUsage(TOOL)).status).toBe("private");
    expect((await client.resourceUsage(WEATHER)).status).toBe("ok");
    const old = bazaarClient(listings, "no-usage-routes").client;
    expect((await old.resourceUsage(WEATHER)).status).toBe("none");
    expect((await old.sellerUsage(exact.payTo)).status).toBe("none");
  });
});
