/**
 * A fake Bazaar for the web role's tests: the public read API (`/discovery/resources`, a listing, its
 * versions, settlements, listing and seller usage) answered from memory as a `fetch`, in any of the
 * states pages must survive: up, down (5xx or timeout), without the usage routes (404), and private.
 */
import { RULES_VERSION, type SettlementRow } from "@rail402.dev/x402-index";
import type { ReportDocument } from "../src/api/report.ts";
import { Aggregator } from "../src/rebuild/aggregates.ts";
import { BazaarClient } from "../src/web/bazaar.ts";

export type BazaarMode = "up" | "down" | "no-usage-routes";

export interface FakeListing {
  readonly id: string;
  readonly type: "http" | "mcp";
  readonly resource: string;
  readonly method?: string;
  readonly toolName?: string;
  readonly description?: string;
  readonly serviceName?: string;
  readonly payTo: string;
  readonly scheme: "exact" | "upto";
  readonly amount: string;
  readonly asset: string;
  readonly info?: Record<string, unknown>;
  readonly routeTemplate?: string;
  /** Settled payments linked to the listing: outer hashes. */
  readonly paid?: readonly SettlementRow[];
  readonly private?: boolean;
  /** The network publishes counts only: no settlement is linked to the listing, none listed. */
  readonly countsOnly?: boolean;
  /** `published` by default; others are shown only by id, as the detail route does. */
  readonly state?: "published" | "pending" | "withdrawn";
}

const NETWORK = "stellar:testnet";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const notFound = (code = "discovery_listing_not_found", reason = "No listing has this identifier.") =>
  json({ error: { code, reason, retryable: false } }, 404);

function item(listing: FakeListing) {
  return {
    resource: listing.resource,
    type: listing.type,
    x402Version: 2,
    accepts: [
      {
        scheme: listing.scheme,
        network: NETWORK,
        amount: listing.amount,
        asset: listing.asset,
        payTo: listing.payTo,
        maxTimeoutSeconds: 300,
        extra: { areFeesSponsored: true },
      },
    ],
    lastUpdated: "2026-10-22T12:59:44.119Z",
    ...(listing.description === undefined ? {} : { description: listing.description }),
    ...(listing.serviceName === undefined ? {} : { serviceName: listing.serviceName }),
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: listing.info ?? {},
        schema: {},
        ...(listing.routeTemplate === undefined ? {} : { routeTemplate: listing.routeTemplate }),
      },
    },
    rail402: {
      ...(listing.method === undefined ? {} : { method: listing.method }),
      ...(listing.toolName === undefined ? {} : { toolName: listing.toolName }),
      trust: "domain_verified",
      settlements: listing.paid?.length ?? 0,
      listings: [
        {
          id: listing.id,
          network: NETWORK,
          version: 2,
          trust: "domain_verified",
          owner: listing.payTo,
          settlements: listing.paid?.length ?? 0,
          firstCataloged: "2026-09-29T14:52:57.854Z",
          lastSettled: "2026-10-26T15:00:33.416Z",
        },
      ],
      options: [{ listing: listing.id, symbol: "USDC", decimals: 7, receivable: true }],
    },
  };
}

function ref(listing: FakeListing) {
  return {
    id: listing.id,
    type: listing.type,
    resource: listing.resource,
    ...(listing.method === undefined ? {} : { method: listing.method }),
    ...(listing.toolName === undefined ? {} : { toolName: listing.toolName }),
    ...(listing.description === undefined ? {} : { description: listing.description }),
    payTo: listing.payTo,
    scheme: listing.scheme,
    amount: listing.amount,
    asset: listing.asset,
    network: NETWORK,
    lastUpdated: "2026-10-22T12:59:44.119Z",
  };
}

