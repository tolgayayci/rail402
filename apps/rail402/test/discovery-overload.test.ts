import { createHash, randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  MemoryCatalogStore,
  contentHash,
  randomAddress,
  type Catalog,
  type CatalogStore,
  type Listing,
  type ListingContent,
} from "@rail402.dev/bazaar";
import { silentLogger, type StellarFacilitator } from "@rail402.dev/facilitator";
import { AssetRegistry, SearchService } from "@rail402.dev/search";
import {
  DiscoveryAdmission,
  Metrics,
  cachedProbe,
  createApp,
  discoveryFailure,
  discoveryLaneOf,
  discoveryRouteOf,
  discoveryRoutes,
  laneRouted,
  loadConfig,
  newAccessKey,
} from "@rail402.dev/service";
import { secretFile } from "./secret-fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
});

/** An error as pg-pool raises it when no connection frees up within the acquire timeout. */
const poolTimeout = () => new Error("timeout exceeded when trying to connect");
const refused = () =>
  Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), { code: "ECONNREFUSED" });

describe("discovery admission", () => {
  it("serves up to its limit, queues up to its queue length and refuses the rest at once", async () => {
    const admission = new DiscoveryAdmission({ maxInFlight: 2, queueLength: 1, queueTimeoutMs: 10_000 });
    expect(await admission.enter()).toBe(true);
    expect(await admission.enter()).toBe(true);
    const waiting = admission.enter();
    expect(admission.queued).toBe(1);
    expect(await admission.enter()).toBe(false);
    admission.leave();
    expect(await waiting).toBe(true);
    expect(admission.inFlight).toBe(2);
    admission.leave();
    admission.leave();
    expect(admission.inFlight).toBe(0);
  });

  it("hands turns over first come, first served", async () => {
    const admission = new DiscoveryAdmission({ maxInFlight: 1, queueLength: 3, queueTimeoutMs: 10_000 });
    await admission.enter();
    const order: number[] = [];
    const queued = [1, 2, 3].map((n) => admission.enter().then(() => order.push(n)));
    for (let i = 0; i < 3; i++) {
      admission.leave();
      await Promise.resolve();
    }
    await Promise.all(queued);
    expect(order).toEqual([1, 2, 3]);
  });

  it("refuses a request whose wait in the queue runs out, and frees its place", async () => {
    vi.useFakeTimers();
    const admission = new DiscoveryAdmission({ maxInFlight: 1, queueLength: 1, queueTimeoutMs: 250 });
    await admission.enter();
    const waiting = admission.enter();
    await vi.advanceTimersByTimeAsync(250);
    expect(await waiting).toBe(false);
    expect(admission.queued).toBe(0);
    // The place is free again, and the slot was never handed to the refused request.
    const next = admission.enter();
    admission.leave();
    expect(await next).toBe(true);
    expect(admission.inFlight).toBe(1);
  });

  it("refuses at once with no queue", async () => {
    const admission = new DiscoveryAdmission({ maxInFlight: 1, queueLength: 0, queueTimeoutMs: 1_000 });
    expect(await admission.enter()).toBe(true);
    expect(await admission.enter()).toBe(false);
  });
});

describe("discovery database failures", () => {
  it("tells a busy database from an unreachable one and from a defect", () => {
    expect(discoveryFailure(poolTimeout())).toBe("database_busy");
    expect(discoveryFailure(new Error("Connection terminated due to connection timeout"))).toBe(
      "database_busy",
    );
    expect(discoveryFailure(Object.assign(new Error("canceling statement"), { code: "57014" }))).toBe(
      "database_busy",
    );
    expect(discoveryFailure(refused())).toBe("database_unavailable");
    expect(discoveryFailure(Object.assign(new Error("terminating"), { code: "57P01" }))).toBe(
      "database_unavailable",
    );
    expect(discoveryFailure(new Error("query failed", { cause: poolTimeout() }))).toBe("database_busy");
    expect(discoveryFailure(new TypeError("cannot read properties of undefined"))).toBeUndefined();
    expect(discoveryFailure("timeout exceeded when trying to connect")).toBeUndefined();
  });

  it("names the route of a request path", () => {
    expect(discoveryRouteOf("/discovery/search")).toBe("/discovery/search");
    expect(discoveryRouteOf("/discovery/resources")).toBe("/discovery/resources");
    expect(discoveryRouteOf("/discovery/resources/abc")).toBe("/discovery/resources/:id");
    expect(discoveryRouteOf("/discovery/resources/abc/versions")).toBe("/discovery/resources/:id/versions");
  });
});

