import { afterAll, describe, expect, it } from "vitest";
import {
  Catalog,
  MAX_EXTENSION_RESPONSES_BYTES,
  MemoryCatalogStore,
  SchemaSandbox,
  askingOrder,
  checkCandidates,
  type CheckCandidate,
  extensionResponsesHeader,
  paymentRequiredFor,
  randomAddress,
  randomContract,
  settledPayment,
  type OriginResponse,
} from "@rail402.dev/bazaar";
import { catalogSuite } from "@rail402.dev/bazaar/testing";

catalogSuite("memory", () => Promise.resolve({ store: new MemoryCatalogStore() }));

describe("origin check candidates", () => {
  const settled = (amount: string, asset = "CUSDC") => ({
    scheme: "exact",
    network: "stellar:testnet",
    asset,
    payTo: "GSELLER",
    amount,
    maxTimeoutSeconds: 60,
    extra: {},
    settledAmount: amount,
  });

  it("keep the path and payment of an owner's settlement that joined a claim's check before candidates were kept", () => {
    const url = "https://items.example.com/items/42";
    expect(checkCandidates({ reason: "owner_conflict", url, settled: settled("10000") })).toEqual([
      { url, settled: settled("10000") },
    ]);
    expect(checkCandidates({ reason: "owner_conflict", url })).toEqual([]);
  });

  it("are asked those no run asked first, then those that failed, larger payments first, never the refused", () => {
    const candidate = (path: string, amount: string, asked?: CheckCandidate["asked"]): CheckCandidate => ({
      url: `https://items.example.com/items/${path}`,
      settled: settled(amount, path.startsWith("x") ? "COTHER" : "CUSDC"),
      ...(asked === undefined ? {} : { asked }),
    });
    const order = askingOrder([
      candidate("a", "1"),
      candidate("b", "10000", { failed: true }),
      candidate("c", "10000"),
      candidate("d", "500", { refused: "origin_not_payment_required" }),
      candidate("x1", "1000000"),
      candidate("e", "10000"),
    ]);
    expect(order.map(({ url }) => url.split("/").at(-1))).toEqual(["x1", "c", "e", "a", "b"]);
  });
});

