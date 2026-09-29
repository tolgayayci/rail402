import { describe, expect, it } from "vitest";
import { SchemaSandbox } from "@rail402.dev/bazaar";
import { unmetConstraints } from "../src/constraints.ts";
import {
  ASSETS,
  catalogDraft,
  draftProblems,
  providerAccount,
  shuffled,
  type Draft,
} from "../src/build/corpus.ts";
import { TfIdf, renderListing } from "../src/build/pool.ts";
import { combine, copiedQueries, kappa } from "../src/build/qrels.ts";
import { queryProblems, withTypos } from "../src/build/queries.ts";
import { leastUsedSamples, publicListings, type Capture } from "../src/build/public.ts";
import type { CorpusEntry } from "../src/dataset.ts";

const draft: Draft = {
  draft: "t-001",
  category: "geo-travel",
  capabilities: ["weather-forecast"],
  provider: "skycast",
  kind: "http",
  resource: "https://api.skycast.example/v2/forecast",
  method: "GET",
  serviceName: "Skycast",
  description: "Hour-by-hour forecasts for the next 10 days",
  tags: ["weather"],
  parameters: [{ name: "city", type: "string", required: true, description: "City name", example: "Lisbon" }],
  output: { example: { tempC: 21 } },
  prices: [
    { network: "stellar:pubnet", asset: "USDC", amount: "0.002" },
    { network: "stellar:pubnet", asset: "XLM", amount: "0.05" },
  ],
  style: "detailed",
};

