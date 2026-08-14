import { describe, it, expect } from "vitest";
import { CatalogStore } from "./catalog/store.js";
import { ingest } from "./catalog/ingest.js";
import { entryKey, type CatalogEntry } from "./catalog/types.js";
import { CORPUS, JUDGMENTS, THRESHOLDS } from "./search/fixtures.js";
import { evaluate, failures } from "./search/evaluate.js";
import { docText } from "./search/index.js";
import {
  createBazaarApp,
  catalogSettledPayment,
  catalogProvisionalPayment,
  encodeExtensionResponses,
} from "./app.js";
import { DomainVerifier, accountsFrom } from "./catalog/domain.js";
import { TrustlineChecker, trustlineTarget } from "./catalog/trustline.js";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

// ── helpers ──────────────────────────────────────────────────────────────────

const SELLER = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";
const OTHER = "GC6CSXBV4C6RL3HEDTW57KXYXSSXKAWKGYDEOSATXM3XNKXSR2VRYN3K";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"; // the real testnet USDC SAC
/** A valid C-address the facilitator does not vouch for (a look-alike USDC issuer's SAC). */
const UNKNOWN_ASSET = "CA2E53VHFZ6YSWQIEIPBXJQGT6VW3VKWWZO555XKRQXYJ63GEBJJGHY7";

const httpSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    input: {
      type: "object",
      properties: {
        type: { type: "string", const: "http" },
        method: { type: "string", enum: ["GET"] },
      },
      required: ["type", "method"],
    },
  },
  required: ["input"],
};

const payload = (over: Record<string, unknown> = {}): PaymentPayload =>
  ({
    x402Version: 2,
    resource: { url: "https://api.example.com/weather", description: "Weather data", mimeType: "application/json" },
    accepted: {},
    payload: { transaction: "AAAA" },
    extensions: {
      bazaar: { info: { input: { type: "http", method: "GET" } }, schema: httpSchema },
    },
    ...over,
  }) as unknown as PaymentPayload;

const requirements = (over: Partial<PaymentRequirements> = {}): PaymentRequirements =>
  ({
    scheme: "exact",
    network: "stellar:testnet",
    amount: "1000000",
    asset: ASSET,
    payTo: SELLER,
    maxTimeoutSeconds: 60,
    // Legitimate Stellar exact listings are always sponsored — the facilitator pays the fee — and the
    // stock @x402/stellar client requires it. Default it here so every fixture is a payable listing;
    // the sponsorship-guard tests override it explicitly.
    extra: { areFeesSponsored: true },
    ...over,
  }) as PaymentRequirements;

const now = "2026-07-30T00:00:00.000Z";
const SERVED = ["stellar:testnet", "stellar:pubnet"] as const;
const doIngest = (p = payload(), r = requirements(), existing?: CatalogEntry) =>
  ingest({
    paymentPayload: p,
    paymentRequirements: r,
    // `ingest` resolves the incumbent from the key it is about to write, so the test fixture
    // answers for that key and only that key.
    lookup: (resource, toolName) =>
      existing && existing.resource === resource && existing.toolName === toolName
        ? existing
        : undefined,
    now,
    allowedNetworks: SERVED,
  });

// ── search quality regression gate ───────────────────────────────────────────

describe("search quality", () => {
  // A ranking regression fails the build. This is what makes search quality a deliverable rather
  // than an aspiration. Thresholds live in fixtures.ts and are only ever raised.
  it("meets every ranking threshold on the judgment set", () => {
    const { metrics, results } = evaluate();
    const misses = failures(results).map(r => `"${r.query}" -> ${r.returned[0] ?? "(nothing)"}`);

    expect(metrics.precisionAt1, `top-1 misses:\n${misses.join("\n")}`).toBeGreaterThanOrEqual(
      THRESHOLDS.precisionAt1,
    );
    expect(metrics.recallAt5).toBeGreaterThanOrEqual(THRESHOLDS.recallAt5);
    expect(metrics.mrr).toBeGreaterThanOrEqual(THRESHOLDS.mrr);
    expect(metrics.ndcgAt10).toBeGreaterThanOrEqual(THRESHOLDS.ndcgAt10);
    expect(metrics.zeroResultRate).toBeLessThanOrEqual(THRESHOLDS.zeroResultRate);
  });

  it("keeps the judgment set honest — every judgment names a real corpus entry", () => {
    // Guards against the failure that silently zeroed every MCP judgment: a hand-written key that
    // did not match what the store produces. Keys must come from entryKey, never from a literal.
    const keys = new Set(CORPUS.map(e => entryKey(e.resource, e.toolName)));
    for (const j of JUDGMENTS) {
      for (const rel of j.relevant) {
        expect(keys.has(rel), `judgment "${j.query}" references unknown key ${JSON.stringify(rel)}`).toBe(true);
      }
    }
  });

  it("ranks the specific sibling tool, not just the right MCP endpoint", () => {
    // Both Finlytics tools share a resource URL. Getting the right one proves the (url, toolName)
    // tuple is honoured end to end.
    const store = new CatalogStore();
    for (const e of CORPUS) store.upsert(e);
    const res = store.search("risk metrics for my investment portfolio", {}, 3);
    const top = res.resources[0]!;
    const tool = (top.extensions?.["bazaar"] as { info?: { input?: { toolName?: string } } })?.info
      ?.input?.toolName;
    expect(tool).toBe("portfolio_risk");
  });

  it("lets relevance beat popularity", () => {
    // The forecast endpoint has 5x the settlements of airquality. A query clearly about air
    // quality must still win, or the quality boost has swamped relevance.
    const store = new CatalogStore();
    for (const e of CORPUS) store.upsert(e);
    const res = store.search("air pollution and pollen levels", {}, 3);
    expect(res.resources[0]!.resource).toBe("https://api.weathervane.io/airquality");
  });
});

// ── wire shapes ──────────────────────────────────────────────────────────────

describe("discovery wire shapes", () => {
  const store = new CatalogStore();
  for (const e of CORPUS) store.upsert(e);
  const app = createBazaarApp({ store, startedAt: Date.now() });

  it("returns `items` with offset pagination from /discovery/resources", async () => {
    const body = (await (await app.request("/discovery/resources?limit=3")).json()) as any;
    expect(Object.keys(body).sort()).toEqual(["items", "pagination", "x402Version"]);
    expect(body.items).toHaveLength(3);
    expect(Object.keys(body.pagination).sort()).toEqual(["limit", "offset", "total"]);
  });

  it("returns `resources` with cursor pagination from /discovery/search", async () => {
    const body = (await (await app.request("/discovery/search?query=weather&limit=2")).json()) as any;
    expect(body).toHaveProperty("resources");
    expect(body).not.toHaveProperty("items");
    expect(body.pagination).toHaveProperty("cursor");
    expect(body.pagination).not.toHaveProperty("offset");
  });

  it("emits lastUpdated as an ISO 8601 string, matching stock SDK types and live wire", async () => {
    const body = (await (await app.request("/discovery/resources?limit=1")).json()) as any;
    const value = body.items[0].lastUpdated;
    expect(typeof value).toBe("string");
    expect(() => new Date(value).toISOString()).not.toThrow();
  });

  it("never leaks ownerPayTo to clients", async () => {
    const text = await (await app.request("/discovery/resources")).text();
    expect(text).not.toContain("ownerPayTo");
  });

  it("requires a query on search and says so with a reason", async () => {
    const res = await app.request("/discovery/search");
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBeTruthy();
    expect(body.reason).toMatch(/query/i);
  });
});

