import { afterAll, describe, expect, it } from "vitest";
import {
  Catalog,
  MAX_EXTENSION_RESPONSES_BYTES,
  MemoryCatalogStore,
  SchemaSandbox,
  extensionResponsesHeader,
  settledPayment,
} from "@rail402.dev/bazaar";
import { catalogSuite } from "@rail402.dev/bazaar/testing";

catalogSuite("memory", () => Promise.resolve({ store: new MemoryCatalogStore() }));

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
});
