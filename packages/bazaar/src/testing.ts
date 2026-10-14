/**
 * Catalog conformance suite. Runs the catalog's integrity rules against a store implementation, so
 * every store (memory, Postgres, an operator's own) is held to the same behaviour. Requires vitest in
 * the consuming project.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Catalog, type CatalogObserver, type TokenDirectory } from "./catalog.ts";
import type { StellarTomlResult } from "./stellar-toml.ts";
import {
  FIXTURE_ASSET,
  muxedAddress,
  paymentRequiredFor,
  randomAddress,
  settledPayment,
  type PaymentFixture,
} from "./fixtures.ts";
import type { SettledPayment } from "./extract.ts";
import type { McpToolProbe } from "./mcp-origin.ts";
import type { OriginResponse } from "./origin.ts";
import { SchemaSandbox } from "./schema-sandbox.ts";
import type { CatalogStore } from "./store.ts";

export interface CatalogFixture {
  readonly store: CatalogStore;
}

/**
 * An `upto` settlement of `settled` under a signed cap of `cap`: the accepted requirements carry the
 * cap, the settled requirements the amount the seller settled.
 */
function uptoPayment(payment: SettledPayment, cap: string, settled: string): SettledPayment {
  const accepted = { ...payment.requirements, scheme: "upto", amount: cap };
  return {
    ...payment,
    payload: { ...payment.payload, accepted, payload: { authorization: "AAAA" } },
    requirements: { ...accepted, amount: settled },
  };
}

