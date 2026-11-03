import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { resolvePolicy as resolveEgress } from "@rail402.dev/safe-fetch";
import { TESTNET } from "@rail402.dev/stellar";
import {
  DiscoveryClient,
  KeyHolder,
  bindingFor,
  createBuyer,
  exactScheme,
  expandRoute,
  payableHit,
  routeParams,
  toHit,
  type DiscoveryItem,
} from "@rail402.dev/sdk";
import { testPolicy, usdc } from "./helpers.ts";

const owner = Keypair.random().publicKey();
const LISTING = "96eab768-0f2c-4a51-9d3b-0c1a2b3c4d5e";
const MCP_LISTING = "0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8";

function item(
  overrides: Partial<DiscoveryItem> = {},
  rail402: Partial<DiscoveryItem["rail402"]> = {},
): DiscoveryItem {
  return {
    resource: "https://weather.example/users/:id",
    type: "http",
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: TESTNET,
        asset: usdc,
        payTo: owner,
        amount: "10000",
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
      {
        scheme: "exact",
        network: "stellar:pubnet",
        asset: usdc,
        payTo: owner,
        amount: "10000",
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
    ],
    lastUpdated: "2026-09-30T00:00:00.000Z",
    description: "Current weather‮ for a city",
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { units: "metric" } },
          output: { example: { t: 21 } },
        },
        schema: { properties: { input: {} } },
        routeTemplate: "/users/:id",
      },
    },
    rail402: {
      method: "GET",
      trust: "origin_verified",
      settlements: 3,
      listings: [
        { id: LISTING, network: TESTNET, version: 2, trust: "origin_verified", owner, settlements: 3 },
        {
          id: "11111111-2222-4333-8444-555555555555",
          network: "stellar:pubnet",
          version: 1,
          trust: "settled",
          owner,
          settlements: 0,
        },
      ],
      options: [
        { listing: LISTING, symbol: "USDC", decimals: 7, receivable: true },
        { listing: "11111111-2222-4333-8444-555555555555", symbol: "USDC", decimals: 7 },
      ],
      ...rail402,
    },
    ...overrides,
  };
}