describe("origin checks over time", () => {
  const sandbox = new SchemaSandbox();
  afterAll(async () => {
    await sandbox.close();
  });

  it("withdraws a listing whose origin stays unreachable through every retry", async () => {
    let now = Date.parse("2026-09-28T00:00:00Z");
    const store = new MemoryCatalogStore(() => now);
    const catalog = new Catalog({
      store,
      sandbox,
      now: () => new Date(now),
      fetchOrigin: () => Promise.resolve({ kind: "unreachable", reason: "connection refused" }),
    });
    const outcome = await catalog.record(settledPayment({ url: "https://gone.example.com/api" }));
    const id = outcome?.listingId ?? "";

    // The first attempt and five retries, 1 minute to 12 hours apart.
    for (let attempt = 0; attempt < 6; attempt++) {
      await catalog.checkOrigins();
      expect((await store.get(id))?.state, `attempt ${String(attempt)}`).toBe(
        attempt < 5 ? "pending" : "quarantined",
      );
      now += 13 * 3_600_000;
    }
    expect(await store.dueOriginChecks(10)).toEqual([]);
    expect((await store.versions(id)).map((v) => v.cause)).toEqual(["settlement", "quarantine"]);
  });

  it("keeps a pending listing's retry schedule however often its owner is paid while its origin fails", async () => {
    let now = Date.parse("2026-09-28T00:00:00Z");
    const store = new MemoryCatalogStore(() => now);
    const answers = new Map<string, OriginResponse>();
    const catalog = new Catalog({
      store,
      sandbox,
      now: () => new Date(now),
      fetchOrigin: (url) => Promise.resolve(answers.get(url) ?? { kind: "unreachable", reason: "offline" }),
    });
    const item = {
      url: "https://items.example.com/items/42",
      payTo: randomAddress(),
      routeTemplate: "/items/:id",
      pathParams: { id: "42" },
    };
    answers.set(item.url, { kind: "not_payment_required", status: 503 });
    const id = (await catalog.record(settledPayment(item)))?.listingId ?? "";
    // A payer pays the seller one unit six times, 20 seconds apart, while the path fails for now.
    for (let payment = 0; payment < 6; payment++) {
      await catalog.record(settledPayment({ ...item, amount: "1" }));
      await catalog.checkOrigins();
      now += 20_000;
    }
    expect(await store.get(id)).toMatchObject({ state: "pending" });
    expect((await store.versions(id)).map((version) => version.cause)).toEqual(["settlement"]);
    // The origin is back: the scheduled retry, 5 minutes after the second, lists it with no settlement.
    answers.set(item.url, { kind: "payment_required", paymentRequired: paymentRequiredFor(item) });
    for (let minute = 0; minute < 6; minute++) {
      await catalog.checkOrigins();
      now += 60_000;
    }
    expect(await store.get(id)).toMatchObject({ state: "published" });
  });

  it("publishes listings staged pending past the hour only as the hourly quotas have room", async () => {
    let now = Date.parse("2026-09-28T00:00:00Z");
    const store = new MemoryCatalogStore(() => now);
    const answers = new Map<string, OriginResponse>();
    const asked: string[] = [];
    const catalog = new Catalog({
      store,
      sandbox,
      now: () => new Date(now),
      networks: { "stellar:testnet": { maxNewListingsPerHour: 3, maxNewListingsPerOwnerPerHour: 2 } },
      fetchOrigin: (url) => {
        asked.push(url);
        return Promise.resolve(answers.get(url) ?? { kind: "unreachable", reason: "offline" });
      },
    });
    // One seller's origin answers 503 while four of its listings, paid in full, are created.
    const owner = randomAddress();
    const urls = ["a", "b", "c", "d"].map((path) => `https://staged.example.com/${path}`);
    const ids: string[] = [];
    for (const url of urls) {
      answers.set(url, { kind: "not_payment_required", status: 503 });
      ids.push((await catalog.record(settledPayment({ url, payTo: owner })))?.listingId ?? "");
    }
    await catalog.checkOrigins();
    // Two hours later the origin answers. Two listings take the seller's quota for the hour; the
    // other two wait, without spending a retry, until the first of those two leaves the hour: their
    // origin is not asked again before, and they are never withdrawn.
    now += 2 * 3_600_000;
    for (const url of urls)
      answers.set(url, {
        kind: "payment_required",
        paymentRequired: paymentRequiredFor({ url, payTo: owner }),
      });
    const published = async () =>
      (await store.getMany(ids)).filter((listing) => listing.state === "published").length;
    await catalog.checkOrigins();
    expect(await published()).toBe(2);
    asked.length = 0;
    for (let minutes = 5; minutes < 60; minutes += 5) {
      now += 5 * 60_000;
      await catalog.checkOrigins();
      expect(await published(), `after ${String(minutes)} minutes`).toBe(2);
    }
    expect(asked).toEqual([]);
    now += 6 * 60_000;
    await catalog.checkOrigins();
    expect(await published()).toBe(4);
    expect(asked).toHaveLength(2);
    expect((await store.getMany(ids)).every((listing) => listing.quotaChargedAt !== undefined)).toBe(true);
  });
});