// ── filters ──────────────────────────────────────────────────────────────────

describe("all seven filters actually filter", () => {
  // The incumbent Bazaar silently ignores `network` and `scheme` — proven by byte-identical
  // responses across different values. These assert we do not.
  const store = new CatalogStore();
  for (const e of CORPUS) store.upsert(e);
  const app = createBazaarApp({ store, startedAt: Date.now() });
  const total = async (qs: string) =>
    ((await (await app.request(`/discovery/resources?${qs}`)).json()) as any).pagination.total;

  it("filters by type", async () => {
    expect(await total("type=mcp")).toBe(CORPUS.filter(e => e.type === "mcp").length);
    expect(await total("type=http")).toBe(CORPUS.filter(e => e.type === "http").length);
  });

  it("filters by network, and a bogus network returns nothing", async () => {
    const all = await total("");
    expect(await total("network=stellar:pubnet")).toBe(1);
    expect(await total("network=totally-bogus-network-xyz")).toBe(0);
    expect(await total("network=stellar:pubnet")).not.toBe(all);
  });

  it("filters by scheme, and a bogus scheme returns nothing", async () => {
    expect(await total("scheme=exact")).toBeGreaterThan(0);
    expect(await total("scheme=bogusscheme")).toBe(0);
  });

  it("filters by payTo and by extension key", async () => {
    expect(await total(`payTo=${OTHER}`)).toBe(0);
    expect(await total("extensions=bazaar")).toBeGreaterThan(0);
    expect(await total("extensions=nosuchextension")).toBe(0);
  });

  it("applies filters to search as well as list", async () => {
    const body = (await (
      await app.request("/discovery/search?query=stellar&network=stellar:pubnet")
    ).json()) as any;
    for (const r of body.resources) {
      expect(r.accepts.some((a: any) => a.network === "stellar:pubnet")).toBe(true);
    }
  });
});

// ── pagination ───────────────────────────────────────────────────────────────

