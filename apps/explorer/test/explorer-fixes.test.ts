/**
 * The Explorer's Bazaar and display safeguards: each visitor's own Bazaar budget, one deadline per
 * page, links checked against the chain, only allow-listed asset codes shown bare, unpublished
 * listings shown without a way to pay them, and caching that waits for cataloging.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Account, MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import { afterAll, describe, expect, it } from "vitest";
import type { SettlementRow } from "@rail402.dev/x402-index";
import type { ComputedReport } from "../src/api/report.ts";
import { BazaarClient, forwardedClientId } from "../src/web/bazaar.ts";
import { webConfig } from "../src/web/config.ts";
import { assetName, baseAccount } from "../src/web/format.ts";
import { bazaarClient, reportOf, type FakeListing } from "./bazaar.ts";
import { MemoryReader, TRANSACTIONS, rowOf, testApp } from "./web.ts";

const exact = rowOf(TRANSACTIONS["rail402-exact"]);
const x402org = rowOf(TRANSACTIONS["x402org-exact-1"]);
const USDC = exact.asset.contract;
const KEY = `r402_explorer-testnet_${"A".repeat(43)}`;
const WEATHER = "96eab768-fe71-47c4-9325-8907a4d6da78";
const PENDING = "c3a1e0f2-0000-4000-8000-000000000009";
const MUXED = "c3a1e0f2-0000-4000-8000-00000000000a";
const muxedPayTo = new MuxedAccount(new Account(exact.payTo, "0"), "7").accountId();

const weather: FakeListing = {
  id: WEATHER,
  type: "http",
  resource: "https://demo.example.org/weather",
  method: "GET",
  payTo: exact.payTo,
  scheme: "exact",
  amount: exact.amount,
  asset: USDC,
  // The Bazaar links x402org's payment too, but it paid another account on chain.
  paid: [exact, x402org],
};
const scratch = mkdtempSync(join(tmpdir(), "rail402-explorer-fixes-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const report = (rows: readonly SettlementRow[]) =>
  ({ document: reportOf(rows) }) as unknown as ComputedReport;

describe("each visitor's own Bazaar budget", () => {
  it("sends the access key and a per-visitor identifier, never the visitor's address", async () => {
    const { client, headers } = bazaarClient([weather], "up", { apiKey: KEY });
    await client.forRequest("198.51.100.7").paidFor([exact.txHash]);
    await client.forRequest("203.0.113.9").paidFor([x402org.txHash]);
    expect(headers.map((entry) => entry.get("authorization"))).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
    const ids = headers.map((entry) => entry.get("x-rail402-client"));
    expect(ids).toEqual([forwardedClientId(KEY, "198.51.100.7"), forwardedClientId(KEY, "203.0.113.9")]);
    expect(ids[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(headers.some((entry) => [...entry.values()].some((value) => value.includes("198.51.100.7")))).toBe(
      false,
    );
  });

  it("forwards the page's visitor from the app, and sends no key without one", async () => {
    const keyed = bazaarClient([weather], "up", { apiKey: KEY });
    const app = testApp({
      reader: new MemoryReader([exact]),
      bazaar: keyed.client,
      trustedProxyHops: 1,
    });
    await app.request(`/testnet/tx/${exact.txHash}`, { headers: { "x-forwarded-for": "198.51.100.7" } });
    expect(keyed.headers.at(-1)?.get("x-rail402-client")).toBe(forwardedClientId(KEY, "198.51.100.7"));
    const plain = bazaarClient([weather]);
    await testApp({ reader: new MemoryReader([exact]), bazaar: plain.client }).request(
      `/testnet/tx/${exact.txHash}`,
    );
    expect(plain.headers.at(-1)?.get("authorization")).toBeNull();
    expect(plain.headers.at(-1)?.get("x-rail402-client")).toBeNull();
  });

  it("reads the key from a file only, refuses an inline key and a key of another shape", () => {
    const base = {
      EXPLORER_DATABASE_URL: "postgres://reader@db/rail402_explorer",
      EXPLORER_NETWORKS: "testnet",
    };
    const file = join(scratch, "bazaar.key");
    writeFileSync(file, `${KEY}\n`, { mode: 0o600 });
    expect(webConfig(base).networks[0]?.bazaarKey).toBeUndefined();
    expect(webConfig({ ...base, EXPLORER_TESTNET_BAZAAR_KEY_FILE: file }).networks[0]?.bazaarKey).toBe(KEY);
    expect(() => webConfig({ ...base, EXPLORER_TESTNET_BAZAAR_KEY: KEY })).toThrow(/is refused/);
    const bad = join(scratch, "bad.key");
    writeFileSync(bad, "lum_test_xxxxxxxxxxxxxxxx\n", { mode: 0o600 });
    expect(() => webConfig({ ...base, EXPLORER_TESTNET_BAZAAR_KEY_FILE: bad })).toThrow(/r402_/);
    // The key's value never appears in a configuration error.
    try {
      webConfig({ ...base, EXPLORER_TESTNET_BAZAAR_KEY: KEY });
    } catch (error) {
      expect(String(error)).not.toContain(KEY);
    }
  });

  it("refuses a Bazaar URL with a path instead of dropping the path", () => {
    const base = {
      EXPLORER_DATABASE_URL: "postgres://reader@db/rail402_explorer",
      EXPLORER_NETWORKS: "testnet",
    };
    for (const url of ["https://bazaar.example.org/api", "https://bazaar.example.org/?x=1"]) {
      expect(() => webConfig({ ...base, EXPLORER_TESTNET_BAZAAR_URL: url }), url).toThrow(/without a path/);
    }
    expect(
      webConfig({ ...base, EXPLORER_TESTNET_BAZAAR_URL: "https://bazaar.example.org/" }).networks[0]
        ?.bazaarUrl,
    ).toBe("https://bazaar.example.org");
    expect(
      () => new BazaarClient({ network: "stellar:testnet", baseUrl: "https://b.example.org/x" }),
    ).toThrow();
  });

  it("asks for 25 versions and keeps crawlers off paginated pages and the CSV", async () => {
    const { client, paths } = bazaarClient([weather]);
    await client.versions(WEATHER);
    expect(paths.at(-1)).toBe(`/discovery/resources/${WEATHER}/versions?limit=25`);
    const robots = await (await testApp({ reader: new MemoryReader([]) }).request("/robots.txt")).text();
    expect(robots).toContain("Disallow: /*?*cursor=");
    expect(robots).toContain("Disallow: /testnet/payments.csv");
  });
});

describe("one Bazaar deadline per page", () => {
  /** A Bazaar that never answers, until the request is aborted. */
  const hanging = () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = (_input, init) => {
      calls++;
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    };
    return { fetch, calls: () => calls };
  };

  it("gives up at the page's deadline, and never keeps that failure for the next visitor", async () => {
    const bazaar = hanging();
    const client = new BazaarClient({
      network: "stellar:testnet",
      baseUrl: "https://b.example.org",
      fetch: bazaar.fetch,
    });
    const started = Date.now();
    expect((await client.forRequest("a", 150).paidFor([exact.txHash])).status).toBe("down");
    expect(Date.now() - started).toBeLessThan(1_000);
    // Out of time before asking: no request at all.
    const late = client.forRequest("a", 0);
    expect((await late.listing(WEATHER)).status).toBe("down");
    expect(bazaar.calls()).toBe(1);
    await client.forRequest("b", 150).paidFor([exact.txHash]);
    expect(bazaar.calls()).toBe(2);
  });

  it("never keeps one visitor's refused budget as the Bazaar being down for the next visitor", async () => {
    let calls = 0;
    const answers = [
      new Response("{}", { status: 429, headers: { "retry-after": "30" } }),
      new Response("{}", { status: 503, headers: { "retry-after": "1" } }),
    ];
    const client = new BazaarClient({
      network: "stellar:testnet",
      baseUrl: "https://b.example.org",
      fetch: () => {
        calls++;
        const next = answers.shift();
        return Promise.resolve(
          next ??
            new Response(JSON.stringify({ items: [], asOf: "2026-10-26T15:00:00.000Z" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        );
      },
    });
    expect((await client.forRequest("a", 2_000).paidFor([exact.txHash])).status).toBe("down");
    expect((await client.forRequest("b", 2_000).paidFor([exact.txHash])).status).toBe("down");
    // Neither refusal was kept: visitor c is answered from the Bazaar, not from a cached failure.
    expect((await client.forRequest("c", 2_000).paidFor([exact.txHash])).status).toBe("ok");
    expect(calls).toBe(3);
  });

  it("renders an account page and the CSV within the deadline while the Bazaar hangs", async () => {
    const bazaar = hanging();
    const client = new BazaarClient({
      network: "stellar:testnet",
      baseUrl: "https://b.example.org",
      fetch: bazaar.fetch,
    });
    const app = testApp({ reader: new MemoryReader([exact, x402org]), bazaar: client, bazaarBudgetMs: 200 });
    for (const path of [`/testnet/account/${exact.payTo}`, "/testnet/payments.csv", "/testnet"]) {
      const started = Date.now();
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(Date.now() - started, path).toBeLessThan(1_500);
    }
  });

  it("pages listings by what the Bazaar sent, not by what it kept", async () => {
    const offsets: string[] = [];
    const page = (items: unknown[], total: number) =>
      new Response(JSON.stringify({ items, pagination: { total, asOf: "2026-10-26T00:00:00.000Z" } }));
    const good = (id: string) => ({
      resource: `https://x.example.org/${id}`,
      type: "http",
      accepts: [
        { scheme: "exact", network: "stellar:testnet", amount: "1", asset: USDC, payTo: exact.payTo },
      ],
      lastUpdated: "2026-10-26T00:00:00.000Z",
      rail402: { listings: [{ id, network: "stellar:testnet" }] },
    });
    const client = new BazaarClient({
      network: "stellar:testnet",
      baseUrl: "https://b.example.org",
      fetch: (input) => {
        const offset = new URL(input instanceof Request ? input.url : input).searchParams.get("offset") ?? "";
        offsets.push(offset);
        return Promise.resolve(
          offset === "0"
            ? page([good("00000000-0000-4000-8000-000000000001"), { malformed: true }], 3)
            : page([good("00000000-0000-4000-8000-000000000003")], 3),
        );
      },
    });
    const answer = await client.listings();
    expect(offsets).toEqual(["0", "2"]);
    expect(answer.status === "ok" && answer.value.map((listing) => listing.id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000003",
    ]);
  });
});

describe("links checked against the chain", () => {
  it("shows a link only when the listing's payTo is the account the payment paid", async () => {
    expect(x402org.payTo).not.toBe(exact.payTo);
    const app = testApp({
      reader: new MemoryReader([exact, x402org]),
      bazaar: bazaarClient([weather]).client,
    });
    expect(await (await app.request(`/testnet/tx/${exact.txHash}`)).text()).toContain(
      `href="/testnet/resource/${WEATHER}"`,
    );
    const other = await (await app.request(`/testnet/tx/${x402org.txHash}`)).text();
    expect(other).not.toContain(`href="/testnet/resource/${WEATHER}"`);
    expect(other).toContain(">not listed<");
    const csv = await (await app.request("/testnet/payments.csv")).text();
    const line = csv.split("\r\n").find((entry) => entry.startsWith(x402org.txHash)) ?? "";
    expect(line).not.toContain(WEATHER);
    const resource = await (await app.request(`/testnet/resource/${WEATHER}`)).text();
    expect(resource).toContain(`/testnet/tx/${exact.txHash}`);
    expect(resource).not.toContain(`/testnet/tx/${x402org.txHash}`);
  });

  it("treats a muxed payTo as its base account", async () => {
    expect(baseAccount(muxedPayTo)).toBe(exact.payTo);
    const listing: FakeListing = { ...weather, id: MUXED, payTo: muxedPayTo, paid: [exact] };
    const app = testApp({ reader: new MemoryReader([exact]), bazaar: bazaarClient([listing]).client });
    const seller = await (await app.request(`/testnet/account/${exact.payTo}`)).text();
    expect(seller).toContain("Services in the Bazaar");
    expect(await (await app.request(`/testnet/tx/${exact.txHash}`)).text()).toContain(
      `href="/testnet/resource/${MUXED}"`,
    );
    const bazaar = await (await app.request("/testnet/services")).text();
    expect(bazaar).toContain("1 seller<");
    expect(bazaar).toContain("1 service<");
  });
});

describe("asset names", () => {
  const otherIssuer = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3));
  const lookalike: SettlementRow = {
    ...exact,
    txHash: "c".repeat(64),
    innerHash: null,
    asset: {
      contract: StrKey.encodeContract(Buffer.alloc(32, 4)),
      code: "USDC",
      issuer: otherIssuer,
      verified: true,
    },
  };

  it("shows a bare code only for an allow-listed contract", () => {
    expect(assetName("stellar:testnet", USDC, "USDC", exact.asset.issuer)).toBe("USDC");
    expect(assetName("stellar:testnet", lookalike.asset.contract, "USDC", otherIssuer)).toBe(
      `USDC ${otherIssuer.slice(0, 4)}…${otherIssuer.slice(-4)}`,
    );
    expect(assetName("stellar:pubnet", USDC, "USDC", exact.asset.issuer)).not.toBe("USDC");
  });

  it("never counts or names another issuer's USDC as USDC", async () => {
    const app = testApp({ reader: new MemoryReader([lookalike]), report: report([lookalike]) });
    const tx = await (await app.request(`/testnet/tx/${lookalike.txHash}`)).text();
    expect(tx).toContain(`USDC ${otherIssuer.slice(0, 4)}…`);
    const home = await (await app.request("/testnet")).text();
    expect(home).toMatch(/Volume<\/span><span class="nrow"><span class="n">0<small>USDC<\/small>/);
  });
});

