/**
 * The public pages against hostile data: on-chain strings never become markup, the CSP is on every
 * response, fake assets and fake upto events are never shown as verified, an account is never shown as
 * the payer of a transfer it did not authorize, and only final pages are cached.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { RULES_VERSION, type SettlementRow } from "@rail402.dev/x402-index";
import type { ComputedReport } from "../src/api/report.ts";
import { CONTENT_SECURITY_POLICY } from "../src/web/csp.ts";
import { SCRIPT, STYLESHEET_TEXT } from "../src/web/assets.ts";
import { page } from "../src/web/ui.ts";
import { NETWORK_VIEWS } from "../src/web/format.ts";
import { displayText, safeHttpsUrl } from "../src/web/text.ts";
import {
  MemoryReader,
  TRANSACTIONS,
  ATTACKER_TOKEN,
  fakeSacToken,
  fakeUptoSettled,
  forgedPayer,
  liveLookup,
  rowOf,
  testApp,
} from "./web.ts";
import { reportOf } from "./bazaar.ts";

const exact = rowOf(TRANSACTIONS["rail402-exact"]);
const upto = rowOf(TRANSACTIONS["rail402-upto"]);
const SCRIPT_TAG = `<script src="${SCRIPT.path}" defer=""></script>`;

/** The page with its own script tag removed: what remains must hold no script or event handler. */
const withoutOwnScript = (html: string) => html.replace(SCRIPT_TAG, "");

const hostile: SettlementRow = {
  ...exact,
  asset: { ...exact.asset, code: "<script>x", verified: true },
  registryVersion: '"><script>alert(2)</script>',
  payToMuxedId: "1<b>2</b>",
  attribution: { ...exact.attribution, evidenceUrl: "javascript:alert(3)" },
  checks: [...exact.checks, "<img src=x onerror=alert(4)>" as never],
};