describe("pagination is deterministic", () => {
  const store = new CatalogStore();
  for (const e of CORPUS) store.upsert(e);

  it("walks the whole result set without repeats or gaps", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = store.search("data", {}, 2, cursor);
      // Key on (resource, toolName): MCP siblings legitimately share a resource URL, so uniqueness of
      // the URL alone would flag two distinct tools as a "repeat". Pagination guarantees no repeated
      // ENTRY, which is the (resource, toolName) tuple.
      seen.push(
        ...res.resources.map(r => {
          const bazaar = r.extensions?.["bazaar"] as { info?: { input?: { toolName?: string } } } | undefined;
          return entryKey(r.resource, bazaar?.info?.input?.toolName);
        }),
      );
      const next = res.pagination?.cursor;
      if (!next) break;
      cursor = next;
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("ignores a cursor issued for a different query rather than returning a wrong slice", () => {
    const first = store.search("weather", {}, 1);
    const cursor = first.pagination!.cursor!;
    // Replayed against another query, the cursor must fail closed to the start.
    const other = store.search("translation", {}, 1, cursor);
    const fresh = store.search("translation", {}, 1);
    expect(other.resources[0]?.resource).toBe(fresh.resources[0]?.resource);
  });

  it("survives a malformed cursor", () => {
    expect(() => store.search("weather", {}, 2, "!!!not-base64!!!")).not.toThrow();
  });
});

// ── cataloging integrity ─────────────────────────────────────────────────────

describe("catalog integrity", () => {
  it("catalogs a well-formed settled payment", () => {
    const out = doIngest();
    expect(out.status).toBe("success");
    if (out.status !== "success") return;
    expect(out.entry.resource).toBe("https://api.example.com/weather");
    expect(out.entry.ownerPayTo).toBe(SELLER);
  });

  it("refuses a payload with no resource.url instead of crashing", () => {
    // The SDK's extractDiscoveryInfo does `new URL(url ?? "")`, which throws — an unauthenticated
    // crash path if called unguarded.
    const out = doIngest(payload({ resource: {} }));
    expect(out.status).toBe("rejected");
    if (out.status !== "rejected") return;
    expect(out.error.code).toBe("bazaar_missing_resource_url");
    expect(out.error.reason).toBeTruthy();
  });

  it("rejects a non-http resource URL", () => {
    const out = doIngest(payload({ resource: { url: "file:///etc/passwd" } }));
    expect(out.status).toBe("rejected");
  });

  // ── Loopback / private-host resource URLs are not payable by any agent (B6) ──
  // The live catalog was 100% http://127.0.0.1:* canary residue that no agent could reach and the
  // buyer surfaces refuse as SSRF (CURRENT_STATUS §6 P9). Catch it at ingest, the moment it arrives.
  it("rejects a loopback resource URL with a coded, non-null reason", () => {
    const out = doIngest(payload({ resource: { url: "http://127.0.0.1:4022/api" } }));
    expect(out.status).toBe("rejected");
    if (out.status !== "rejected") return;
    expect(out.error.code).toBe("bazaar_resource_url_not_public");
    expect(out.error.reason).toBeTruthy();
    expect(out.error.details).toMatchObject({ host: "127.0.0.1" });
  });

  it("rejects private-range, link-local, localhost, and metadata resource URLs", () => {
    for (const url of [
      "http://10.0.0.5/api",
      "http://192.168.1.10/api",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:3000/api",
      "http://metadata.google.internal/x",
      "http://vault.internal/x",
    ]) {
      const out = doIngest(payload({ resource: { url } }));
      expect(out.status, url).toBe("rejected");
      if (out.status !== "rejected") continue;
      expect(out.error.code, url).toBe("bazaar_resource_url_not_public");
    }
  });

  it("catalogs a loopback resource URL only when the local-dev opt-in is set", () => {
    const out = ingest({
      paymentPayload: payload({ resource: { url: "http://127.0.0.1:4022/api" } }),
      paymentRequirements: requirements(),
      now,
      allowedNetworks: SERVED,
      allowPrivateHosts: true,
    });
    expect(out.status).toBe("success");
    if (out.status !== "success") return;
    expect(out.entry.resource).toBe("http://127.0.0.1:4022/api");
  });

  it("threads the private-host opt-in through catalogSettledPayment", () => {
    // Proves the flag reaches ingest through the facilitator-facing entry point, not only when ingest
    // is called directly — the seam is where a wiring bug would hide.
    const decode = (h: string | undefined) =>
      h ? (JSON.parse(Buffer.from(h, "base64").toString("utf8")) as { bazaar: { status: string } }).bazaar : undefined;
    const store = new CatalogStore();
    const loop = () => payload({ resource: { url: "http://127.0.0.1:9/api" } });
    // Off by default: refused, nothing written.
    expect(decode(catalogSettledPayment(store, loop(), requirements(), "GP1", now, SERVED))?.status).toBe(
      "rejected",
    );
    expect(store.size).toBe(0);
    // Opt-in on: the same listing catalogs.
    expect(
      decode(
        catalogSettledPayment(store, loop(), requirements(), "GP1", now, SERVED, undefined, undefined, true),
      )?.status,
    ).toBe("success");
    expect(store.size).toBe(1);
  });

  it("rejects a malformed network identifier", () => {
    const out = doIngest(payload(), requirements({ network: "not a caip2 id!" }));
    expect(out.status).toBe("rejected");
    if (out.status !== "rejected") return;
    expect(out.error.code).toBe("bazaar_network_not_caip2");
  });

  it("rejects a well-formed network we do not settle on", () => {
    // `aws:base` really is valid CAIP-2 syntax — it appears in the live CDP catalog and passes a
    // pure syntax check. Bounding the catalog to networks we actually settle is what excludes it.
    const out = doIngest(payload(), requirements({ network: "aws:base" }));
    expect(out.status).toBe("rejected");
    if (out.status !== "rejected") return;
    expect(out.error.code).toBe("bazaar_network_not_caip2");
    expect(out.error.reason).toMatch(/settles on/i);
  });

  // ── A Stellar listing a stock client cannot pay must never be cataloged (B2) ──
  // The stock @x402/stellar client destructures `extra` and throws when areFeesSponsored is not
  // truthfully true, so an entry without it is UNPAYABLE — exactly the broken Stellar listings the
  // live CDP catalog serves because it validates none of this.
  it("rejects a Stellar exact listing whose extra is missing", () => {
    const out = doIngest(payload(), requirements({ extra: undefined }));
    expect(out.status).toBe("rejected");
    if (out.status !== "rejected") return;
    expect(out.error.code).toBe("bazaar_stellar_fees_not_sponsored");
    expect(out.error.reason).toBeTruthy();
  });

  it("rejects a Stellar exact listing whose extra is null (schema-legal, but a client crash)", () => {
    const out = doIngest(payload(), requirements({ extra: null as unknown as Record<string, unknown> }));
    expect(out.status).toBe("rejected");
    if (out.status !== "rejected") return;
    expect(out.error.code).toBe("bazaar_stellar_fees_not_sponsored");
  });

  it("rejects a Stellar exact listing that declares fees are not sponsored", () => {
    const out = doIngest(payload(), requirements({ extra: { areFeesSponsored: false } }));
    expect(out.status).toBe("rejected");
    if (out.status !== "rejected") return;
    expect(out.error.code).toBe("bazaar_stellar_fees_not_sponsored");
  });

  it("catalogs a Stellar exact listing that truthfully advertises sponsorship", () => {
    const out = doIngest(payload(), requirements({ extra: { areFeesSponsored: true } }));
    expect(out.status).toBe("success");
    if (out.status !== "success") return;
    expect(out.entry.accepts[0]!.extra).toMatchObject({ areFeesSponsored: true });
  });

  it("always emits extra on a catalog entry, since stock PaymentRequirements.extra is required (B1)", () => {
    // A non-exact scheme is not subject to the sponsorship guard, so this exercises the default: a
    // listing whose requirements carry no extra must still be cataloged WITH `extra: {}`, never with
    // extra omitted — an omitted extra is a listing a strict stock consumer rejects.
    const out = doIngest(payload(), requirements({ scheme: "upto", asset: UNKNOWN_ASSET, extra: undefined }));
    expect(out.status).toBe("success");
    if (out.status !== "success") return;
    expect(out.entry.accepts[0]!.extra).toEqual({});
  });

  // ── Provable Stellar asset identity (facilitator-computed extra.stellar) ──────
  it("attaches a provable asset identity, and drops any client-supplied one", () => {
    // The default requirements pay in the real testnet USDC SAC. The facilitator must publish a
    // DERIVED identity for it, and must IGNORE a client's forged `extra.stellar` (echoed from the
    // resource block — attacker-controlled input).
    const out = doIngest(
      payload(),
      requirements({ extra: { areFeesSponsored: true, stellar: { asset: { code: "SCAM", identity: "derived" } } } }),
    );
    expect(out.status).toBe("success");
    if (out.status !== "success") return;
    const extra = out.entry.accepts[0]!.extra as {
      areFeesSponsored?: boolean;
      stellar?: { asset?: { code?: string; identity?: string } };
    };
    expect(extra.stellar?.asset?.code).toBe("USDC");
    expect(extra.stellar?.asset?.identity).toBe("derived");
    // A legitimate client field survives; the forged stellar block does not.
    expect(extra.areFeesSponsored).toBe(true);
  });

  it("does not vouch for an asset it cannot derive (no forged 'derived' label)", () => {
    const out = doIngest(payload(), requirements({ asset: UNKNOWN_ASSET }));
    expect(out.status).toBe("success");
    if (out.status !== "success") return;
    expect((out.entry.accepts[0]!.extra as { stellar?: unknown }).stellar).toBeUndefined();
  });

  it("refuses to let one seller overwrite another seller's listing", () => {
    const first = doIngest();
    expect(first.status).toBe("success");
    if (first.status !== "success") return;

    const hostile = doIngest(payload(), requirements({ payTo: OTHER }), first.entry);
    expect(hostile.status).toBe("rejected");
    if (hostile.status !== "rejected") return;
    expect(hostile.error.code).toBe("bazaar_listing_ownership_conflict");
    expect(hostile.error.reason).toContain(SELLER);
  });

  // ── Ownership must survive routeTemplate ────────
  //
  // These go through `catalogSettledPayment` and a real store rather than `doIngest`, because the
  // vulnerability lived in the seam between the two: the caller looked the incumbent up under
  // `origin + pathname` while the SDK wrote under `origin + routeTemplate`. A test that hands
  // `ingest` an entry directly cannot see that seam at all, which is exactly why it went unnoticed.

  const template = (t: string, over: Record<string, unknown> = {}) =>
    payload({
      ...over,
      extensions: {
        bazaar: { info: { input: { type: "http", method: "GET" } }, schema: httpSchema, routeTemplate: t },
      },
    });

  const verdict = (header: string | undefined) =>
    header ? (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { bazaar: { status: string; code?: string } }).bazaar : undefined;

  it("will not let a routeTemplate write over another seller's listing", () => {
    const store = new CatalogStore();
    const settle = (p: PaymentPayload, r: PaymentRequirements, payer: string) =>
      verdict(catalogSettledPayment(store, p, r, payer, now, SERVED));

    // Victim lists an ordinary, untemplated endpoint.
    expect(
      settle(payload({ resource: { url: "https://api.victim.example/quotes" } }), requirements(), "GP1")?.status,
    ).toBe("success");
    expect(store.get("https://api.victim.example/quotes")?.ownerPayTo).toBe(SELLER);

    // Attacker settles a payment to THEMSELVES, declaring the victim's origin on an unrelated path
    // plus a template that resolves to the victim's key. Under the old lookup this landed as
    // `success`, replaced the entry, and locked the victim out of their own listing.
    const attack = settle(
      template("/quotes", { resource: { url: "https://api.victim.example/unrelated", description: "PWNED" } }),
      requirements({ payTo: OTHER, amount: "50000000" }),
      "GP2",
    );
    expect(attack?.status).toBe("rejected");
    expect(attack?.code).toBe("bazaar_listing_ownership_conflict");

    const after = store.get("https://api.victim.example/quotes")!;
    expect(after.ownerPayTo).toBe(SELLER);
    expect(after.description).not.toBe("PWNED");
    expect(after.accepts[0]!.amount).not.toBe("50000000");
  });

  it("accumulates settlements and merges options for a templated route", () => {
    // The same lookup miss meant every templated settlement looked like the first: totalSettlements
    // stuck at 1 forever, and `mergeAccepts` never ran.
    const store = new CatalogStore();
    for (let i = 0; i < 3; i++) {
      catalogSettledPayment(
        store,
        template("/quotes/:symbol", { resource: { url: `https://api.seller.example/quotes/SYM${i}` } }),
        requirements(),
        `GP${i}`,
        now,
        SERVED,
      );
    }
    const entry = store.get("https://api.seller.example/quotes/:symbol")!;
    expect(entry.quality.totalSettlements).toBe(3);
    expect(entry.quality.uniquePayers).toBe(3);
    expect(entry.accepts).toHaveLength(1);
  });

  it("still catalogs a templated route the first time", () => {
    // Guard against over-correcting: the ownership check must not reject a genuinely new key.
    const store = new CatalogStore();
    const header = catalogSettledPayment(
      store,
      template("/quotes/:symbol", { resource: { url: "https://api.seller.example/quotes/AAPL" } }),
      requirements(),
      "GP1",
      now,
      SERVED,
    );
    expect(verdict(header)?.status).toBe("success");
    expect(store.get("https://api.seller.example/quotes/:symbol")?.ownerPayTo).toBe(SELLER);
  });

  it("rejects info that does not validate against its own declared schema", () => {
    const bad = payload({
      extensions: {
        bazaar: { info: { input: { type: "http" } }, schema: httpSchema }, // missing required `method`
      },
    });
    const out = doIngest(bad);
    expect(out.status).toBe("rejected");
    if (out.status !== "rejected") return;
    expect(out.error.code).toBe("bazaar_info_schema_validation_failed");
  });

  it("soft-drops hostile service metadata without discarding the listing", () => {
    const out = doIngest(
      payload({
        resource: {
          url: "https://api.example.com/weather",
          serviceName: "x".repeat(50), // over the 32-char limit
          iconUrl: "http://127.0.0.1/icon.png", // SSRF attempt
          tags: ["ok", " bad"],
        },
      }),
    );
    expect(out.status).toBe("success");
    if (out.status !== "success") return;
    expect(out.entry.serviceName).toBeUndefined();
    expect(out.entry.iconUrl).toBeUndefined();
    expect(out.entry.tags).toEqual(["ok"]);
  });

  it("discards a traversal routeTemplate but still catalogs the resource", () => {
    const out = doIngest(
      payload({
        extensions: {
          bazaar: {
            info: { input: { type: "http", method: "GET" } },
            schema: httpSchema,
            routeTemplate: "/users/%2e%2e/admin",
          },
        },
      }),
    );
    expect(out.status).toBe("success");
    if (out.status !== "success") return;
    expect(out.entry.resource).not.toContain("..");
    expect(out.entry.resource).toBe("https://api.example.com/weather");
  });
});

// ── EXTENSION-RESPONSES ──────────────────────────────────────────────────────

describe("hybrid cataloging — provisional at verify", () => {
  const decode = (h: string) => JSON.parse(Buffer.from(h, "base64").toString("utf8")).bazaar;

  it("catalogs a discoverable provisional entry at verify, carrying no ranking signals", () => {
    const store = new CatalogStore();
    const header = catalogProvisionalPayment(store, payload(), requirements(), now, SERVED);
    expect(decode(header!).status).toBe("processing");
    // Discoverable — a resource appears "during payment verification", matching the reference impl.
    expect(store.list({}, 10, 0).items.map(i => i.resource)).toContain("https://api.example.com/weather");
    // ...but powerless: it has settled nothing, so there is no usage signal to boost its rank.
    const entry = store.get("https://api.example.com/weather");
    expect(entry?.provisional).toBe(true);
    expect(entry?.quality.totalSettlements).toBe(0);
    expect(entry?.quality.uniquePayers).toBe(0);
  });

  it("reports `rejected` at verify for metadata that would not catalog, and writes nothing", () => {
    const store = new CatalogStore();
    const header = catalogProvisionalPayment(store, payload(), requirements({ network: "aws:base" }), now, SERVED);
    expect(decode(header!).status).toBe("rejected");
    expect(store.size).toBe(0);
  });

  it("confirms a provisional entry into a settled, owned, counted listing", () => {
    const store = new CatalogStore();
    catalogProvisionalPayment(store, payload(), requirements(), now, SERVED);
    const settleHeader = catalogSettledPayment(store, payload(), requirements(), OTHER, now, SERVED);
    expect(decode(settleHeader!).status).toBe("success");
    const entry = store.get("https://api.example.com/weather");
    expect(entry?.provisional).toBeFalsy();
    expect(entry?.ownerPayTo).toBe(SELLER);
    expect(entry?.quality.totalSettlements).toBe(1);
    expect(entry?.quality.uniquePayers).toBe(1);
  });

  it("does not let a hostile verify-time listing lock the real seller out at settle", () => {
    // Anti-poison: an attacker calls /verify declaring the seller's resource under the attacker's own
    // payTo. Because a provisional entry owns nothing, the real seller's settlement must CLAIM it —
    // not be refused as an ownership conflict, which is how the F1 takeover would return via verify.
    const store = new CatalogStore();
    catalogProvisionalPayment(store, payload(), requirements({ payTo: OTHER }), now, SERVED);
    expect(store.get("https://api.example.com/weather")?.ownerPayTo).toBe(OTHER);

    const settleHeader = catalogSettledPayment(store, payload(), requirements({ payTo: SELLER }), OTHER, now, SERVED);
    expect(decode(settleHeader!).status).toBe("success");
    const entry = store.get("https://api.example.com/weather");
    expect(entry?.provisional).toBeFalsy();
    expect(entry?.ownerPayTo).toBe(SELLER);
  });
});

describe("EXTENSION-RESPONSES reporting", () => {
  const decode = (h: string) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));

  it("encodes success in the spec's base64 JSON envelope", () => {
    expect(decode(encodeExtensionResponses({ status: "success" }))).toEqual({
      bazaar: { status: "success" },
    });
  });

  it("reports a successful cataloging on settle", () => {
    const store = new CatalogStore();
    const header = catalogSettledPayment(store, payload(), requirements(), SELLER, now)!;
    expect(decode(header).bazaar.status).toBe("success");
    expect(store.size).toBe(1);
  });

  it("tells a seller why a listing was rejected, with a non-null reason", () => {
    const store = new CatalogStore();
    const header = catalogSettledPayment(
      store,
      payload(),
      requirements({ network: "aws:base" }),
      SELLER,
      now,
      SERVED,
    )!;
    const decoded = decode(header).bazaar;
    expect(decoded.status).toBe("rejected");
    expect(decoded.rejectedReason).toBeTruthy();
    expect(decoded.code).toBe("bazaar_network_not_caip2");
    expect(store.size).toBe(0);
  });

  it("emits no header when the payment carries no bazaar extension", () => {
    const store = new CatalogStore();
    expect(
      catalogSettledPayment(store, payload({ extensions: {} }), requirements(), SELLER, now),
    ).toBeUndefined();
  });

  it("counts unique payers rather than raw settlements for the ranking signal", () => {
    const store = new CatalogStore();
    catalogSettledPayment(store, payload(), requirements(), "GPAYER1", now);
    catalogSettledPayment(store, payload(), requirements(), "GPAYER1", now);
    catalogSettledPayment(store, payload(), requirements(), "GPAYER2", now);
    const entry = store.get("https://api.example.com/weather")!;
    expect(entry.quality.uniquePayers).toBe(2);
    expect(entry.quality.totalSettlements).toBe(3);
  });
});

