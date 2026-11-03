/**
 * Pubnet's own connection pool against Postgres (docker compose up -d postgres).
 *
 * With several networks served, testnet work (settlements, cataloging, limiter writes from many
 * addresses) can hold every connection of the shared pool. Pubnet's settle path must not wait for it:
 * its request and party limits, its metering and its settlement ledger use a pool of their own, and
 * every pool gives up after its acquire timeout so a saturated pool is refused with a code instead of
 * queueing requests without end. Neither may the process's readiness, nor the service-wide limit of a
 * request to the pubnet host; and anonymous callers there, or scraping /metrics anywhere, never take a
 * connection of pubnet's pool.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { sql, type Kysely } from "kysely";
import { SettleLimits, silentLogger } from "@rail402.dev/facilitator";
import {
  PostgresCatalogStore,
  PostgresSettlementLedger,
  createDatabase,
  migrate,
  type Database,
} from "@rail402.dev/store-postgres";
import type { CatalogStore } from "@rail402.dev/bazaar";
import {
  Metrics,
  PUBNET_POOL_SIZE,
  createAccessStores,
  createApp,
  createRuntime,
  discoveryLaneContext,
  laneRouted,
  loadConfig,
  newAccessKey,
  type Runtime,
} from "@rail402.dev/service";
import { COLD_SIGNER, secretFile, sponsorKeyFile } from "./secret-fixtures.ts";
import { DATABASE_URL, createServiceSchema, dropServiceSchema } from "./service-harness.ts";

const PUBNET = "stellar:pubnet";
const TESTNET = "stellar:testnet";
const ACQUIRE_TIMEOUT_MS = 500;
const SATURATE_SECONDS = 4;

describe("pubnet's own database pool", () => {
  let schema: string;
  let shared: Kysely<Database>;
  let pubnet: Kysely<Database>;

  beforeAll(async () => {
    schema = await createServiceSchema();
    const url = `${DATABASE_URL}?options=-c%20search_path%3D${schema}`;
    shared = createDatabase({
      connectionString: url,
      maxConnections: 2,
      acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
    });
    pubnet = createDatabase({
      connectionString: url,
      maxConnections: 2,
      acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
    });
    await migrate(shared);
  });

  afterAll(async () => {
    await shared.destroy();
    await pubnet.destroy();
    await dropServiceSchema(schema);
  });

  /** Holds every connection of `db` for a few seconds, as a flood of slow queries would. */
  const saturate = (db: Kysely<Database>) =>
    Promise.all([1, 2].map(() => sql`SELECT pg_sleep(${SATURATE_SECONDS})`.execute(db)));

  const timed = async <T>(work: () => Promise<T>) => {
    const started = Date.now();
    const value = await work();
    return { value, ms: Date.now() - started };
  };

  it("settles pubnet through its own pool while testnet holds every shared connection", async () => {
    const stores = createAccessStores(shared, pubnet, { rateLimitPerMinute: 600, pubnet: PUBNET });
    const ledger = new PostgresSettlementLedger(pubnet);
    const limits = new SettleLimits({
      network: PUBNET,
      take: (key, perMinute) => stores.partyLimiter.takeLimit(key, perMinute),
      payerPerMinute: 10,
      payToPerMinute: 60,
      failuresPerHour: 3,
      ledger,
      failClosed: true,
    });
    const flood = saturate(shared);
    // Let the sleeps take both shared connections.
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Every step of a pubnet settlement that touches the database answers at once.
    const steps = await timed(async () => {
      expect(await stores.networkLimiter.takeLimit(`n:${PUBNET}|k:key-1`, 60)).toBe(0);
      expect(
        await limits.admit({ network: PUBNET, scheme: "exact", payer: "GPAYER", payTo: "GSELLER" }),
      ).toEqual({
        ok: true,
      });
      const claim = await ledger.claim(
        { network: PUBNET, payer: "GPAYER", nonce: "1" },
        { payloadHash: "p", requestHash: "r" },
        "owner",
        60_000,
      );
      expect(claim.kind).toBe("claimed");
      expect(
        await limits.admitVerified({ network: PUBNET, scheme: "exact", payer: "GPAYER", payTo: "GSELLER" }),
      ).toEqual({ ok: true });
      await stores.meter.record({
        subject: "key:key-1",
        network: PUBNET,
        operation: "settle",
        outcome: "success",
        asset: "",
        settledAmount: "1",
      });
    });
    expect(steps.ms).toBeLessThan(SATURATE_SECONDS * 1_000 - 1_000);

    // Testnet's own limiter, on the saturated pool, fails fast instead of waiting for a connection.
    const testnet = await timed(() =>
      Promise.resolve(stores.networkLimiter.takeLimit(`n:${TESTNET}|ip:203.0.113.7`, 60)).then(
        () => "answered",
        () => "refused",
      ),
    );
    expect(testnet.value).toBe("refused");
    expect(testnet.ms).toBeLessThan(ACQUIRE_TIMEOUT_MS + 1_000);
    await flood;
  }, 30_000);

  it("refuses pubnet with a code, not a hang, once its own pool is saturated", async () => {
    const stores = createAccessStores(shared, pubnet, { rateLimitPerMinute: 600, pubnet: PUBNET });
    const limits = new SettleLimits({
      network: PUBNET,
      take: (key, perMinute) => stores.partyLimiter.takeLimit(key, perMinute),
      payerPerMinute: 10,
      failClosed: true,
    });
    const flood = saturate(pubnet);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const refused = await timed(() =>
      limits.admitVerified({ network: PUBNET, scheme: "exact", payer: "GPAYER2", payTo: "GSELLER" }),
    );
    expect(refused.value).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/cannot be checked/) as string,
    });
    expect(refused.ms).toBeLessThan(ACQUIRE_TIMEOUT_MS + 1_000);
    await flood;
  }, 30_000);

  it("serves pubnet-scoped discovery through its own pool while the shared discovery pool is saturated", async () => {
    const stores = createAccessStores(shared, pubnet, {
      rateLimitPerMinute: 600,
      pubnet: PUBNET,
      discoveryDb: shared,
      pubnetDiscoveryDb: pubnet,
    });
    const reads = laneRouted<CatalogStore>(
      new PostgresCatalogStore(shared),
      new Map([["pubnet", new PostgresCatalogStore(pubnet)]]),
    );
    const flood = saturate(shared);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const pubnetRead = await timed(() =>
      discoveryLaneContext.run("pubnet", async () => {
        expect(await stores.discoveryLimiter?.take("ip:203.0.113.9")).toBe(0);
        return reads.list({ limit: 1, offset: 0 });
      }),
    );
    expect(pubnetRead.value.total).toBeGreaterThanOrEqual(0);
    expect(pubnetRead.ms).toBeLessThan(SATURATE_SECONDS * 1_000 - 1_000);
    // A shared-lane read on the saturated pool fails fast.
    const sharedRead = await timed(() =>
      discoveryLaneContext
        .run("shared", () => reads.list({ limit: 1, offset: 0 }))
        .then(
          () => "answered",
          () => "refused",
        ),
    );
    expect(sharedRead.value).toBe("refused");
    await flood;
  }, 30_000);
});