describe("checks over a small host budget", () => {
  const sandbox = new SchemaSandbox();
  afterAll(async () => {
    await sandbox.close();
  });

  const items = (perMinute: number) => {
    let now = Date.parse("2026-09-28T00:00:00Z");
    const store = new MemoryCatalogStore(() => now);
    const answers = new Map<string, OriginResponse>();
    const asked: string[] = [];
    const catalog = new Catalog({
      store,
      sandbox,
      now: () => new Date(now),
      originChecksPerHostPerMinute: perMinute,
      fetchOrigin: (url) => {
        asked.push(url);
        return Promise.resolve(answers.get(url) ?? { kind: "not_payment_required", status: 404 });
      },
    });
    const seller = randomAddress();
    const item = (id: string, fixture: Parameters<typeof settledPayment>[0] = {}) => ({
      url: `https://items.example.com/items/${id}`,
      payTo: seller,
      routeTemplate: "/items/:id",
      pathParams: { id },
      ...fixture,
    });
    const sells = (id: string) => {
      answers.set(item(id).url, { kind: "payment_required", paymentRequired: paymentRequiredFor(item(id)) });
    };
    const minute = () => {
      now += 61_000;
    };
    return { store, catalog, asked, answers, item, sells, minute };
  };
  const published = (id: string) => ({
    state: "published",
    content: { bazaar: { info: { input: { pathParams: { id } } } } },
  });

  it("goes on from the paths earlier runs found refused, never asking one twice", async () => {
    const { store, catalog, asked, item, sells, minute } = items(2);
    // Large payments of a token worth nothing, at paths the seller does not sell, before a buyer's.
    const junk = randomContract();
    let id = "";
    for (const path of ["x1", "x2", "x3"]) {
      const outcome = await catalog.record(settledPayment(item(path, { asset: junk, amount: "1000000000" })));
      id ||= outcome?.listingId ?? "";
    }
    sells("42");
    await catalog.record(settledPayment(item("42")));
    await catalog.checkOrigins();
    expect(await store.get(id)).toMatchObject({ state: "pending" });
    expect((await store.dueOriginChecks(10))[0]).toBeUndefined();
    minute();
    await catalog.checkOrigins();
    expect(await store.get(id)).toMatchObject(published("42"));
    expect(asked).toEqual(["x1", "x2", "x3", "42"].map((path) => item(path).url));
  });

  it("asks a buyer's path before listing from a payment below the price at another", async () => {
    const { store, catalog, asked, item, sells, minute } = items(2);
    // Large payments of a token the seller does not price in, at paths it sells, before a buyer's.
    const junk = randomContract();
    let id = "";
    for (const path of ["x1", "x2"]) {
      sells(path);
      const outcome = await catalog.record(settledPayment(item(path, { asset: junk, amount: "1000000000" })));
      id ||= outcome?.listingId ?? "";
    }
    sells("42");
    await catalog.record(settledPayment(item("42")));
    await catalog.checkOrigins();
    expect(await store.get(id)).toMatchObject({ state: "pending" });
    minute();
    await catalog.checkOrigins();
    const listing = await store.get(id);
    expect(listing).toMatchObject(published("42"));
    // Listed for the buyer's payment of its price, it counts toward the seller's hourly quota.
    expect(listing?.quotaChargedAt).toBeInstanceOf(Date);
    // The buyer's path first, then, as far as the budget goes, those that listed it for less.
    expect(asked).toEqual(["x1", "x2", "42", "x1"].map((path) => item(path).url));
  });

  it("weighs a claim and withdraws from what earlier runs found, one request a minute", async () => {
    const { store, catalog, asked, item, minute } = items(1);
    let id = "";
    for (const path of ["d1", "d2", "d3"]) {
      const outcome = await catalog.record(settledPayment(item(path, { amount: "1" })));
      id ||= outcome?.listingId ?? "";
    }
    await catalog.record(settledPayment(item("c", { payTo: randomAddress() })));
    for (let run = 0; run < 4; run++) {
      expect(await store.get(id), `run ${String(run)}`).toMatchObject({ state: "pending" });
      await catalog.checkOrigins();
      minute();
    }
    // Each path once, then the example the claim is weighed at: the path that created the listing.
    expect(asked).toEqual(["d1", "d2", "d3", "d1"].map((path) => item(path).url));
    expect(await store.get(id)).toMatchObject({ state: "quarantined" });
    expect(await store.transaction(id, (tx) => tx.latestReason(id))).toBe("origin_not_payment_required");
    expect(await store.dueOriginChecks(10)).toEqual([]);
  });

  it("backs off while the paths it asks fail for now, and asks those it has not first next time", async () => {
    const { store, catalog, asked, answers, item, sells, minute } = items(2);
    let id = "";
    for (const path of ["t1", "t2"]) {
      answers.set(item(path).url, { kind: "not_payment_required", status: 503 });
      const outcome = await catalog.record(settledPayment(item(path, { amount: "20000" })));
      id ||= outcome?.listingId ?? "";
    }
    sells("42");
    await catalog.record(settledPayment(item("42")));
    await catalog.checkOrigins();
    expect(await store.get(id)).toMatchObject({ state: "pending" });
    minute();
    await catalog.checkOrigins();
    expect(await store.get(id)).toMatchObject(published("42"));
    // The path it had not asked first; the one that failed after it, as far as the budget goes.
    expect(asked).toEqual(["t1", "t2", "42", "t1"].map((path) => item(path).url));
  });
});

