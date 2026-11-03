/**
 * Discovery over HTTP on a Postgres catalog holding listings on testnet and pubnet: filters, offset
 * pagination pinned by asOf, search cursors across the other network's catalog changes, partial
 * results, cursors across replicas, and trust shown per network. Needs Postgres (docker compose up -d
 * postgres).
 */
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import type { PaymentRequired } from "@x402/core/types";
import {
  Catalog,
  FIXTURE_ASSET,
  SchemaSandbox,
  muxedAddress,
  paymentRequiredFor,
  randomAddress,
  settledPayment,
  type PaymentFixture,
} from "@rail402.dev/bazaar";
import { AssetRegistry, SearchService, type Embedder } from "@rail402.dev/search";
import { PostgresCatalogStore, createDatabase, migrate, type Database } from "@rail402.dev/store-postgres";
import { discoveryRoutes } from "@rail402.dev/service";

const URL = process.env["RAIL402_TEST_DATABASE_URL"] ?? "postgres://rail402:rail402@localhost:5432/rail402";
const TESTNET = "stellar:testnet";
const PUBNET = "stellar:pubnet";
const SECRET = randomBytes(32);

const sandbox = new SchemaSandbox();
const schemas: string[] = [];
const opened: Kysely<Database>[] = [];

afterAll(async () => {
  await sandbox.close();
  await Promise.all(opened.map((db) => db.destroy()));
  const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
  for (const schema of schemas) await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin);
  await admin.destroy();
});

/**
 * A deterministic stand-in for the embedding model: a normalised bag of hashed words, so texts that
 * share words are similar. Enough to exercise the hybrid path without the model files.
 */
const bagOfWords: Embedder = {
  id: "bag-of-words",
  dimensions: 64,
  embed(text) {
    const vector = new Float32Array(64);
    for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      let hash = 0;
      for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      vector[hash % 64] = (vector[hash % 64] ?? 0) + 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return Promise.resolve(vector.map((value) => value / norm));
  },
};

interface Item {
  resource: string;
  type: string;
  accepts: { network: string; payTo: string; scheme: string }[];
  rail402: { trust: string; settlements: number; listings: { network: string; trust: string }[] };
}

async function catalogStack() {
  const schema = `disc_${randomBytes(6).toString("hex")}`;
  const admin = createDatabase({ connectionString: URL, maxConnections: 1 });
  await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
  await admin.destroy();
  schemas.push(schema);
  const db = createDatabase({ connectionString: URL, schema, maxConnections: 10 });
  opened.push(db);
  await migrate(db);
  const store = new PostgresCatalogStore(db);
  const origins = new Map<string, PaymentRequired>();
  /** Hosts whose stellar.toml and owner's home_domain name each other, on testnet only. */
  const claimed = new Map<string, string>();
  const catalog = new Catalog({
    store,
    sandbox,
    fetchOrigin: (url) => {
      const paymentRequired = origins.get(url);
      return Promise.resolve(
        paymentRequired === undefined
          ? { kind: "unreachable", reason: "offline" }
          : { kind: "payment_required", paymentRequired },
      );
    },
    stellarToml: (host) => {
      const owner = claimed.get(host);
      return Promise.resolve(
        owner === undefined ? { ok: false, reason: "none" } : { ok: true, accounts: [owner] },
      );
    },
    homeDomain: (network, account) =>
      Promise.resolve(
        network === TESTNET
          ? [...claimed].find(([, owner]) => owner === account)?.[0].split(":")[0]
          : undefined,
      ),
  });
  /** Settles a payment for a resource whose own 402 matches it, and publishes it. */
  const publish = async (fixture: PaymentFixture) => {
    const payment = settledPayment(fixture);
    origins.set(fixture.url ?? "", paymentRequiredFor({ ...fixture, payTo: payment.requirements.payTo }));
    const outcome = await catalog.record(payment);
    while ((await store.dueOriginChecks(1)).length > 0) await catalog.checkOrigins(50);
    return outcome;
  };
  const search = (options: { embedder?: Embedder; depth?: number } = {}) =>
    new SearchService({
      store,
      assets: new AssetRegistry(
        [TESTNET, PUBNET].map((network) => ({
          network,
          contract: FIXTURE_ASSET,
          symbol: "USDC",
          decimals: 7,
          usd: true,
        })),
      ),
      cursorSecret: SECRET,
      ...options,
    });
  return { store, catalog, publish, claimed, search };
}

let hosts = 0;
const url = (path = "weather") => `https://api${String(++hosts)}.example.com/${path}`;

async function json<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