describe("unpublished listings and payment page caching", () => {
  it("shows a pending listing's state and history only: no price, no seller, no way to call it", async () => {
    const pending: FakeListing = { ...weather, id: PENDING, state: "pending", paid: [] };
    const app = testApp({ reader: new MemoryReader([exact]), bazaar: bazaarClient([pending]).client });
    const response = await app.request(`/testnet/resource/${PENDING}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("not published: pending");
    expect(html).toContain("History");
    for (const text of ["How to call", "Try in Playground", "Copy address", "More from", "0.001 USDC"]) {
      expect(html, text).not.toContain(text);
    }
  });

  it("caches a payment page as final only once its link is known or the grace period is over", async () => {
    const at = (minutes: number) => () => Date.parse(exact.closedAt) + minutes * 60_000;
    const cache = async (listings: readonly FakeListing[], minutes: number, mode: "up" | "down" = "up") =>
      (
        await testApp({
          reader: new MemoryReader([exact]),
          bazaar: bazaarClient(listings, mode).client,
          now: at(minutes),
        }).request(`/testnet/tx/${exact.txHash}`)
      ).headers.get("cache-control");
    expect(await cache([weather], 1)).toContain("max-age=3600");
    expect(await cache([], 1)).toContain("max-age=15");
    expect(await cache([], 30)).toContain("max-age=3600");
    expect(await cache([weather], 30, "down")).toContain("max-age=15");
  });

  it("says a network publishes payment counts only, and links no payment to the listing then", async () => {
    const counted: FakeListing = { ...weather, countsOnly: true };
    const app = testApp({ reader: new MemoryReader([exact]), bazaar: bazaarClient([counted]).client });
    const html = await (await app.request(`/testnet/resource/${WEATHER}`)).text();
    expect(html).toContain("Payments are counted only");
    expect(html).toContain("links no payment, and no payer, to a listing");
    const tx = await (await app.request(`/testnet/tx/${exact.txHash}`)).text();
    expect(tx).not.toContain(`href="/testnet/resource/${WEATHER}"`);
  });

  it("says the truth about an unlinked payment and a private listing", async () => {
    const app = testApp({ reader: new MemoryReader([x402org]), bazaar: bazaarClient([]).client });
    const html = await (await app.request(`/testnet/tx/${x402org.txHash}`)).text();
    expect(html).toContain(">not listed<");
    expect(html).toContain("The Bazaar links no public listing to this payment.");
    expect(html).not.toContain("No Bazaar listing is linked");
  });
});

describe("how to call a listing", () => {
  it("shows a hostile method as text, and no command to paste", async () => {
    const hostile: FakeListing = { ...weather, method: "POST;id<b>", paid: [] };
    const app = testApp({ reader: new MemoryReader([exact]), bazaar: bazaarClient([hostile]).client });
    const html = await (await app.request(`/testnet/resource/${WEATHER}`)).text();
    expect(html).toContain("POST;id&lt;");
    expect(html).not.toContain("rail402 pay");
  });
});
