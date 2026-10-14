import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { TESTNET } from "@rail402.dev/stellar";
import { LISTING_ID, seller, usdcContract } from "./helpers.ts";

export interface FakeBazaar {
  readonly url: string;
  readonly queries: string[];
  close(): Promise<void>;
}

/** A Bazaar answering every search with one testnet listing, on 127.0.0.1. */
export async function startFakeBazaar(): Promise<FakeBazaar> {
  const queries: string[] = [];
  const item = {
    resource: "https://weather.example/now",
    type: "http",
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: TESTNET,
        asset: usdcContract,
        payTo: seller,
        amount: "10000",
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
    ],
    lastUpdated: "2026-09-30T00:00:00.000Z",
    description: "Current weather for a city",
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", queryParams: { city: "Ankara" } },
          output: { example: { t: 21 } },
        },
      },
    },
    rail402: {
      method: "GET",
      trust: "origin_verified",
      settlements: 3,
      listings: [
        {
          id: LISTING_ID,
          network: TESTNET,
          version: 1,
          trust: "origin_verified",
          owner: seller,
          settlements: 3,
        },
      ],
      options: [{ listing: LISTING_ID, symbol: "USDC", decimals: 7, receivable: true }],
    },
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://bazaar");
    if (url.pathname !== "/discovery/search") {
      response
        .writeHead(404, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { code: "not_found", reason: "No route." } }));
      return;
    }
    queries.push(url.search);
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        resources: [item],
        partialResults: false,
        pagination: { limit: 5, cursor: null },
        rail402: { method: "bm25" },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    queries,
    close: () =>
      new Promise((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
}
