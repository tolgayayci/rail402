/**
 * The interoperability suite, run against a catalog store: the memory store in the unit project and
 * Postgres in the integration project.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { withBazaar } from "@x402/extensions/bazaar";
import { SchemaSandbox, extensionResponsesHeader, type CatalogStore } from "@rail402.dev/bazaar";
import {
  buildFixtures,
  catalogFixtures,
  type PublishedItem,
  type RoundTrip,
  differences,
} from "../src/index.ts";

const FACILITATOR = "https://facilitator.example";

export function interopSuite(name: string, create: () => Promise<CatalogStore>): void {
  const fixtures = buildFixtures();
  const sandbox = new SchemaSandbox();
  let trip: RoundTrip;

  beforeAll(async () => {
    trip = await catalogFixtures(await create(), sandbox, fixtures);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await sandbox.close();
  });

  const get = async <T>(path: string): Promise<T> => {
    const response = await trip.app.request(path);
    expect(response.status, path).toBe(200);
    return (await response.json()) as T;
  };
  const list = async (query = "") =>
    (await get<{ items: PublishedItem[] }>(`/discovery/resources?limit=100${query}`)).items;
  const itemFor = (items: readonly PublishedItem[], resource: string) =>
    items.find((item) => item.resource === resource);

  describe(`${name}: Bazaar interoperability fixtures`, () => {
    it("catalogs every fixture from its settlement and origin check", () => {
      for (const fixture of fixtures) {
        expect(trip.outcomes.get(fixture.id), fixture.id).toMatchObject({ status: "processing" });
      }
    });

    it.each(buildFixtures().map((fixture) => [fixture.id, fixture] as const))(
      "returns %s from /discovery/resources with its specified fields unchanged",
      async (_id, fixture) => {
        const item = itemFor(await list(), fixture.expected.resource);
        expect(item, fixture.id).toBeDefined();
        if (item !== undefined) expect(differences(item, fixture)).toEqual([]);
      },
    );

    it.each(buildFixtures().map((fixture) => [fixture.id, fixture] as const))(
      "returns %s from /discovery/search with its specified fields unchanged",
      async (_id, fixture) => {
        const resource = fixture.paymentRequired.resource as unknown as { description: string };
        const query = encodeURIComponent(resource.description);
        const found = await get<{ resources: PublishedItem[] }>(`/discovery/search?query=${query}&limit=50`);
        const item = itemFor(found.resources, fixture.expected.resource);
        expect(item, fixture.id).toBeDefined();
        if (item !== undefined) expect(differences(item, fixture)).toEqual([]);
      },
    );

    it("returns each fixture exactly when every filter holds for it", async () => {
      const otherNetwork = {
        "stellar:testnet": "stellar:pubnet",
        "stellar:pubnet": "stellar:testnet",
      } as const;
      for (const fixture of fixtures) {
        const [option] = fixture.paymentRequired.accepts;
        if (option === undefined) continue;
        const declared = Object.keys(fixture.paymentRequired.extensions ?? {});
        const holds = [
          `type=${fixture.expected.type}`,
          `network=${option.network}`,
          `payTo=${option.payTo}`,
          `scheme=${option.scheme}`,
          `extensions=${declared.join(",")}`,
          `type=${fixture.expected.type}&network=${option.network}&payTo=${option.payTo}&scheme=${option.scheme}`,
        ];
        const fails = [
          `type=${fixture.expected.type === "http" ? "mcp" : "http"}`,
          `network=${otherNetwork[option.network as keyof typeof otherNetwork]}`,
          `payTo=${fixtures.find((other) => other.id !== fixture.id)?.paymentRequired.accepts[0]?.payTo ?? ""}`,
          `scheme=${option.scheme === "exact" ? "upto" : "exact"}`,
          `extensions=${[...declared, "not-declared"].join(",")}`,
        ];
        for (const query of holds) {
          expect(
            itemFor(await list(`&${query}`), fixture.expected.resource),
            `${fixture.id} ${query}`,
          ).toBeDefined();
          const searched = await get<{ resources: PublishedItem[] }>(
            `/discovery/search?query=${encodeURIComponent(fixture.paymentRequired.resource.description ?? "")}&${query}`,
          );
          expect(
            itemFor(searched.resources, fixture.expected.resource),
            `search ${fixture.id} ${query}`,
          ).toBeDefined();
        }
        for (const query of fails) {
          expect(
            itemFor(await list(`&${query}`), fixture.expected.resource),
            `${fixture.id} ${query}`,
          ).toBeUndefined();
        }
      }
    });

    it("keeps the declared differences, and only those", async () => {
      const items = await list();
      // (a) Other extensions are republished by key, with an empty object.
      const other = itemFor(items, "https://quotes.example/price");
      expect(other?.extensions["payment-identifier"]).toEqual({});
      // (b) An upto listing shows the cap its seller offers, not the amount a settlement moved.
      const upto = itemFor(items, "https://history.example/history");
      expect(upto?.accepts[0]).toMatchObject({ scheme: "upto", amount: "100000" });
      // (d) Rail402's own facts live under `rail402` only.
      for (const item of items) {
        expect(Object.keys(item).filter((key) => key === "rail402")).toEqual(["rail402"]);
      }
    });

    it("is parsed by the upstream withBazaar client, list and search", async () => {
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        expect(url.origin).toBe(FACILITATOR);
        return trip.app.request(`${url.pathname}${url.search}`, init);
      });
      const client = withBazaar(new HTTPFacilitatorClient({ url: FACILITATOR }));
      const listed = await client.extensions.bazaar.listResources({ limit: 100 });
      expect(listed.items.map((item) => item.resource).sort()).toEqual(
        fixtures.map((fixture) => fixture.expected.resource).sort(),
      );
      const pubnet = await client.extensions.bazaar.listResources({
        network: "stellar:pubnet",
        type: "http",
      });
      expect(pubnet.items.map((item) => item.resource).sort()).toEqual([
        "https://quotes.example/price",
        "https://search.example/search",
      ]);
      const searched = await client.extensions.bazaar.search({ query: "financial analysis", type: "mcp" });
      expect(searched.resources.map((item) => item.resource)).toEqual(["https://tools.example/mcp"]);
      expect(searched.pagination?.limit).toBe(searched.resources.length);
      vi.unstubAllGlobals();
    });

    it("reports cataloging outcomes in EXTENSION-RESPONSES in the specified shape", () => {
      const decode = (header: string) =>
        (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { bazaar: Record<string, unknown> })
          .bazaar;
      for (const outcome of trip.outcomes.values()) {
        const bazaar = decode(extensionResponsesHeader(outcome));
        expect(["success", "processing", "rejected"]).toContain(bazaar["status"]);
        expect("rejectedReason" in bazaar).toBe(bazaar["status"] === "rejected");
      }
      const rejected = decode(
        extensionResponsesHeader({
          status: "rejected",
          code: "bazaar_info_invalid",
          rejectedReason: "info failed schema validation",
        }),
      );
      expect(rejected).toMatchObject({ status: "rejected", rejectedReason: "info failed schema validation" });
    });
  });
}