/** A catalog store whose reads fail with `error`. */
function failingStore(error: () => Error): CatalogStore {
  const store = new MemoryCatalogStore();
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "list" || property === "get" || property === "getMany" || property === "revision")
        return () => Promise.reject(error());
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

describe("discovery routes over a failing catalog database", () => {
  it("refuse with a coded 503 and Retry-After, never a 500", async () => {
    const failures: string[] = [];
    for (const [error, code, failure] of [
      [poolTimeout, "discovery_overloaded", "database_busy"],
      [refused, "discovery_catalog_unavailable", "database_unavailable"],
    ] as const) {
      const app = discoveryRoutes(failingStore(error), undefined, undefined, {
        failed: (route, reason) => failures.push(`${route} ${reason}`),
      });
      for (const path of ["/resources", "/resources/00000000-0000-4000-8000-000000000000"]) {
        const response = await app.request(path);
        expect(response.status, path).toBe(503);
        expect(response.headers.get("retry-after")).toBe("1");
        expect(await response.json()).toMatchObject({ error: { code, retryable: true } });
      }
      expect(failures.at(-1)).toBe(`/discovery/resources/:id ${failure}`);
    }
  });
});

/** The service with a catalog whose page reads wait for `release`, and the given discovery limits. */
function service(store: CatalogStore, env: Record<string, string>, search?: SearchService) {
  const config = loadConfig({
    STORE: "memory",
    TESTNET_RPC_URL: "http://localhost:8000/rpc",
    TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
    API_KEY_SHA256: createHash("sha256").update("key").digest("hex"),
    RATE_LIMIT_PER_MINUTE: "0",
    SEARCH_RATE_LIMIT_PER_MINUTE: "0",
    ...env,
  });
  const facilitator = {
    core: {
      getSupported: () => ({
        kinds: [
          { x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } },
        ],
        extensions: [],
        signers: { "stellar:*": ["GSPONSOR"] },
      }),
    },
    networks: new Map(),
  } as unknown as StellarFacilitator;
  const metrics = new Metrics();
  const app = createApp({
    config,
    facilitator,
    metrics,
    log: silentLogger,
    readiness: () => Promise.resolve({ ready: true, checks: {} }),
    version: "test",
    bazaar: { catalog: {} as Catalog, store, ...(search === undefined ? {} : { search }) },
  });
  return { app, metrics };
}

