import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { PaymentRequired } from "@x402/core/types";
import {
  Catalog,
  FIXTURE_ASSET,
  MemoryCatalogStore,
  PRIVATE_USAGE_EXTENSION,
  SchemaSandbox,
  muxedAddress,
  paymentRequiredFor,
  randomAddress,
  settledPayment,
  type OriginResponse,
  type PaymentFixture,
} from "@rail402.dev/bazaar";
import {
  defaultUsageDetail,
  discoveryRouteOf,
  discoveryRoutes,
  type DiscoveryLimits,
  type UsageDetail,
} from "@rail402.dev/service";

const TESTNET = "stellar:testnet";
const PUBNET = "stellar:pubnet";

const sandbox = new SchemaSandbox();
afterAll(async () => {
  await sandbox.close();
});

const hash = () => randomBytes(32).toString("hex");

/**
 * Discovery routes over a memory catalog holding a published testnet listing paid three times by two
 * payers, a pubnet listing of the same seller, a pending, a quarantined and a private-usage listing.
 */
async function usageCatalog(
  limits?: Omit<DiscoveryLimits, "clientKey">,
  usageDetail: (network: string) => UsageDetail = () => "settlements",
) {
  const store = new MemoryCatalogStore();
  const origins = new Map<string, PaymentRequired>();
  let clock = Date.now() - 3_600_000;
  const catalog = new Catalog({
    store,
    sandbox,
    now: () => new Date((clock += 1_000)),
    fetchOrigin: (url) => {
      const paymentRequired = origins.get(url);
      return Promise.resolve(
        paymentRequired === undefined
          ? { kind: "unreachable", reason: "offline" }
          : { kind: "payment_required", paymentRequired },
      );
    },
  });
  const settle = async (fixture: PaymentFixture, confirm?: PaymentFixture) => {
    if (confirm !== undefined) origins.set(confirm.url ?? "", paymentRequiredFor(confirm));
    const outcome = await catalog.record(settledPayment(fixture));
    while ((await store.dueOriginChecks(1)).length > 0) await catalog.checkOrigins(50);
    return outcome?.listingId ?? "";
  };

  const seller = randomAddress();
  const [alice, bob] = [randomAddress(), randomAddress()];
  const paid = [hash(), hash(), hash()] as const;
  const url = "https://weather.example.com/now";
  const fixture = { url, payTo: seller, description: "Current weather", serviceName: "Weather" };
  const listing = await settle({ ...fixture, payer: alice, transaction: paid[0] }, fixture);
  await settle({ ...fixture, payer: bob, transaction: paid[1] });
  await settle({ ...fixture, payer: alice, transaction: paid[2], amount: "20000" });

  const pubnetPaid = hash();
  const pubnetFixture = { url: "https://weather.example.com/pubnet", payTo: seller, network: PUBNET };
  const pubnet = await settle({ ...pubnetFixture, payer: bob, transaction: pubnetPaid }, pubnetFixture);

  const pendingPaid = hash();
  const pending = await settle({
    url: "https://pending.example.com/x",
    payTo: seller,
    transaction: pendingPaid,
  });

  const quarantinedPaid = hash();
  const quarantinedUrl = "https://quarantined.example.com/x";
  const quarantined = await settle(
    { url: quarantinedUrl, payTo: seller, transaction: quarantinedPaid },
    { url: quarantinedUrl, payTo: randomAddress() },
  );

  const privatePaid = hash();
  const privateFixture = {
    url: "https://private.example.com/x",
    payTo: seller,
    extensions: { [PRIVATE_USAGE_EXTENSION]: {} },
  };
  const privateListing = await settle({ ...privateFixture, transaction: privatePaid }, privateFixture);

  expect((await store.get(listing))?.state).toBe("published");
  expect((await store.get(pubnet))?.state).toBe("published");
  expect((await store.get(pending))?.state).toBe("pending");
  expect((await store.get(quarantined))?.state).toBe("quarantined");
  expect((await store.get(privateListing))?.state).toBe("published");

  const app = discoveryRoutes(
    store,
    undefined,
    limits === undefined ? undefined : { ...limits, clientKey: () => "one client" },
    undefined,
    usageDetail,
  );
  return {
    app,
    seller,
    payers: { alice, bob },
    listings: { listing, pubnet, pending, quarantined, privateListing },
    paid: {
      listing: paid,
      pubnet: pubnetPaid,
      pending: pendingPaid,
      quarantined: quarantinedPaid,
      privatePaid,
    },
  };
}