describe("per-parameter descriptions are searchable", () => {
  // Regression guard. HTTP endpoints carry parameter descriptions in the JSON Schema that validates
  // `info`, not in `info.input` (which holds only concrete example values). The indexer originally
  // read only `info.input.queryParams`, so it captured parameter NAMES and silently dropped every
  // description the seller wrote — degrading search for every HTTP resource in the catalog.
  const withDescribedParam: CatalogEntry = {
    resource: "https://api.example.com/lookup",
    type: "http",
    x402Version: 2,
    accepts: [
      { scheme: "exact", network: "stellar:testnet", amount: "1", asset: ASSET, payTo: SELLER },
    ],
    lastUpdated: now,
    description: "A lookup endpoint.",
    extensions: {
      bazaar: {
        info: { input: { type: "http", method: "GET", queryParams: { isbn: "978-3" } } },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                type: { type: "string", const: "http" },
                method: { type: "string", enum: ["GET"] },
                queryParams: {
                  type: "object",
                  properties: {
                    isbn: {
                      type: "string",
                      description: "International Standard Book Number of the publication.",
                    },
                  },
                  required: ["isbn"],
                },
              },
              required: ["type", "method"],
            },
          },
          required: ["input"],
        },
      },
    },
    quality: { totalSettlements: 1, uniquePayers: 1, firstSeenAt: now },
    ownerPayTo: SELLER,
  };

  it("finds a resource by words that appear only in a parameter description", () => {
    const store = new CatalogStore();
    store.upsert(withDescribedParam);
    // "publication" and "book number" appear nowhere except the parameter's description.
    const res = store.search("international standard book number", {}, 5);
    expect(res.resources.map(r => r.resource)).toContain("https://api.example.com/lookup");
  });

  it("still finds it by parameter name", () => {
    const store = new CatalogStore();
    store.upsert(withDescribedParam);
    expect(store.search("isbn", {}, 5).resources).toHaveLength(1);
  });

  it("feeds the parameter description to the semantic arm, not only BM25 (Z2)", () => {
    // The description lives ONLY in bazaar.schema (the JSON Schema that validates info), not in
    // info.input. `docText` is the text the vector embedder sees; before Z2 it read only
    // info.input.inputSchema and missed the schema descriptions entirely — degrading the semantic
    // arm for the majority of HTTP entries while the BM25 arm saw them.
    const text = docText(withDescribedParam);
    expect(text).toContain("International Standard Book Number of the publication.");
  });
});

