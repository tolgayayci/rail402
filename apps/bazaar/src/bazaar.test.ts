import { describe, it, expect } from "vitest";
import { CatalogStore } from "./catalog/store.js";
import { ingest } from "./catalog/ingest.js";
import { entryKey, type CatalogEntry } from "./catalog/types.js";
import { CORPUS, JUDGMENTS, THRESHOLDS } from "./search/fixtures.js";
import { evaluate, failures } from "./search/evaluate.js";
import { createBazaarApp, catalogSettledPayment, encodeExtensionResponses } from "./app.js";
import { DomainVerifier, accountsFrom } from "./catalog/domain.js";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

// ── helpers ──────────────────────────────────────────────────────────────────

const SELLER = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";
const OTHER = "GC6CSXBV4C6RL3HEDTW57KXYXSSXKAWKGYDEOSATXM3XNKXSR2VRYN3K";
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

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
      seen.push(...res.resources.map(r => r.resource));
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