async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; reason: string; retryable: boolean } }).error;
}

interface SettlementsBody {
  items: { transaction: string; listing: Record<string, unknown>; observedAt: string }[];
  asOf: string;
}

describe("GET /discovery/settlements", () => {
  it("links each settlement to the listing it paid for, in the order asked, as a ListingRef", async () => {
    const { app, seller, listings, paid } = await usageCatalog();
    const asked = [paid.listing[2], hash(), paid.listing[0], paid.listing[2]];
    const response = await app.request(`/settlements?network=${TESTNET}&transactions=${asked.join(",")}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as SettlementsBody;
    expect(Date.parse(body.asOf)).not.toBeNaN();
    expect(body.items.map((item) => item.transaction)).toEqual([paid.listing[2], paid.listing[0]]);
    expect(body.items[0]?.listing).toEqual({
      id: listings.listing,
      type: "http",
      resource: "https://weather.example.com/now",
      method: "GET",
      description: "Current weather",
      serviceName: "Weather",
      payTo: seller,
      scheme: "exact",
      amount: "10000",
      asset: FIXTURE_ASSET,
      network: TESTNET,
      lastUpdated: expect.any(String) as string,
    });
    expect(Date.parse(body.items[0]?.observedAt ?? "")).toBeGreaterThan(
      Date.parse(body.items[1]?.observedAt ?? ""),
    );
  });

  it("never shows another network's settlement, nor one of a listing discovery does not show", async () => {
    const { app, listings, paid } = await usageCatalog();
    const hidden = [paid.pubnet, paid.pending, paid.quarantined, paid.privatePaid].join(",");
    const testnet = (await (
      await app.request(`/settlements?network=${TESTNET}&transactions=${hidden}`)
    ).json()) as SettlementsBody;
    expect(testnet.items).toEqual([]);

    const all = [...paid.listing, paid.pubnet, paid.pending, paid.quarantined, paid.privatePaid].join(",");
    const pubnet = (await (
      await app.request(`/settlements?network=${PUBNET}&transactions=${all}`)
    ).json()) as SettlementsBody;
    expect(
      pubnet.items.map((item) => [item.transaction, item.listing["id"], item.listing["network"]]),
    ).toEqual([[paid.pubnet, listings.pubnet, PUBNET]]);
  });

  it("takes 1 to 100 lowercase 64-hex hashes and refuses anything else with a coded 400", async () => {
    const { app } = await usageCatalog();
    const hundred = Array.from({ length: 100 }, hash).join(",");
    expect((await app.request(`/settlements?network=${TESTNET}&transactions=${hundred}`)).status).toBe(200);
    const bad = [
      `network=${TESTNET}`,
      `network=${TESTNET}&transactions=`,
      `network=${TESTNET}&transactions=${hundred},${hash()}`,
      `network=${TESTNET}&transactions=${hash().toUpperCase()}`,
      `network=${TESTNET}&transactions=${hash().slice(1)}`,
      `network=${TESTNET}&transactions=${hash()},`,
      `network=${TESTNET}&transactions=${hash()},,${hash()}`,
      `network=${TESTNET}&transactions=${hash()}%20`,
      `transactions=${hash()}`,
      `network=stellar:futurenet&transactions=${hash()}`,
      `network=eip155:8453&transactions=${hash()}`,
      `network=${TESTNET}&transactions=${hash()}&limit=5`,
    ];
    for (const query of bad) {
      const response = await app.request(`/settlements?${query}`);
      expect(response.status, query).toBe(400);
      const error = await errorOf(response);
      expect(error.code, query).toBe("discovery_invalid_parameter");
      expect(error.reason.trim(), query).not.toBe("");
    }
  });
});

interface UsageBody {
  listingId: string;
  payments: number;
  payers: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  recent: Record<string, unknown>[];
}

describe("GET /discovery/resources/:id/usage", () => {
  it("counts a listing's settlements and payers and shows the latest, newest first", async () => {
    const { app, listings, paid, payers } = await usageCatalog();
    const response = await app.request(`/resources/${listings.listing}/usage?network=${TESTNET}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as UsageBody;
    expect(body).toMatchObject({ listingId: listings.listing, payments: 3, payers: 2 });
    expect(body.recent.map((entry) => entry["transaction"])).toEqual([...paid.listing].reverse());
    expect(body.recent[0]).toEqual({
      transaction: paid.listing[2],
      payer: payers.alice,
      asset: FIXTURE_ASSET,
      amount: "20000",
      observedAt: body.lastObservedAt,
    });
    expect(body.recent[2]?.["observedAt"]).toBe(body.firstObservedAt);
  });

  it("answers 404 for a listing discovery does not show on that network", async () => {
    const { app, listings } = await usageCatalog();
    for (const [id, network] of [
      [listings.pending, TESTNET],
      [listings.quarantined, TESTNET],
      [listings.listing, PUBNET],
      [listings.pubnet, TESTNET],
      ["2b0f8a8e-7c1d-4c55-9d8e-6f0a1b2c3d4e", TESTNET],
      ["not-a-listing", TESTNET],
    ] as const) {
      const response = await app.request(`/resources/${id}/usage?network=${network}`);
      expect(response.status, `${id} ${network}`).toBe(404);
      expect((await errorOf(response)).code).toBe("discovery_listing_not_found");
    }
    expect((await app.request(`/resources/${listings.pubnet}/usage?network=${PUBNET}`)).status).toBe(200);
  });

  it("answers 404 with its own code for a listing whose seller keeps its usage private", async () => {
    const { app, listings } = await usageCatalog();
    const response = await app.request(`/resources/${listings.privateListing}/usage?network=${TESTNET}`);
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toEqual({
      code: "discovery_usage_private",
      reason: "The seller of this listing keeps its usage private.",
      retryable: false,
    });
    // The listing itself stays readable.
    expect((await app.request(`/resources/${listings.privateListing}`)).status).toBe(200);
  });

  it("requires a Stellar network and refuses any other parameter", async () => {
    const { app, listings } = await usageCatalog();
    for (const query of ["", "?network=stellar:futurenet", `?network=${TESTNET}&limit=5`]) {
      const response = await app.request(`/resources/${listings.listing}/usage${query}`);
      expect(response.status, query).toBe(400);
      expect((await errorOf(response)).code).toBe("discovery_invalid_parameter");
    }
  });
});

interface SellerBody {
  payTo: string;
  totals: { payments: number; payers: number };
  listings: { listing: Record<string, unknown>; payments: number; payers: number; lastObservedAt: string }[];
  truncated: boolean;
}

describe("GET /discovery/sellers/:payTo/usage", () => {
  it("shows the seller's public listings on the network with their usage, and totals", async () => {
    const { app, seller, listings } = await usageCatalog();
    const testnet = (await (
      await app.request(`/sellers/${seller}/usage?network=${TESTNET}`)
    ).json()) as SellerBody;
    expect(testnet).toMatchObject({ payTo: seller, totals: { payments: 3, payers: 2 }, truncated: false });
    // Pending, quarantined and private listings are left out.
    expect(testnet.listings.map((entry) => [entry.listing["id"], entry.payments, entry.payers])).toEqual([
      [listings.listing, 3, 2],
    ]);
    expect(testnet.listings[0]?.listing).toMatchObject({ network: TESTNET, payTo: seller, scheme: "exact" });

    const pubnet = (await (
      await app.request(`/sellers/${seller}/usage?network=${PUBNET}`)
    ).json()) as SellerBody;
    expect(pubnet.totals).toEqual({ payments: 1, payers: 1 });
    expect(pubnet.listings.map((entry) => entry.listing["id"])).toEqual([listings.pubnet]);
  });

  it("answers a seller without listings with an empty list", async () => {
    const { app } = await usageCatalog();
    const other = randomAddress();
    const response = await app.request(`/sellers/${other}/usage?network=${TESTNET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      payTo: other,
      totals: { payments: 0, payers: 0 },
      listings: [],
      truncated: false,
    });
    const contract = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
    expect((await app.request(`/sellers/${contract}/usage?network=${TESTNET}`)).status).toBe(200);
  });

  it("takes a G… or C… address with a valid checksum, never a muxed or secret one", async () => {
    const { app, seller } = await usageCatalog();
    const corrupted = `${seller.slice(0, 55)}${seller.endsWith("A") ? "B" : "A"}`;
    for (const payTo of [
      corrupted,
      `S${seller.slice(1)}`,
      muxedAddress(seller, 1n),
      seller.toLowerCase(),
      "nobody",
    ]) {
      const response = await app.request(`/sellers/${payTo}/usage?network=${TESTNET}`);
      expect(response.status, payTo).toBe(400);
      expect((await errorOf(response)).code).toBe("discovery_invalid_parameter");
    }
    for (const query of ["", "?network=eip155:8453", `?network=${TESTNET}&offset=1`]) {
      const response = await app.request(`/sellers/${seller}/usage${query}`);
      expect(response.status, query).toBe(400);
    }
  });
});

describe("usage cost limits", () => {
  it("charges a settlements lookup by its size and a seller's usage double, reporting refusals by route", async () => {
    const refused: string[] = [];
    const { app, seller, listings } = await usageCatalog({
      perMinute: 7,
      uncachedSearchCost: 5,
      onLimited: (route) => refused.push(route),
    });
    // 50 hashes cost 3, a seller's usage 2, a listing's usage 1: 6 of 7.
    const fifty = Array.from({ length: 50 }, hash).join(",");
    expect((await app.request(`/settlements?network=${TESTNET}&transactions=${fifty}`)).status).toBe(200);
    expect((await app.request(`/sellers/${seller}/usage?network=${TESTNET}`)).status).toBe(200);
    expect((await app.request(`/resources/${listings.listing}/usage?network=${TESTNET}`)).status).toBe(200);
    expect((await app.request(`/sellers/${seller}/usage?network=${TESTNET}`)).status).toBe(429);
    expect((await app.request(`/settlements?network=${TESTNET}&transactions=${hash()}`)).status).toBe(200);
    expect((await app.request(`/resources/${listings.listing}/usage?network=${TESTNET}`)).status).toBe(429);
    expect((await app.request(`/settlements?network=${TESTNET}&transactions=${hash()}`)).status).toBe(429);
    expect(refused).toEqual([
      "/discovery/sellers/:payTo/usage",
      "/discovery/resources/:id/usage",
      "/discovery/settlements",
    ]);
  });

  it("names each usage route for metrics", () => {
    expect(discoveryRouteOf("/discovery/settlements")).toBe("/discovery/settlements");
    expect(discoveryRouteOf("/discovery/resources/abc/usage")).toBe("/discovery/resources/:id/usage");
    expect(discoveryRouteOf("/discovery/sellers/GABC/usage")).toBe("/discovery/sellers/:payTo/usage");
  });
});

describe("usage of a listing no origin confirmed", () => {
  const tool = (payTo: string) => ({
    kind: "mcp" as const,
    url: `mcp://tools.example/forecast_${hash().slice(0, 8)}`,
    toolName: "forecast",
    payTo,
  });
  const offline = () => {
    const store = new MemoryCatalogStore();
    const catalog = new Catalog({
      store,
      sandbox,
      fetchOrigin: () => Promise.resolve({ kind: "unreachable", reason: "offline" }),
    });
    return { catalog, store };
  };

  it("stays private for an mcp:// tool whatever its first payer echoed, and links no settlement", async () => {
    const { catalog, store } = offline();
    const [seller, first, later] = [randomAddress(), randomAddress(), randomAddress()];
    const resource = tool(seller);
    // The first payer leaves the seller's private-usage declaration out of its echo.
    const created = await catalog.record(settledPayment({ ...resource, payer: first, transaction: hash() }));
    const id = created?.listingId ?? "";
    expect((await store.get(id))?.content.extensions ?? []).not.toContain(PRIVATE_USAGE_EXTENSION);
    const paid = hash();
    await catalog.record(settledPayment({ ...resource, payer: later, transaction: paid }));
    const app = discoveryRoutes(store);
    const usage = await app.request(`/resources/${id}/usage?network=${TESTNET}`);
    expect(usage.status).toBe(404);
    expect(await errorOf(usage)).toMatchObject({ code: "discovery_usage_private", retryable: false });
    const links = await app.request(`/settlements?network=${TESTNET}&transactions=${paid}`);
    expect(((await links.json()) as SettlementsBody).items).toEqual([]);
    const sellerUsage = await app.request(`/sellers/${seller}/usage?network=${TESTNET}`);
    expect(await sellerUsage.json()).toMatchObject({ totals: { payments: 0 }, listings: [] });
  });

  it("keeps a declared opt-out once any settlement declared it, whatever later payers echo", async () => {
    const { catalog, store } = offline();
    const resource = tool(randomAddress());
    const created = await catalog.record(settledPayment({ ...resource, transaction: hash() }));
    const id = created?.listingId ?? "";
    await catalog.record(
      settledPayment({ ...resource, transaction: hash(), extensions: { [PRIVATE_USAGE_EXTENSION]: {} } }),
    );
    await catalog.record(settledPayment({ ...resource, transaction: hash() }));
    expect((await store.get(id))?.content.extensions).toEqual([PRIVATE_USAGE_EXTENSION]);
    expect((await discoveryRoutes(store).request(`/resources/${id}/usage?network=${TESTNET}`)).status).toBe(
      404,
    );
  });
});

describe("usage detail per network", () => {
  it("publishes counts only on pubnet by default, settlements on testnet", () => {
    expect(defaultUsageDetail(PUBNET)).toBe("counts");
    expect(defaultUsageDetail(TESTNET)).toBe("settlements");
  });

  it("with counts, links no settlement to a listing and lists no payer, but still counts", async () => {
    const { app, seller, listings, paid } = await usageCatalog(undefined, defaultUsageDetail);
    const links = (await (
      await app.request(`/settlements?network=${PUBNET}&transactions=${paid.pubnet}`)
    ).json()) as SettlementsBody;
    expect(links.items).toEqual([]);
    const usage = await app.request(`/resources/${listings.pubnet}/usage?network=${PUBNET}`);
    expect(usage.status).toBe(200);
    const body = (await usage.json()) as UsageBody;
    expect(body).toMatchObject({ payments: 1, payers: 1, recent: [] });
    expect(JSON.stringify(body)).not.toContain(paid.pubnet);
    const sellerUsage = await app.request(`/sellers/${seller}/usage?network=${PUBNET}`);
    expect(await sellerUsage.json()).toMatchObject({ totals: { payments: 1, payers: 1 } });
    // Testnet keeps its settlement links by default.
    const testnet = (await (
      await app.request(`/settlements?network=${TESTNET}&transactions=${paid.listing[0]}`)
    ).json()) as SettlementsBody;
    expect(testnet.items).toHaveLength(1);
  });
});

describe("what a listing's other routes show of its settlements", () => {
  interface VersionsBody {
    versions: { transaction?: string }[];
  }
  interface DetailBody {
    rail402: { listings: { settlements: number; lastSettled?: string }[] };
  }

  it("links no version to a settlement, and dates no settlement, while the usage is private", async () => {
    const { app, listings, paid } = await usageCatalog();
    const versions = (await (
      await app.request(`/resources/${listings.privateListing}/versions`)
    ).json()) as VersionsBody;
    expect(versions.versions.length).toBeGreaterThan(0);
    expect(versions.versions.every((version) => version.transaction === undefined)).toBe(true);
    const detail = (await (await app.request(`/resources/${listings.privateListing}`)).json()) as DetailBody;
    expect(detail.rail402.listings[0]?.lastSettled).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain(paid.privatePaid);

    // A public listing keeps both.
    const shown = (await (
      await app.request(`/resources/${listings.listing}/versions`)
    ).json()) as VersionsBody;
    expect(shown.versions[0]?.transaction).toBe(paid.listing[0]);
    const public_ = (await (await app.request(`/resources/${listings.listing}`)).json()) as DetailBody;
    expect(public_.rail402.listings[0]?.lastSettled).toEqual(expect.any(String));
  });

  it("links no version to a settlement on a network that publishes usage counts only", async () => {
    const { app, listings } = await usageCatalog(undefined, defaultUsageDetail);
    const pubnet = (await (
      await app.request(`/resources/${listings.pubnet}/versions`)
    ).json()) as VersionsBody;
    expect(pubnet.versions.every((version) => version.transaction === undefined)).toBe(true);
    const testnet = (await (
      await app.request(`/resources/${listings.listing}/versions`)
    ).json()) as VersionsBody;
    expect(testnet.versions[0]?.transaction).toEqual(expect.any(String));
  });

  it("dates no settlement of a withdrawn listing whose usage is private, while it is paid again", async () => {
    let clock = Date.now();
    const store = new MemoryCatalogStore(() => clock);
    const origins = new Map<string, OriginResponse>();
    const catalog = new Catalog({
      store,
      sandbox,
      now: () => new Date(clock),
      fetchOrigin: (url) => Promise.resolve(origins.get(url) ?? { kind: "unreachable", reason: "offline" }),
    });
    const settle = async (fixture: PaymentFixture) => {
      const outcome = await catalog.record(settledPayment(fixture));
      while ((await store.dueOriginChecks(1)).length > 0) await catalog.checkOrigins(50);
      return outcome?.listingId ?? "";
    };
    const app = discoveryRoutes(store, undefined, undefined, undefined, () => "settlements");
    const detail = async (id: string) =>
      (await (await app.request(`/resources/${id}`)).json()) as DetailBody & { state: string };
    const listed = async (url: string, payTo: string) => {
      const fixture = { url, payTo, extensions: { [PRIVATE_USAGE_EXTENSION]: {} } };
      origins.set(url, { kind: "payment_required", paymentRequired: paymentRequiredFor(fixture) });
      const id = await settle(fixture);
      expect(await store.get(id)).toMatchObject({ state: "published", trust: "origin_verified" });
      expect((await detail(id)).rail402.listings[0]?.lastSettled).toBeUndefined();
      return { id, fixture };
    };

    // Withdrawn by its origin, then paid again while it stays withdrawn.
    const seller = randomAddress();
    const refused = await listed("https://private-refused.example.com/x", seller);
    origins.set(refused.fixture.url, { kind: "not_payment_required", status: 404 });
    await settle({ ...refused.fixture, description: "Changed" });
    clock += 3_600_000;
    await settle(refused.fixture);
    // Withdrawn for being idle (testnet's default idle retention).
    const idle = await listed("https://private-idle.example.com/x", seller);
    clock += 91 * 86_400_000;
    expect(await catalog.expire()).toBeGreaterThan(0);

    for (const id of [refused.id, idle.id]) {
      expect(await store.get(id)).toMatchObject({ state: "quarantined", trust: "origin_verified" });
      const body = await detail(id);
      expect(body.state).toBe("quarantined");
      expect(body.rail402.listings).toHaveLength(1);
      expect(body.rail402.listings[0]?.lastSettled).toBeUndefined();
    }
  });
});