// ── SEP-1 seller domain verification ─────────────────

describe("SEP-1 domain verification", () => {
  const TOML = (accounts: string[]) =>
    `VERSION="2.7.0"\nNETWORK_PASSPHRASE="Test SDF Network ; September 2015"\nACCOUNTS=[\n${accounts.map(a => `  "${a}",`).join("\n")}\n]\n`;

  const verifierFor = (body: string | null, status = 200) => {
    const seen: string[] = [];
    const impl = (async (input: URL | RequestInfo) => {
      seen.push(String(input));
      if (body === null) throw new Error("connection refused");
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    return { verifier: new DomainVerifier({ fetchImpl: impl }), seen };
  };

  it("reads ACCOUNTS from a real SEP-1 document", () => {
    expect(accountsFrom(TOML([SELLER, OTHER]))).toEqual([SELLER, OTHER]);
  });

  it("ignores an ACCOUNTS key that is not top-level", () => {
    // A regex-based extractor would happily verify against this. That is the whole reason a real
    // TOML parser is used for a security decision.
    const nested = `VERSION="2.7.0"\n[DOCUMENTATION]\nORG_NAME="x"\n[[CURRENCIES]]\nACCOUNTS=["${OTHER}"]\n`;
    expect(accountsFrom(nested)).toBeUndefined();
  });

  it("returns undefined for malformed TOML rather than throwing", () => {
    expect(accountsFrom("this is not [ toml")).toBeUndefined();
  });

  it("fetches the well-known path over https and verifies a listed account", async () => {
    const { verifier, seen } = verifierFor(TOML([SELLER]));
    const verdict = await verifier.verify("https://api.seller.example/quotes", SELLER);
    expect(verdict.verified).toBe(true);
    expect(seen).toEqual(["https://api.seller.example/.well-known/stellar.toml"]);
  });

  it("refuses an account the domain does not vouch for, with a reason naming both", async () => {
    const { verifier } = verifierFor(TOML([SELLER]));
    const verdict = await verifier.verify("https://api.seller.example/quotes", OTHER);
    expect(verdict.verified).toBe(false);
    if (verdict.verified) return;
    expect(verdict.reason).toContain(OTHER);
    expect(verdict.reason).toContain("ACCOUNTS");
  });

  it("never fetches a private or IP-literal host", async () => {
    for (const url of [
      "http://127.0.0.1/x",
      "https://169.254.169.254/x",
      "https://localhost/x",
      "https://vault.internal/x",
    ]) {
      const { verifier, seen } = verifierFor(TOML([SELLER]));
      const verdict = await verifier.verify(url, SELLER);
      expect(verdict.verified, `${url} should not verify`).toBe(false);
      expect(seen, `${url} was fetched`).toEqual([]);
    }
  });

  it("shares one request between concurrent checks for the same pair", async () => {
    const { verifier, seen } = verifierFor(TOML([SELLER]));
    await Promise.all([
      verifier.verify("https://api.seller.example/a", SELLER),
      verifier.verify("https://api.seller.example/b", SELLER),
      verifier.verify("https://api.seller.example/c", SELLER),
    ]);
    expect(seen).toHaveLength(1);
  });

  it("treats an unreachable stellar.toml as unverified, not as an error", async () => {
    const { verifier } = verifierFor(null);
    const verdict = await verifier.verify("https://api.seller.example/x", SELLER);
    expect(verdict.verified).toBe(false);
  });
});

describe("MCP resource URLs", () => {
  const mcpBazaar = (over: Record<string, unknown> = {}) => ({
    info: {
      input: {
        type: "mcp",
        toolName: "harbour_tides",
        inputSchema: { type: "object", properties: { harbour: { type: "string" } } },
      },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: { type: { type: "string", const: "mcp" }, toolName: { type: "string" } },
          required: ["type", "toolName"],
        },
      },
      required: ["input"],
    },
    ...over,
  });

  it("refuses an mcp:// resource URL with a reason that says what to use instead", () => {
    // A seller reaches this by doing the obvious thing: @x402/mcp's createToolResourceUrl defaults
    // to `mcp://tool/<name>`. The value is not merely unsupported, it is unusable — `mcp:` is not a
    // WHATWG special scheme, so `new URL("mcp://tool/x").origin` is the STRING "null" and the
    // spec's origin+path key collapses to one key shared by every seller on earth.
    expect(new URL("mcp://tool/harbour_tides").origin).toBe("null");
    expect(new URL("mcp://alice.example/tool/x").origin).toBe("null"); // the host is dropped too

    const outcome = ingest({
      paymentPayload: payload({
        resource: { url: "mcp://tool/harbour_tides" },
        extensions: { bazaar: mcpBazaar() },
      }),
      paymentRequirements: requirements(),
      now,
      allowedNetworks: SERVED,
    });

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.error.code).toBe("bazaar_mcp_resource_url_not_addressable");
    // An actionable reason, not a restatement of the rule.
    expect(outcome.error.reason).toMatch(/http\(s\)/);
    expect(outcome.error.reason).toMatch(/input\.toolName/);
    expect(outcome.error.reason).toContain("mcp://tool/harbour_tides");
  });

  it("catalogs an MCP tool whose resource URL is the http endpoint, keyed on the pair", () => {
    const outcome = ingest({
      paymentPayload: payload({
        resource: { url: "https://api.example.com/mcp" },
        extensions: { bazaar: mcpBazaar() },
      }),
      paymentRequirements: requirements(),
      now,
      allowedNetworks: SERVED,
    });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.entry.type).toBe("mcp");
    expect(outcome.entry.toolName).toBe("harbour_tides");
    // One endpoint multiplexes many tools, so the URL alone is not the identity.
    expect(entryKey(outcome.entry.resource, outcome.entry.toolName)).not.toBe(outcome.entry.resource);
  });
});

