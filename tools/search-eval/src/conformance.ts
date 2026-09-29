/**
 * Filter conformance: every hard constraint tested on its own against a generated catalog built to
 * stress it, apart from the judged dataset. The catalog covers both networks, the `exact` and `upto`
 * schemes, G…, muxed M… and contract C… recipients, assets with 6, 7 and 18 decimals, an asset the
 * service does not know, prices one base unit either side of each ceiling, and listings whose options
 * each satisfy part of a filter. Every query is paged to the end, and the results are compared with an
 * independent check both ways: a result that breaks a constraint is a violation, a listing that
 * satisfies every constraint but is not returned is a miss. Both must be zero.
 */
import { createHash } from "node:crypto";
import { Account, Keypair, MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import {
  MemoryCatalogStore,
  contentHash,
  type Listing,
  type ListingContent,
  type PaymentOption,
} from "@rail402.dev/bazaar";
import {
  AssetRegistry,
  SearchService,
  type Embedder,
  type KnownAsset,
  type SearchFilter,
} from "@rail402.dev/search";
import { unmetConstraints, type EvalAsset } from "./constraints.ts";
import type { ExpectedConstraints } from "./dataset.ts";

export type FilterName = "network" | "asset" | "scheme" | "payTo" | "price";

export interface FilterTally {
  readonly queries: number;
  /** Results returned and checked, over every page. */
  readonly results: number;
  /** Results, or shown payment options, that break a constraint. */
  readonly violations: number;
  /** Listings that satisfy every constraint but were not returned. */
  readonly missed: number;
}

export interface ConformanceReport {
  readonly listings: number;
  readonly queries: number;
  readonly modes: readonly string[];
  readonly byFilter: Readonly<Record<FilterName, FilterTally>>;
}

const TESTNET = "stellar:testnet";
const PUBNET = "stellar:pubnet";

const derived = (label: string) =>
  createHash("sha256").update(`rail402 filter conformance: ${label}`).digest();
const account = (label: string) => Keypair.fromRawEd25519Seed(derived(label)).publicKey();
const contract = (label: string) => StrKey.encodeContract(derived(label));

const ALICE = account("alice");
const BOB = account("bob");
const ALICE_MUXED = new MuxedAccount(new Account(ALICE, "0"), "7").accountId();
const ALICE_OTHER_MUXED = new MuxedAccount(new Account(ALICE, "0"), "8").accountId();
const CONTRACT_PAYEE = contract("contract payee");
const UNKNOWN_ASSET = contract("unknown asset");

/** The assets the service is configured with. Kept apart from the checker's copy below on purpose. */
const SERVICE_ASSETS: readonly KnownAsset[] = [
  { network: TESTNET, contract: contract("usdc testnet"), symbol: "USDC", decimals: 7, usd: true },
  { network: PUBNET, contract: contract("usdc pubnet"), symbol: "USDC", decimals: 7, usd: true },
  { network: TESTNET, contract: contract("eurc testnet"), symbol: "EURC", decimals: 7, usd: false },
  { network: TESTNET, contract: contract("usdx testnet"), symbol: "USDX", decimals: 6, usd: true },
  { network: PUBNET, contract: contract("weth pubnet"), symbol: "WETH", decimals: 18, usd: false },
];

const CHECKER_ASSETS: readonly EvalAsset[] = SERVICE_ASSETS.map((asset) => ({ ...asset }));

const contractOf = (network: string, symbol: string) =>
  SERVICE_ASSETS.find((asset) => asset.network === network && asset.symbol === symbol)?.contract ?? "";

/** One base unit either side of a ceiling of one cent, or of 0.01 of the asset. */
function boundaryAmounts(decimals: number): string[] {
  const cent = 10n ** BigInt(decimals) / 100n;
  return [cent - 1n, cent, cent + 1n].map(String);
}

function option(
  network: string,
  asset: string,
  scheme: string,
  payTo: string,
  amount: string,
): PaymentOption {
  return { scheme, network, asset, payTo, amount, maxTimeoutSeconds: 60, extra: {} };
}

/** The generated catalog: every combination of network, asset, scheme, recipient and boundary price. */
export function conformanceCatalog(): Listing[] {
  const options: PaymentOption[][] = [];
  const assets: [string, string, number][] = [
    ...SERVICE_ASSETS.map((asset): [string, string, number] => [
      asset.network,
      asset.contract,
      asset.decimals,
    ]),
    [TESTNET, UNKNOWN_ASSET, 7],
    [PUBNET, UNKNOWN_ASSET, 7],
  ];
  for (const [network, asset, decimals] of assets) {
    for (const scheme of ["exact", "upto"]) {
      for (const payTo of [ALICE, ALICE_MUXED, BOB, CONTRACT_PAYEE]) {
        for (const amount of boundaryAmounts(decimals))
          options.push([option(network, asset, scheme, payTo, amount)]);
      }
    }
  }
  // Each option satisfies part of a filter, never all of it: none of these may match a combined filter.
  const usdcTestnet = contractOf(TESTNET, "USDC");
  const usdcPubnet = contractOf(PUBNET, "USDC");
  options.push(
    [option(TESTNET, usdcTestnet, "upto", ALICE, "1"), option(PUBNET, usdcPubnet, "exact", BOB, "1")],
    [option(TESTNET, usdcTestnet, "exact", BOB, "1"), option(PUBNET, usdcPubnet, "upto", ALICE, "1")],
    [
      option(TESTNET, usdcTestnet, "exact", ALICE, "1000000"),
      option(PUBNET, usdcPubnet, "exact", ALICE, "1"),
    ],
    [option(TESTNET, UNKNOWN_ASSET, "exact", ALICE, "1"), option(PUBNET, usdcPubnet, "upto", ALICE, "1")],
  );
  const date = new Date("2026-09-01T00:00:00.000Z");
  return options.map((accepts, index) => {
    const content: ListingContent = {
      resource: `https://fc${String(index + 1)}.conformance.example/weather`,
      kind: "http",
      method: "GET",
      description: "Weather observations for a city",
      serviceName: "Weather feed",
      bazaar: { info: { input: { type: "http", method: "GET" } }, schema: { type: "object" } },
      accepts,
    };
    return {
      id: `FC${String(index + 1).padStart(3, "0")}`,
      sequence: index + 1,
      identity: {
        network: accepts[0]?.network ?? TESTNET,
        kind: "http",
        resource: content.resource,
        method: "GET",
        toolName: "",
        scope: "",
      },
      owner: accepts[0]?.payTo ?? ALICE,
      trust: "settled",
      state: "published",
      version: 1,
      content,
      contentHash: contentHash(content),
      firstCatalogedAt: date,
      listedAt: date,
      lastUpdated: date,
      lastSettledAt: date,
      settlements: 1,
    };
  });
}

interface Case {
  readonly filter: FilterName;
  readonly query: string;
  readonly parameters: SearchFilter;
  /** What the searcher asked for, in the checker's vocabulary. */
  readonly expected: ExpectedConstraints;
}

/** Queries that each exercise one constraint, alone and combined, as parameters and as text. */
export function conformanceCases(): Case[] {
  const usdx = contractOf(TESTNET, "USDX");
  const weth = contractOf(PUBNET, "WETH");
  const cases: Case[] = [];
  const add = (filter: FilterName, query: string, parameters: SearchFilter, expected: ExpectedConstraints) =>
    cases.push({ filter, query, parameters, expected });

  for (const network of [TESTNET, PUBNET]) add("network", "weather", { network }, { network });
  add("network", "weather on testnet", {}, { network: TESTNET });
  add("network", "weather mainnet only", {}, { network: PUBNET });
  add("network", "weather not on testnet", {}, { network: PUBNET });

  for (const symbol of ["USDC", "EURC", "USDX", "WETH"])
    add("asset", "weather", { asset: symbol }, { asset: symbol });
  add("asset", "weather", { asset: usdx }, { asset: usdx });
  add("asset", "weather", { asset: UNKNOWN_ASSET }, { asset: UNKNOWN_ASSET });
  add("asset", "weather paid in EURC", {}, { asset: "EURC" });
  add("asset", "weather", { asset: "USDC", network: PUBNET }, { asset: "USDC", network: PUBNET });

  for (const scheme of ["exact", "upto"]) add("scheme", "weather", { scheme }, { scheme });
  add("scheme", "weather", { scheme: "upto", network: TESTNET }, { scheme: "upto", network: TESTNET });

  for (const payTo of [ALICE, ALICE_MUXED, ALICE_OTHER_MUXED, BOB, CONTRACT_PAYEE]) {
    add("payTo", "weather", { payTo }, { payTo });
  }
  add("payTo", "weather", { payTo: ALICE, scheme: "upto" }, { payTo: ALICE, scheme: "upto" });
  add("payTo", "weather", { payTo: BOB, network: PUBNET }, { payTo: BOB, network: PUBNET });

  const usd = (value: string) => ({ maxPrice: { value, unit: "usd" as const } });
  add("price", "weather", usd("0.01"), { maxPrice: { amount: "0.01", unit: "USD" } });
  add("price", "weather", usd("0.0099999"), { maxPrice: { amount: "0.0099999", unit: "USD" } });
  add("price", "weather under 1 cent", {}, { maxPrice: { amount: "0.01", unit: "USD" } });
  add(
    "price",
    "weather",
    { asset: usdx, maxPrice: { value: "0.01", unit: "asset" } },
    { asset: usdx, maxPrice: { amount: "0.01", unit: "USDX" } },
  );
  add(
    "price",
    "weather",
    { asset: weth, maxPrice: { value: "0.01", unit: "asset" } },
    { asset: weth, maxPrice: { amount: "0.01", unit: "WETH" } },
  );
  add("price", "weather under 0.01 EURC", {}, { asset: "EURC", maxPrice: { amount: "0.01", unit: "EURC" } });
  add(
    "price",
    "weather",
    { asset: UNKNOWN_ASSET, maxPrice: { value: "1", unit: "asset" } },
    { asset: UNKNOWN_ASSET, maxPrice: { amount: "1", unit: UNKNOWN_ASSET } },
  );
  add(
    "price",
    "weather",
    { payTo: ALICE, network: TESTNET, ...usd("0.01") },
    { payTo: ALICE, network: TESTNET, maxPrice: { amount: "0.01", unit: "USD" } },
  );
  return cases;
}

/** Runs every case through SearchService, lexical-only and, given an embedder, hybrid. */
export async function checkFilters(embedder?: Embedder): Promise<ConformanceReport> {
  const catalog = conformanceCatalog();
  const store = new MemoryCatalogStore();
  for (const listing of catalog) {
    await store.transaction(listing.identity, (tx) =>
      tx.insert(listing, {
        listingId: listing.id,
        version: 1,
        createdAt: listing.firstCatalogedAt,
        cause: "settlement",
        owner: listing.owner,
        trust: listing.trust,
        state: listing.state,
        content: listing.content,
      }),
    );
  }
  const registry = new AssetRegistry(SERVICE_ASSETS);
  const secret = Buffer.alloc(32, 2);
  const services: Record<string, SearchService> = {
    lexical: new SearchService({ store, assets: registry, cursorSecret: secret }),
    ...(embedder === undefined
      ? {}
      : { hybrid: new SearchService({ store, assets: registry, cursorSecret: secret, embedder }) }),
  };

  const cases = conformanceCases();
  const tally = Object.fromEntries(
    (["network", "asset", "scheme", "payTo", "price"] as const).map((name) => [
      name,
      { queries: 0, results: 0, violations: 0, missed: 0 },
    ]),
  ) as Record<FilterName, { queries: number; results: number; violations: number; missed: number }>;

  for (const [, service] of Object.entries(services)) {
    for (const test of cases) {
      const counts = tally[test.filter];
      counts.queries++;
      const returned = new Map<string, Listing>();
      let cursor: string | undefined;
      do {
        const page = await service.search({
          query: test.query,
          filter: test.parameters,
          limit: 50,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const listing of page.resources.flat()) returned.set(listing.id, listing);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);

      for (const listing of returned.values()) {
        counts.results++;
        // Every option shown must satisfy the whole filter on its own.
        const shown = listing.content.accepts.map((accepted) =>
          unmetConstraints({ ...listing.content, accepts: [accepted] }, test.expected, CHECKER_ASSETS),
        );
        if (listing.content.accepts.length === 0 || shown.some((unmet) => unmet.length > 0))
          counts.violations++;
      }
      for (const listing of catalog) {
        const satisfies = unmetConstraints(listing.content, test.expected, CHECKER_ASSETS).length === 0;
        if (satisfies && !returned.has(listing.id)) counts.missed++;
      }
    }
  }
  return { listings: catalog.length, queries: cases.length, modes: Object.keys(services), byFilter: tally };
}