/** A fake Bazaar's fetch over `listings`, and the paths it was asked for. */
export function fakeBazaar(listings: readonly FakeListing[], mode: BazaarMode = "up") {
  const paths: string[] = [];
  const fetch: typeof globalThis.fetch = (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    paths.push(`${url.pathname}${url.search}`);
    if (mode === "down") return Promise.resolve(new Response("upstream error", { status: 502 }));
    const path = url.pathname;
    if (path === "/discovery/resources") {
      const payTo = url.searchParams.get("payTo");
      const items = listings
        .filter((listing) => (listing.state ?? "published") === "published")
        .filter((listing) => payTo === null || listing.payTo === payTo)
        .map(item);
      return Promise.resolve(
        json({
          x402Version: 2,
          items,
          pagination: { limit: 100, offset: 0, total: items.length, asOf: "2026-10-26T15:00:00.000Z" },
        }),
      );
    }
    const detail = /^\/discovery\/resources\/([0-9a-f-]{36})(\/versions|\/usage)?$/.exec(path);
    if (detail !== null) {
      const listing = listings.find((entry) => entry.id === detail[1]);
      if (listing === undefined) return Promise.resolve(notFound());
      if (detail[2] === undefined)
        return Promise.resolve(json({ ...item(listing), state: listing.state ?? "published" }));
      if (detail[2] === "/versions") {
        return Promise.resolve(
          json({
            x402Version: 2,
            id: listing.id,
            versions: [
              {
                version: 1,
                createdAt: "2026-09-29T14:52:57.854Z",
                cause: "settlement",
                transaction: "5".repeat(64),
                owner: listing.payTo,
                trust: "settled",
                state: "pending",
                contentWithheld: true,
                content: {},
              },
              {
                version: 2,
                createdAt: "2026-09-29T14:52:58.631Z",
                cause: "origin_verification",
                owner: listing.payTo,
                trust: "domain_verified",
                state: "published",
                content: {},
              },
            ],
            pagination: { limit: 100, after: 0, latest: 2 },
          }),
        );
      }
      if (mode === "no-usage-routes") return Promise.resolve(new Response("Not Found", { status: 404 }));
      if (listing.private === true)
        return Promise.resolve(
          notFound("discovery_usage_private", "The seller of this listing keeps its usage private."),
        );
      const paid = listing.paid ?? [];
      return Promise.resolve(
        json({
          listingId: listing.id,
          payments: paid.length,
          payers: new Set(paid.map((row) => row.payer)).size,
          firstObservedAt: paid.at(-1)?.closedAt ?? null,
          lastObservedAt: paid[0]?.closedAt ?? null,
          recent: (listing.countsOnly === true ? [] : paid.slice(0, 20)).map((row) => ({
            transaction: row.txHash,
            payer: row.payer,
            asset: row.asset.contract,
            amount: row.amount,
            observedAt: row.closedAt,
          })),
        }),
      );
    }
    if (mode === "no-usage-routes") return Promise.resolve(new Response("Not Found", { status: 404 }));
    if (path === "/discovery/settlements") {
      const wanted = (url.searchParams.get("transactions") ?? "").split(",");
      const items = listings.flatMap((listing) =>
        listing.private === true || listing.countsOnly === true
          ? []
          : (listing.paid ?? [])
              .filter((row) => wanted.includes(row.txHash))
              .map((row) => ({ transaction: row.txHash, listing: ref(listing), observedAt: row.closedAt })),
      );
      return Promise.resolve(json({ items, asOf: "2026-10-26T15:00:00.000Z" }));
    }
    const seller = /^\/discovery\/sellers\/([GC][A-Z2-7]{55})\/usage$/.exec(path);
    if (seller !== null) {
      const mine = listings.filter((listing) => listing.payTo === seller[1] && listing.private !== true);
      const rows = mine.flatMap((listing) => listing.paid ?? []);
      return Promise.resolve(
        json({
          payTo: seller[1],
          totals: { payments: rows.length, payers: new Set(rows.map((row) => row.payer)).size },
          listings: mine.map((listing) => ({
            listing: ref(listing),
            payments: listing.paid?.length ?? 0,
            payers: new Set((listing.paid ?? []).map((row) => row.payer)).size,
            lastObservedAt: listing.paid?.[0]?.closedAt ?? null,
          })),
          truncated: false,
        }),
      );
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };
  return { fetch, paths };
}

export function bazaarClient(
  listings: readonly FakeListing[],
  mode: BazaarMode = "up",
  options: { readonly apiKey?: string } = {},
) {
  const fake = fakeBazaar(listings, mode);
  const headers: Headers[] = [];
  const client = new BazaarClient({
    network: "stellar:testnet",
    baseUrl: "https://bazaar.example.org",
    fetch: (input, init) => {
      headers.push(new Headers(init?.headers));
      return fake.fetch(input, init);
    },
    ...options,
  });
  return { client, paths: fake.paths, headers };
}

/** A report over `rows`, as the indexer would publish it, for page tests. */
export function reportOf(rows: readonly SettlementRow[]): ReportDocument {
  const aggregator = new Aggregator();
  for (const row of rows) aggregator.add(row);
  const assets = Object.fromEntries(
    rows.map((row) => [
      row.asset.contract,
      { code: row.asset.code, issuer: row.asset.issuer, verified: row.asset.verified },
    ]),
  );
  const ledgers = rows.map((row) => row.ledger);
  return {
    network: "stellar:testnet",
    epoch: "2025-12-17",
    generatedAt: "2026-10-26T15:00:00.000Z",
    scope: "registry",
    headlineScope: "registered-facilitators",
    range: { from: Math.min(...ledgers), to: Math.max(...ledgers) },
    detachedFrom: null,
    coverageStop: null,
    failedLedgers: [],
    discovery: {
      source: "lumeus",
      routes: 30,
      generations: [],
      decoderVersions: [],
      ledgersRead: ledgers.length,
      ledgersWithoutAttributedRow: 0,
      bytes: { lake: 0, rpc: 0 },
    },
    rulesVersion: RULES_VERSION,
    registryVersion: "test",
    registrySha256: "0".repeat(64),
    rowRegistryVersions: ["test"],
    reproducible: true,
    aggregates: aggregator.result(),
    assets,
    manifestSha256: "0".repeat(64),
    rebuildCommand: "pnpm explorer:rebuild --network testnet --ledgers-from manifest.json",
    auditCommand: "pnpm explorer:rebuild --network testnet --from 1 --to 2",
  } as unknown as ReportDocument;
}