describe("trustline pre-flight", () => {
  const decode = (h: string | undefined) =>
    h ? (JSON.parse(Buffer.from(h, "base64").toString("utf8")) as Record<string, unknown>) : undefined;
  const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const CONTRACT_PAYEE = "CAQSCMM6L2QVQGZ6SFPPPQGKV3TYPPTPZBQYJUQDKGNSJKGQXKPXMDBC";

  const balance = (over: Record<string, unknown> = {}) => ({
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: USDC_ISSUER,
    limit: "922337203685.4775807",
    is_authorized: true,
    ...over,
  });

  const checkerFor = (respond: () => Response | Promise<Response>) => {
    const seen: string[] = [];
    const impl = (async (input: URL | RequestInfo) => {
      seen.push(String(input));
      return respond();
    }) as unknown as typeof fetch;
    return { checker: new TrustlineChecker({ fetchImpl: impl }), seen };
  };
  const accountWith = (balances: unknown[]) =>
    () => new Response(JSON.stringify({ balances }), { status: 200 });

  // ── the three conditions that make the question askable ───────────────────
  it("does not apply to native XLM, a contract payee, or an unidentifiable asset", () => {
    // Each of these would produce a confidently wrong answer if checked anyway: XLM needs no
    // trustline, a contract payee holds SAC balances in contract storage where trustlines do not
    // exist, and a SAC address cannot be reversed into the (code, issuer) a trustline is held
    // against. Silence is the only honest output.
    expect(trustlineTarget("stellar:testnet", XLM_SAC, SELLER)).toBeUndefined();
    expect(trustlineTarget("stellar:testnet", ASSET, CONTRACT_PAYEE)).toBeUndefined();
    expect(trustlineTarget("stellar:testnet", UNKNOWN_ASSET, SELLER)).toBeUndefined();
    // And it does apply to the case it exists for: a classic account paid in identifiable USDC.
    expect(trustlineTarget("stellar:testnet", ASSET, SELLER)).toMatchObject({
      code: "USDC",
      issuer: USDC_ISSUER,
    });
  });

  it("makes no request at all when the question does not apply", async () => {
    const { checker, seen } = checkerFor(accountWith([balance()]));
    expect(await checker.check("stellar:testnet", XLM_SAC, SELLER)).toBeUndefined();
    expect(await checker.check("stellar:testnet", ASSET, CONTRACT_PAYEE)).toBeUndefined();
    expect(seen).toEqual([]);
  });

  // ── the four states ───────────────────────────────────────────────────────
  it("reports ok for an authorized trustline", async () => {
    const { checker, seen } = checkerFor(accountWith([balance(), { asset_type: "native", balance: "10" }]));
    const verdict = await checker.check("stellar:testnet", ASSET, SELLER);
    expect(verdict?.state).toBe("ok");
    expect(verdict?.checkedAt).toBeTruthy();
    expect(seen).toEqual([`https://horizon-testnet.stellar.org/accounts/${SELLER}`]);
  });

  it("reports missing when the payee holds no trustline, naming the fix", async () => {
    const { checker } = checkerFor(accountWith([{ asset_type: "native", balance: "10" }]));
    const verdict = await checker.check("stellar:testnet", ASSET, SELLER);
    expect(verdict?.state).toBe("missing");
    // Non-null reason on every non-ok state, and it must be actionable.
    expect(verdict?.reason).toContain("USDC");
    expect(verdict?.reason).toMatch(/CHANGE_TRUST/);
  });

  it("reports missing for an account that does not exist", async () => {
    const { checker } = checkerFor(() => new Response("{}", { status: 404 }));
    const verdict = await checker.check("stellar:testnet", ASSET, SELLER);
    expect(verdict?.state).toBe("missing");
    expect(verdict?.reason).toContain("does not exist");
  });

  it("reports unauthorized for a deauthorized trustline and for a zero limit", async () => {
    // Two different mechanisms, one consequence: the line exists and can receive nothing. The state
    // is shared; the reason says which one it is, because they need different fixes.
    const deauthorized = checkerFor(accountWith([balance({ is_authorized: false })]));
    const deauthorizedVerdict = await deauthorized.checker.check("stellar:testnet", ASSET, SELLER);
    expect(deauthorizedVerdict?.state).toBe("unauthorized");
    expect(deauthorizedVerdict?.reason).toMatch(/issuer has not authorized/);

    const zeroLimit = checkerFor(accountWith([balance({ limit: "0" })]));
    const zeroVerdict = await zeroLimit.checker.check("stellar:testnet", ASSET, SELLER);
    expect(zeroVerdict?.state).toBe("unauthorized");
    expect(zeroVerdict?.reason).toMatch(/limit of 0/);
  });

  it("reports unknown — never ok — when Horizon cannot answer", async () => {
    // Failing open here would tell an agent a payment will land when nothing checked that it would,
    // which is strictly worse than saying nothing.
    for (const respond of [
      () => { throw new Error("ECONNREFUSED"); },
      () => new Response("upstream", { status: 503 }),
      () => new Response(JSON.stringify({ balances: "not an array" }), { status: 200 }),
    ]) {
      const { checker } = checkerFor(respond as () => Response);
      const verdict = await checker.check("stellar:testnet", ASSET, SELLER);
      expect(verdict?.state).toBe("unknown");
      expect(verdict?.reason).toBeTruthy();
    }
  });

  it("shares one request between concurrent checks for the same triple", async () => {
    const { checker, seen } = checkerFor(accountWith([balance()]));
    await Promise.all([
      checker.check("stellar:testnet", ASSET, SELLER),
      checker.check("stellar:testnet", ASSET, SELLER),
      checker.check("stellar:testnet", ASSET, SELLER),
    ]);
    expect(seen).toHaveLength(1);
  });

  // ── advisory: it never gates cataloging ───────────────────────────────────
  it("catalogs a listing whose payee cannot receive the asset, with the problem stated on it", async () => {
    // The whole posture. Delisting a seller because Horizon says `missing` would be a worse failure
    // than the one being prevented and would hand anyone a denial-of-listing lever — and Horizon
    // being briefly down would silently unlist working sellers.
    const store = new CatalogStore();
    const { checker } = checkerFor(accountWith([{ asset_type: "native", balance: "10" }]));
    const header = catalogSettledPayment(
      store,
      payload(),
      requirements(),
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      now,
      SERVED,
      undefined,
      checker,
    );
    // Cataloged, unconditionally.
    expect(decode(header)).toMatchObject({ bazaar: { status: "success" } });
    expect(store.size).toBe(1);

    // The check resolves afterwards and is written onto the listing, never in front of it.
    await new Promise(resolve => setImmediate(resolve));
    const entry = store.get("https://api.example.com/weather")!;
    const stellar = entry.accepts[0]!.extra["stellar"] as Record<string, unknown>;
    expect(stellar["payToTrustline"]).toMatchObject({ state: "missing" });
    // The derived asset identity is still there — the two enrichments share one key and neither
    // displaces the other.
    expect(stellar["asset"]).toMatchObject({ code: "USDC", identity: "derived" });
  });

  it("attaches a cached verdict at ingest, keyed on the triple it was checked for", async () => {
    const { checker } = checkerFor(accountWith([balance()]));
    await checker.check("stellar:testnet", ASSET, SELLER);

    const outcome = ingest({
      paymentPayload: payload(),
      paymentRequirements: requirements(),
      trustlineVerdict: checker.cached("stellar:testnet", ASSET, SELLER),
      now,
      allowedNetworks: SERVED,
    });
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    const stellar = outcome.entry.accepts[0]!.extra["stellar"] as Record<string, unknown>;
    expect(stellar["payToTrustline"]).toMatchObject({ state: "ok" });
    // A verdict about a different payee is not this listing's verdict — the cache must not answer.
    expect(checker.cached("stellar:testnet", ASSET, OTHER)).toBeUndefined();
  });

  it("updates every listing that shares the triple, and cannot move anything's rank", () => {
    const store = new CatalogStore();
    for (const path of ["/a", "/b"]) {
      const entry = ingest({
        paymentPayload: payload({ resource: { url: `https://api.example.com${path}` } }),
        paymentRequirements: requirements(),
        now,
        allowedNetworks: SERVED,
      });
      if (entry.status === "success") store.upsert(entry.entry);
    }
    // A third listing for a different payee must not be touched by a verdict about SELLER.
    const other = ingest({
      paymentPayload: payload({ resource: { url: "https://other.example.com/c" } }),
      paymentRequirements: requirements({ payTo: OTHER }),
      now,
      allowedNetworks: SERVED,
    });
    if (other.status === "success") store.upsert(other.entry);

    const before = store.search("weather", {}).resources.map(r => r.resource);
    const updated = store.setTrustline("stellar:testnet", ASSET, SELLER, {
      state: "missing",
      checkedAt: now,
      reason: "no trustline",
    });
    expect(updated).toBe(2);
    expect(
      (store.get("https://other.example.com/c")!.accepts[0]!.extra["stellar"] as Record<string, unknown>)[
        "payToTrustline"
      ],
    ).toBeUndefined();
    // Advisory metadata is not a ranking signal. If it were, a seller could tune their rank by
    // touching their own trustline.
    expect(store.search("weather", {}).resources.map(r => r.resource)).toEqual(before);
  });
});