async function mixedCatalog() {
  const stack = await catalogStack();
  const muxedOwner = randomAddress();
  const shared = url("forecast");
  const fixtures = {
    testnet: [url(), url()].map((u) => ({ url: u, network: TESTNET, description: "City weather report" })),
    pubnet: [url(), url()].map((u) => ({ url: u, network: PUBNET, description: "City weather report" })),
    muxed: {
      url: url(),
      network: TESTNET,
      payTo: muxedAddress(muxedOwner, 7n),
      description: "Weather by muxed",
    },
    extended: {
      url: url(),
      network: TESTNET,
      description: "Weather with payment identifiers",
      extensions: { "payment-identifier": { info: { required: false } } },
    },
    sharedTestnet: { url: shared, network: TESTNET, description: "Weather forecast" },
    sharedPubnet: { url: shared, network: PUBNET, description: "Weather forecast" },
  };
  for (const fixture of [
    ...fixtures.testnet,
    ...fixtures.pubnet,
    fixtures.muxed,
    fixtures.extended,
    fixtures.sharedTestnet,
    fixtures.sharedPubnet,
  ]) {
    expect((await stack.publish(fixture))?.code).toBe("awaiting_origin_verification");
  }
  // An MCP tool for the type filter: under mcp://, testnet publishes it from its settlement.
  await stack.catalog.record(settledPayment({ url: "mcp://tool/forecast", kind: "mcp", network: TESTNET }));
  return { ...stack, fixtures, muxedOwner, shared };
}

