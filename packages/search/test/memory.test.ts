import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  contentHash,
  DEFAULT_MAX_LISTING_BYTES,
  listingBytes,
  MemoryCatalogStore,
  type Listing,
  type ListingContent,
  type Trust,
} from "@rail402.dev/bazaar";
import { AssetRegistry, SearchService, type Embedder } from "@rail402.dev/search";

setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;

/** Memory in use after full collections: the reachable heap and array buffers (vectors live there). */
function heapUsed(): number {
  for (let round = 0; round < 3; round++) collect();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

const MiB = 1024 * 1024;
const TESTNET = "stellar:testnet";
const PUBNET = "stellar:pubnet";
const ASSET = `C${"A".repeat(55)}`;
let counter = 0;
const prefix = randomBytes(3).toString("hex");
/** `count` words no other call returns: every term they make is new to the index. */
const words = (count: number) =>
  Array.from({ length: count }, () => `q${prefix}${(counter++).toString(36)}`).join(" ");

/** A cheap deterministic embedder with the real model's dimensions, so vectors take their real room. */
const embedder: Embedder = {
  id: "hash-384",
  dimensions: 384,
  embed: (text) => {
    const seed = createHash("sha256").update(text).digest();
    return Promise.resolve(Float32Array.from({ length: 384 }, (_, i) => (seed[i % 32] ?? 0) / 255));
  },
};

/**
 * A listing as large as the catalog lets one be, written to cost the index as much as possible: every
 * word in it is unique, so none of its terms is shared with another listing.
 */
function hostile(network: string, trust: Trust, index: number): Listing {
  const payTo = `G${randomBytes(34).toString("hex").toUpperCase().slice(0, 55)}`;
  const properties: Record<string, unknown> = {};
  const filled: ListingContent = {
    resource: `mcp://tool-${String(index)}-${randomUUID()}`,
    kind: "mcp",
    toolName: `tool_${String(index)}`,
    description: words(90).slice(0, 1_000),
    serviceName: words(4),
    tags: words(10).split(" "),
    bazaar: {
      info: { input: { type: "mcp", toolName: `tool_${String(index)}`, description: words(40) } },
      schema: { type: "object", properties },
    },
    accepts: Array.from({ length: 8 }, (_, option) => ({
      scheme: "exact",
      network,
      asset: ASSET,
      payTo,
      amount: String(1_000 + option),
      maxTimeoutSeconds: 60,
      extra: { note: words(150).slice(0, 1_900) },
    })),
  };
  let bytes = listingBytes(filled);
  for (let property = 0; ; property++) {
    const entry = { type: "string", description: words(40) };
    const added = Buffer.byteLength(JSON.stringify({ [`p${String(property)}`]: entry })) + 1;
    if (bytes + added > DEFAULT_MAX_LISTING_BYTES - 64) break;
    properties[`p${String(property)}`] = entry;
    bytes += added;
  }
  const now = new Date(Date.now() + index);
  return {
    id: randomUUID(),
    sequence: 0,
    identity: {
      network,
      kind: "mcp",
      resource: filled.resource,
      method: "",
      toolName: filled.toolName ?? "",
      scope: payTo,
    },
    owner: payTo,
    trust,
    state: "published",
    version: 1,
    content: filled,
    contentHash: contentHash(filled),
    firstCatalogedAt: now,
    listedAt: now,
    lastUpdated: now,
    lastSettledAt: now,
    settlements: 1,
  };
}

async function insert(store: MemoryCatalogStore, listing: Listing): Promise<void> {
  await store.transaction(listing.identity, (tx) =>
    tx.insert(listing, {
      listingId: listing.id,
      version: 1,
      createdAt: listing.firstCatalogedAt,
      cause: "settlement",
      owner: listing.owner,
      trust: listing.trust,
      state: listing.state,
      content: listing.content,
    }),
  );
}

/**
 * A store whose reads hand out fresh copies of each listing, as a database does: a snapshot that kept
 * what it read would hold its own copy of every listing's content.
 */
function copying(store: MemoryCatalogStore): MemoryCatalogStore {
  return Object.assign(Object.create(store) as MemoryCatalogStore, {
    scanPublished: (visit: (batch: readonly Listing[]) => void, size?: number) =>
      store.scanPublished((batch) => {
        visit(structuredClone(batch));
      }, size),
  });
}

describe("search memory", () => {
  it("estimates a snapshot at no less than the heap it holds, for thousands of maximum-size listings", async () => {
    const store = new MemoryCatalogStore();
    for (let index = 0; index < 2_000; index++)
      await insert(store, hostile(TESTNET, "origin_verified", index));
    let estimated = 0;
    const service = new SearchService({
      store: copying(store),
      assets: new AssetRegistry([]),
      cursorSecret: randomBytes(32),
      embedder,
      maxIndexBytesPerNetwork: 1024 * MiB,
      observer: {
        indexBuild: () => undefined,
        embeddingFailure: () => undefined,
        search: () => undefined,
        snapshots: (_count, bytes) => {
          estimated = bytes;
        },
      },
    });
    const before = heapUsed();
    const snapshot = await service.refresh();
    const held = heapUsed() - before;
    expect(snapshot.listings.size).toBe(2_000);
    // The estimate is what the caps compare against: it may be generous, never short.
    expect(estimated).toBeGreaterThanOrEqual(held);
    expect(estimated).toBeLessThan(held * 3);
  }, 120_000);

  it("stays within its memory caps under a flood of free testnet listings, and keeps every pubnet listing searchable", async () => {
    const store = new MemoryCatalogStore();
    // Unverified mcp:// tools, as free testnet payments publish them, far beyond the index's share.
    for (let index = 0; index < 3_000; index++) await insert(store, hostile(TESTNET, "settled", index));
    const pubnet: Listing[] = [];
    for (let index = 0; index < 100; index++) {
      const listing = hostile(PUBNET, "origin_verified", 10_000 + index);
      pubnet.push(listing);
      await insert(store, listing);
    }
    const left = new Map<string, number>();
    const maxIndexBytesPerNetwork = 24 * MiB;
    const maxSnapshotBytes = 64 * MiB;
    const service = new SearchService({
      store: copying(store),
      assets: new AssetRegistry([]),
      cursorSecret: randomBytes(32),
      embedder,
      maxIndexBytesPerNetwork,
      maxSnapshotBytes,
      maxSnapshots: 8,
      observer: {
        indexBuild: () => undefined,
        embeddingFailure: () => undefined,
        search: () => undefined,
        leftOut: (network, count) => left.set(network, count),
      },
    });
    const before = heapUsed();
    // Every revision is followed by a search whose cursor pins its snapshot.
    for (let round = 0; round < 6; round++) {
      await insert(store, hostile(TESTNET, "settled", 20_000 + round));
      const page = await service.search({ query: "tool", filter: {}, limit: 1 });
      expect(page.nextCursor).not.toBeNull();
    }
    const held = heapUsed() - before;
    // All kept snapshots together stay within the snapshot cap (the latest is within its networks'
    // shares), measured on the real heap, not the estimate.
    expect(held).toBeLessThan(maxSnapshotBytes);
    // Testnet's unverified listings took at most half of testnet's share; pubnet kept all of its own.
    expect(left.get(TESTNET)).toBeGreaterThan(2_000);
    expect(left.get(PUBNET)).toBe(0);
    const latest = await service.refresh();
    for (const listing of pubnet) expect(latest.listings.has(listing.id)).toBe(true);
    const testnetKept = [...latest.listings.values()].filter((l) => l.identity.network === TESTNET).length;
    expect(testnetKept).toBeGreaterThan(0);
  }, 180_000);
});