describe("SEP-1 ownership precedence", () => {
  const verdict = (verified: boolean) =>
    verified
      ? ({ verified: true, domain: "api.victim.example" } as const)
      : ({ verified: false, domain: "api.victim.example", reason: "not listed" } as const);

  const settle = (
    store: CatalogStore,
    payTo: string,
    domainVerdict?: { verified: boolean; domain: string; reason?: string },
  ) =>
    ingest({
      paymentPayload: payload({ resource: { url: "https://api.victim.example/quotes" } }),
      paymentRequirements: requirements({ payTo }),
      lookup: (r, t) => store.get(r, t),
      ...(domainVerdict === undefined ? {} : { domainVerdict: domainVerdict as never }),
      now,
      allowedNetworks: SERVED,
    });

  it("lets a domain-verified seller displace an unverified squatter", () => {
    const store = new CatalogStore();
    // Squatter gets there first, as they always will — claiming a key is cheap.
    const squat = settle(store, OTHER);
    expect(squat.status).toBe("success");
    if (squat.status !== "success") return;
    store.upsert(squat.entry, "GPSQUAT");

    // The real owner arrives with SEP-1 evidence.
    const real = settle(store, SELLER, verdict(true));
    expect(real.status).toBe("success");
    if (real.status !== "success") return;
    expect(real.entry.ownerPayTo).toBe(SELLER);
    expect(real.entry.domainVerified).toBe(true);
    // The squatter's accumulated signals do not transfer to the new owner.
    expect(real.entry.quality.totalSettlements).toBe(1);
    expect(real.entry.accepts).toHaveLength(1);
  });

  it("never lets anyone displace a domain-verified owner", () => {
    const store = new CatalogStore();
    const real = settle(store, SELLER, verdict(true));
    if (real.status !== "success") return;
    store.upsert(real.entry, "GPREAL");

    // Even another verified-looking claim loses: the incumbent's evidence already stands.
    for (const attempt of [settle(store, OTHER, verdict(true)), settle(store, OTHER)]) {
      expect(attempt.status).toBe("rejected");
      if (attempt.status !== "rejected") continue;
      expect(attempt.error.code).toBe("bazaar_listing_ownership_conflict");
    }
    expect(store.get("https://api.victim.example/quotes")?.ownerPayTo).toBe(SELLER);
  });

  it("tells an unverified challenger exactly how to establish precedence", () => {
    const store = new CatalogStore();
    const first = settle(store, OTHER);
    if (first.status !== "success") return;
    store.upsert(first.entry, "GP1");

    const denied = settle(store, SELLER, verdict(false));
    expect(denied.status).toBe("rejected");
    if (denied.status !== "rejected") return;
    expect(denied.error.reason).toMatch(/stellar\.toml/);
    expect(denied.error.reason).toMatch(/ACCOUNTS/);
    expect(denied.error.details).toMatchObject({ remedy: "sep1-accounts" });
  });

  it("only flips the badge for the owner, not for whoever last paid", () => {
    // A third party paying a seller's endpoint from their own verified address must not be able to
    // stamp — or clear — that seller's badge.
    const store = new CatalogStore();
    const mine = settle(store, SELLER, verdict(true));
    if (mine.status !== "success") return;
    store.upsert(mine.entry, "GP1");

    expect(store.setDomainVerified("https://api.victim.example/quotes", OTHER, false)).toBe(false);
    expect(store.get("https://api.victim.example/quotes")?.domainVerified).toBe(true);

    expect(store.setDomainVerified("https://api.victim.example/quotes", SELLER, false)).toBe(true);
    expect(store.get("https://api.victim.example/quotes")?.domainVerified).toBe(false);
  });
});

