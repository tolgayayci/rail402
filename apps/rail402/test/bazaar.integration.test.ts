/**
 * The Bazaar end to end: a real @x402/express seller with the bazaar server extension, a buyer on
 * the stock @x402/fetch flow, and Rail402 (Postgres, local Stellar network) as facilitator.
 * Needs `docker compose --profile stellar up -d`.
 */
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { type Keypair } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import {
  LocalNetwork,
  requirementsFor,
  type IssuedAsset,
  type PaymentRequirementsLike,
} from "@rail402.dev/testkit";
import { startService, type RunningService } from "./service-harness.ts";

const net = new LocalNetwork();
const available = await net.available();

interface DiscoveryList {
  items: {
    resource: string;
    type: string;
    accepts: { payTo: string; amount: string; network: string }[];
    extensions: { bazaar: { info: { input: Record<string, unknown> } } };
    rail402: { trust: string; listings: { id: string; trust: string; owner: string; version: number }[] };
  }[];
  pagination: { limit: number; offset: number; total: number };
}

describe.skipIf(!available)("Bazaar: settlement-gated cataloging through a real seller", () => {
  let usdc: IssuedAsset;
  let service: RunningService;
  let seller: Keypair;
  let sellerServer: Server;
  let sellerUrl: string;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    service = await startService(net, usdc, {
      DISCOVERY_ALLOW_LOOPBACK: "true",
      ORIGIN_CHECK_INTERVAL_MS: "600000",
    });
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];

    // A seller exactly as the x402 docs describe it, pointed at Rail402.
    const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: service.url }))
      .register("stellar:testnet", new ExactStellarServer())
      .registerExtension(bazaarResourceServerExtension);
    const app = express();
    app.use(
      paymentMiddleware(
        {
          "GET /weather": {
            accepts: {
              scheme: "exact",
              price: { amount: "150000", asset: usdc.sac },
              network: "stellar:testnet",
              payTo: seller.publicKey(),
            },
            description: "Current weather for a city",
            mimeType: "application/json",
            extensions: declareDiscoveryExtension({
              input: { city: "Ankara" },
              inputSchema: {
                properties: { city: { type: "string", description: "City name" } },
                required: ["city"],
              },
              output: { example: { temperature: 21, conditions: "sunny" } },
            }),
          },
        },
        resourceServer,
      ),
    );
    app.get("/weather", (_req, res) => {
      res.json({ temperature: 21, conditions: "sunny" });
    });
    sellerServer = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => sellerServer.once("listening", resolve));
    sellerUrl = `http://127.0.0.1:${String((sellerServer.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => sellerServer.close(resolve));
    await service.stop();
  });

  /** Stock @x402/fetch; only the Stellar signing step uses the local-RPC-capable helper. */
  const buyerFetch = (payer: Keypair) =>
    wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [
        {
          network: "stellar:testnet",
          client: {
            scheme: "exact",
            createPaymentPayload: async (x402Version: number, requirements: PaymentRequirements) => {
              const payment = await net.payment(payer, requirements as unknown as PaymentRequirementsLike);
              return { x402Version, payload: payment.payload };
            },
          },
        },
      ],
      spendControls: false,
    });

  const list = async (query = "") =>
    (await (await fetch(`${service.url}/discovery/resources${query}`)).json()) as DiscoveryList;

  it("advertises the bazaar extension", async () => {
    const supported = (await (await fetch(`${service.url}/supported`)).json()) as { extensions: string[] };
    expect(supported.extensions).toContain("bazaar");
  });

  it("catalogs a paid HTTP endpoint automatically and lists it once the seller's own 402 confirms it", async () => {
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const response = await buyerFetch(payer)(`${sellerUrl}/weather?city=Ankara`);
    expect(response.status).toBe(200);

    await service.runtime.bazaar?.catalog.checkOrigins();
    const { items, pagination } = await list(`?payTo=${seller.publicKey()}`);
    expect(pagination.total).toBe(1);
    const [item] = items;
    expect(item).toMatchObject({
      resource: `${sellerUrl}/weather`,
      type: "http",
      x402Version: 2,
      accepts: [{ payTo: seller.publicKey(), amount: "150000", network: "stellar:testnet" }],
      description: "Current weather for a city",
      rail402: {
        trust: "origin_verified",
        listings: [
          { network: "stellar:testnet", trust: "origin_verified", owner: seller.publicKey(), version: 2 },
        ],
      },
    });
    expect(item?.extensions.bazaar.info.input).toMatchObject({ type: "http", method: "GET" });
    expect(new Date((item as unknown as { lastUpdated: string }).lastUpdated).toISOString()).toBeTruthy();
  });

  it("keeps the settlement and the origin verification as public versions", async () => {
    const { items } = await list(`?payTo=${seller.publicKey()}`);
    const versions = (await (
      await fetch(`${service.url}/discovery/resources/${items[0]?.rail402.listings[0]?.id ?? ""}/versions`)
    ).json()) as { versions: { version: number; cause: string; state: string }[] };
    expect(versions.versions.map((v) => [v.cause, v.state])).toEqual([
      ["settlement", "pending"],
      ["origin_verification", "published"],
    ]);
  });

  it("reports cataloging outcomes to the seller in EXTENSION-RESPONSES", async () => {
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const client = new HTTPFacilitatorClient({ url: service.url });
    const requirements = requirementsFor(usdc.sac, seller.publicKey(), 150_000n) as PaymentRequirements;
    const payment = await net.payment(payer, requirementsFor(usdc.sac, seller.publicKey(), 150_000n));
    const { bazaar } = declareDiscoveryExtension({
      input: { city: "Izmir" },
      inputSchema: { properties: { city: { type: "string" } } },
    });
    const withBazaar = {
      ...payment,
      resource: {
        url: `${sellerUrl}/weather`,
        description: "Current weather for a city",
        mimeType: "application/json",
      },
      extensions: {
        bazaar: { ...bazaar, info: { ...bazaar?.info, input: { ...bazaar?.info.input, method: "GET" } } },
      },
    } as unknown as PaymentPayload;

    const verified = await client.verify(withBazaar, requirements);
    expect(verified.isValid).toBe(true);
    expect(verified.extensionResponses?.["bazaar"]).toMatchObject({
      status: "processing",
      code: "awaiting_settlement",
    });

    // The echoed metadata differs from the listing, so it waits for the seller's own 402.
    const settled = await client.settle(withBazaar, requirements);
    expect(settled.success).toBe(true);
    const outcome = settled.extensionResponses?.["bazaar"] as {
      status: string;
      code: string;
      reason: string;
    };
    expect(outcome).toMatchObject({ status: "processing", code: "awaiting_origin_verification" });
    expect(outcome.reason.trim()).not.toBe("");
  });

  it("refuses a different payTo for the same resource, with a coded reason", async () => {
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const [impostor] = (await net.holders(usdc, 1, "0")) as [Keypair];
    const client = new HTTPFacilitatorClient({ url: service.url });
    const requirements = requirementsFor(usdc.sac, impostor.publicKey(), 1n) as PaymentRequirements;
    const payment = await net.payment(payer, requirementsFor(usdc.sac, impostor.publicKey(), 1n));
    const { bazaar } = declareDiscoveryExtension({ input: { city: "x" }, inputSchema: { properties: {} } });
    const hijack = {
      ...payment,
      resource: { url: `${sellerUrl}/weather`, description: "Free weather!" },
      extensions: {
        bazaar: { ...bazaar, info: { ...bazaar?.info, input: { ...bazaar?.info.input, method: "GET" } } },
      },
    } as unknown as PaymentPayload;

    const settled = await client.settle(hijack, requirements);
    expect(settled.success).toBe(true);
    expect(settled.extensionResponses?.["bazaar"]).toMatchObject({
      status: "rejected",
      code: "bazaar_owner_conflict",
    });
    const { items } = await list(`?payTo=${seller.publicKey()}`);
    expect(items[0]).toMatchObject({
      description: "Current weather for a city",
      accepts: [{ amount: "150000" }],
    });
  });

  it("catalogs an MCP tool keyed by resource URL and tool name", async () => {
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const client = new HTTPFacilitatorClient({ url: service.url });
    const requirements = requirementsFor(usdc.sac, seller.publicKey(), 50_000n) as PaymentRequirements;
    const payment = await net.payment(payer, requirementsFor(usdc.sac, seller.publicKey(), 50_000n));
    const { bazaar } = declareDiscoveryExtension({
      toolName: "forecast",
      description: "Five-day forecast",
      transport: "streamable-http",
      inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    });
    const tool = {
      ...payment,
      resource: { url: "mcp://tool/forecast", description: "Five-day forecast" },
      extensions: { bazaar },
    } as unknown as PaymentPayload;
    const settled = await client.settle(tool, requirements);
    expect(settled.extensionResponses?.["bazaar"]).toMatchObject({ status: "success", code: "cataloged" });

    const { items } = await list(`?type=mcp&payTo=${seller.publicKey()}`);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ resource: "mcp://tool/forecast", type: "mcp" });
    expect(items[0]?.extensions.bazaar.info.input).toMatchObject({
      type: "mcp",
      toolName: "forecast",
      transport: "streamable-http",
    });
  });

  it("finds cataloged resources with natural-language search", async () => {
    await service.runtime.bazaar?.search.refresh();
    const response = await fetch(
      `${service.url}/discovery/search?query=${encodeURIComponent("city weather conditions")}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      x402Version: number;
      resources: { resource: string; type: string }[];
      partialResults: boolean;
      pagination: { limit: number; cursor: string | null };
      rail402: { method: string };
    };
    expect(body.x402Version).toBe(2);
    expect(body.resources[0]?.resource).toBe(`${sellerUrl}/weather`);
    expect(typeof body.partialResults).toBe("boolean");
    expect(body.pagination.limit).toBe(10);
    expect(body.rail402.method).toBe("hybrid");

    const mainnet = (await (
      await fetch(`${service.url}/discovery/search?query=${encodeURIComponent("weather on mainnet")}`)
    ).json()) as { resources: unknown[]; rail402: { recognised: string[] } };
    expect(mainnet.resources).toEqual([]);
    expect(mainnet.rail402.recognised).toEqual(["network=stellar:pubnet"]);

    const missing = await fetch(`${service.url}/discovery/search`);
    expect(missing.status).toBe(400);
    const forged = await fetch(`${service.url}/discovery/search?query=weather&cursor=abc.def`);
    expect(await forged.json()).toMatchObject({ error: { code: "search_invalid_cursor" } });
  });

  it("answers malformed discovery queries with coded errors and clamps large pages", async () => {
    const bad = await fetch(`${service.url}/discovery/resources?limit=abc`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "discovery_invalid_parameter" } });
    const unknown = await fetch(`${service.url}/discovery/resources?maxPrice=1`);
    expect(await unknown.json()).toMatchObject({ error: { code: "discovery_invalid_parameter" } });
    const clamped = await list("?limit=1000");
    expect(clamped.pagination.limit).toBe(100);
    const other = await list("?network=eip155:8453");
    expect(other.pagination.total).toBe(0);
    for (const path of [`/discovery/resources/${randomUUID()}`, "/discovery/resources/not-an-id/versions"]) {
      const missing = await fetch(`${service.url}${path}`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ error: { code: "discovery_listing_not_found" } });
    }
  });
});