describe("one process serving testnet and pubnet while testnet holds every shared connection", () => {
  // Connections of the shared pool (createDatabase's default size).
  const SHARED_POOL_SIZE = 10;
  const ACQUIRE_MS = 1_000;
  /** `RATE_LIMIT_PER_MINUTE`, per client address; the key holder's own limit is 1,000. */
  const ADDRESS_LIMIT = 30;
  const TESTNET_HOST = "testnet.example";
  const MAINNET_HOST = "mainnet.example";
  const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
  const suffix = randomBytes(4).toString("hex");
  const schema = `pubpool_${suffix}`;
  const owner = `rail402_ppowner_${suffix}`;
  const service = `rail402_ppapp_${suffix}`;
  const password = randomBytes(12).toString("hex");
  const holder = newAccessKey("mainnet-holder-1");
  let admin: Kysely<Database>;
  let runtime: Runtime;
  let app: ReturnType<typeof createApp>;
  let metrics: Metrics;

  const urlFor = (role: string) => {
    const url = new URL(DATABASE_URL);
    url.username = role;
    url.password = password;
    url.search = `?options=-c%20search_path%3D${schema}`;
    return url.toString();
  };

  beforeAll(async () => {
    // Pubnet runs as a role that only reads and writes rows; the schema owner applies the migrations.
    admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 4 });
    for (const statement of [
      sql`CREATE SCHEMA ${sql.id(schema)}`,
      sql`CREATE ROLE ${sql.id(owner)} LOGIN PASSWORD ${sql.lit(password)}`,
      sql`CREATE ROLE ${sql.id(service)} LOGIN PASSWORD ${sql.lit(password)}`,
      sql`GRANT USAGE, CREATE ON SCHEMA ${sql.id(schema)} TO ${sql.id(owner)}`,
      sql`GRANT USAGE ON SCHEMA ${sql.id(schema)} TO ${sql.id(service)}`,
      sql`ALTER DEFAULT PRIVILEGES FOR ROLE ${sql.id(owner)} IN SCHEMA ${sql.id(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${sql.id(service)}`,
      sql`ALTER DEFAULT PRIVILEGES FOR ROLE ${sql.id(owner)} IN SCHEMA ${sql.id(schema)} GRANT USAGE, SELECT ON SEQUENCES TO ${sql.id(service)}`,
    ]) {
      await statement.execute(admin);
    }
    const ownerDb = createDatabase({ connectionString: urlFor(owner), maxConnections: 1 });
    await migrate(ownerDb);
    await ownerDb.destroy();

    const config = loadConfig({
      NETWORKS: "stellar:testnet,stellar:pubnet",
      PUBLIC_HOSTS: `${TESTNET_HOST}=stellar:testnet,${MAINNET_HOST}=stellar:pubnet`,
      TRUSTED_PROXY_HOPS: "1",
      // Small enough for a test to spend an address's limit.
      RATE_LIMIT_PER_MINUTE: String(ADDRESS_LIMIT),
      DATABASE_URL_FILE: secretFile(urlFor(service)),
      MIGRATE_ON_START: "false",
      DATABASE_ACQUIRE_TIMEOUT_MS: String(ACQUIRE_MS),
      BAZAAR_ENABLED: "false",
      SEARCH_EMBEDDINGS: "false",
      METRICS_PRIVATE_TOKEN_SHA256: "c0ffee".padEnd(64, "0"),
      // No RPC answers: both networks start held, which readiness does not gate on with two networks.
      TESTNET_RPC_URL: "http://127.0.0.1:9/rpc",
      TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
      TESTNET_UPTO_ENABLED: "false",
      TESTNET_STARTUP_TIMEOUT_MS: "1000",
      PUBNET_RPC_SINGLE_PROVIDER: "true",
      PUBNET_RPC_URL: "https://127.0.0.1:9/rpc",
      PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(Keypair.random().secret()),
      PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
      PUBNET_REQUIRE_API_KEY: "true",
      API_KEYS_FILE: secretFile(
        JSON.stringify({
          schemaVersion: 1,
          keys: [
            {
              id: "mainnet-holder-1",
              sha256: holder.sha256,
              networks: [PUBNET],
              requestsPerMinute: 1000,
              sponsorBudgetXlmPerHour: "1",
              expiresAt: "2099-01-01T00:00:00Z",
              createdAt: "2098-06-01T00:00:00Z",
            },
          ],
        }),
      ),
      PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "10",
      PUBNET_MAX_TX_FEE_STROOPS: "300000",
      PUBNET_INCLUSION_FEE_STROOPS: "200",
      PUBNET_ASSETS: `${USDC}:USDC:7:10000`,
      PUBNET_STARTUP_TIMEOUT_MS: "1000",
      PUBNET_UPTO_ENABLED: "true",
      PUBNET_UPTO_CONTRACT: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      PUBNET_UPTO_WASM_HASH: "ab".repeat(32),
      PUBNET_UPTO_MAX_TX_FEE_STROOPS: "500000",
      PUBNET_UPTO_TTL_MAX_FEE_STROOPS: "50000000",
    });
    metrics = new Metrics();
    runtime = await createRuntime(config, metrics, silentLogger, { version: "test" });
    const access = runtime.access;
    if (access === undefined) throw new Error("expected the Postgres limiters");
    // Wired as main.ts wires them.
    app = createApp({
      config,
      facilitator: runtime.facilitator,
      metrics,
      log: silentLogger,
      readiness: () => runtime.readiness(),
      networkReadiness: (network) => runtime.networkReadiness(network),
      // Pubnet's startup hold is lifted, so its requests reach the key decision and its limits as they
      // would with an RPC that answers.
      refusal: (network) => (network === PUBNET ? undefined : runtime.refusal(network)),
      health: () => runtime.health(),
      version: "test",
      accessKeys: runtime.accessKeys,
      rateLimiter: access.rateLimiter,
      networkLimiter: access.networkLimiter,
      ...(access.discoveryLimiter === undefined ? {} : { discoveryLimiter: access.discoveryLimiter }),
      meter: access.meter,
      ...(access.pubnetRateLimiter === undefined ? {} : { pubnetRateLimiter: access.pubnetRateLimiter }),
    });
  });

  afterAll(async () => {
    try {
      await (runtime as Runtime | undefined)?.stop();
    } finally {
      await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename IN (${service}, ${owner})`.execute(
        admin,
      );
      await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin);
      for (const role of [service, owner]) {
        await sql`DROP OWNED BY ${sql.id(role)}`.execute(admin);
        await sql`DROP ROLE IF EXISTS ${sql.id(role)}`.execute(admin);
      }
      await admin.destroy();
    }
  });

  /**
   * Runs `take` in a transaction left open until the release: whatever it locks, every statement of
   * the service that needs it waits, holding its pooled connection, as statements do on a busy server.
   */
  async function hold(take: (trx: Kysely<Database>) => Promise<void>): Promise<() => Promise<void>> {
    const released = Promise.withResolvers<undefined>();
    const holding = Promise.withResolvers<undefined>();
    const done = admin.transaction().execute(async (trx) => {
      await take(trx);
      holding.resolve(undefined);
      await released.promise;
    });
    await Promise.race([holding.promise, done]);
    return async () => {
      released.resolve(undefined);
      await done;
    };
  }

  /**
   * Holds the rows of the service-wide limit's `buckets` (`addr:<address>`, `key:<id>`), this minute's
   * and the next.
   */
  const holdBuckets = (buckets: readonly string[]) =>
    hold(async (trx) => {
      for (const bucket of buckets) {
        await sql`
          INSERT INTO ${sql.id(schema, "rate_limit_windows")} (key, window_start, count)
          VALUES (${bucket}, date_trunc('minute', now()), 0),
                 (${bucket}, date_trunc('minute', now()) + interval '1 minute', 0)
          ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_windows.count`.execute(trx);
      }
    });

  /** Connections of the service's role waiting for a row lock. */
  const lockWaits = async () => {
    const { rows } = await sql<{ waiting: string }>`
      SELECT count(*) AS waiting FROM pg_stat_activity
      WHERE usename = ${service} AND wait_event_type = 'Lock'`.execute(admin);
    return Number(rows[0]?.waiting ?? 0);
  };

  const send = (url: string, init: RequestInit) => Promise.resolve(app.request(url, init));

  const post = (host: string, path: string, network: string, address: string, headers = {}) =>
    send(`http://${host}${path}`, {
      method: "POST",
      headers: { host, "content-type": "application/json", "x-forwarded-for": address, ...headers },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: {
          x402Version: 2,
          accepted: { scheme: "exact", network },
          payload: { transaction: "AAAA" },
        },
        paymentRequirements: { scheme: "exact", network },
      }),
    });

  /** The response, or undefined when it has not come within the acquire timeout. */
  const answeredInTime = (response: Promise<Response>) =>
    Promise.race([response, sleep(ACQUIRE_MS, undefined)]);

  const served = async () => {
    const counted = await metrics.accessRequests.get();
    return (
      counted.values.find(
        (value) =>
          value.labels["network"] === PUBNET &&
          value.labels["key_id"] === "mainnet-holder-1" &&
          value.labels["outcome"] === "served",
      )?.value ?? 0
    );
  };

  /** Keyless testnet-host requests whose per-address writes wait: they hold every shared connection. */
  async function holdSharedPool(address: string) {
    const release = await holdBuckets([`addr:${address}`]);
    const flood = Array.from({ length: SHARED_POOL_SIZE + 2 }, () =>
      post(TESTNET_HOST, "/verify", TESTNET, address),
    );
    await expect.poll(lockWaits, { timeout: 10_000 }).toBe(SHARED_POOL_SIZE);
    return async () => {
      await release();
      await Promise.all(flood);
    };
  }

  it("stays ready and admits a pubnet key holder at once while keyless testnet traffic holds the shared pool", async () => {
    const release = await holdSharedPool("203.0.113.10");
    try {
      // Readiness asks whether the database answers, not whether the shared pool has a connection free.
      await runtime.readiness();
      await sleep(ACQUIRE_MS + 250);
      expect(await runtime.readiness()).toEqual({ ready: true, checks: { database: { ok: true } } });
      const ready = await send(`http://${MAINNET_HOST}/ready`, { headers: { host: MAINNET_HOST } });
      expect(ready.status).toBe(200);

      // A pubnet key holder's request passes both its limits without waiting for a shared connection.
      const before = await served();
      const started = Date.now();
      const settled = await answeredInTime(
        post(MAINNET_HOST, "/settle", PUBNET, "198.51.100.77", { "x-api-key": holder.key }),
      );
      const elapsed = Date.now() - started;
      expect(settled).toBeDefined();
      expect(elapsed).toBeLessThan(ACQUIRE_MS);
      expect(await served()).toBe(before + 1);
    } finally {
      await release();
    }
  }, 60_000);

  it("admits a pubnet key holder on every host after anonymous testnet traffic spent its address's limit", async () => {
    const address = "198.51.100.90";
    let status = 0;
    for (let sent = 0; status !== 429 && sent <= ADDRESS_LIMIT; sent++) {
      status = (await post(TESTNET_HOST, "/verify", TESTNET, address)).status;
    }
    expect(status).toBe(429);
    const before = await served();
    for (const host of [MAINNET_HOST, "facilitator.internal"]) {
      const answer = await post(host, "/settle", PUBNET, address, { "x-api-key": holder.key });
      expect(answer.status, host).not.toBe(429);
    }
    expect(await served()).toBe(before + 2);
    // The address itself is still over its limit.
    expect((await post(TESTNET_HOST, "/verify", TESTNET, address)).status).toBe(429);
  }, 60_000);

  it("answers /metrics from memory, so anonymous scrapes take no database connection", async () => {
    // Every statement that reads the channel leases waits while this holds their table.
    const release = await hold(async (trx) => {
      await sql`LOCK TABLE ${sql.id(schema, "channels")} IN ACCESS EXCLUSIVE MODE`.execute(trx);
    });
    const scrapes = Array.from({ length: 30 }, () =>
      send(`http://${TESTNET_HOST}/metrics`, { headers: { host: TESTNET_HOST } }),
    );
    try {
      const answers = await Promise.all(scrapes.map(answeredInTime));
      expect(answers.map((answer) => answer?.status)).toEqual(scrapes.map(() => 200));
      expect(await lockWaits()).toBe(0);
      // Pubnet's pool is all free for a key holder's admission.
      const before = await served();
      const started = Date.now();
      const settled = await answeredInTime(
        post(MAINNET_HOST, "/settle", PUBNET, "198.51.100.78", { "x-api-key": holder.key }),
      );
      expect(settled).toBeDefined();
      expect(Date.now() - started).toBeLessThan(ACQUIRE_MS);
      expect(await served()).toBe(before + 1);
    } finally {
      await release();
      await Promise.all(scrapes);
    }
  }, 60_000);

  it("takes pubnet's sponsor lock without a shared connection", async () => {
    const keeper = runtime.uptoKeepers.get(PUBNET);
    if (keeper === undefined) throw new Error("expected pubnet's upto keeper");
    const release = await holdSharedPool("203.0.113.11");
    try {
      // The round gets its lock at once and fails only at the RPC, which does not answer here.
      const started = Date.now();
      const failure = await keeper.maintain().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(Date.now() - started).toBeLessThan(ACQUIRE_MS);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toMatch(/timeout exceeded when trying to connect/);
    } finally {
      await release();
    }
  }, 60_000);

  it("gives keyless and refused mainnet-host callers no pubnet connection and no per-address write", async () => {
    const release = await holdBuckets(["key:mainnet-holder-1", "addr:198.51.100.30"]);
    // Key holders whose writes to their key's bucket wait hold every connection of pubnet's pool.
    const holders = Array.from({ length: PUBNET_POOL_SIZE }, () =>
      post(MAINNET_HOST, "/settle", PUBNET, "198.51.100.20", { "x-api-key": holder.key }),
    );
    const pending: Promise<Response>[] = [];
    try {
      await expect.poll(lockWaits, { timeout: 10_000 }).toBe(PUBNET_POOL_SIZE);

      // The anonymous callers' address row is held too: a request that wrote its per-address limit
      // would not answer.
      const anonymous: Record<string, string>[] = [
        {},
        { "x-api-key": "not-a-key" },
        { authorization: "Bearer one", "x-api-key": "two" },
      ];
      for (const headers of anonymous) {
        for (const path of ["/settle", "/verify"]) {
          const response = post(MAINNET_HOST, path, PUBNET, "198.51.100.30", headers);
          pending.push(response);
          const answer = await answeredInTime(response);
          expect(answer?.status, `${path} ${JSON.stringify(headers)}`).toBe(401);
        }
      }
      const supported = send(`http://${MAINNET_HOST}/supported`, {
        headers: { host: MAINNET_HOST, "x-forwarded-for": "198.51.100.30" },
      });
      pending.push(supported);
      expect((await answeredInTime(supported))?.status).toBe(200);
      // Without the Bazaar a discovery path is limited like any other.
      const discovery = send(`http://${MAINNET_HOST}/discovery/resources`, {
        headers: { host: MAINNET_HOST, "x-forwarded-for": "198.51.100.30" },
      });
      pending.push(discovery);
      expect((await answeredInTime(discovery))?.status).toBe(404);

      // Pubnet's pool is indeed held: a key holder from another address waits for it, and is refused.
      const started = Date.now();
      const refused = await post(MAINNET_HOST, "/settle", PUBNET, "198.51.100.40", {
        "x-api-key": holder.key,
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(ACQUIRE_MS);
      expect(refused.status).toBe(503);
    } finally {
      await release();
      await Promise.all([...holders, ...pending]);
    }
  }, 60_000);
});