/** A memory catalog whose list pages hang until `release` is called. */
function stalledStore() {
  const store = new MemoryCatalogStore();
  const stalled: (() => void)[] = [];
  const wrapped = new Proxy(store, {
    get(target, property, receiver) {
      if (property === "list") {
        return async (...args: Parameters<CatalogStore["list"]>) => {
          await new Promise<void>((resolve) => stalled.push(resolve));
          return target.list(...args);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return {
    store: wrapped,
    stalled: () => stalled.length,
    release: () => {
      for (const resume of stalled.splice(0)) resume();
    },
  };
}

describe("discovery load shedding in the service", () => {
  // Requests made in process all come from one client; its share must not be what refuses them.
  const limits = {
    DISCOVERY_MAX_IN_FLIGHT: "2",
    DISCOVERY_QUEUE_LENGTH: "1",
    DISCOVERY_QUEUE_TIMEOUT_MS: "5000",
    DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT: "100",
  };

  it("refuses discovery beyond its slots and queue with 503 while health and settlement routes answer", async () => {
    const catalog = stalledStore();
    const { app, metrics } = service(catalog.store, limits);
    const pages = Array.from({ length: 6 }, () => Promise.resolve(app.request("/discovery/resources")));
    await vi.waitFor(() => {
      expect(catalog.stalled()).toBe(2);
    });
    // Three of six were turned away at once: two slots and one queue place.
    const early = await Promise.all(pages.slice(3));
    for (const response of early) {
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.json()).toMatchObject({
        error: { code: "discovery_overloaded", retryable: true },
      });
    }
    // The rest of the process answers while discovery is saturated.
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/supported")).status).toBe(200);
    expect((await app.request("/ready")).status).toBe(200);
    expect((await metrics.registry.getSingleMetricAsString("rail402_discovery_in_flight")).trim()).toMatch(
      / 2$/,
    );
    catalog.release();
    await vi.waitFor(() => {
      expect(catalog.stalled()).toBe(1);
    });
    catalog.release();
    const served = await Promise.all(pages.slice(0, 3));
    expect(served.map((response) => response.status)).toEqual([200, 200, 200]);
    const shed = await metrics.registry.getSingleMetricAsString("rail402_discovery_shed_total");
    expect(shed).toContain('rail402_discovery_shed_total{route="/discovery/resources",reason="admission"} 3');
  });

  it("refuses a queued request once its wait runs out", async () => {
    const catalog = stalledStore();
    const { app } = service(catalog.store, {
      ...limits,
      DISCOVERY_MAX_IN_FLIGHT: "1",
      DISCOVERY_QUEUE_TIMEOUT_MS: "100",
    });
    const first = app.request("/discovery/resources");
    await vi.waitFor(() => {
      expect(catalog.stalled()).toBe(1);
    });
    const started = Date.now();
    const queued = await app.request("/discovery/resources");
    expect(queued.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2_000);
    catalog.release();
    expect((await first).status).toBe(200);
  });

  it("leaves a defect, which is not load, to the internal error handler", async () => {
    const { app } = service(
      failingStore(() => new TypeError("a defect")),
      limits,
    );
    const response = await app.request("/discovery/resources");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
  });

  it("answers a busy catalog database with a coded 503 through the service", async () => {
    const { app, metrics } = service(failingStore(poolTimeout), limits);
    const response = await app.request("/discovery/resources");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "discovery_overloaded" } });
    expect(await metrics.registry.getSingleMetricAsString("rail402_discovery_shed_total")).toContain(
      'rail402_discovery_shed_total{route="/discovery/resources",reason="database_busy"} 1',
    );
  });
});

/**
 * The Node bindings of one request as the HTTP server passes them, with a response that has no
 * connection yet: it counts as sent only once `send` is called.
 */
function delivery() {
  const outgoing = new ServerResponse(new IncomingMessage(new Socket()));
  return {
    env: { incoming: outgoing.req, outgoing },
    send: () => {
      outgoing.destroy();
    },
  };
}

const inFlight = async (metrics: Metrics) =>
  (await metrics.registry.getSingleMetricAsString("rail402_discovery_in_flight")).trim();

describe("discovery responses awaiting delivery", () => {
  it("hold their slot until they are sent, so the pages one process keeps for its clients are bounded", async () => {
    const { app, metrics } = service(new MemoryCatalogStore(), {
      DISCOVERY_MAX_IN_FLIGHT: "1",
      DISCOVERY_QUEUE_LENGTH: "0",
    });
    const first = delivery();
    expect((await app.request("/discovery/resources", {}, first.env)).status).toBe(200);
    // The handler has answered, but the page has not reached its client: the slot stays taken.
    expect(await inFlight(metrics)).toMatch(/ 1$/);
    const refused = await app.request("/discovery/resources", {}, delivery().env);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { code: "discovery_overloaded" } });
    first.send();
    await vi.waitFor(async () => {
      expect(await inFlight(metrics)).toMatch(/ 0$/);
    });
    expect((await app.request("/discovery/resources", {}, delivery().env)).status).toBe(200);
  });

  it("limit how many one client holds at once, so one client cannot take every slot", async () => {
    const { app, metrics } = service(new MemoryCatalogStore(), {
      DISCOVERY_MAX_IN_FLIGHT: "8",
      DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT: "2",
      TRUSTED_PROXY_HOPS: "1",
    });
    const from = (address: string) => ({ headers: { "x-forwarded-for": address } });
    const held = [delivery(), delivery()];
    for (const pending of held) {
      expect((await app.request("/discovery/resources", from("203.0.113.7"), pending.env)).status).toBe(200);
    }
    const over = await app.request("/discovery/resources", from("203.0.113.7"), delivery().env);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("1");
    expect(await over.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(await metrics.registry.getSingleMetricAsString("rail402_discovery_rate_limited_total")).toContain(
      'rail402_discovery_rate_limited_total{route="/discovery/resources"} 1',
    );
    // Another client is served meanwhile, and the first gets a turn back once a page is sent.
    expect((await app.request("/discovery/resources", from("198.51.100.9"), delivery().env)).status).toBe(
      200,
    );
    held[0]?.send();
    await vi.waitFor(async () => {
      expect((await app.request("/discovery/resources", from("203.0.113.7"))).status).toBe(200);
    });
  });

  it("count an internal identity's forwarded clients one by one, and never limit the identity as one client", async () => {
    const internal = newAccessKey("discovery-front");
    const keys = {
      schemaVersion: 1,
      keys: [
        {
          id: "discovery-front",
          sha256: internal.sha256,
          networks: [],
          scopes: ["discovery-internal"],
          forwardedClientRequestsPerMinute: 100,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    const { app } = service(new MemoryCatalogStore(), {
      DISCOVERY_MAX_IN_FLIGHT: "8",
      DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT: "1",
      API_KEYS_FILE: secretFile(JSON.stringify(keys)),
    });
    const as = (client?: string) => ({
      headers: { "x-api-key": internal.key, ...(client === undefined ? {} : { "x-rail402-client": client }) },
    });
    expect((await app.request("/discovery/resources", as("agent-a"), delivery().env)).status).toBe(200);
    expect((await app.request("/discovery/resources", as("agent-a"), delivery().env)).status).toBe(429);
    expect((await app.request("/discovery/resources", as("agent-b"), delivery().env)).status).toBe(200);
    // Without a forwarded client the identity is one front end for many users: the lane bounds it.
    expect((await app.request("/discovery/resources", as(), delivery().env)).status).toBe(200);
    expect((await app.request("/discovery/resources", as(), delivery().env)).status).toBe(200);
  });
});

describe("discovery lanes per network", () => {
  const limits = {
    DISCOVERY_MAX_IN_FLIGHT: "4",
    DISCOVERY_QUEUE_LENGTH: "0",
    DISCOVERY_QUEUE_TIMEOUT_MS: "1000",
    DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT: "100",
  };

  it("scopes a request to the pubnet lane by its network only, everything else to the shared lane", () => {
    expect(discoveryLaneOf("stellar:pubnet")).toBe("pubnet");
    expect(discoveryLaneOf("stellar:testnet")).toBe("shared");
    expect(discoveryLaneOf(undefined)).toBe("shared");
  });

  it("keeps admitting pubnet discovery while testnet discovery fills every slot of its lane", async () => {
    const catalog = stalledStore();
    const { app } = service(catalog.store, limits);
    const testnet = Array.from({ length: 4 }, () =>
      Promise.resolve(app.request("/discovery/resources?network=stellar:testnet")),
    );
    await vi.waitFor(() => {
      expect(catalog.stalled()).toBe(4);
    });
    // The shared lane is full: one more testnet or unscoped request is shed at once.
    expect((await app.request("/discovery/resources?network=stellar:testnet")).status).toBe(503);
    expect((await app.request("/discovery/resources")).status).toBe(503);
    // The pubnet lane still admits.
    const pubnet = app.request("/discovery/resources?network=stellar:pubnet");
    await vi.waitFor(() => {
      expect(catalog.stalled()).toBe(5);
    });
    catalog.release();
    expect((await pubnet).status).toBe(200);
    expect((await Promise.all(testnet)).map((response) => response.status)).toEqual([200, 200, 200, 200]);
  });

  it("reads a pubnet request through the pubnet lane's store while the shared one is busy", async () => {
    const pubnetStore = new MemoryCatalogStore();
    const store = laneRouted<CatalogStore>(failingStore(poolTimeout), new Map([["pubnet", pubnetStore]]));
    const { app } = service(store, limits);
    const testnet = await app.request("/discovery/resources?network=stellar:testnet");
    expect(testnet.status).toBe(503);
    expect(await testnet.json()).toMatchObject({ error: { code: "discovery_overloaded" } });
    expect((await app.request("/discovery/resources?network=stellar:pubnet")).status).toBe(200);
    // Outside a discovery request (background work), the shared store answers.
    await expect(store.list({ limit: 1, offset: 0 })).rejects.toThrow(/timeout exceeded/);
  });

  it("answers a pubnet search while the shared lane's store has no connection for an index build", async () => {
    const catalog = new MemoryCatalogStore();
    await publish(catalog, "stellar:pubnet");
    // The shared lane's store. Once request load holds every connection, a catalog scan waits for one
    // and fails as pg-pool does after its acquire timeout; a revision read just got the last one freed.
    let busy = false;
    let sharedScans = 0;
    const waiting: (() => void)[] = [];
    const shared = new Proxy(catalog, {
      get(target, property) {
        if (property === "scanPublished") {
          return async (...args: Parameters<CatalogStore["scanPublished"]>) => {
            sharedScans++;
            if (busy) {
              await new Promise<void>((resolve) => waiting.push(resolve));
              throw poolTimeout();
            }
            return target.scanPublished(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as () => unknown).bind(target) : value;
      },
    });
    const reads = laneRouted<CatalogStore>(shared, new Map([["pubnet", catalog]]));
    // As the runtime builds it: index builds read the catalog through connections of their own.
    const search = new SearchService({
      store: reads,
      indexStore: catalog,
      assets: new AssetRegistry([]),
      cursorSecret: Buffer.alloc(32, 9),
      revisionMaxAgeMs: 1_000,
    });
    const { app } = service(reads, limits, search);
    const pubnetSearch = "/discovery/search?query=forecast&network=stellar:pubnet";
    await search.refresh();
    expect((await app.request(pubnetSearch)).status).toBe(200);

    // A testnet listing is cataloged; then request load takes every shared discovery connection.
    await publish(catalog, "stellar:testnet");
    busy = true;
    // The background refresh, outside any request, while a pubnet search arrives.
    const background = search.refresh().then(
      () => "built",
      () => "failed",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pubnet = Promise.resolve(app.request(pubnetSearch));
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const timeout of waiting.splice(0)) timeout();

    const response = await pubnet;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rail402: { revision: await catalog.revision() } });
    expect(await background).toBe("built");
    expect(sharedScans).toBe(0);
  });
});

/** Publishes a listing of a resource on `network` in `store`. */
async function publish(store: MemoryCatalogStore, network: string): Promise<Listing> {
  const content: ListingContent = {
    resource: `https://${randomUUID().slice(0, 8)}.example.org/forecast`,
    kind: "http",
    method: "GET",
    description: "Weather forecast for a city",
    bazaar: { info: { input: { type: "http", method: "GET" } }, schema: { type: "object" } },
    accepts: [
      {
        scheme: "exact",
        network,
        asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        payTo: randomAddress(),
        amount: "100000",
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  };
  const now = new Date();
  const item: Listing = {
    id: randomUUID(),
    sequence: 0,
    identity: { network, kind: "http", resource: content.resource, method: "GET", toolName: "", scope: "" },
    owner: content.accepts[0]?.payTo ?? "",
    trust: "settled",
    state: "published",
    version: 1,
    content,
    contentHash: contentHash(content),
    firstCatalogedAt: now,
    lastUpdated: now,
    lastSettledAt: now,
    settlements: 1,
  };
  await store.transaction(item.identity, (tx) =>
    tx.insert(item, {
      listingId: item.id,
      version: 1,
      createdAt: now,
      cause: "settlement",
      owner: item.owner,
      trust: item.trust,
      state: item.state,
      content: item.content,
    }),
  );
  return item;
}

describe("the readiness probe while a refresh runs", () => {
  it("answers from the last result instead of waiting for a slow probe", async () => {
    let clock = 0;
    let finish: (value: string) => void = () => undefined;
    let calls = 0;
    const probe = cachedProbe(
      () =>
        calls++ === 0
          ? Promise.resolve("ok")
          : new Promise<string>((resolve) => {
              finish = resolve;
            }),
      2_000,
      () => clock,
      { staleWhileRunning: true },
    );
    expect(await probe()).toBe("ok");
    clock += 2_000;
    // The refresh hangs (a contended pool); callers get the last result meanwhile.
    expect(await probe()).toBe("ok");
    expect(await probe()).toBe("ok");
    expect(calls).toBe(2);
    finish("down");
    await Promise.resolve();
    await Promise.resolve();
    expect(await probe()).toBe("down");
  });
});