describe("explorer pages", () => {
  it("renders script-bearing on-chain strings as text", async () => {
    const app = testApp({ reader: new MemoryReader([hostile]) });
    const response = await app.request(`/testnet/tx/${exact.txHash}`);
    expect(response.status).toBe(200);
    const html = withoutOwnScript(await response.text());
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain("<b>2</b>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;script&gt;x");
    // A check id the rules do not define is never shown, as markup or as a passed check.
    expect(html).not.toContain("onerror");
  });

  it("sends the strict CSP on every page", async () => {
    const app = testApp({ reader: new MemoryReader([exact, upto]) });
    const paths = [
      "/testnet",
      `/testnet/tx/${exact.txHash}`,
      `/testnet/account/${exact.payer}`,
      "/testnet/ecosystem",
      "/testnet/facilitator/rail402",
      "/methodology",
      "/testnet/tx/nothex",
      "/api/v1/testnet/facilitators",
      SCRIPT.path,
    ];
    for (const path of paths) {
      const response = await app.request(path);
      expect(response.headers.get("content-security-policy"), path).toBe(CONTENT_SECURITY_POLICY);
      expect(response.headers.get("cache-control"), path).toContain("no-transform");
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
    expect(CONTENT_SECURITY_POLICY).toContain(
      "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    // No inline script or style anywhere: the policy would block it, so pages must not need it.
    const html = await (await app.request(`/testnet/tx/${upto.txHash}`)).text();
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toMatch(/<style|style="/);
  });

  it("strips bidi controls and keeps the full address copyable", async () => {
    expect(displayText("\u202eUSDC\u2066x\u200b\u0000y")).toBe("USDCxy");
    expect(displayText("a".repeat(300), 10)).toBe(`${"a".repeat(10)}…`);
    expect(safeHttpsUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpsUrl("https://user:pw@example.org")).toBeUndefined();
    expect(safeHttpsUrl("https://example.org/a")).toBe("https://example.org/a");
    const bidi = { ...exact, asset: { ...exact.asset, code: "\u202eDSU\u200b" } };
    const app = testApp({ reader: new MemoryReader([bidi]) });
    const html = await (await app.request(`/testnet/tx/${exact.txHash}`)).text();
    expect(html).not.toContain("\u202e");
    expect(html).not.toContain("\u200b");
    expect(html).toContain("DSU");
    // Every party is linked with its full strkey in the title and accessible label, with a copy
    // button carrying it in full.
    for (const address of [exact.payer, exact.payTo, exact.fee.payer]) {
      expect(html).toContain(`title="${address}" aria-label="${address}"`);
      expect(html).toContain(`data-copy="${address}"`);
    }
    // Tables shorten addresses only with the full value in the title and the accessible label, linked
    // to the account page that shows it in full.
    const list = await (await app.request(`/testnet/account/${exact.payer}`)).text();
    expect(list).toContain(`title="${exact.payTo}"`);
    expect(list).toContain(`aria-label="${exact.payTo}"`);
    expect(list).toContain(`href="/testnet/account/${exact.payTo}"`);
  });

  it("shows every required fact of an indexed payment", async () => {
    const app = testApp({ reader: new MemoryReader([exact, upto]) });
    const html = await (await app.request(`/testnet/tx/${upto.txHash}`)).text();
    for (const text of [
      ">stellar:testnet<",
      ">upto<",
      "verified",
      "Max amount",
      "% used",
      "Authority",
      upto.payer,
      upto.payTo,
      ">Rail402<",
      "fee sponsored",
      upto.fee.payer,
      " XLM",
      upto.txHash,
      "Why it counts",
      "Registered settlement contract",
      "Ledger matches the record",
      `https://stellar.expert/explorer/testnet/tx/${upto.txHash}`,
    ]) {
      expect(html, text).toContain(text);
    }
    // Every check of the row passed: no line is crossed.
    expect(html).not.toContain('<li class="no">');
  });

  it("resolves the inner hash of a fee bump to the same payment", async () => {
    const app = testApp({ reader: new MemoryReader([exact]) });
    expect(exact.innerHash).not.toBeNull();
    const html = await (await app.request(`/testnet/tx/${exact.innerHash ?? ""}`)).text();
    expect(html).toContain(exact.txHash);
  });

  it("never caches a live lookup and versions the ETag of indexed pages", async () => {
    const x402org = TRANSACTIONS["x402org-exact-1"];
    const { lookup } = liveLookup({ [x402org.hash]: x402org });
    const app = testApp({ reader: new MemoryReader([exact]), lookup });
    const indexed = await app.request(`/testnet/tx/${exact.txHash}`);
    expect(indexed.headers.get("cache-control")).toBe("public, max-age=3600, no-transform");
    const etag = indexed.headers.get("etag") ?? "";
    expect(etag).toContain(`r${RULES_VERSION}-${exact.registryVersion}-`);
    const again = await app.request(`/testnet/tx/${exact.txHash}`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);

    const live = await app.request(`/testnet/tx/${x402org.hash}`);
    expect(live.status).toBe(200);
    expect(live.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(live.headers.get("etag")).toBeNull();
    const html = await live.text();
    expect(html).toContain("not indexed yet");
    expect(html).toContain("x402.org");

    const missing = await app.request(`/testnet/tx/${"0".repeat(64)}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store, no-transform");
  });

  it("caches a row under an older registry version only briefly, with an ETag of its own versions", async () => {
    const stale: SettlementRow = {
      ...exact,
      registryVersion: "2020-01-01.1",
      attribution: { ...exact.attribution, tier: "shaped", facilitatorId: null },
    };
    const app = testApp({ reader: new MemoryReader([stale]) });
    for (const path of [`/testnet/tx/${stale.txHash}`, `/api/v1/testnet/transactions/${stale.txHash}`]) {
      const response = await app.request(path);
      expect(response.headers.get("cache-control"), path).toBe("public, max-age=15, no-transform");
      expect(response.headers.get("etag"), path).toContain(`r${RULES_VERSION}-2020-01-01.1-`);
    }
  });

  it("never shows a row indexed under other rules as a settlement, and looks the transaction up again", async () => {
    // The row an indexer under the previous rules made of a forged custom-token transfer.
    const victim = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33));
    const forged = forgedPayer(TRANSACTIONS["x402org-exact-1"], victim);
    const x402org = rowOf(TRANSACTIONS["x402org-exact-1"]);
    const stale: SettlementRow = {
      ...x402org,
      txHash: forged.hash,
      innerHash: null,
      payer: victim.publicKey(),
      asset: { contract: ATTACKER_TOKEN, code: null, issuer: null, verified: false },
      rulesVersion: "1",
      checks: ["E1", "E2", "E3", "E4", "E5", "E6"],
    };
    const indexOnly = testApp({ reader: new MemoryReader([stale]) });
    for (const path of [`/testnet/tx/${forged.hash}`, `/api/v1/testnet/transactions/${forged.hash}`]) {
      const response = await indexOnly.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain(victim.publicKey());
    }
    const { lookup } = liveLookup({ [forged.hash]: forged });
    const live = testApp({ reader: new MemoryReader([stale]), lookup });
    const html = await (await live.request(`/testnet/tx/${forged.hash}`)).text();
    expect(html).toContain("Near miss");
    expect(html).toContain("Buyer&#39;s signature proven");
    expect(html).not.toContain(">Buyer<");
  });

  it("serves no report computed under other rules", async () => {
    const rows = [exact, upto];
    const current = { document: reportOf(rows) } as unknown as ComputedReport;
    const older = { document: { ...reportOf(rows), rulesVersion: "1" } } as unknown as ComputedReport;
    const olderRows = {
      document: reportOf(rows),
      manifest: { rowVersions: { rules: ["1", RULES_VERSION], registry: ["test"] } },
    } as unknown as ComputedReport;
    expect(
      (await testApp({ reader: new MemoryReader(rows), report: current }).request("/api/v1/testnet/report"))
        .status,
    ).toBe(200);
    for (const report of [older, olderRows]) {
      const app = testApp({ reader: new MemoryReader(rows), report });
      const api = await app.request("/api/v1/testnet/report");
      expect(api.status).toBe(503);
      expect(((await api.json()) as { error: { code: string } }).error.code).toBe(
        "explorer_report_unavailable",
      );
      const facilitators = (await (await app.request("/api/v1/testnet/facilitators")).json()) as Record<
        string,
        unknown
      >;
      expect(JSON.stringify(facilitators)).not.toContain('"payments"');
    }
  });

  it("filters only payments received by a muxed id, and labels the totals as the base account's", async () => {
    const muxed: SettlementRow = {
      ...upto,
      txHash: "e".repeat(64),
      innerHash: null,
      payTo: exact.payer,
      payToMuxedId: "42",
    };
    const app = testApp({ reader: new MemoryReader([exact, muxed]) });
    const html = await (await app.request(`/testnet/account/${exact.payer}?muxed=42`)).text();
    expect(html).toContain(muxed.txHash);
    // exact.payer paid exact: a payment it made is not a payment received by muxed id 42.
    expect(html).not.toContain(`/testnet/tx/${exact.txHash}`);
    expect(html).toContain("every muxed id of the base account");
    const refused = await app.request(
      `/api/v1/testnet/accounts/${exact.payer}/settlements?role=payer&muxed=42`,
    );
    expect(refused.status).toBe(400);
    const api = (await (
      await app.request(`/api/v1/testnet/accounts/${exact.payer}/settlements?muxed=42`)
    ).json()) as { role: string; items: SettlementRow[] };
    expect(api.role).toBe("payTo");
    expect(api.items.map((item) => item.txHash)).toEqual([muxed.txHash]);
  });

  it("says how many assets the account totals leave out, on the page and in the API", async () => {
    class Cut extends MemoryReader {
      override accountTotals() {
        return Promise.resolve({
          items: [
            {
              role: "payTo" as const,
              assetContract: exact.asset.contract,
              assetCode: "USDC",
              assetIssuer: null,
              assetVerified: true,
              payments: 3,
              volume: "30",
              firstAt: exact.closedAt,
              lastAt: exact.closedAt,
            },
          ],
          more: { payer: 0, payTo: 51 },
        });
      }
    }
    const cut = new Cut([exact]);
    const app = testApp({ reader: cut });
    const html = await (await app.request(`/testnet/account/${exact.payer}`)).text();
    expect(html).toContain("51 more received assets are not shown");
    const api = (await (await app.request(`/api/v1/testnet/accounts/${exact.payer}`)).json()) as {
      moreTotals: { payer: number; payTo: number };
    };
    expect(api.moreTotals).toEqual({ payer: 0, payTo: 51 });
  });

  it("never marks a fake SAC asset topic as verified", async () => {
    const fake = fakeSacToken(TRANSACTIONS["rail402-exact"]);
    const { lookup } = liveLookup({ [fake.hash]: fake });
    const app = testApp({ reader: new MemoryReader([]), lookup });
    const html = await (await app.request(`/testnet/tx/${fake.hash}`)).text();
    expect(html).toContain("unverified token");
    expect(html).not.toContain('"bdg ok">verified');
    expect(html).toContain(" units");
    const json = (await (await app.request(`/api/v1/testnet/transactions/${fake.hash}`)).json()) as {
      settlement: SettlementRow;
    };
    expect(json.settlement.asset).toMatchObject({ verified: false, code: null, issuer: null });
  });

  it("never shows a fake upto_settled event as a settlement", async () => {
    const fake = fakeUptoSettled(TRANSACTIONS["rail402-upto"]);
    const { lookup } = liveLookup({ [fake.hash]: fake });
    const app = testApp({ reader: new MemoryReader([]), lookup });
    const html = await (await app.request(`/testnet/tx/${fake.hash}`)).text();
    expect(html).toContain("Near miss");
    expect(html).toContain("Registered settlement contract");
    expect(html).not.toContain("Max amount");
  });

  it("never shows an account as the payer of a custom-token transfer it did not sign", async () => {
    const victim = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33));
    const forged = forgedPayer(TRANSACTIONS["x402org-exact-1"], victim);
    const { lookup } = liveLookup({ [forged.hash]: forged });
    const app = testApp({ reader: new MemoryReader([]), lookup });
    const html = await (await app.request(`/testnet/tx/${forged.hash}`)).text();
    expect(html).toContain("Near miss");
    expect(html).toContain("Buyer&#39;s signature proven");
    expect(html).not.toContain(">Buyer<");
    const json = (await (await app.request(`/api/v1/testnet/transactions/${forged.hash}`)).json()) as Record<
      string,
      unknown
    >;
    expect(json).toMatchObject({ kind: "not_x402", notX402: { exclusion: "unproven_authorization" } });
    expect(json).not.toHaveProperty("settlement");
  });

  it("redirects aliases and upper-case hashes, and answers unknown paths with explorer_not_found", async () => {
    const app = testApp({ reader: new MemoryReader([exact]) });
    for (const [from, to] of [
      [`/public/tx/${exact.txHash}`, `/tx/${exact.txHash}`],
      [`/pubnet/account/${exact.payer}?role=payer`, `/account/${exact.payer}?role=payer`],
      ["/mainnet/ecosystem", "/ecosystem"],
      ["/public", "/"],
      // Never another origin: doubled slashes and backslashes collapse to a same-origin path.
      ["/public//evil.example/x", "/evil.example/x"],
      ["/pubnet//evil.example", "/evil.example"],
      ["/public/\\evil.example", "/evil.example"],
      ["/mainnet/%2F%2Fevil.example", "/%2F%2Fevil.example"],
      [`/testnet/tx/${exact.txHash.toUpperCase()}`, `/testnet/tx/${exact.txHash}`],
      [
        `/api/v1/testnet/transactions/${exact.txHash.toUpperCase()}`,
        `/api/v1/testnet/transactions/${exact.txHash}`,
      ],
    ] as const) {
      const response = await app.request(from);
      expect(response.status, from).toBe(301);
      expect(response.headers.get("location"), from).toBe(to);
    }
    const search = await app.request(`/testnet/search?q=${exact.txHash.toUpperCase()}`);
    expect(search.headers.get("location")).toBe(`/testnet/tx/${exact.txHash}`);
    for (const path of [
      "/testnet/tx/xyz",
      "/testnet/account/GNOTANACCOUNT",
      "/nowhere",
      "/testnet/facilitator/Bad_Id",
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toContain("not found · 404");
    }
    // This app serves testnet only: mainnet paths are not found, never shown as another network.
    expect((await app.request(`/tx/${exact.txHash}`)).status).toBe(404);
    const api = await app.request("/api/v1/pubnet/report");
    expect(await api.json()).toMatchObject({ error: { code: "explorer_not_found" } });
  });

  it("sends the root to the testnet home only when mainnet is not served", async () => {
    const testnetOnly = await testApp({ reader: new MemoryReader([exact]) }).request("/");
    expect(testnetOnly.status).toBe(302);
    expect(testnetOnly.headers.get("location")).toBe("/testnet");
    const both = await testApp({ reader: new MemoryReader([]), pubnet: true }).request("/");
    expect(both.status).toBe(200);
    expect(both.headers.get("content-type")).toMatch(/^text\/html/);
  });

  it("uses no raw HTML in the web sources", () => {
    const root = fileURLToPath(new URL("../src/web/", import.meta.url));
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    for (const file of files(root)) {
      const text = readFileSync(file, "utf8");
      // The one exception inlines the compile-time stylesheet, and takes no input.
      if (file.endsWith("inline-style.ts")) {
        expect(text.match(/\braw\(/g)).toEqual(["raw("]);
        expect(text).toContain("raw(STYLESHEET_TEXT)");
        continue;
      }
      expect(text, file).not.toMatch(/dangerouslySetInnerHTML|innerHTML|\braw\(|hono\/html/);
    }
  });

  it("inlines the stylesheet unescaped in the standalone snapshot", () => {
    const html = page({
      view: NETWORK_VIEWS["stellar:testnet"],
      networks: [],
      path: "/",
      title: "t",
      standalone: { origin: "https://explorer.example.org" },
    });
    expect(html).toContain(`<style>${STYLESHEET_TEXT}</style>`);
    expect(STYLESHEET_TEXT).toMatch(/>/);
  });
});