describe("discovery on a mixed-network Postgres catalog", () => {
  it("applies each filter alone and combined, never showing another network's options", async () => {
    const { store, search, fixtures, muxedOwner, shared } = await mixedCatalog();
    const app = discoveryRoutes(store, search());
    const list = async (query: string) =>
      (await json<{ items: Item[]; pagination: { total: number } }>(await app.request(`/resources?${query}`)))
        .items;
    const resources = (items: Item[]) => items.map((item) => item.resource).sort();

    const testnet = await list(`network=${TESTNET}&limit=100`);
    const pubnet = await list(`network=${PUBNET}&limit=100`);
    expect(testnet.flatMap((item) => item.accepts.map((option) => option.network))).not.toContain(PUBNET);
    expect(pubnet.flatMap((item) => item.accepts.map((option) => option.network))).not.toContain(TESTNET);
    expect(resources(pubnet)).toEqual([...fixtures.pubnet.map((f) => f.url), shared].sort());
    expect(testnet).toHaveLength(6);
    const all = await list("limit=100");
    expect(all).toHaveLength(8);
    expect(
      all
        .find((item) => item.resource === shared)
        ?.accepts.map((o) => o.network)
        .sort(),
    ).toEqual([PUBNET, TESTNET]);

    // A G… payTo matches its muxed addresses on its own network only; an M… payTo only itself.
    expect(resources(await list(`payTo=${muxedOwner}`))).toEqual([fixtures.muxed.url]);
    expect(resources(await list(`payTo=${fixtures.muxed.payTo}`))).toEqual([fixtures.muxed.url]);
    expect(await list(`payTo=${muxedOwner}&network=${PUBNET}`)).toEqual([]);
    expect(await list(`payTo=${muxedAddress(muxedOwner, 8n)}`)).toEqual([]);

    expect((await list("type=mcp")).map((item) => item.type)).toEqual(["mcp"]);
    expect(await list(`type=mcp&network=${PUBNET}`)).toEqual([]);
    expect(resources(await list("extensions=payment-identifier"))).toEqual([fixtures.extended.url]);
    expect(await list(`extensions=payment-identifier&network=${PUBNET}`)).toEqual([]);
    expect(resources(await list(`scheme=exact&network=${PUBNET}&type=http`))).toEqual(resources(pubnet));

    // Search applies the same filters, alone and combined.
    const searched = async (query: string) =>
      (await json<{ resources: Item[] }>(await app.request(`/search?query=weather&limit=50&${query}`)))
        .resources;
    expect(resources(await searched(`network=${PUBNET}`))).toEqual(resources(pubnet));
    for (const item of await searched(`network=${PUBNET}`)) {
      expect(item.accepts.every((option) => option.network === PUBNET)).toBe(true);
    }
    expect(resources(await searched(`payTo=${muxedOwner}`))).toEqual([fixtures.muxed.url]);
    expect(await searched(`payTo=${muxedOwner}&network=${PUBNET}`)).toEqual([]);
    expect(resources(await searched(`extensions=payment-identifier&network=${TESTNET}`))).toEqual([
      fixtures.extended.url,
    ]);
  });

  it("pins offset pages with asOf while either network publishes", async () => {
    const { store, search, publish } = await mixedCatalog();
    const app = discoveryRoutes(store, search());
    const first = await json<{ items: Item[]; pagination: { total: number; asOf: string } }>(
      await app.request(`/resources?network=${TESTNET}&limit=3&offset=0`),
    );
    expect(first.pagination.total).toBe(6);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await publish({ url: url(), network: TESTNET, description: "Late weather" });
    await publish({ url: url(), network: PUBNET, description: "Late weather" });

    const asOf = encodeURIComponent(first.pagination.asOf);
    const second = await json<{ items: Item[]; pagination: { total: number } }>(
      await app.request(`/resources?network=${TESTNET}&limit=3&offset=3&asOf=${asOf}`),
    );
    expect(second.pagination.total).toBe(6);
    const pages = [...first.items, ...second.items].map((item) => item.resource);
    expect(new Set(pages).size).toBe(6);
    const fresh = await json<{ pagination: { total: number } }>(
      await app.request(`/resources?network=${TESTNET}&limit=3`),
    );
    expect(fresh.pagination.total).toBe(7);
  });

  it("continues a search cursor across a catalog change made on the other network", async () => {
    const { store, search, publish } = await mixedCatalog();
    const app = discoveryRoutes(store, search());
    type Page = { resources: Item[]; pagination: { cursor: string | null }; rail402: { revision: number } };
    const first = await json<Page>(await app.request(`/search?query=weather&network=${PUBNET}&limit=1`));
    expect(first.pagination.cursor).not.toBeNull();
    await publish({ url: url(), network: TESTNET, description: "More weather" });
    expect(await store.revision()).toBeGreaterThan(first.rail402.revision);

    const seen = first.resources.map((item) => item.resource);
    let cursor = first.pagination.cursor;
    while (cursor !== null) {
      const page = await json<Page>(
        await app.request(
          `/search?query=weather&network=${PUBNET}&limit=1&cursor=${encodeURIComponent(cursor)}`,
        ),
      );
      expect(page.rail402.revision).toBe(first.rail402.revision);
      seen.push(...page.resources.map((item) => item.resource));
      cursor = page.pagination.cursor;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it("reports partialResults when lexical-only or cut at the retrieval depth, not otherwise", async () => {
    const { store, search } = await mixedCatalog();
    type Page = { partialResults: boolean; rail402: { method: string } };
    const ask = async (service: SearchService, query = "city weather report") =>
      json<Page>(await discoveryRoutes(store, service).request(`/search?query=${encodeURIComponent(query)}`));

    expect(await ask(search())).toMatchObject({ partialResults: true, rail402: { method: "lexical" } });
    expect(await ask(search({ embedder: bagOfWords }))).toMatchObject({
      partialResults: false,
      rail402: { method: "hybrid" },
    });
    expect(await ask(search({ embedder: bagOfWords, depth: 1 }))).toMatchObject({
      partialResults: true,
      rail402: { method: "hybrid" },
    });
    // Constraints only: every candidate matches, nothing is cut.
    const filterOnly = await json<Page>(
      await discoveryRoutes(store, search()).request(`/search?query=${encodeURIComponent("on pubnet")}`),
    );
    expect(filterOnly).toMatchObject({ partialResults: false, rail402: { method: "filter" } });
  });

  it("accepts a cursor on another replica while the catalog is at its revision, and expires it after", async () => {
    const { store, search, publish } = await mixedCatalog();
    type Page = { resources: Item[]; pagination: { cursor: string | null } };
    const replicaA = discoveryRoutes(store, search());
    const replicaB = discoveryRoutes(store, search());
    const first = await json<Page>(await replicaA.request("/search?query=weather&limit=2"));
    const cursor = encodeURIComponent(first.pagination.cursor ?? "");
    const onA = await json<Page>(await replicaA.request(`/search?query=weather&limit=2&cursor=${cursor}`));
    const onB = await json<Page>(await replicaB.request(`/search?query=weather&limit=2&cursor=${cursor}`));
    expect(onB.resources.map((item) => item.resource)).toEqual(onA.resources.map((item) => item.resource));

    // Once either network changes the catalog, a replica without the snapshot cannot rebuild it.
    await publish({ url: url(), network: PUBNET, description: "Pubnet weather" });
    const replicaC = discoveryRoutes(store, search());
    const expired = await replicaC.request(`/search?query=weather&limit=2&cursor=${cursor}`);
    expect(expired.status).toBe(400);
    expect(((await expired.json()) as { error: { code: string } }).error.code).toBe("search_cursor_expired");
  });

  it("shows each network's trust, never trust proved on another network", async () => {
    const { store, catalog, search, claimed, shared } = await mixedCatalog();
    const items = await store.list({ limit: 100, offset: 0 });
    const listings = items.items.find(([first]) => first.content.resource === shared) ?? [];
    const testnetOwner = listings.find((listing) => listing.identity.network === TESTNET)?.owner ?? "";
    claimed.set(new globalThis.URL(shared).host, testnetOwner);
    await catalog.enrich(50);
    const app = discoveryRoutes(store, search());
    const item = async (query: string) =>
      (await json<{ items: Item[] }>(await app.request(`/resources?limit=100${query}`))).items.find(
        (entry) => entry.resource === shared,
      );
    const unfiltered = await item("");
    expect(unfiltered?.rail402.listings.map((l) => [l.network, l.trust]).sort()).toEqual([
      [PUBNET, "origin_verified"],
      [TESTNET, "domain_verified"],
    ]);
    expect(unfiltered?.rail402.trust).toBe("origin_verified");
    expect((await item(`&network=${TESTNET}`))?.rail402.trust).toBe("domain_verified");
    expect((await item(`&network=${PUBNET}`))?.rail402.trust).toBe("origin_verified");

    const searched = async (network: string) =>
      (
        await json<{ resources: Item[] }>(
          await app.request(`/search?query=forecast&network=${encodeURIComponent(network)}`),
        )
      ).resources.find((entry) => entry.resource === shared);
    expect((await searched(TESTNET))?.rail402.trust).toBe("domain_verified");
    expect((await searched(PUBNET))?.rail402.trust).toBe("origin_verified");
  });
});

describe("usage on a mixed-network Postgres catalog", () => {
  const hash = () => randomBytes(32).toString("hex");

  it("links settlements to listings per network and never to one discovery does not show", async () => {
    const { store, catalog, publish } = await catalogStack();
    // Pubnet publishes counts only unless its operator configures settlement links.
    const app = discoveryRoutes(store, undefined, undefined, undefined, () => "settlements");
    const seller = randomAddress();
    const [alice, bob] = [randomAddress(), randomAddress()];
    const shared = url("forecast");
    const [t1, t2, onPubnet, pending, kept] = [hash(), hash(), hash(), hash(), hash()];

    await publish({ url: shared, payTo: seller, payer: alice, transaction: t1 });
    await catalog.record(settledPayment({ url: shared, payTo: seller, payer: bob, transaction: t2 }));
    await publish({ url: shared, payTo: seller, payer: bob, transaction: onPubnet, network: PUBNET });
    // Never confirmed by its origin: pending.
    await catalog.record(settledPayment({ url: url(), payTo: seller, transaction: pending }));
    // Its seller keeps its usage private.
    await publish({
      url: url(),
      payTo: seller,
      transaction: kept,
      extensions: { "rail402-private-usage": {} },
    });
    const listings = (await store.list({ payTo: seller, limit: 100, offset: 0 })).items.flat();
    const onNetwork = (network: string) =>
      listings.find((l) => l.content.resource === shared && l.identity.network === network)?.id ?? "";

    type Links = { items: { transaction: string; listing: { id: string; network: string } }[] };
    const every = [t1, t2, onPubnet, pending, kept].join(",");
    const testnet = await json<Links>(
      await app.request(`/settlements?network=${TESTNET}&transactions=${every}`),
    );
    expect(testnet.items.map((item) => [item.transaction, item.listing.id, item.listing.network])).toEqual([
      [t1, onNetwork(TESTNET), TESTNET],
      [t2, onNetwork(TESTNET), TESTNET],
    ]);
    const pubnet = await json<Links>(
      await app.request(`/settlements?network=${PUBNET}&transactions=${every}`),
    );
    expect(pubnet.items.map((item) => [item.transaction, item.listing.id])).toEqual([
      [onPubnet, onNetwork(PUBNET)],
    ]);
    const counts = await json<Links>(
      await discoveryRoutes(store).request(`/settlements?network=${PUBNET}&transactions=${every}`),
    );
    expect(counts.items).toEqual([]);

    type Usage = { payments: number; payers: number; recent: { transaction: string }[] };
    const usage = await json<Usage>(
      await app.request(`/resources/${onNetwork(TESTNET)}/usage?network=${TESTNET}`),
    );
    expect(usage).toMatchObject({ payments: 2, payers: 2 });
    expect(usage.recent.map((entry) => entry.transaction).sort()).toEqual([t1, t2].sort());
    expect((await app.request(`/resources/${onNetwork(TESTNET)}/usage?network=${PUBNET}`)).status).toBe(404);

    type Seller = { totals: { payments: number; payers: number }; listings: { listing: { id: string } }[] };
    const sellerTestnet = await json<Seller>(
      await app.request(`/sellers/${seller}/usage?network=${TESTNET}`),
    );
    expect(sellerTestnet.totals).toEqual({ payments: 2, payers: 2 });
    expect(sellerTestnet.listings.map((entry) => entry.listing.id)).toEqual([onNetwork(TESTNET)]);
    const sellerPubnet = await json<Seller>(await app.request(`/sellers/${seller}/usage?network=${PUBNET}`));
    expect(sellerPubnet.totals).toEqual({ payments: 1, payers: 1 });
    expect(sellerPubnet.listings.map((entry) => entry.listing.id)).toEqual([onNetwork(PUBNET)]);
  });
});