describe("corpus construction", () => {
  it("catalogs a draft through the stock extension and Rail402's extraction", async () => {
    const sandbox = new SchemaSandbox();
    try {
      const result = await catalogDraft(draft, sandbox);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content).toMatchObject({ kind: "http", method: "GET", serviceName: "Skycast" });
      expect(result.content.accepts.map((option) => option.amount)).toEqual(["20000", "500000"]);
      expect(result.content.accepts.every((option) => option.payTo === providerAccount("skycast"))).toBe(
        true,
      );
      expect(result.content.bazaar.info).toMatchObject({ output: { example: { tempC: 21 } } });

      const missingExample = await catalogDraft(
        { ...draft, parameters: [{ name: "city", type: "string", required: true }] },
        sandbox,
      );
      expect(missingExample).toMatchObject({ ok: false });
    } finally {
      await sandbox.close();
    }
  });

  it("reports malformed drafts", () => {
    expect(draftProblems(draft)).toEqual([]);
    expect(
      draftProblems({ ...draft, prices: [{ network: "stellar:pubnet", asset: "DOGE", amount: "1" }] }),
    ).toEqual(["unknown asset DOGE on stellar:pubnet"]);
    expect(draftProblems({ ...draft, kind: "mcp", toolName: undefined })).toContain(
      "toolName must be a non-empty string",
    );
  });

  it("shuffles deterministically", () => {
    expect(shuffled([1, 2, 3, 4, 5], 9)).toEqual(shuffled([1, 2, 3, 4, 5], 9));
    expect(shuffled([1, 2, 3, 4, 5], 9).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("query construction", () => {
  const capabilities = new Set(["weather-forecast"]);

  it("requires labelled constraints to cover the filter", () => {
    const base = { draft: "q-1", text: "forecast", class: "constraint", targets: ["weather-forecast"] };
    expect(queryProblems({ ...base, expected: { network: "stellar:testnet" } }, capabilities)).toEqual([]);
    expect(queryProblems(base, capabilities)).toContain("constraint queries need expected constraints");
    expect(
      queryProblems(
        { ...base, filter: { type: "mcp" }, expected: { network: "stellar:testnet" } },
        capabilities,
      ),
    ).toContain("filter type is missing from expected");
  });

  it("derives typos deterministically and only from longer words", () => {
    expect(withTypos("iban validator", 3)).toBe(withTypos("iban validator", 3));
    expect(withTypos("iban validator", 3)).not.toBe("iban validator");
    expect(withTypos("iban validator", 3).startsWith("iban ")).toBe(true);
  });
});

describe("independent constraint check", () => {
  const usdc = ASSETS.find((asset) => asset.network === "stellar:pubnet" && asset.symbol === "USDC");
  const xlm = ASSETS.find((asset) => asset.network === "stellar:pubnet" && asset.symbol === "XLM");
  const listing = {
    resource: "https://x.example/a",
    kind: "http" as const,
    bazaar: { info: {}, schema: {} },
    accepts: [
      {
        scheme: "exact",
        network: "stellar:pubnet",
        asset: usdc?.contract ?? "",
        payTo: "G",
        amount: "200000",
        maxTimeoutSeconds: 60,
        extra: {},
      },
      {
        scheme: "exact",
        network: "stellar:pubnet",
        asset: xlm?.contract ?? "",
        payTo: "G",
        amount: "500000",
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  };

  it("checks constraints jointly on one payment option", () => {
    expect(unmetConstraints(listing, { maxPrice: { amount: "0.02", unit: "USD" } }, ASSETS)).toEqual([]);
    expect(unmetConstraints(listing, { maxPrice: { amount: "0.01", unit: "USD" } }, ASSETS)).toEqual([
      "price",
    ]);
    // XLM is cheap enough but is not a dollar asset; USDC is a dollar asset but too expensive.
    expect(
      unmetConstraints(listing, { asset: "XLM", maxPrice: { amount: "0.01", unit: "USD" } }, ASSETS),
    ).toEqual(["price"]);
    expect(
      unmetConstraints(listing, { asset: "XLM", maxPrice: { amount: "0.05", unit: "XLM" } }, ASSETS),
    ).toEqual([]);
    expect(unmetConstraints(listing, { network: "stellar:testnet" }, ASSETS)).toEqual(["network"]);
    expect(unmetConstraints(listing, { type: "mcp" }, ASSETS)).toEqual(["type"]);
  });
});

describe("pooling and judging", () => {
  it("ranks with an independent TF-IDF", () => {
    const index = new TfIdf(
      new Map([
        ["L1", "weather forecast api"],
        ["L2", "stock quotes"],
      ]),
    );
    expect(index.search("forecast", 5)).toEqual(["L1"]);
  });

  it("renders listings without price or network", () => {
    const text = renderListing("L7", {
      resource: "https://x.example/a",
      kind: "http",
      method: "GET",
      description: "Forecasts",
      bazaar: { info: {}, schema: {} },
      accepts: [],
    });
    expect(text).toContain("HTTP GET https://x.example/a");
    expect(text).not.toMatch(/stellar:|USDC|amount/);
  });

  it("combines two judges conservatively and requires adjudication for wide gaps", () => {
    expect(combine(2, 2, undefined)).toBe(2);
    expect(combine(3, 2, undefined)).toBe(2);
    expect(combine(3, 0, undefined)).toBeUndefined();
    expect(combine(3, 0, 2)).toBe(2);
  });

  it("computes Cohen's kappa", () => {
    expect(
      kappa(
        [
          [1, 1],
          [0, 0],
          [1, 1],
          [0, 0],
        ],
        2,
        false,
      ),
    ).toBe(1);
    expect(
      kappa(
        [
          [1, 0],
          [0, 1],
          [1, 0],
          [0, 1],
        ],
        2,
        false,
      ),
    ).toBeLessThan(0);
  });

  it("flags queries whose two sets agree on every candidate and share notes", () => {
    const pools = new Map([
      ["Q1", { query: "Q1", pool: ["L1", "L2"], systems: {} }],
      ["Q2", { query: "Q2", pool: ["L1", "L2"], systems: {} }],
      ["Q3", { query: "Q3", pool: ["L1", "L2"], systems: {} }],
    ]);
    const line = (query: string, listing: string, grade: number, note?: string) =>
      [`${query}|${listing}`, { query, listing, grade, ...(note === undefined ? {} : { note }) }] as const;
    const a = new Map([
      line("Q1", "L1", 3, "does it"),
      line("Q1", "L2", 0),
      line("Q2", "L1", 0),
      line("Q2", "L2", 0),
      line("Q3", "L1", 3, "does it"),
      line("Q3", "L2", 1, "sibling"),
    ]);
    const b = new Map([
      line("Q1", "L1", 3, "does it"),
      line("Q1", "L2", 0),
      line("Q2", "L1", 0),
      line("Q2", "L2", 0),
      line("Q3", "L1", 3, "does it"),
      line("Q3", "L2", 1, "related op"),
    ]);
    // Q2 agrees but shares no note (all zero, a genuine no-answer query); Q3 differs in a note.
    expect(copiedQueries(pools, a, b)).toEqual(["Q1"]);
  });
});

describe("public listings", () => {
  const item = (resource: string, trust: string, extra: Record<string, unknown> = {}) => ({
    resource,
    type: "mcp" as const,
    accepts: [],
    description: `${trust} copy`,
    extensions: { bazaar: { info: {}, schema: {} }, ...extra },
    rail402: { toolName: "forecast", trust },
  });

  it("keeps one listing per resource, the most trusted, with its declared extension keys", () => {
    const capture: Capture = {
      catalog: "https://facilitator.example/discovery/resources",
      retrievedAt: "2026-09-28T00:00:00.000Z",
      facilitatorVersion: "test",
      pages: [],
      items: [
        item("https://a.example/mcp", "settled"),
        item("https://a.example/mcp", "domain_verified", { "payment-identifier": {} }),
        item("https://a.example/mcp", "settled"),
        item("https://b.example/mcp", "settled"),
      ],
    };
    const listings = publicListings(capture);
    expect(listings.map((listing) => [listing.resource, listing.description, listing.extensions])).toEqual([
      ["https://a.example/mcp", "domain_verified copy", ["payment-identifier"]],
      ["https://b.example/mcp", "settled copy", undefined],
    ]);
  });

  it("drops the samples no judge found relevant and the pooled systems returned least", () => {
    const entry = (id: string): CorpusEntry => ({
      id,
      source: "sample",
      listing: {} as CorpusEntry["listing"],
    });
    const corpus = ["L1", "L2", "L3", "L4"].map(entry);
    const grades = new Map([
      ["L1", 0],
      ["L2", 2],
      ["L3", 0],
      ["L4", 0],
    ]);
    const pools = [{ query: "Q1", pool: [], systems: { bm25: ["L1", "L2", "L3"], dense: ["L1"] } }];
    expect(leastUsedSamples(corpus, grades, pools, 2)).toEqual(["L4", "L3"]);
  });
});
