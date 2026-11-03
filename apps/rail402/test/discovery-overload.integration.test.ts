/**
 * Discovery under overload, through the whole service (Postgres, local Stellar network): a flood of
 * discovery requests far beyond what the service admits is shed with coded 503s, never 500s, while a
 * real settlement, /health and /ready keep answering within bounds; and with every connection of the
 * discovery pool held, discovery refuses quickly with a code while settlement and search indexing, which
 * use other pools, go through. Needs `docker compose --profile stellar up -d`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Keypair } from "@stellar/stellar-sdk";
import { contentHash, randomAddress, type Listing, type ListingContent } from "@rail402.dev/bazaar";
import { LocalNetwork, requirementsFor, type IssuedAsset } from "@rail402.dev/testkit";
import { startService, type RunningService } from "./service-harness.ts";

const net = new LocalNetwork();
const available = await net.available();

const ACQUIRE_TIMEOUT_MS = 300;
const QUEUE_TIMEOUT_MS = 200;
const FLOOD = 1_500;

/** A published listing of `usdc` on testnet. */
function listing(usdc: string, index: number): Listing {
  const content: ListingContent = {
    resource: `https://api${String(index)}.overload.example/weather`,
    kind: "http",
    method: "GET",
    description: `City weather forecast ${String(index)}`,
    bazaar: { info: { input: { type: "http", method: "GET" } }, schema: { type: "object" } },
    accepts: [
      {
        scheme: "exact",
        network: "stellar:testnet",
        asset: usdc,
        payTo: randomAddress(),
        amount: "100000",
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  };
  const now = new Date();
  return {
    id: randomUUID(),
    sequence: 0,
    identity: {
      network: "stellar:testnet",
      kind: "http",
      resource: content.resource,
      method: "GET",
      toolName: "",
      scope: "",
    },
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
}

interface Timed {
  readonly status: number;
  readonly code: string | undefined;
  readonly ms: number;
}

async function timedGet(url: string): Promise<Timed> {
  const started = performance.now();
  const response = await fetch(url);
  const text = await response.text();
  let code: string | undefined;
  try {
    code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
  } catch {
    code = undefined;
  }
  return { status: response.status, code, ms: performance.now() - started };
}

describe.skipIf(!available)("discovery overload against the whole service", () => {
  let usdc: IssuedAsset;
  let seller: Keypair;
  let service: RunningService;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    service = await startService(net, usdc, {
      SEARCH_EMBEDDINGS: "false",
      SEARCH_RATE_LIMIT_PER_MINUTE: "0",
      DISCOVERY_MAX_IN_FLIGHT: "4",
      // The flood stands for many clients but comes from one address: their shares are not what sheds it.
      DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT: "10000",
      DISCOVERY_QUEUE_LENGTH: "4",
      DISCOVERY_QUEUE_TIMEOUT_MS: String(QUEUE_TIMEOUT_MS),
      DISCOVERY_DATABASE_POOL_SIZE: "2",
      DISCOVERY_DATABASE_ACQUIRE_TIMEOUT_MS: String(ACQUIRE_TIMEOUT_MS),
    });
    const store = service.runtime.bazaar?.store;
    if (store === undefined) throw new Error("the service has no catalog");
    for (let i = 0; i < 300; i++) {
      const item = listing(usdc.sac, i);
      await store.transaction(item.identity, (tx) =>
        tx.insert(item, {
          listingId: item.id,
          version: 1,
          createdAt: new Date(),
          cause: "settlement",
          owner: item.owner,
          trust: item.trust,
          state: item.state,
          content: item.content,
        }),
      );
    }
    const deadline = Date.now() + 60_000;
    while (!(await service.runtime.readiness()).ready) {
      if (Date.now() > deadline) throw new Error("the service did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }, 120_000);

  afterAll(async () => {
    await service.stop();
  });

  /** Settles one fresh `exact` payment through `/settle`; its outcome and how long it took. */
  async function settle(): Promise<{ success: boolean; ms: number }> {
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const requirements = requirementsFor(usdc.sac, seller.publicKey(), 1_000n);
    const payload = await net.payment(payer, requirements);
    const started = performance.now();
    const response = await fetch(`${service.url}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
    });
    const body = (await response.json()) as { success?: boolean };
    return { success: response.status === 200 && body.success === true, ms: performance.now() - started };
  }

  it("sheds a discovery flood with coded 503s while settlement, /health and /ready answer", async () => {
    const query = (i: number) =>
      i % 2 === 0
        ? `${service.url}/discovery/search?query=${encodeURIComponent(`weather forecast ${String(i)}`)}`
        : `${service.url}/discovery/resources?limit=100&offset=${String(i % 200)}`;
    const flood = { running: true };
    const probes: Timed[] = [];
    const probing = (async () => {
      while (flood.running) {
        probes.push(await timedGet(`${service.url}/health`));
        probes.push(await timedGet(`${service.url}/ready/testnet`));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
    const flooding = Promise.all(Array.from({ length: FLOOD }, (_, i) => timedGet(query(i))));
    const settled = await settle();
    const answers = await flooding;
    flood.running = false;
    await probing;

    // Settlement went through beside the flood.
    expect(settled.success).toBe(true);
    expect(settled.ms).toBeLessThan(15_000);
    // Every discovery answer is a 200 or a coded 503: never a 500, never a hang.
    const statuses = new Map<string, number>();
    for (const answer of answers) {
      const key = `${String(answer.status)} ${answer.code ?? ""}`;
      statuses.set(key, (statuses.get(key) ?? 0) + 1);
    }
    expect([...statuses.keys()].every((key) => key === "200 " || key.startsWith("503 discovery_"))).toBe(
      true,
    );
    expect(statuses.get("503 discovery_overloaded") ?? 0).toBeGreaterThan(FLOOD / 10);
    expect(statuses.get("200 ") ?? 0).toBeGreaterThan(0);
    expect(Math.max(...answers.map((answer) => answer.ms))).toBeLessThan(10_000);
    // Health and per-network readiness answered throughout, promptly.
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((probe) => probe.status === 200)).toBe(true);
    expect(Math.max(...probes.map((probe) => probe.ms))).toBeLessThan(2_000);
    const shed = await service.metrics.registry.getSingleMetricAsString("rail402_discovery_shed_total");
    expect(shed).toMatch(/reason="admission"\} [1-9]/);
  }, 120_000);

  it("refuses discovery with a code while its pool is held, and settles through the other pools", async () => {
    const store = service.runtime.bazaar?.store;
    if (store === undefined) throw new Error("the service has no catalog");
    // Hold both connections of the discovery pool, as a burst of slow catalog reads would.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holders = [0, 1].map((i) => store.transaction(listing(usdc.sac, 10_000 + i).identity, () => held));
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      const page = await timedGet(`${service.url}/discovery/resources`);
      expect(page.status).toBe(503);
      expect(page.code).toBe("discovery_overloaded");
      expect(page.ms).toBeLessThan(ACQUIRE_TIMEOUT_MS + 1_500);

      const [settled, health, ready, readyNetwork] = await Promise.all([
        settle(),
        timedGet(`${service.url}/health`),
        timedGet(`${service.url}/ready`),
        timedGet(`${service.url}/ready/testnet`),
      ]);
      expect(settled.success).toBe(true);
      expect(settled.ms).toBeLessThan(15_000);
      for (const probe of [health, ready, readyNetwork]) {
        expect(probe.status).toBe(200);
        expect(probe.ms).toBeLessThan(1_000);
      }
    } finally {
      release();
      await Promise.all(holders);
    }
    // Once the pool is free, discovery answers again.
    expect((await timedGet(`${service.url}/discovery/resources`)).status).toBe(200);
  }, 60_000);

  it("keeps the search index current while every discovery connection is held", async () => {
    const store = service.runtime.bazaar?.store;
    const search = service.runtime.bazaar?.search;
    if (store === undefined || search === undefined) throw new Error("the service has no catalog");
    const late = listing(usdc.sac, 20_000);
    await store.transaction(late.identity, (tx) =>
      tx.insert(late, {
        listingId: late.id,
        version: 1,
        createdAt: new Date(),
        cause: "settlement",
        owner: late.owner,
        trust: late.trust,
        state: late.state,
        content: late.content,
      }),
    );
    const revision = await store.revision();
    // Hold both connections of the discovery pool, as a burst of slow catalog reads would.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holders = [0, 1].map((i) => store.transaction(listing(usdc.sac, 20_001 + i).identity, () => held));
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      // The index is built through connections of its own, so discovery load never fails a build.
      const snapshot = await search.refresh();
      expect(snapshot.revision).toBe(revision);
      expect(snapshot.listings.has(late.id)).toBe(true);
    } finally {
      release();
      await Promise.all(holders);
    }
  }, 60_000);
});