const mcpItem = item(
  {
    resource: "https://tools.example/mcp",
    type: "mcp",
    accepts: [
      {
        scheme: "exact",
        network: TESTNET,
        asset: usdc,
        payTo: owner,
        amount: "20000",
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
    ],
    extensions: {
      bazaar: {
        info: {
          input: { type: "mcp", toolName: "forecast", transport: "sse", inputSchema: { type: "object" } },
        },
        schema: {},
      },
    },
  },
  {
    method: undefined,
    toolName: "forecast",
    listings: [{ id: MCP_LISTING, network: TESTNET, version: 1, trust: "settled", owner, settlements: 1 }],
    options: [{ listing: MCP_LISTING, decimals: 7 }],
  },
);

describe("discovery", () => {
  let server: Server;
  let url = "";
  const seen: string[] = [];
  const listings: Record<string, unknown> = {};
  /** Error answers by path, ahead of everything else. */
  const failures: Record<string, [number, unknown]> = {};

  beforeAll(async () => {
    const route = (requestUrl: string): [number, unknown] => {
      seen.push(requestUrl);
      const { pathname, searchParams } = new URL(requestUrl, "http://x");
      if (pathname === "/discovery/search") {
        const query = searchParams.get("query");
        if (query === "boom") return [503, { error: { code: "unavailable", reason: "down" } }];
        if (query === "bad") {
          return [400, { error: { code: "discovery_invalid_parameter", reason: "Parameter limit is bad." } }];
        }
        if (query === "odd") return [200, { resources: "nope" }];
        return [
          200,
          {
            x402Version: 2,
            resources: [item(), mcpItem],
            partialResults: true,
            pagination: { limit: 10, cursor: "next-page" },
            rail402: { method: "bm25", recognised: [] },
          },
        ];
      }
      if (pathname === "/discovery/resources") {
        return [
          200,
          {
            x402Version: 2,
            items: [item()],
            pagination: { limit: 20, offset: 0, total: 1, asOf: "2026-09-30T00:00:00.000Z" },
          },
        ];
      }
      const failure = failures[pathname];
      if (failure !== undefined) return failure;
      const after = searchParams.get("after");
      const listing =
        listings[
          `${pathname.replace("/discovery/resources/", "").replace("/discovery/", "")}${after === null ? "" : `?after=${after}`}`
        ];
      if (listing === undefined) {
        return [404, { error: { code: "discovery_listing_not_found", reason: "No listing." } }];
      }
      return [200, listing];
    };
    server = createServer((request, response) => {
      const [status, body] = route(request.url ?? "/");
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("searches with the buyer's network and filters", async () => {
    const client = new DiscoveryClient({ baseUrl: `${url}/`, network: TESTNET });
    const page = await client.search("weather", {
      type: "http",
      maxPrice: "0.01",
      limit: 500,
      extensions: ["bazaar"],
    });
    expect(page).toMatchObject({ nextCursor: "next-page", partialResults: true, method: "bm25" });
    expect(page.items).toHaveLength(2);
    const query = new URL(seen.at(-1) ?? "", "http://x").searchParams;
    expect(Object.fromEntries(query)).toEqual({
      query: "weather",
      network: TESTNET,
      type: "http",
      maxPrice: "0.01",
      extensions: "bazaar",
      limit: "50",
    });
  });

  it("maps Bazaar failures to codes", async () => {
    const client = new DiscoveryClient({ baseUrl: url, network: TESTNET });
    await expect(client.search("boom")).rejects.toMatchObject({
      code: "discovery_unavailable",
      retryable: true,
    });
    await expect(client.search("bad")).rejects.toMatchObject({
      code: "discovery_rejected",
      details: { upstream: { code: "discovery_invalid_parameter" } },
    });
    await expect(client.search("odd")).rejects.toMatchObject({ code: "discovery_rejected" });
    await expect(client.listing("not-an-id")).rejects.toMatchObject({ code: "listing_not_found" });
    await expect(client.listing(LISTING.replace("9", "8"))).rejects.toMatchObject({
      code: "listing_not_found",
    });
    const down = new DiscoveryClient({ baseUrl: "http://127.0.0.1:1", network: TESTNET });
    await expect(down.list()).rejects.toMatchObject({ code: "discovery_unavailable" });
  });

  it("reads a listing's version history", async () => {
    const version = {
      version: 1,
      createdAt: "2026-09-30T00:00:00.000Z",
      cause: "settlement",
      transaction: "e".repeat(64),
      owner,
      trust: "settled",
      state: "published",
      content: { accepts: [] },
    };
    listings[`${LISTING}/versions`] = { x402Version: 2, id: LISTING, versions: [version] };
    const client = new DiscoveryClient({ baseUrl: url, network: TESTNET });
    await expect(client.versions(LISTING)).resolves.toEqual([version]);
    await expect(client.versions(MCP_LISTING)).rejects.toMatchObject({ code: "listing_not_found" });
    await expect(client.versions("../x")).rejects.toMatchObject({ code: "listing_not_found" });
    listings[`${LISTING}/versions`] = { id: LISTING, versions: [{ version: "one" }] };
    await expect(client.versions(LISTING)).rejects.toMatchObject({ code: "discovery_rejected" });
  });

  it("reads usage: settlement links, a listing's usage and a seller's, on the client's network", async () => {
    const ref = {
      id: LISTING,
      type: "http",
      resource: "https://weather.example/now",
      method: "GET",
      payTo: owner,
      scheme: "exact",
      amount: "10000",
      asset: usdc,
      network: TESTNET,
      lastUpdated: "2026-09-30T00:00:00.000Z",
    };
    const [paid, other] = ["a".repeat(64), "b".repeat(64)];
    const links = {
      items: [{ transaction: paid, listing: ref, observedAt: "2026-09-30T00:00:01.000Z" }],
      asOf: "2026-09-30T00:01:00.000Z",
    };
    listings["settlements"] = links;
    const usage = {
      listingId: LISTING,
      payments: 1,
      payers: 1,
      firstObservedAt: "2026-09-30T00:00:01.000Z",
      lastObservedAt: "2026-09-30T00:00:01.000Z",
      recent: [
        {
          transaction: paid,
          payer: owner,
          asset: usdc,
          amount: "10000",
          observedAt: "2026-09-30T00:00:01.000Z",
        },
      ],
    };
    listings[`${LISTING}/usage`] = usage;
    const seller = {
      payTo: owner,
      totals: { payments: 1, payers: 1 },
      listings: [{ listing: ref, payments: 1, payers: 1, lastObservedAt: "2026-09-30T00:00:01.000Z" }],
      truncated: false,
    };
    listings[`sellers/${owner}/usage`] = seller;
    const client = new DiscoveryClient({ baseUrl: url, network: TESTNET });

    seen.length = 0;
    await expect(client.settlements([paid, other, paid])).resolves.toEqual(links);
    expect(seen).toEqual([
      `/discovery/settlements?network=stellar%3Atestnet&transactions=${paid}%2C${other}`,
    ]);
    await expect(client.usage(LISTING)).resolves.toEqual(usage);
    expect(seen.at(-1)).toBe(`/discovery/resources/${LISTING}/usage?network=stellar%3Atestnet`);
    await expect(client.sellerUsage(owner)).resolves.toEqual(seller);
    expect(seen.at(-1)).toBe(`/discovery/sellers/${owner}/usage?network=stellar%3Atestnet`);

    // Refused before anything is sent.
    seen.length = 0;
    for (const hashes of [
      [],
      [paid.toUpperCase()],
      ["x"],
      Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(64, "0")),
    ]) {
      await expect(client.settlements(hashes)).rejects.toMatchObject({ code: "discovery_rejected" });
    }
    await expect(client.usage("../x")).rejects.toMatchObject({ code: "listing_not_found" });
    for (const payTo of ["nobody", `S${owner.slice(1)}`, owner.toLowerCase()]) {
      await expect(client.sellerUsage(payTo)).rejects.toMatchObject({ code: "discovery_rejected" });
    }
    expect(seen).toEqual([]);

    // An unknown listing is not found; one whose usage is private says so by its code; an unexpected
    // shape is refused.
    await expect(client.usage(MCP_LISTING)).rejects.toMatchObject({ code: "listing_not_found" });
    failures[`/discovery/resources/${MCP_LISTING}/usage`] = [
      404,
      {
        error: {
          code: "discovery_usage_private",
          reason: "The seller of this listing keeps its usage private.",
          retryable: false,
        },
      },
    ];
    await expect(client.usage(MCP_LISTING)).rejects.toMatchObject({
      code: "discovery_rejected",
      details: { upstream: { code: "discovery_usage_private" } },
    });
    listings[`${LISTING}/usage`] = { ...usage, payments: "one" };
    await expect(client.usage(LISTING)).rejects.toMatchObject({ code: "discovery_rejected" });
  });

  it("reads every page of a long version history", async () => {
    const version = (n: number) => ({
      version: n,
      createdAt: "2026-09-30T00:00:00.000Z",
      cause: "settlement",
      owner,
      trust: "settled",
      state: "published",
      content: {},
    });
    const page = (from: number, to: number, next?: number) => ({
      x402Version: 2,
      id: LISTING,
      versions: Array.from({ length: to - from + 1 }, (_, index) => version(from + index)),
      pagination: { limit: 100, after: from - 1, latest: 250, ...(next === undefined ? {} : { next }) },
    });
    listings[`${LISTING}/versions`] = page(1, 100, 100);
    listings[`${LISTING}/versions?after=100`] = page(101, 200, 200);
    listings[`${LISTING}/versions?after=200`] = page(201, 250);
    const client = new DiscoveryClient({ baseUrl: url, network: TESTNET });
    const versions = await client.versions(LISTING);
    expect(versions.map((entry) => entry.version)).toEqual(
      Array.from({ length: 250 }, (_, index) => index + 1),
    );
    // A `next` that does not move forward ends the read instead of looping.
    listings[`${LISTING}/versions`] = page(1, 2, 0);
    await expect(client.versions(LISTING)).resolves.toHaveLength(2);
  });

  it("flattens an item to its listing on the buyer's network", async () => {
    const policy = await testPolicy();
    const context = { network: TESTNET, policy, adapters: [exactScheme()], egress: resolveEgress() } as const;
    const hit = toHit(item(), context);
    expect(hit).toMatchObject({
      listingId: LISTING,
      type: "http",
      method: "GET",
      routeTemplate: "/users/:id",
      owner,
      trust: "origin_verified",
      callable: true,
      notCallableReason: null,
      withinPolicy: true,
      seller: { description: "Current weather for a city" },
      input: { pathParams: ["id"], example: { units: "metric" } },
      output: { example: { t: 21 } },
    });
    expect(hit.prices).toEqual([
      {
        scheme: "exact",
        amount: "0.001",
        atomic: "10000",
        asset: "USDC",
        assetContract: usdc,
        decimals: 7,
        payTo: owner,
        feesSponsored: true,
        receivable: true,
        maxTimeoutSeconds: 60,
        withinPolicy: true,
      },
    ]);
    expect(payableHit(hit, policy)).toBe(true);

    const mcp = toHit(mcpItem, context);
    expect(mcp).toMatchObject({ type: "mcp", toolName: "forecast", transport: "sse", trust: "settled" });
    const unreachable = toHit(item({ resource: "mcp://tool/forecast", type: "mcp" }), context);
    expect(unreachable).toMatchObject({
      callable: false,
      notCallableReason: "The MCP endpoint is not an http(s) URL.",
    });
    const plain = toHit(item({ resource: "http://weather.example/x" }), context);
    expect(plain.callable).toBe(false);
    const pricey = toHit(
      item({ accepts: [{ ...item().accepts[0], amount: "5000000" } as DiscoveryItem["accepts"][0]] }),
      context,
    );
    expect(pricey.withinPolicy).toBe(false);
  });

  it("binds the listed prices of HTTP listings and of MCP tools at an http(s) endpoint", () => {
    const listed = { scheme: "exact", asset: usdc, payTo: owner };
    expect(bindingFor(item(), TESTNET, owner)).toEqual({
      type: "http",
      owner,
      prices: [{ ...listed, amount: "10000" }],
    });
    expect(bindingFor(mcpItem, TESTNET, owner)).toEqual({
      type: "mcp",
      owner,
      prices: [{ ...listed, amount: "20000" }],
    });
    // A tool that is not at an http(s) endpoint is never confirmed at an origin, or called.
    expect(bindingFor({ ...mcpItem, resource: "mcp://tool/forecast" }, TESTNET, owner)).toEqual({
      type: "mcp",
      owner,
    });
  });

  it("fills route parameters and refuses traversal", () => {
    expect(routeParams("/users/:id/posts/:post")).toEqual(["id", "post"]);
    expect(expandRoute("https://x.example/users/:id", { id: "a b/c" })).toBe(
      "https://x.example/users/a%20b%2Fc",
    );
    for (const value of ["", ".", "..", "%2e%2e", "%252e%252e", "a\nb", " .. "]) {
      expect(() => expandRoute("https://x.example/users/:id", { id: value }), JSON.stringify(value)).toThrow(
        expect.objectContaining({ code: "payment_request_invalid" }) as Error,
      );
    }
    expect(() => expandRoute("https://x.example/users/:id", {})).toThrow(/required/);
    expect(() => expandRoute("https://x.example/users", { id: "1" })).toThrow(/no path parameter/);
  });

  describe("buyer", () => {
    const buyer = () =>
      createBuyer({
        network: TESTNET,
        signer: KeyHolder.random(),
        rpcUrl: "http://127.0.0.1:1",
        bazaarUrl: url,
      });

    it("searches and lists through the Bazaar", async () => {
      const client = await buyer();
      const page = await client.search("weather");
      expect(page.hits.map((hit) => hit.listingId)).toEqual([LISTING, MCP_LISTING]);
      const list = await client.list({ type: "http" });
      expect(list.pagination).toMatchObject({ total: 1 });
      await client.close();
    });

    it("refuses listings that cannot be paid before anything is fetched from the seller", async () => {
      const client = await buyer();
      listings[LISTING] = { ...item(), state: "pending" };
      await expect(
        client.payListing(LISTING, { pathParams: { id: "1" } }, { maxAmount: { amount: "0.05" } }),
      ).rejects.toMatchObject({
        code: "listing_not_payable",
      });
      listings[LISTING] = { ...item({ resource: "http://weather.example/users/:id" }), state: "published" };
      await expect(client.payListing(LISTING, {}, { maxAmount: { amount: "0.05" } })).rejects.toMatchObject({
        code: "listing_not_payable",
      });
      await expect(
        client.payListing("11111111-2222-4333-8444-000000000000", {}, { maxAmount: { amount: "0.05" } }),
      ).rejects.toMatchObject({
        code: "listing_not_found",
      });
      await expect(
        client.searchAndPay("weather", { maxAmount: { amount: "0.05" }, pick: () => undefined }),
      ).rejects.toMatchObject({ code: "listing_not_payable" });
      await client.close();
    });

    it("refuses raw URLs when the policy requires a listing, and pays nothing without a signer", async () => {
      const strict = await createBuyer({
        network: TESTNET,
        signer: KeyHolder.random(),
        rpcUrl: "http://127.0.0.1:1",
        bazaarUrl: url,
        policy: { requireCatalogListing: true },
      });
      await expect(
        strict.pay({ kind: "http", url: "https://weather.example/x" }, { maxAmount: { amount: "0.05" } }),
      ).rejects.toMatchObject({ code: "payment_listing_required" });
      const searchOnly = await createBuyer({
        network: TESTNET,
        rpcUrl: "http://127.0.0.1:1",
        bazaarUrl: url,
      });
      expect(searchOnly.address).toBeUndefined();
      await expect(
        searchOnly.pay({ kind: "http", url: "https://weather.example/x" }, { maxAmount: { amount: "0.05" } }),
      ).rejects.toMatchObject({ code: "payment_signer_unavailable" });
      await expect(searchOnly.budget()).rejects.toMatchObject({ code: "payment_signer_unavailable" });
      await strict.close();
      await searchOnly.close();
    });

    it("refuses unsafe egress on pubnet and has no default network", async () => {
      await expect(
        createBuyer({
          network: "stellar:pubnet",
          rpcUrl: "https://rpc.example",
          egress: { allowPrivateNetwork: "loopback" },
        }),
      ).rejects.toMatchObject({ code: "payment_policy_invalid" });
      await expect(
        createBuyer({
          network: "stellar:pubnet",
          rpcUrl: "https://rpc.example",
          egress: { ports: [443, 6379] },
        }),
      ).rejects.toThrow(/port 443/);
      await expect(createBuyer({} as unknown as Parameters<typeof createBuyer>[0])).rejects.toMatchObject({
        code: "payment_policy_invalid",
      });
      await expect(createBuyer({ network: "stellar:pubnet" })).rejects.toMatchObject({
        code: "payment_policy_invalid",
      });
    });
  });
});