export function catalogSuite(name: string, create: () => Promise<CatalogFixture>): void {
  const sandbox = new SchemaSandbox();
  afterAll(async () => {
    await sandbox.close();
  });

  const origins = new Map<string, OriginResponse>();
  const setup = async (
    options: {
      maxNewListingsPerOwnerPerHour?: number;
      maxNewListingsPerPayerPerHour?: number;
      maxNewListingsPerHour?: number;
      originChecksPerHostPerMinute?: number;
      outboxGraceMs?: number;
      assets?: TokenDirectory;
      stellarToml?: (host: string) => Promise<StellarTomlResult>;
      homeDomain?: (network: string, account: string) => Promise<string | undefined>;
      now?: () => Date;
      fetchOrigin?: (url: string, method: string) => Promise<OriginResponse>;
      probeTool?: (url: string, tool: McpToolProbe) => Promise<OriginResponse>;
      observer?: CatalogObserver;
    } = {},
  ) => {
    const { store } = await create();
    const catalog = new Catalog({
      store,
      sandbox,
      fetchOrigin: (url) =>
        Promise.resolve(origins.get(url) ?? { kind: "unreachable", reason: "no origin in test" }),
      probeTool: (url, tool) =>
        Promise.resolve(
          origins.get(toolKey(url, tool.toolName)) ?? { kind: "unreachable", reason: "no origin in test" },
        ),
      ...options,
    });
    return { store, catalog };
  };
  let urlCounter = 0;
  const uniqueUrl = (path = "weather") => `https://api${String(++urlCounter)}.example.com/${path}`;
  /** Where the suite's origins map keeps an MCP tool's answer. */
  const toolKey = (url: string, toolName: string) => `${url}#${toolName}`;
  const originKey = (fixture: PaymentFixture) =>
    fixture.kind === "mcp" ? toolKey(fixture.url ?? "", fixture.toolName ?? "forecast") : (fixture.url ?? "");
  const origin = (fixture: PaymentFixture) => {
    origins.set(originKey(fixture), {
      kind: "payment_required",
      paymentRequired: paymentRequiredFor(fixture),
    });
  };
  /** Settles a payment for a resource whose own 402 matches it, and runs the origin check. */
  const publish = async (catalog: Catalog, fixture: PaymentFixture) => {
    const payment = settledPayment(fixture);
    origin({ ...fixture, payTo: payment.requirements.payTo });
    const outcome = await catalog.record(payment);
    await catalog.checkOrigins();
    return outcome;
  };

  describe(`${name}: bazaar catalog`, () => {
    it("catalogs an HTTP resource after settlement and lists it once its own 402 confirms it", async () => {
      const { catalog, store } = await setup();
      const payTo = randomAddress();
      const url = uniqueUrl();
      const outcome = await catalog.record(settledPayment({ url, payTo }));
      expect(outcome).toMatchObject({
        status: "processing",
        code: "awaiting_origin_verification",
        version: 1,
      });
      expect(outcome?.reason?.trim()).not.toBe("");
      const id = outcome?.listingId ?? "";
      expect(await store.get(id)).toMatchObject({ owner: payTo, trust: "settled", state: "pending" });
      expect((await store.list({ payTo, limit: 100, offset: 0 })).total).toBe(0);

      origin({ url, payTo });
      expect(await catalog.checkOrigins()).toBe(1);
      const listing = await store.get(id);
      expect(listing).toMatchObject({
        owner: payTo,
        trust: "origin_verified",
        state: "published",
        settlements: 1,
      });
      expect(listing?.content).toMatchObject({ resource: url, kind: "http", method: "GET" });
      expect(listing?.content.accepts).toEqual([expect.objectContaining({ payTo, amount: "10000" })]);
      expect((await store.list({ payTo, limit: 100, offset: 0 })).items.flat().map((l) => l.id)).toEqual([
        id,
      ]);
      expect((await store.versions(id)).map((v) => [v.cause, v.state])).toEqual([
        ["settlement", "pending"],
        ["origin_verification", "published"],
      ]);
    });

    it("never lists an HTTP resource whose own response is not a 402", async () => {
      const { catalog, store } = await setup();
      const payTo = randomAddress();
      const url = uniqueUrl("login");
      const outcome = await catalog.record(settledPayment({ url, payTo }));
      origins.set(url, { kind: "not_payment_required", status: 200 });
      await catalog.checkOrigins();
      expect(await store.get(outcome?.listingId ?? "")).toMatchObject({ state: "quarantined", version: 2 });
      expect((await store.list({ payTo, limit: 100, offset: 0 })).total).toBe(0);
      expect(await store.dueOriginChecks(10)).toEqual([]);
    });

    it("keeps checking other origins when one sends a malformed 402", async () => {
      const { catalog, store } = await setup();
      const payTo = randomAddress();
      const broken = [uniqueUrl(), uniqueUrl(), uniqueUrl()];
      const good = uniqueUrl();
      const ids: string[] = [];
      for (const url of [...broken, good]) {
        ids.push((await catalog.record(settledPayment({ url, payTo })))?.listingId ?? "");
      }
      const [empty, noArray, badOptions] = broken as [string, string, string];
      origins.set(empty, { kind: "payment_required", paymentRequired: {} as never });
      origins.set(noArray, {
        kind: "payment_required",
        paymentRequired: { ...paymentRequiredFor({ url: noArray, payTo }), accepts: "all" as never },
      });
      const malformed = paymentRequiredFor({ url: badOptions, payTo });
      origins.set(badOptions, {
        kind: "payment_required",
        paymentRequired: {
          ...malformed,
          accepts: malformed.accepts.map((option) => ({ ...option, amount: "1.5" })),
        },
      });
      origin({ url: good, payTo });

      expect(await catalog.checkOrigins()).toBe(4);
      const states = await Promise.all(ids.map(async (id) => (await store.get(id))?.state));
      expect(states).toEqual(["quarantined", "quarantined", "quarantined", "published"]);
    });

    it("publishes only the well-formed payment options of an origin's 402", async () => {
      const { catalog, store } = await setup();
      const payTo = randomAddress();
      const url = uniqueUrl();
      const outcome = await catalog.record(settledPayment({ url, payTo }));
      const required = paymentRequiredFor({ url, payTo });
      const [valid] = required.accepts;
      origins.set(url, {
        kind: "payment_required",
        paymentRequired: {
          ...required,
          accepts: [
            { ...valid, amount: "-5" },
            { ...valid, asset: "USDC" },
            ...required.accepts,
          ] as typeof required.accepts,
        },
      });
      await catalog.checkOrigins();
      const listing = await store.get(outcome?.listingId ?? "");
      expect(listing?.state).toBe("published");
      expect(listing?.content.accepts).toEqual([expect.objectContaining({ payTo, amount: "10000" })]);
    });

    it("catalogs at most one resource per settlement", async () => {
      const { catalog, store } = await setup();
      const payTo = randomAddress();
      const first = settledPayment({ url: uniqueUrl(), payTo });
      const created = await catalog.record(first);
      // The same settled transaction replayed with another resource in the payload.
      const replay = settledPayment({ url: uniqueUrl(), payTo, transaction: first.transaction });
      const outcome = await catalog.record(replay);
      expect(outcome).toMatchObject({ status: "rejected", code: "bazaar_settlement_reused" });
      expect(outcome?.rejectedReason?.trim()).not.toBe("");
      expect(outcome?.listingId).toBeUndefined();
      expect(await catalog.record(first)).toMatchObject({
        status: "success",
        code: "recorded",
        listingId: created?.listingId,
      });
      expect((await store.get(created?.listingId ?? ""))?.settlements).toBe(1);
    });

    it("prices an upto listing at the cap the buyer signed, as the seller's own 402 offers it", async () => {
      const { catalog, store } = await setup();
      const payTo = randomAddress();
      const url = uniqueUrl("metered");
      const cap = "1000000";
      // The seller settled 250000 of the cap: the requirements carry the amount settled.
      const outcome = await catalog.record(uptoPayment(settledPayment({ url, payTo }), cap, "250000"));
      const id = outcome?.listingId ?? "";
      expect(outcome).toMatchObject({ status: "processing", code: "awaiting_origin_verification" });
      expect((await store.get(id))?.content.accepts).toEqual([
        expect.objectContaining({ scheme: "upto", payTo, amount: cap }),
      ]);

      // The 402 offers the cap; the listing publishes unchanged.
      const required = paymentRequiredFor({ url, payTo });
      origins.set(url, {
        kind: "payment_required",
        paymentRequired: {
          ...required,
          accepts: required.accepts.map((option) => ({ ...option, scheme: "upto", amount: cap })),
        },
      });
      await catalog.checkOrigins();
      const listing = await store.get(id);
      expect(listing).toMatchObject({ state: "published", version: 2 });
      expect(listing?.content.accepts).toEqual([
        expect.objectContaining({ scheme: "upto", payTo, amount: cap }),
      ]);

      // A later settlement of a different amount under the same cap changes nothing.
      const again = await catalog.record(uptoPayment(settledPayment({ url, payTo }), cap, "1"));
      expect(again).toMatchObject({ status: "success", code: "recorded", listingId: id });
      expect((await store.get(id))?.contentHash).toBe(listing?.contentHash);
    });

    it("does not catalog a payment settled without a transaction", async () => {
      const { catalog, store } = await setup({ outboxGraceMs: 0 });
      const payTo = randomAddress();
      const offchain = uptoPayment(
        settledPayment({ url: uniqueUrl("metered"), payTo, transaction: "" }),
        "5",
        "0",
      );
      for (const outcome of [await catalog.record(offchain), await catalog.recordDurably(offchain)]) {
        expect(outcome).toMatchObject({ status: "rejected", code: "bazaar_settlement_offchain" });
        expect(outcome?.rejectedReason?.trim()).not.toBe("");
      }
      expect((await store.list({ payTo, limit: 100, offset: 0 })).total).toBe(0);
      expect(await store.claimSettlements(10, 60_000)).toEqual([]);
    });

    it("does not catalog a settlement that moved nothing, however high its cap", async () => {
      const { catalog, store } = await setup({ outboxGraceMs: 0 });
      const payTo = randomAddress();
      const url = uniqueUrl("metered");
      const zero = uptoPayment(settledPayment({ url, payTo }), "100000000000000000", "0");
      for (const outcome of [await catalog.record(zero), await catalog.recordDurably(zero)]) {
        expect(outcome).toMatchObject({ status: "rejected", code: "bazaar_settlement_zero" });
        expect(outcome?.rejectedReason?.trim()).not.toBe("");
      }
      expect((await store.list({ payTo, limit: 100, offset: 0 })).total).toBe(0);
      expect(await store.claimSettlements(10, 60_000)).toEqual([]);
      // The payTo's own settlement that moved value catalogs it afterwards.
      const paid = await catalog.record(uptoPayment(settledPayment({ url, payTo }), "10000", "5000"));
      expect(paid?.status).not.toBe("rejected");
    });

    it("bounds a rejection reason that quotes the buyer's input", async () => {
      const { catalog } = await setup();
      const huge = "x".repeat(100_000);
      const outcome = await catalog.record(
        settledPayment({ extension: { info: { input: { type: huge } }, schema: { type: "object" } } }),
      );
      expect(outcome).toMatchObject({ status: "rejected", code: "bazaar_info_unsupported" });
      expect(outcome?.rejectedReason?.length).toBeLessThanOrEqual(300);
    });

    it("keys MCP tools on (resource.url, toolName)", async () => {
      const { catalog, store } = await setup();
      const payTo = randomAddress();
      const url = uniqueUrl("mcp");
      const first = await publish(catalog, { url, payTo, kind: "mcp", toolName: "forecast" });
      const second = await publish(catalog, { url, payTo, kind: "mcp", toolName: "history" });
      const again = await catalog.record(settledPayment({ url, payTo, kind: "mcp", toolName: "forecast" }));
      expect(first?.code).toBe("awaiting_origin_verification");
      expect(second?.code).toBe("awaiting_origin_verification");
      expect(first?.listingId).not.toBe(second?.listingId);
      expect(again).toMatchObject({ code: "recorded", listingId: first?.listingId });
      const tools = (await store.list({ type: "mcp", payTo, limit: 100, offset: 0 })).items.flat();
      expect(tools.map((l) => l.content.toolName).sort()).toEqual(["forecast", "history"]);
    });

    it.each([
      ["an mcp:// URL", () => `mcp://tool/shared_${String(++urlCounter)}`, "cataloged"],
      ["an https URL", () => uniqueUrl("mcp"), "awaiting_origin_verification"],
    ])(
      "scopes MCP tools on %s to their owner, so no seller can claim another's tool",
      async (_label, url, code) => {
        const { catalog } = await setup();
        const resource = url();
        const a = await catalog.record(settledPayment({ url: resource, kind: "mcp", toolName: "shared" }));
        const b = await catalog.record(settledPayment({ url: resource, kind: "mcp", toolName: "shared" }));
        expect(a?.code).toBe(code);
        expect(b?.code).toBe(code);
        expect(a?.listingId).not.toBe(b?.listingId);
      },
    );

    it("publishes an MCP tool under an mcp:// URL at once, at trust settled, keeping its first content", async () => {
      const { catalog, store } = await setup();
      const payTo = randomAddress();
      const url = `mcp://tool/first_${String(++urlCounter)}`;
      const first = await catalog.record(settledPayment({ url, payTo, kind: "mcp" }));
      expect(first).toMatchObject({ status: "success", code: "cataloged" });
      const changed = await catalog.record(
        settledPayment({ url, payTo, kind: "mcp", description: "Another description" }),
      );
      expect(changed).toMatchObject({ code: "recorded", listingId: first?.listingId });
      expect(changed?.reason).toMatch(/mcp:\/\//);
      expect(await store.get(first?.listingId ?? "")).toMatchObject({
        state: "published",
        trust: "settled",
        content: { description: "Weather for a city" },
      });
    });

    it("lists an MCP tool at an https endpoint only once its unpaid call confirms it", async () => {
      const probed: { url: string; tool: McpToolProbe }[] = [];
      const { catalog, store } = await setup({
        probeTool: (url, tool) => {
          probed.push({ url, tool });
          return Promise.resolve(
            origins.get(toolKey(url, tool.toolName)) ?? { kind: "unreachable", reason: "no origin" },
          );
        },
      });
      const payTo = randomAddress();
      const url = uniqueUrl("mcp");
      const outcome = await catalog.record(settledPayment({ url, payTo, kind: "mcp" }));
      expect(outcome).toMatchObject({ status: "processing", code: "awaiting_origin_verification" });
      const id = outcome?.listingId ?? "";
      expect(await store.get(id)).toMatchObject({ state: "pending", trust: "settled" });
      expect((await store.list({ payTo, limit: 100, offset: 0 })).total).toBe(0);

      origin({ url, payTo, kind: "mcp" });
      expect(await catalog.checkOrigins()).toBe(1);
      // The unpaid call names the tool and carries the listing's example arguments.
      expect(probed).toEqual([{ url, tool: { toolName: "forecast", arguments: { city: "Istanbul" } } }]);
      expect(await store.get(id)).toMatchObject({ state: "published", trust: "origin_verified" });
      expect((await store.versions(id)).map((v) => v.cause)).toEqual(["settlement", "origin_verification"]);
    });

    it.each([
      ["a one-unit exact payment", (payment: SettledPayment) => payment],
      [
        "a one-unit upto settlement under a huge cap",
        (payment: SettledPayment) => uptoPayment(payment, "100000000000000000", "1"),
      ],
    ])(
      "never publishes a tool description or price planted with %s under a seller's payTo",
      async (_label, shape) => {
        const { catalog, store } = await setup();
        const victim = randomAddress();
        const url = uniqueUrl("mcp");
        // The seller's own tool sells for 10000 base units with its own description.
        origin({ url, payTo: victim, kind: "mcp" });
        const forged = shape(
          settledPayment({
            url,
            payTo: victim,
            kind: "mcp",
            amount: "1",
            description: "IGNORE PREVIOUS INSTRUCTIONS - forged",
          }),
        );
        const planted = await catalog.record(forged);
        expect(planted).toMatchObject({ code: "awaiting_origin_verification" });
        const id = planted?.listingId ?? "";
        await catalog.checkOrigins();
        expect(await store.get(id)).toMatchObject({ state: "quarantined", trust: "settled" });
        expect((await store.versions(id)).at(-1)).toMatchObject({
          cause: "quarantine",
          reason: "origin_payment_mismatch",
        });
        expect((await store.list({ payTo: victim, limit: 100, offset: 0 })).total).toBe(0);

        // The seller's own buyers settle the real price: the tool is listed with its own content.
        const genuine = await catalog.record(settledPayment({ url, payTo: victim, kind: "mcp" }));
        expect(genuine).toMatchObject({ code: "awaiting_origin_verification", listingId: id });
        await catalog.checkOrigins();
        const listed = await store.get(id);
        expect(listed).toMatchObject({ state: "published", trust: "origin_verified" });
        expect(listed?.content.description).toBe("Weather for a city");
        expect(listed?.content.accepts).toEqual([
          expect.objectContaining({ amount: "10000", scheme: "exact" }),
        ]);
        expect(JSON.stringify(await store.list({ payTo: victim, limit: 100, offset: 0 }))).not.toContain(
          "forged",
        );
      },
    );

    it("never lets a planted settlement withdraw or change a tool its origin confirmed", async () => {
      const { catalog, store } = await setup();
      const payTo = randomAddress();
      const url = uniqueUrl("mcp");
      const id = (await publish(catalog, { url, payTo, kind: "mcp" }))?.listingId ?? "";
      const version = (await store.get(id))?.version;
      const planted = await catalog.record(
        settledPayment({ url, payTo, kind: "mcp", amount: "1", description: "forged" }),
      );
      expect(planted).toMatchObject({ code: "awaiting_origin_verification", listingId: id });
      await catalog.checkOrigins();
      expect(await store.get(id)).toMatchObject({
        state: "published",
        trust: "origin_verified",
        version,
        content: { description: "Weather for a city" },
      });
    });

    it("updates an MCP tool's metadata once its origin confirms the change", async () => {
      const { catalog, store } = await setup();
      const payTo = randomAddress();
      const url = uniqueUrl("mcp");
      const id = (await publish(catalog, { url, payTo, kind: "mcp" }))?.listingId ?? "";
      const changed = { url, payTo, kind: "mcp", description: "Seven-day forecast" } as const;
      origin(changed);
      expect(await catalog.record(settledPayment(changed))).toMatchObject({
        code: "awaiting_origin_verification",
        listingId: id,
      });
      await catalog.checkOrigins();
      expect(await store.get(id)).toMatchObject({
        state: "published",
        version: 3,
        content: { description: "Seven-day forecast" },
      });
      expect((await store.versions(id)).map((v) => v.cause)).toEqual([
        "settlement",
        "origin_verification",
        "origin_verification",
      ]);
    });

    it("quarantines a tool its server does not sell to the listed payTo, with a coded reason", async () => {
      const { catalog, store } = await setup();
      const seller = randomAddress();
      const cases: [PaymentFixture, OriginResponse | undefined, string][] = [
        // Another payTo declaring the seller's tool: the tool's 402 names only the seller.
        [{ kind: "mcp", toolName: "forecast" }, undefined, "origin_owner_mismatch"],
        [{ kind: "mcp", toolName: "missing" }, { kind: "tool_not_listed" }, "origin_tool_not_listed"],
        [
          { kind: "mcp", toolName: "free" },
          { kind: "not_payment_required", status: 200 },
          "origin_not_payment_required",
        ],
      ];
      for (const [fixture, answer, reason] of cases) {
        const url = uniqueUrl("mcp");
        origin({ ...fixture, url, payTo: seller });
        if (answer !== undefined) origins.set(originKey({ ...fixture, url }), answer);
        const id = (await catalog.record(settledPayment({ ...fixture, url })))?.listingId ?? "";
        await catalog.checkOrigins();
        expect(await store.get(id)).toMatchObject({ state: "quarantined" });
        expect((await store.versions(id)).at(-1)).toMatchObject({ cause: "quarantine", reason });
      }
    });

    it("records a repeated settlement once and never duplicates the listing", async () => {
      const { catalog, store } = await setup();
      const payment = settledPayment({ url: uniqueUrl() });
      const first = await catalog.record(payment);
      const again = await catalog.record(payment);
      expect(again).toMatchObject({ status: "success", code: "recorded", listingId: first?.listingId });
      expect((await store.get(first?.listingId ?? ""))?.settlements).toBe(1);
      expect(await store.versions(first?.listingId ?? "")).toHaveLength(1);
    });

    it("reads several listings by id as they are now, leaving unknown ids out", async () => {
      const { catalog, store } = await setup();
      const url = uniqueUrl();
      const first = await catalog.record(settledPayment({ url }));
      const other = await catalog.record(settledPayment({ url: uniqueUrl() }));
      const id = first?.listingId ?? "";
      const before = await store.revision();
      await catalog.record(settledPayment({ url, payTo: (await store.get(id))?.owner ?? "" }));
      expect(await store.revision()).toBe(before);
      const read = await store.getMany([
        id,
        other?.listingId ?? "",
        id,
        "00000000-0000-4000-8000-000000000000",
      ]);
      expect(read.map((listing) => listing.id).sort()).toEqual([id, other?.listingId ?? ""].sort());
      expect(read.find((listing) => listing.id === id)?.settlements).toBe(2);
      expect(await store.getMany([])).toEqual([]);
    });

    it("creates exactly one listing under concurrent settlements for a new resource", async () => {
      const { catalog, store } = await setup();
      const url = uniqueUrl();
      const payTo = randomAddress();
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, () => catalog.record(settledPayment({ url, payTo }))),
      );
      expect(new Set(outcomes.map((o) => o?.listingId)).size).toBe(1);
      expect((await store.get(outcomes[0]?.listingId ?? ""))?.settlements).toBe(10);
      expect(await store.versions(outcomes[0]?.listingId ?? "")).toHaveLength(1);
    });

    it("never lets a different payTo modify a listing", async () => {
      const { catalog, store } = await setup();
      const url = uniqueUrl();
      const owner = randomAddress();
      const first = await catalog.record(settledPayment({ url, payTo: owner, amount: "10000" }));
      const attack = await catalog.record(
        settledPayment({ url, payTo: randomAddress(), amount: "1", description: "Forged description" }),
      );
      expect(attack).toMatchObject({ status: "rejected", code: "bazaar_owner_conflict" });
      expect(attack?.rejectedReason?.trim()).not.toBe("");
      const listing = await store.get(first?.listingId ?? "");
      expect(listing).toMatchObject({ owner, version: 1 });
      expect(listing?.content.description).toBe("Weather for a city");
      expect(listing?.content.accepts[0]?.amount).toBe("10000");
    });

    it("does not let echoed metadata change a listing until the origin confirms it", async () => {
      const { catalog, store } = await setup();
      const url = uniqueUrl();
      const payTo = randomAddress();
      const first = await catalog.record(settledPayment({ url, payTo, amount: "10000" }));
      // A buyer pays the real seller a tiny amount and echoes forged metadata.
      const forged = await catalog.record(
        settledPayment({ url, payTo, amount: "1", description: "Now free!" }),
      );
      expect(forged).toMatchObject({ status: "processing", code: "awaiting_origin_verification" });
      expect((await store.get(first?.listingId ?? ""))?.content.accepts[0]?.amount).toBe("10000");

      // The seller's own 402 still says 10000: the forged change never publishes.
      origin({ url, payTo, amount: "10000" });
      await catalog.checkOrigins();
      const listing = await store.get(first?.listingId ?? "");
      expect(listing).toMatchObject({ trust: "origin_verified", state: "published" });
      expect(listing?.content.accepts[0]?.amount).toBe("10000");
      expect(listing?.content.description).toBe("Weather for a city");
    });

    it("publishes a price change the origin confirms, with a public version history", async () => {
      const { catalog, store } = await setup();
      const url = uniqueUrl();
      const payTo = randomAddress();
      const first = await catalog.record(settledPayment({ url, payTo, amount: "10000" }));
      await catalog.record(settledPayment({ url, payTo, amount: "20000" }));
      origin({ url, payTo, amount: "20000" });
      await catalog.checkOrigins();
      const listing = await store.get(first?.listingId ?? "");
      expect(listing?.content.accepts[0]?.amount).toBe("20000");
      const versions = await store.versions(first?.listingId ?? "");
      expect(versions.map((v) => [v.version, v.cause])).toEqual([
        [1, "settlement"],
        [2, "origin_verification"],
      ]);
      expect(versions[0]?.content.accepts[0]?.amount).toBe("10000");
      expect(versions[0]?.transaction).toMatch(/^[0-9a-f]{64}$/);
    });

    it("quarantines a listing whose origin does not name its owner", async () => {
      const { catalog, store } = await setup();
      const url = uniqueUrl();
      const first = await catalog.record(settledPayment({ url, payTo: randomAddress() }));
      origin({ url, payTo: randomAddress() });
      await catalog.checkOrigins();
      expect(await store.get(first?.listingId ?? "")).toMatchObject({ state: "quarantined", version: 2 });
      expect((await store.versions(first?.listingId ?? "")).at(-1)).toMatchObject({
        cause: "quarantine",
        reason: "origin_owner_mismatch",
      });
      expect((await store.list({ limit: 100, offset: 0 })).items.flat().map((l) => l.id)).not.toContain(
        first?.listingId,
      );
    });

    it("quarantines a listing whose origin stayed unreachable through every retry", async () => {
      const { catalog, store } = await setup();
      const id = (await catalog.record(settledPayment({ url: uniqueUrl() })))?.listingId ?? "";
      // Spend the retry schedule without waiting for it.
      for (let attempt = 0; attempt < 5; attempt++) {
        const [check] = await store.claimOriginChecks(1, 60_000);
        if (check !== undefined) await store.deferOriginCheck(check, 0);
      }
      await catalog.checkOrigins();
      expect(await store.get(id)).toMatchObject({ state: "quarantined" });
      expect((await store.versions(id)).at(-1)).toMatchObject({
        cause: "quarantine",
        reason: "origin_unreachable",
      });
      expect(await store.dueOriginChecks(10)).toEqual([]);
    });

    it("republishes a quarantined listing when a settlement with changed content passes the origin check", async () => {
      const { catalog, store } = await setup();
      const url = uniqueUrl();
      const payTo = randomAddress();
      const first = await catalog.record(settledPayment({ url, payTo, amount: "10000" }));
      const id = first?.listingId ?? "";
      origin({ url, payTo: randomAddress() });
      await catalog.checkOrigins();
      expect(await store.get(id)).toMatchObject({ state: "quarantined" });

      // Every settlement re-checks a quarantined listing; it stays hidden while its origin disagrees.
      const same = await catalog.record(settledPayment({ url, payTo, amount: "10000" }));
      expect(same).toMatchObject({
        status: "processing",
        code: "awaiting_origin_verification",
        listingId: id,
      });
      await catalog.checkOrigins();
      expect(await store.get(id)).toMatchObject({ state: "quarantined", version: 2 });

      const changed = await catalog.record(settledPayment({ url, payTo, amount: "20000" }));
      expect(changed).toMatchObject({ status: "processing", code: "awaiting_origin_verification" });
      origin({ url, payTo, amount: "20000" });
      await catalog.checkOrigins();
      expect(await store.get(id)).toMatchObject({
        owner: payTo,
        state: "published",
        trust: "origin_verified",
        version: 3,
      });
      expect((await store.list({ payTo, limit: 100, offset: 0 })).items.flat().map((l) => l.id)).toEqual([
        id,
      ]);
      expect((await store.versions(id)).map((v) => [v.cause, v.state])).toEqual([
        ["settlement", "pending"],
        ["quarantine", "quarantined"],
        ["origin_verification", "published"],
      ]);
    });

    it("republishes a quarantined listing under a different payTo that its origin names", async () => {
      const { catalog, store } = await setup();
      const url = uniqueUrl();
      const newOwner = randomAddress();
      const first = await catalog.record(settledPayment({ url, payTo: randomAddress() }));
      const id = first?.listingId ?? "";
      origin({ url, payTo: randomAddress() });
      await catalog.checkOrigins();
      expect(await store.get(id)).toMatchObject({ state: "quarantined" });

      const conflict = await catalog.record(settledPayment({ url, payTo: newOwner }));
      expect(conflict).toMatchObject({ status: "rejected", code: "bazaar_owner_conflict", listingId: id });
      origin({ url, payTo: newOwner });
      await catalog.checkOrigins();
      expect(await store.get(id)).toMatchObject({ owner: newOwner, state: "published", version: 3 });
      expect(
        (await store.list({ payTo: newOwner, limit: 100, offset: 0 })).items.flat().map((l) => l.id),
      ).toEqual([id]);
      expect((await store.versions(id)).at(-1)).toMatchObject({
        cause: "ownership_transfer",
        state: "published",
      });
    });

    it("transfers ownership only when the origin names the new payTo", async () => {
      const { catalog, store } = await setup();
      const url = uniqueUrl();
      const oldOwner = randomAddress();
      const newOwner = randomAddress();
      const first = await catalog.record(settledPayment({ url, payTo: oldOwner }));
      await catalog.record(settledPayment({ url, payTo: newOwner }));
      origin({ url, payTo: newOwner });
      await catalog.checkOrigins();
      const listing = await store.get(first?.listingId ?? "");
      expect(listing).toMatchObject({ owner: newOwner, trust: "origin_verified", state: "published" });
      expect((await store.versions(first?.listingId ?? "")).at(-1)?.cause).toBe("ownership_transfer");
    });

    it("retries an unreachable or failing origin without changing the listing", async () => {
      const { catalog, store } = await setup();
      const unreachable = await catalog.record(settledPayment({ url: uniqueUrl() }));
      const failing = uniqueUrl();
      const erroring = await catalog.record(settledPayment({ url: failing }));
      origins.set(failing, { kind: "not_payment_required", status: 503 });
      expect(await catalog.checkOrigins()).toBe(0);
      expect(await store.dueOriginChecks(10)).toEqual([]);
      for (const outcome of [unreachable, erroring]) {
        expect(await store.get(outcome?.listingId ?? "")).toMatchObject({
          trust: "settled",
          state: "pending",
          version: 1,
        });
      }
    });

    it.each<[string, PaymentFixture, string]>([
      [
        "a schema with an external $ref",
        {
          extension: {
            info: { input: { type: "http", method: "GET" } },
            schema: { $ref: "https://evil.example/s.json" },
          },
        },
        "bazaar_schema_external_reference",
      ],
      [
        "info that fails its schema",
        {
          extension: {
            info: { input: { type: "http", method: "GET" } },
            schema: { type: "object", required: ["output"] },
          },
        },
        "bazaar_info_invalid",
      ],
      [
        "an unknown input type",
        { extension: { info: { input: { type: "ftp" } }, schema: { type: "object" } } },
        "bazaar_info_unsupported",
      ],
      ["a missing info", { extension: { schema: {} } }, "bazaar_extension_malformed"],
      ["a private host", { url: "https://10.0.0.8/api" }, "bazaar_resource_unsafe"],
      ["a loopback host", { url: "http://localhost:4021/api" }, "bazaar_resource_unsafe"],
      ["credentials in the URL", { url: "https://user:secret@api.example.com/x" }, "bazaar_resource_invalid"],
      ["a non-http scheme", { url: "file:///etc/passwd" }, "bazaar_resource_invalid"],
      [
        "plain http on pubnet",
        { url: "http://api.example.com/weather", network: "stellar:pubnet" },
        "bazaar_resource_invalid",
      ],
    ])("rejects %s with a coded, non-empty reason", async (_label, fixture, code) => {
      const { catalog } = await setup();
      const outcome = await catalog.record(settledPayment(fixture));
      expect(outcome).toMatchObject({ status: "rejected", code });
      expect(outcome?.rejectedReason?.trim()).not.toBe("");
    });

    it("catalogs only x402 version 2 payments", async () => {
      const { catalog } = await setup();
      const payment = settledPayment({ url: uniqueUrl() });
      expect(
        await catalog.record({ ...payment, payload: { ...payment.payload, x402Version: 1 } }),
      ).toMatchObject({ status: "rejected", code: "bazaar_unsupported_version" });
    });

    it("reports an unavailable store as a retryable outcome instead of throwing", async () => {
      const { store } = await create();
      const failing = new Proxy(store, {
        get: (target, property) =>
          property === "transaction"
            ? () => Promise.reject(new Error("store unavailable"))
            : (Reflect.get(target, property) as unknown),
      });
      const catalog = new Catalog({
        store: failing,
        sandbox,
        fetchOrigin: () => Promise.reject(new Error()),
      });
      expect(await catalog.record(settledPayment({ url: uniqueUrl() }))).toMatchObject({
        status: "rejected",
        code: "bazaar_catalog_unavailable",
      });
    });

    it("finishes cataloging a settlement that an interrupted process left queued", async () => {
      const { catalog, store } = await setup({ outboxGraceMs: 0 });
      const payment = settledPayment({ url: uniqueUrl() });
      // As if the process stopped right after queuing, before cataloging.
      await store.enqueueSettlement(payment, 0);
      expect(await catalog.processQueued()).toBe(1);
      expect(await store.claimSettlements(10, 60_000)).toEqual([]);
      expect(await catalog.record(payment)).toMatchObject({ status: "success", code: "recorded" });
    });

    it("clears a queued settlement once cataloging reached an outcome", async () => {
      const { catalog, store } = await setup({ outboxGraceMs: 0 });
      const outcome = await catalog.recordDurably(settledPayment({ url: uniqueUrl() }));
      expect(outcome).toMatchObject({ code: "awaiting_origin_verification" });
      expect(await store.claimSettlements(10, 60_000)).toEqual([]);
      const rejected = await catalog.recordDurably(settledPayment({ url: "https://10.0.0.8/api" }));
      expect(rejected).toMatchObject({ code: "bazaar_resource_unsafe" });
      expect(await store.claimSettlements(10, 60_000)).toEqual([]);
    });

    it("keeps a settlement queued while the catalog store cannot take it", async () => {
      const { store } = await create();
      const failing = new Proxy(store, {
        get: (target, property) =>
          property === "transaction"
            ? () => Promise.reject(new Error("store unavailable"))
            : (Reflect.get(target, property) as unknown),
      });
      const catalog = new Catalog({ store: failing, sandbox, outboxGraceMs: 0 });
      const payment = settledPayment({ url: uniqueUrl() });
      expect(await catalog.recordDurably(payment)).toMatchObject({ code: "bazaar_catalog_unavailable" });
      expect((await store.claimSettlements(10, 60_000)).map((queued) => queued.payment.transaction)).toEqual([
        payment.transaction,
      ]);
    });

    it("reports its background outcomes to an observer and counts listings by state", async () => {
      const outcomes: string[] = [];
      let factsFail = true;
      const { catalog, store } = await setup({
        outboxGraceMs: 0,
        observer: {
          outcome: (phase, status, code) => {
            outcomes.push(`${phase}:${status}:${code}`);
          },
        },
        assets: {
          describe: () =>
            factsFail
              ? Promise.reject(new Error("RPC unavailable"))
              : Promise.resolve({ symbol: "USDC", name: "USDC", decimals: 7 }),
          receivable: () => Promise.resolve(true),
        },
        stellarToml: () => Promise.resolve({ ok: false, reason: "no stellar.toml" }),
      });
      expect(await store.stats()).toEqual({
        listings: { pending: 0, published: 0, quarantined: 0 },
        queuedSettlements: 0,
      });

      await publish(catalog, { url: uniqueUrl() });
      expect(outcomes.splice(0)).toEqual(["origin_check:success:origin_confirmed"]);

      const disowned = uniqueUrl();
      origin({ url: disowned, payTo: randomAddress() });
      await catalog.record(settledPayment({ url: disowned }));
      await catalog.checkOrigins();
      expect(outcomes.splice(0)).toEqual(["origin_check:rejected:origin_withdrawn"]);

      await catalog.record(settledPayment({ url: uniqueUrl() }));
      await catalog.checkOrigins();
      expect(outcomes.splice(0)).toEqual(["origin_check:processing:origin_retry"]);

      await store.enqueueSettlement(settledPayment({ url: uniqueUrl() }), 0);
      expect(await store.stats()).toMatchObject({ queuedSettlements: 1 });
      await catalog.processQueued();
      expect(outcomes.splice(0)).toEqual(["outbox:processing:awaiting_origin_verification"]);

      await catalog.enrich();
      factsFail = false;
      await catalog.enrich();
      expect(outcomes.splice(0)).toEqual([
        "enrich:processing:facts_unavailable",
        "enrich:success:facts_refreshed",
      ]);

      expect(await store.stats()).toEqual({
        listings: { pending: 2, published: 1, quarantined: 1 },
        queuedSettlements: 0,
      });
    });

    it("never lets a throwing observer affect cataloging", async () => {
      const { catalog, store } = await setup({
        observer: {
          outcome: () => {
            throw new Error("observer failed");
          },
        },
      });
      const outcome = await publish(catalog, { url: uniqueUrl() });
      expect(await store.get(outcome?.listingId ?? "")).toMatchObject({ state: "published" });
    });

    it("rejects self-payments", async () => {
      const { catalog } = await setup();
      const account = randomAddress();
      expect(
        await catalog.record(settledPayment({ url: uniqueUrl(), payTo: account, payer: account })),
      ).toMatchObject({
        status: "rejected",
        code: "bazaar_self_payment",
      });
    });

    it("soft-drops invalid service metadata without failing the listing", async () => {
      const { catalog, store } = await setup();
      const outcome = await catalog.record(
        settledPayment({
          url: uniqueUrl(),
          serviceName: "A name that is far longer than thirty-two characters",
          tags: ["weather", "WEATHER", "\u0000bad", "forecast"],
          iconUrl: "http://127.0.0.1/icon.png",
        }),
      );
      expect(outcome).toMatchObject({ status: "processing", code: "awaiting_origin_verification" });
      expect(outcome?.dropped).toEqual(expect.arrayContaining(["serviceName", "iconUrl", "tags"]));
      const listing = await store.get(outcome?.listingId ?? "");
      expect(listing?.content.serviceName).toBeUndefined();
      expect(listing?.content.iconUrl).toBeUndefined();
      expect(listing?.content.tags).toEqual(["weather", "forecast"]);
    });

    it("uses a routeTemplate only when it is safe and matches the paid path", async () => {
      const { catalog, store } = await setup();
      const host = `https://api${String(++urlCounter)}.example.com`;
      const payTo = randomAddress();
      const templated = await catalog.record(
        settledPayment({ url: `${host}/users/42`, payTo, routeTemplate: "/users/:id" }),
      );
      expect((await store.get(templated?.listingId ?? ""))?.content.resource).toBe(`${host}/users/:id`);

      for (const template of ["/users/%2e%2e/admin", "/users/%252e%252e", "//evil.example/x", "/admin/:id"]) {
        const outcome = await catalog.record(
          settledPayment({ url: `${host}/users/43`, payTo, routeTemplate: template }),
        );
        expect(outcome?.dropped, template).toContain("routeTemplate");
        expect((await store.get(outcome?.listingId ?? ""))?.content.resource, template).toBe(
          `${host}/users/43`,
        );
      }
    });

    it("bounds how many listings one payTo may create per hour", async () => {
      const { catalog } = await setup({ maxNewListingsPerOwnerPerHour: 2 });
      const payTo = randomAddress();
      const outcomes = [];
      for (let i = 0; i < 3; i++) outcomes.push(await publish(catalog, { url: uniqueUrl(), payTo }));
      expect(outcomes.map((o) => o?.code)).toEqual([
        "awaiting_origin_verification",
        "awaiting_origin_verification",
        "bazaar_rate_limited",
      ]);
    });

    it("does not charge an owner's quota for listings other payers created and its origin never confirmed", async () => {
      const { catalog } = await setup({ maxNewListingsPerOwnerPerHour: 2 });
      const victim = randomAddress();
      for (let i = 0; i < 5; i++) {
        expect(
          (await catalog.record(settledPayment({ url: uniqueUrl("mcp"), payTo: victim, kind: "mcp" })))?.code,
        ).toBe("awaiting_origin_verification");
      }
      expect((await publish(catalog, { url: uniqueUrl(), payTo: victim }))?.code).toBe(
        "awaiting_origin_verification",
      );
    });

    it("hands each due origin check to one worker at a time, until its lease ends", async () => {
      const { catalog, store } = await setup();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push((await catalog.record(settledPayment({ url: uniqueUrl() })))?.listingId ?? "");
      }
      const [first, second] = await Promise.all([
        store.claimOriginChecks(10, 60_000),
        store.claimOriginChecks(10, 60_000),
      ]);
      expect([...first, ...second].map((check) => check.listingId).sort()).toEqual([...ids].sort());
      expect(await store.dueOriginChecks(10)).toEqual([]);

      // A claim whose lease has ended can be claimed again, by any worker.
      const next = await catalog.record(settledPayment({ url: uniqueUrl() }));
      expect((await store.claimOriginChecks(1, 1)).map((check) => check.listingId)).toEqual([
        next?.listingId,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await store.claimOriginChecks(1, 60_000)).map((check) => check.listingId)).toEqual([
        next?.listingId,
      ]);
    });

    it("keeps an origin check that was requested again while it was being fetched", async () => {
      const { catalog, store } = await setup();
      const url = uniqueUrl();
      const id = (await catalog.record(settledPayment({ url })))?.listingId ?? "";
      const [claimed] = await store.claimOriginChecks(1, 60_000);
      expect(claimed?.listingId).toBe(id);
      await store.transaction(id, (tx) => tx.requestOriginCheck(id, "changed", url));
      if (claimed === undefined) throw new Error("no claim");
      await store.completeOriginCheck(claimed);
      await store.deferOriginCheck(claimed, 60_000);
      expect((await store.dueOriginChecks(10)).map((check) => check.listingId)).toEqual([id]);
    });

    it("treats equivalent spellings of one URL as one listing", async () => {
      const { catalog } = await setup();
      const host = `https://api${String(++urlCounter)}.example.com`;
      const payTo = randomAddress();
      const outcomes = [];
      for (const path of ["/api", "/%61pi", "/v1/%2e%2e/api"]) {
        outcomes.push(await catalog.record(settledPayment({ url: `${host}${path}`, payTo })));
      }
      expect(new Set(outcomes.map((o) => o?.listingId)).size).toBe(1);
    });

    it("keeps a route-template listing unchanged when another path of the route is paid", async () => {
      const { catalog, store } = await setup();
      const host = `https://api${String(++urlCounter)}.example.com`;
      const payTo = randomAddress();
      const first = await publish(catalog, {
        url: `${host}/users/42`,
        payTo,
        routeTemplate: "/users/:id",
        pathParams: { id: "42" },
      });
      const id = first?.listingId ?? "";
      const version = (await store.get(id))?.version;
      const other = await catalog.record(
        settledPayment({
          url: `${host}/users/7`,
          payTo,
          routeTemplate: "/users/:id",
          pathParams: { id: "7" },
        }),
      );
      expect(other).toMatchObject({ status: "success", code: "recorded", listingId: id });
      expect(await store.dueOriginChecks(10)).toEqual([]);
      expect((await store.get(id))?.version).toBe(version);
    });

    it("bounds the new listings one payer's settlements may create per hour", async () => {
      const { catalog } = await setup({ maxNewListingsPerPayerPerHour: 2 });
      const payer = randomAddress();
      const codes = [];
      for (let i = 0; i < 3; i++)
        codes.push((await catalog.record(settledPayment({ url: uniqueUrl(), payer })))?.code);
      expect(codes).toEqual([
        "awaiting_origin_verification",
        "awaiting_origin_verification",
        "bazaar_rate_limited",
      ]);
    });

    it("bounds the new listings the whole catalog accepts per hour", async () => {
      const { catalog } = await setup({ maxNewListingsPerHour: 2 });
      const codes = [];
      for (let i = 0; i < 3; i++)
        codes.push((await catalog.record(settledPayment({ url: uniqueUrl() })))?.code);
      expect(codes.at(-1)).toBe("bazaar_rate_limited");
    });

    it("does not charge an owner's quota for listings its origin withdrew", async () => {
      const { catalog } = await setup({ maxNewListingsPerOwnerPerHour: 1 });
      const payTo = randomAddress();
      const fake = uniqueUrl();
      await catalog.record(settledPayment({ url: fake, payTo }));
      origins.set(fake, { kind: "not_payment_required", status: 200 });
      await catalog.checkOrigins();
      expect((await catalog.record(settledPayment({ url: uniqueUrl(), payTo })))?.code).toBe(
        "awaiting_origin_verification",
      );
    });

    it("paces origin requests to one host without spending a retry", async () => {
      const fetched: string[] = [];
      const { catalog, store } = await setup({
        originChecksPerHostPerMinute: 2,
        fetchOrigin: (url) => {
          fetched.push(url);
          return Promise.resolve({ kind: "unreachable", reason: "down" });
        },
      });
      const host = `https://api${String(++urlCounter)}.example.com`;
      for (const path of ["/a", "/b", "/c"]) await catalog.record(settledPayment({ url: `${host}${path}` }));
      await catalog.checkOrigins();
      expect(fetched).toHaveLength(2);
      // The third check stays claimed for now and has spent no attempt.
      expect(await store.dueOriginChecks(10)).toEqual([]);
    });

    it("filters within one payment option and pages in a stable order", async () => {
      const { catalog, store } = await setup();
      const payTo = randomAddress();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const outcome = await publish(catalog, { url: uniqueUrl(), payTo });
        ids.push(outcome?.listingId ?? "");
      }
      await publish(catalog, { url: uniqueUrl(), payTo, network: "stellar:pubnet" });

      const page1 = await store.list({ payTo, network: "stellar:testnet", limit: 2, offset: 0 });
      const page2 = await store.list({ payTo, network: "stellar:testnet", limit: 2, offset: 2 });
      const page3 = await store.list({ payTo, network: "stellar:testnet", limit: 2, offset: 4 });
      expect(page1.total).toBe(5);
      expect([...page1.items, ...page2.items, ...page3.items].flat().map((l) => l.id)).toEqual(ids);

      expect((await store.list({ payTo, scheme: "exact", limit: 100, offset: 0 })).total).toBe(6);
      expect((await store.list({ payTo, scheme: "upto", limit: 100, offset: 0 })).total).toBe(0);
      expect((await store.list({ payTo, network: "eip155:8453", limit: 100, offset: 0 })).total).toBe(0);
      expect((await store.list({ payTo, extensions: ["bazaar"], limit: 100, offset: 0 })).total).toBe(6);
      expect(
        (await store.list({ payTo, extensions: ["bazaar", "other"], limit: 100, offset: 0 })).total,
      ).toBe(0);
      expect((await store.list({ payTo, type: "mcp", limit: 100, offset: 0 })).total).toBe(0);
    });

    it("shows one resource sold on several networks as one resource, each network its own listing", async () => {
      const { catalog, store } = await setup();
      const url = uniqueUrl();
      const testnetPayTo = randomAddress();
      const pubnetPayTo = randomAddress();
      const testnet = settledPayment({ url, payTo: testnetPayTo });
      const pubnet = settledPayment({ url, payTo: pubnetPayTo, network: "stellar:pubnet" });
      // The seller's own 402 offers both networks, each paid to its own account.
      origins.set(url, {
        kind: "payment_required",
        paymentRequired: {
          ...paymentRequiredFor({ url }),
          accepts: [testnet.requirements, pubnet.requirements],
        },
      });
      const first = await catalog.record(testnet);
      const second = await catalog.record(pubnet);
      await catalog.checkOrigins();
      expect(first?.listingId).not.toBe(second?.listingId);
      expect(await store.get(first?.listingId ?? "")).toMatchObject({
        owner: testnetPayTo,
        state: "published",
      });
      expect(await store.get(second?.listingId ?? "")).toMatchObject({
        owner: pubnetPayTo,
        state: "published",
      });

      const all = await store.list({ limit: 100, offset: 0 });
      const resource = all.items.find(([listing]) => listing.content.resource === url);
      expect(resource?.map((listing) => listing.id)).toEqual([first?.listingId, second?.listingId]);
      expect(resource?.map((listing) => listing.content.accepts.map((option) => option.network))).toEqual([
        ["stellar:testnet"],
        ["stellar:pubnet"],
      ]);

      // Filtered, a resource keeps only the listings, and the options, that matched.
      const onPubnet = await store.list({
        network: "stellar:pubnet",
        payTo: pubnetPayTo,
        limit: 100,
        offset: 0,
      });
      expect(onPubnet.total).toBe(1);
      expect(onPubnet.items.flat().map((listing) => listing.id)).toEqual([second?.listingId]);
      expect(onPubnet.items.flat().flatMap((listing) => listing.content.accepts)).toEqual([
        expect.objectContaining({ network: "stellar:pubnet", payTo: pubnetPayTo }),
      ]);
      expect(
        (await store.list({ payTo: testnetPayTo, network: "stellar:pubnet", limit: 100, offset: 0 })).total,
      ).toBe(0);
    });

    it("pages resources, not listings, however many networks each is sold on", async () => {
      const { catalog, store } = await setup();
      const payTo = randomAddress();
      const urls = [uniqueUrl(), uniqueUrl(), uniqueUrl()];
      for (const url of urls) {
        const testnet = settledPayment({ url, payTo });
        const pubnet = settledPayment({ url, payTo, network: "stellar:pubnet" });
        origins.set(url, {
          kind: "payment_required",
          paymentRequired: {
            ...paymentRequiredFor({ url }),
            accepts: [testnet.requirements, pubnet.requirements],
          },
        });
        await catalog.record(testnet);
        await catalog.record(pubnet);
      }
      await catalog.checkOrigins();
      const first = await store.list({ payTo, limit: 2, offset: 0 });
      const second = await store.list({ payTo, limit: 2, offset: 2 });
      expect(first.total).toBe(3);
      expect([...first.items, ...second.items].map(([listing]) => listing.content.resource)).toEqual(urls);
      expect([...first.items, ...second.items].map((resource) => resource.length)).toEqual([2, 2, 2]);
    });

    it("lists the other extensions a resource's own 402 declares, and filters on them", async () => {
      const { catalog, store } = await setup();
      const payTo = randomAddress();
      const url = uniqueUrl();
      const extensions = {
        "sign-in-with-x": { info: { nonce: "a1b2" } },
        "payment-identifier": { info: { required: false } },
        "not a key!": {},
      };
      const outcome = await publish(catalog, { url, payTo, extensions });
      expect(outcome?.dropped).toContain("extensions");
      const listing = await store.get(outcome?.listingId ?? "");
      expect(listing?.content.extensions).toEqual(["payment-identifier", "sign-in-with-x"]);
      const count = async (keys: string[]) =>
        (await store.list({ payTo, extensions: keys, limit: 100, offset: 0 })).total;
      expect(await count(["bazaar"])).toBe(1);
      expect(await count(["bazaar", "payment-identifier"])).toBe(1);
      expect(await count(["sign-in-with-x", "payment-identifier"])).toBe(1);
      expect(await count(["offer-and-receipt"])).toBe(0);

      // The origin, not the buyer's echo, decides: a key the 402 stops declaring leaves the listing.
      origin({ url, payTo, extensions: { "payment-identifier": {} } });
      await catalog.record(settledPayment({ url, payTo, extensions: { "payment-identifier": {} } }));
      await catalog.checkOrigins();
      expect((await store.get(outcome?.listingId ?? ""))?.content.extensions).toEqual(["payment-identifier"]);
      expect(await count(["sign-in-with-x"])).toBe(0);
    });

    it("bumps the revision with every published change and reads it together with the listings", async () => {
      const { catalog, store } = await setup();
      const before = await store.published();
      expect(before.revision).toBe(await store.revision());
      const outcome = await publish(catalog, { url: uniqueUrl(), payTo: randomAddress() });
      const after = await store.published();
      expect(after.revision).toBeGreaterThan(before.revision);
      expect(after.revision).toBe(await store.revision());
      expect(after.listings.map((listing) => listing.id)).toContain(outcome?.listingId);
    });

    it("never lets a reader see a revision without its change, or a change without its revision", async () => {
      const { store } = await setup();
      const payment = settledPayment({ url: uniqueUrl(), payTo: randomAddress() });
      let reads: { revision: number; listings: number } | undefined;
      const identity = {
        network: "stellar:testnet",
        kind: "http" as const,
        resource: payment.payload.resource?.url ?? "",
        method: "GET",
        toolName: "",
        scope: "",
      };
      const content = {
        resource: identity.resource,
        kind: "http" as const,
        method: "GET",
        bazaar: { info: {}, schema: {} },
        accepts: [],
      };
      const now = new Date();
      const listing = {
        id: randomUUID(),
        sequence: 0,
        identity,
        owner: randomAddress(),
        trust: "settled" as const,
        state: "published" as const,
        version: 1,
        content,
        contentHash: "x",
        firstCatalogedAt: now,
        listedAt: now,
        lastUpdated: now,
        lastSettledAt: now,
        settlements: 1,
      };
      const baseline = await store.published();
      await store.transaction(identity, async (tx) => {
        await tx.insert(listing, {
          listingId: listing.id,
          version: 1,
          createdAt: now,
          cause: "settlement",
          owner: listing.owner,
          trust: "settled",
          state: "published",
          content,
        });
        // A read from outside sees the change whole or not at all: never its revision without it.
        const inside = await store.published();
        reads = { revision: inside.revision, listings: inside.listings.length };
      });
      const after = await store.published();
      expect(after.revision).toBeGreaterThan(baseline.revision);
      expect([
        { revision: baseline.revision, listings: baseline.listings.length },
        { revision: after.revision, listings: after.listings.length },
      ]).toContainEqual(reads);
    });

    it("pins a pagination with asOf, so listings published meanwhile never shift its pages", async () => {
      const { catalog, store } = await setup();
      const payTo = randomAddress();
      const ids: string[] = [];
      for (let i = 0; i < 4; i++)
        ids.push((await publish(catalog, { url: uniqueUrl(), payTo }))?.listingId ?? "");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const asOf = new Date();
      const first = await store.list({ payTo, asOf, limit: 2, offset: 0 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const late = await publish(catalog, { url: uniqueUrl(), payTo });
      const second = await store.list({ payTo, asOf, limit: 2, offset: 2 });
      expect([...first.items, ...second.items].flat().map((l) => l.id)).toEqual(ids);
      expect(second.total).toBe(4);
      // Unpinned, the new listing appears at the end.
      expect((await store.list({ payTo, limit: 100, offset: 0 })).items.flat().map((l) => l.id)).toEqual([
        ...ids,
        late?.listingId,
      ]);
    });

    it("records each payment option's token facts and whether its payTo can receive it", async () => {
      const receivers = new Set<string>();
      const { catalog, store } = await setup({
        assets: {
          describe: (_network, contract) =>
            Promise.resolve({ symbol: "USDC", name: `USDC:${contract.slice(0, 4)}`, decimals: 7 }),
          receivable: (_network, _contract, payTo) => Promise.resolve(receivers.has(payTo)),
        },
        stellarToml: () => Promise.resolve({ ok: false, reason: "no stellar.toml" }),
      });
      const payTo = randomAddress();
      receivers.add(payTo);
      const outcome = await publish(catalog, { url: uniqueUrl(), payTo });
      expect(await catalog.enrich()).toBeGreaterThanOrEqual(1);
      const listing = await store.get(outcome?.listingId ?? "");
      expect(listing?.facts?.options).toEqual([
        { symbol: "USDC", name: `USDC:${FIXTURE_ASSET.slice(0, 4)}`, decimals: 7, receivable: true },
      ]);
      expect(listing?.facts?.domain).toMatchObject({ claimsOwner: false });
      expect(listing?.trust).toBe("origin_verified");
      // Fresh facts are not read again.
      expect((await store.staleFacts(10, new Date(Date.now() - 60_000))).map((l) => l.id)).not.toContain(
        listing?.id,
      );
    });

    it("raises trust to domain_verified while the domain and the owner name each other", async () => {
      const claimed = new Set<string>();
      const homeDomains = new Map<string, string>();
      let clock = Date.now();
      const { catalog, store } = await setup({
        now: () => new Date(clock),
        stellarToml: () => Promise.resolve({ ok: true, accounts: [...claimed] }),
        homeDomain: (_network, account) => Promise.resolve(homeDomains.get(account)),
      });
      const payTo = randomAddress();
      const url = uniqueUrl();
      const id = (await publish(catalog, { url, payTo }))?.listingId ?? "";
      claimed.add(payTo);
      homeDomains.set(payTo, new URL(url).hostname);
      await catalog.enrich();
      expect(await store.get(id)).toMatchObject({ trust: "domain_verified", version: 3 });
      expect((await store.versions(id)).at(-1)).toMatchObject({
        cause: "domain_verification",
        trust: "domain_verified",
      });

      // An origin check for the same owner keeps the domain claim.
      await store.transaction(id, (tx) => tx.requestOriginCheck(id, "changed", url));
      await catalog.checkOrigins();
      expect((await store.get(id))?.trust).toBe("domain_verified");

      // Hours later the domain no longer lists the owner: trust falls back to origin_verified.
      claimed.clear();
      clock += 7 * 3_600_000;
      await catalog.enrich();
      expect(await store.get(id)).toMatchObject({ trust: "origin_verified", version: 4 });
    });

    it("never raises trust on a one-way claim: a domain listing an account that does not name it", async () => {
      // Anyone can list a reputable seller's account in their own stellar.toml.
      const victim = randomAddress();
      const { catalog, store } = await setup({
        stellarToml: () => Promise.resolve({ ok: true, accounts: [victim] }),
        homeDomain: () => Promise.resolve("victim.example.com"),
      });
      const id =
        (await publish(catalog, { url: uniqueUrl("mcp"), payTo: victim, kind: "mcp" }))?.listingId ?? "";
      await catalog.enrich();
      expect((await store.get(id))?.trust).toBe("origin_verified");
      expect((await store.get(id))?.facts?.domain).toMatchObject({
        claimsOwner: true,
        homeDomainMatches: false,
      });
    });

    it("lets a domain vouch for an MCP tool listed under its host", async () => {
      const claimed = new Set<string>();
      const { catalog, store } = await setup({
        stellarToml: () => Promise.resolve({ ok: true, accounts: [...claimed] }),
        homeDomain: (_network, account) => Promise.resolve(claimed.has(account) ? host : undefined),
      });
      const payTo = randomAddress();
      claimed.add(payTo);
      const endpoint = uniqueUrl("mcp");
      const host = new URL(endpoint).hostname;
      const id =
        (await catalog.record(settledPayment({ url: endpoint, payTo, kind: "mcp" })))?.listingId ?? "";
      // Not yet confirmed by the tool itself: pending, so no domain can vouch for it.
      await catalog.enrich();
      expect(await store.get(id)).toMatchObject({ state: "pending", trust: "settled" });
      origin({ url: endpoint, payTo, kind: "mcp" });
      await catalog.checkOrigins();
      await catalog.enrich();
      expect((await store.get(id))?.trust).toBe("domain_verified");
      expect((await store.get(id))?.facts?.domain).toMatchObject({
        claimsOwner: true,
        homeDomainMatches: true,
      });
      // A tool under an mcp:// URL has no domain to ask.
      const scoped =
        (
          await catalog.record(
            settledPayment({ url: `mcp://tool/t${String(++urlCounter)}`, payTo, kind: "mcp" }),
          )
        )?.listingId ?? "";
      await catalog.enrich();
      expect((await store.get(scoped))?.trust).toBe("settled");
    });

    it("matches an M… payTo exactly and a G… payTo across its muxed addresses", async () => {
      const { catalog, store } = await setup();
      const account = randomAddress();
      const [first, second] = [muxedAddress(account, 1n), muxedAddress(account, 2n)];
      for (const payTo of [account, first, second]) {
        await publish(catalog, { url: uniqueUrl("mcp"), payTo, kind: "mcp" });
      }
      const count = async (payTo: string) => (await store.list({ payTo, limit: 100, offset: 0 })).total;
      expect(await count(account)).toBe(3);
      expect(await count(first)).toBe(1);
      expect(await count(second)).toBe(1);
      expect(await count(muxedAddress(account, 3n))).toBe(0);
    });
  });
}
