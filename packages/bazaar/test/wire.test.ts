import { describe, expect, it } from "vitest";
import { randomAddress, toDiscoveryItem, trustFor, type Listing, type Trust } from "@rail402.dev/bazaar";

function listing(network: string, trust: Trust): Listing {
  const owner = randomAddress();
  const at = new Date("2026-10-01T00:00:00Z");
  return {
    id: `${network}-${trust}`,
    sequence: 1,
    identity: {
      network,
      kind: "http",
      resource: "https://api.example.com/x",
      method: "GET",
      toolName: "",
      scope: "",
    },
    owner,
    trust,
    state: "published",
    version: 1,
    content: {
      resource: "https://api.example.com/x",
      kind: "http",
      method: "GET",
      bazaar: { info: {}, schema: {} },
      accepts: [
        {
          scheme: "exact",
          network,
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          payTo: owner,
          amount: "10",
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
    },
    contentHash: "h",
    firstCatalogedAt: at,
    listedAt: at,
    lastUpdated: at,
    lastSettledAt: at,
    settlements: 2,
  };
}

describe("discovery items", () => {
  it("shows pubnet trust only from pubnet proof", () => {
    const testnet = listing("stellar:testnet", "domain_verified");
    const pubnet = listing("stellar:pubnet", "origin_verified");
    // Both networks shown: never more than either network proved.
    expect(toDiscoveryItem([testnet, pubnet]).rail402.trust).toBe("origin_verified");
    expect(toDiscoveryItem([pubnet, testnet]).rail402.trust).toBe("origin_verified");
    // Filtered to one network, the item shows that network's listing only, and its trust.
    expect(toDiscoveryItem([pubnet]).rail402.trust).toBe("origin_verified");
    expect(toDiscoveryItem([testnet]).rail402.trust).toBe("domain_verified");
    expect(toDiscoveryItem([testnet, pubnet]).rail402.listings.map((entry) => entry.trust)).toEqual([
      "domain_verified",
      "origin_verified",
    ]);
    expect(trustFor([listing("stellar:pubnet", "settled"), testnet])).toBe("settled");
  });

  it("never adds testnet settlements to a pubnet count", () => {
    const testnet = { ...listing("stellar:testnet", "origin_verified"), settlements: 5_000 };
    const pubnet = { ...listing("stellar:pubnet", "origin_verified"), settlements: 3 };
    // Both networks shown: no sum, and never more than either network counted.
    expect(toDiscoveryItem([testnet, pubnet]).rail402.settlements).toBe(3);
    expect(toDiscoveryItem([pubnet, testnet]).rail402.settlements).toBe(3);
    // Filtered to one network, that network's count; each network's own count is in its listing.
    expect(toDiscoveryItem([pubnet]).rail402.settlements).toBe(3);
    expect(toDiscoveryItem([testnet]).rail402.settlements).toBe(5_000);
    expect(
      toDiscoveryItem([testnet, pubnet]).rail402.listings.map(({ network, settlements }) => ({
        network,
        settlements,
      })),
    ).toEqual([
      { network: "stellar:testnet", settlements: 5_000 },
      { network: "stellar:pubnet", settlements: 3 },
    ]);
  });
});