describe("checks that wait for room in the hour", () => {
  const sandbox = new SchemaSandbox();
  afterAll(async () => {
    await sandbox.close();
  });

  it.each([
    ["kept pending at a path that fails for now", 503],
    ["withdrawn at a path the seller does not sell", 404],
  ])("never lets dust decide a listing %s while it waits for the network's quota", async (_label, status) => {
    let now = Date.parse("2026-09-28T00:00:00Z");
    const store = new MemoryCatalogStore(() => now);
    const answers = new Map<string, OriginResponse>();
    const asked: string[] = [];
    const catalog = new Catalog({
      store,
      sandbox,
      now: () => new Date(now),
      networks: { "stellar:testnet": { maxNewListingsPerHour: 1 } },
      fetchOrigin: (url) => {
        asked.push(url);
        return Promise.resolve(answers.get(url) ?? { kind: "unreachable", reason: "offline" });
      },
    });
    const seller = randomAddress();
    const item = (id: string, amount?: string) =>
      settledPayment({
        url: `https://items.example.com/items/${id}`,
        payTo: seller,
        routeTemplate: "/items/:id",
        pathParams: { id },
        ...(amount === undefined ? {} : { amount }),
      });
    const sells = (id: string) => {
      const url = `https://items.example.com/items/${id}`;
      answers.set(url, {
        kind: "payment_required",
        paymentRequired: paymentRequiredFor({
          url,
          payTo: seller,
          routeTemplate: "/items/:id",
          pathParams: { id },
        }),
      });
    };
    answers.set("https://items.example.com/items/1", { kind: "not_payment_required", status });
    answers.set("https://items.example.com/items/zzz", { kind: "not_payment_required", status: 404 });
    sells("42");
    // A payer creates the listing with one unit at a path that does not sell it.
    const id = (await catalog.record(item("1", "1")))?.listingId ?? "";
    await catalog.checkOrigins();
    // Another seller's listing takes the hour's only place.
    const other = "https://other.example.com/x";
    const otherPayTo = randomAddress();
    answers.set(other, {
      kind: "payment_required",
      paymentRequired: paymentRequiredFor({ url: other, payTo: otherPayTo }),
    });
    await catalog.record(settledPayment({ url: other, payTo: otherPayTo }));
    await catalog.checkOrigins();
    // A buyer pays the price at a path the seller sells; the payer pays one unit at another path.
    await catalog.record(item("42"));
    await catalog.record(item("zzz", "1"));
    asked.length = 0;
    await catalog.checkOrigins();
    expect(asked).toEqual([]);
    now += 3_600_000 + 2_000;
    await catalog.checkOrigins();
    expect(asked).toContain("https://items.example.com/items/42");
    expect(await store.get(id)).toMatchObject({
      state: "published",
      content: { bazaar: { info: { input: { pathParams: { id: "42" } } } } },
    });
  });
});

describe("EXTENSION-RESPONSES", () => {
  it("stays within the header budget whatever the outcome carries", () => {
    const header = extensionResponsesHeader({
      status: "rejected",
      code: "bazaar_info_unsupported",
      rejectedReason: "x".repeat(100_000),
      listingId: "0b1c2d3e-0000-4000-8000-000000000000",
    });
    expect(header.length).toBeLessThanOrEqual(MAX_EXTENSION_RESPONSES_BYTES);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString()) as {
      bazaar: { status: string; code: string; rejectedReason: string };
    };
    expect(decoded.bazaar).toMatchObject({ status: "rejected", code: "bazaar_info_unsupported" });
    expect(decoded.bazaar.rejectedReason.trim()).not.toBe("");
  });

  it("passes an ordinary outcome through unchanged", () => {
    const outcome = { status: "success", code: "recorded", listingId: "id", version: 2 } as const;
    const header = extensionResponsesHeader(outcome);
    expect(JSON.parse(Buffer.from(header, "base64").toString())).toEqual({ bazaar: outcome });
  });

  it("carries other extensions' entries next to the outcome, and without one", () => {
    const rail402 = { settlement: { repeat: true, settledBy: "rail402" } };
    const decode = (header: string) => JSON.parse(Buffer.from(header, "base64").toString()) as unknown;
    const outcome = { status: "success", code: "recorded" } as const;
    expect(decode(extensionResponsesHeader(outcome, { rail402 }))).toEqual({ rail402, bazaar: outcome });
    expect(decode(extensionResponsesHeader(undefined, { rail402 }))).toEqual({ rail402 });
    const reduced = extensionResponsesHeader(
      { status: "rejected", code: "bazaar_info_unsupported", rejectedReason: "x".repeat(100_000) },
      { rail402 },
    );
    expect(reduced.length).toBeLessThanOrEqual(MAX_EXTENSION_RESPONSES_BYTES);
    expect(decode(reduced)).toMatchObject({ rail402, bazaar: { code: "bazaar_info_unsupported" } });
  });
});