describe("ranking signals resist self-dealing", () => {
  it("does not count a seller paying its own endpoint", () => {
    // The anti-spam argument was that every listing costs a real payment. With payer === payTo it
    // costs nothing: no net value moves and the facilitator sponsors the fee (§F7).
    const store = new CatalogStore();
    const out = doIngest();
    if (out.status !== "success") return;
    for (let i = 0; i < 60; i++) store.upsert(structuredClone(out.entry), SELLER);

    const entry = store.get("https://api.example.com/weather")!;
    expect(entry.quality.totalSettlements).toBe(0);
    expect(entry.quality.uniquePayers).toBe(0);
  });

  it("still counts genuine third-party buyers", () => {
    const store = new CatalogStore();
    const out = doIngest();
    if (out.status !== "success") return;
    for (const buyer of ["GPBUYER1", "GPBUYER2", "GPBUYER3"]) {
      store.upsert(structuredClone(out.entry), buyer);
    }
    expect(store.get("https://api.example.com/weather")!.quality.uniquePayers).toBe(3);
  });
});

describe("search cursors bind to the whole request", () => {
  /** Several entries sharing a term, half owned by each payTo, so filters change the candidate set. */
  const paged = () => {
    const store = new CatalogStore();
    for (let i = 0; i < 6; i++) {
      const out = ingest({
        paymentPayload: payload({
          resource: {
            url: `https://api.example.com/tide${i}`,
            description: "tide times and sea conditions at a coastal port",
          },
        }),
        paymentRequirements: requirements({ payTo: i < 3 ? SELLER : OTHER }),
        lookup: (r, t) => store.get(r, t),
        now,
        allowedNetworks: SERVED,
      });
      if (out.status === "success") store.upsert(out.entry, `GPBUYER${i}`);
    }
    return store;
  };

  it("refuses a cursor replayed under different filters", () => {
    const store = paged();
    const first = store.search("tide times", { payTo: SELLER }, 2);
    const cursor = first.pagination?.cursor;
    expect(cursor).toBeTruthy();

    // Same query, different filters. The offset must NOT carry over into a different candidate
    // list — the caller would have no way to tell they were handed an arbitrary slice.
    const replayed = store.search("tide times", { payTo: OTHER }, 2, cursor ?? undefined);
    const fresh = store.search("tide times", { payTo: OTHER }, 2);
    expect(replayed.resources.map(r => r.resource)).toEqual(fresh.resources.map(r => r.resource));
  });

  it("still paginates correctly when the filters match", () => {
    const store = paged();
    const page1 = store.search("tide times", { payTo: SELLER }, 2);
    const page2 = store.search("tide times", { payTo: SELLER }, 2, page1.pagination?.cursor ?? undefined);
    const seen = [...page1.resources, ...page2.resources].map(r => r.resource);
    expect(new Set(seen).size).toBe(seen.length);
    expect(page1.resources).toHaveLength(2);
    expect(page2.resources).toHaveLength(1);
  });
});

describe("partialResults truncation (Z4)", () => {
  // `partialResults` is one of the three §3.2 search features and shipped with zero tests. It means
  // matches were TRUNCATED at the facilitator's scoring ceiling — NOT merely that another page
  // exists. It fires when scored matches reach SEARCH_CEILING (200); the page limit (MAX_LIMIT 100)
  // only bounds the page, so the flag is genuinely reachable with enough matching entries.
  const many = (count: number) => {
    const store = new CatalogStore();
    for (let i = 0; i < count; i++) {
      store.upsert({
        resource: `https://api.example.com/forecast/${i}`,
        type: "http",
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "stellar:testnet", amount: "1", asset: ASSET, payTo: SELLER }],
        lastUpdated: now,
        description: "coastal weather forecast service",
        quality: { totalSettlements: 1, uniquePayers: 1, firstSeenAt: now },
        ownerPayTo: SELLER,
      } as CatalogEntry);
    }
    return store;
  };

  it("sets partialResults when matches hit the scoring ceiling", () => {
    const res = many(260).search("coastal weather forecast", {}, 100);
    expect(res.resources).toHaveLength(100); // page capped at MAX_LIMIT
    expect(res.pagination?.cursor).toBeTruthy(); // more pages exist
    expect(res.partialResults).toBe(true); // and the match set itself was truncated
  });

  it("omits partialResults when matches are under the ceiling, even across pages", () => {
    const res = many(30).search("coastal weather forecast", {}, 10);
    // A next page exists (30 matches, page of 10) but nothing was truncated — the flag must stay off.
    expect(res.pagination?.cursor).toBeTruthy();
    expect(res.partialResults).toBeUndefined();
  });
});
