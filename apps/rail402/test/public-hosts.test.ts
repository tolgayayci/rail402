import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { silentLogger, type StellarFacilitator } from "@rail402.dev/facilitator";
import {
  type AppDependencies,
  type CallerRateLimiter,
  type ConfigError,
  Metrics,
  createApp,
  loadConfig,
  newAccessKey,
} from "@rail402.dev/service";
import { COLD_SIGNER, secretFile, sponsorKeyFile } from "./secret-fixtures.ts";

const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const env = {
  NETWORKS: "stellar:testnet,stellar:pubnet",
  STORE: "memory",
  METRICS_PRIVATE_TOKEN_SHA256: "ab".repeat(32),
  TESTNET_RPC_URL: "http://localhost:8000/rpc",
  TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
  PUBNET_RPC_SINGLE_PROVIDER: "true",
  PUBNET_RPC_URL: "https://mainnet.example/rpc",
  PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(Keypair.random().secret()),
  PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
  PUBNET_REQUIRE_API_KEY: "false",
  PUBNET_RATE_LIMIT_PER_MINUTE: "60",
  PUBNET_KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR: "1",
  PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "10",
  PUBNET_MAX_TX_FEE_STROOPS: "300000",
  PUBNET_INCLUSION_FEE_STROOPS: "200",
  PUBNET_ASSETS: `${USDC}:USDC:7:10000`,
  PUBLIC_HOSTS: "testnet.rail402.example=stellar:testnet,mainnet.rail402.example=stellar:pubnet",
};

function make(changes: Record<string, string> = {}, deps: Partial<AppDependencies> = {}) {
  const config = loadConfig({ ...env, ...changes });
  const accounts = { "stellar:testnet": "GTESTNETSPONSOR", "stellar:pubnet": "GPUBNETSPONSOR" } as const;
  const facilitator = {
    core: {
      getSupported: () => ({
        kinds: Object.keys(accounts).map((network) => ({
          x402Version: 2,
          scheme: "exact",
          network,
          extra: {},
        })),
        extensions: [],
        signers: { "stellar:*": Object.values(accounts) },
      }),
      verify: () => Promise.resolve({ isValid: true }),
      settle: (_p: unknown, requirements: { network: string }) =>
        Promise.resolve({ success: true, transaction: "a".repeat(64), network: requirements.network }),
    },
    networks: new Map(
      Object.entries(accounts).map(([network, address]) => [
        network,
        { engine: { facilitatorAddresses: new Set([address]) } },
      ]),
    ),
  } as unknown as StellarFacilitator;
  return createApp({
    config,
    facilitator,
    metrics: new Metrics(),
    log: silentLogger,
    readiness: () => Promise.resolve({ ready: true, checks: {} }),
    version: "test",
    ...deps,
  });
}

const verify = (app: ReturnType<typeof make>, host: string, network: string) => {
  const requirements = {
    scheme: "exact",
    network,
    asset: USDC,
    payTo: Keypair.random().publicKey(),
    amount: "10000",
    maxTimeoutSeconds: 60,
    extra: {},
  };
  return app.request("/verify", {
    method: "POST",
    headers: { "content-type": "application/json", host },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: "AAAA" } },
      paymentRequirements: requirements,
    }),
  });
};

describe("host-scoped views", () => {
  it("shows a scoped host only its network's kinds and signers", async () => {
    const app = make();
    const mainnet = (await (
      await app.request("/supported", { headers: { host: "mainnet.rail402.example" } })
    ).json()) as {
      kinds: { network: string }[];
      signers: Record<string, string[]>;
    };
    expect(mainnet.kinds.map((kind) => kind.network)).toEqual(["stellar:pubnet"]);
    expect(mainnet.signers).toEqual({ "stellar:*": ["GPUBNETSPONSOR"] });
    // With a port, too.
    const testnet = (await (
      await app.request("/supported", { headers: { host: "TESTNET.rail402.example:443" } })
    ).json()) as {
      kinds: { network: string }[];
    };
    expect(testnet.kinds.map((kind) => kind.network)).toEqual(["stellar:testnet"]);
    // An unlisted host (an internal caller) sees everything.
    const internal = (await (
      await app.request("/supported", { headers: { host: "facilitator:8080" } })
    ).json()) as { kinds: unknown[] };
    expect(internal.kinds).toHaveLength(2);
  });

  it("refuses the other network on a scoped host, naming the host that serves it", async () => {
    const app = make();
    const refused = await verify(app, "testnet.rail402.example", "stellar:pubnet");
    expect(await refused.json()).toMatchObject({
      isValid: false,
      invalidReason: "invalid_network",
      invalidMessage:
        "This host serves stellar:testnet only; send stellar:pubnet payments to mainnet.rail402.example.",
    });
    expect(await (await verify(app, "mainnet.rail402.example", "stellar:pubnet")).json()).toMatchObject({
      isValid: true,
    });
    expect(await (await verify(app, "facilitator:8080", "stellar:testnet")).json()).toMatchObject({
      isValid: true,
    });
  });

  it("refuses an invalid host map", () => {
    for (const value of [
      "testnet.example=stellar:futurenet",
      "bad host=stellar:testnet",
      "a.example=stellar:testnet,a.example=stellar:pubnet",
    ]) {
      try {
        loadConfig({ ...env, PUBLIC_HOSTS: value });
        expect.unreachable(value);
      } catch (error) {
        expect((error as ConfigError).code, value).toBe("config_public_hosts_invalid");
      }
    }
  });
});

describe("the per-address limit on the pubnet host", () => {
  const MAINNET = "mainnet.rail402.example";
  const TESTNET = "testnet.rail402.example";
  const holder = newAccessKey("mainnet-1");
  const tester = newAccessKey("tester-1");
  const lifetime = { expiresAt: "2099-01-01T00:00:00Z", createdAt: "2098-06-01T00:00:00Z" };
  const keys = {
    TRUSTED_PROXY_HOPS: "1",
    API_KEYS_FILE: secretFile(
      JSON.stringify({
        schemaVersion: 1,
        keys: [
          {
            id: "mainnet-1",
            sha256: holder.sha256,
            networks: ["stellar:pubnet"],
            sponsorBudgetXlmPerHour: "1",
            ...lifetime,
          },
          { id: "tester-1", sha256: tester.sha256, networks: ["stellar:testnet"], ...lifetime },
        ],
      }),
    ),
  };
  const required = { ...keys, PUBNET_REQUIRE_API_KEY: "true" };
  /** The key file of a process that serves pubnet alone: no key for a network it does not serve. */
  const pubnetKeys = secretFile(
    JSON.stringify({
      schemaVersion: 1,
      keys: [
        {
          id: "mainnet-1",
          sha256: holder.sha256,
          networks: ["stellar:pubnet"],
          sponsorBudgetXlmPerHour: "1",
          ...lifetime,
        },
      ],
    }),
  );

  /**
   * An app whose shared, pubnet and network limiters record the buckets they are asked for; without
   * `ownPool`, pubnet has no limiter of its own, as when it is served alone.
   */
  function limited(changes: Record<string, string>, deps: Partial<AppDependencies> = {}, ownPool = true) {
    const taken = { shared: [] as string[], pubnet: [] as string[], network: [] as string[] };
    const recording = (into: string[]): CallerRateLimiter => ({
      enabled: true,
      take: (key) => {
        into.push(key);
        return 0;
      },
      takeLimit: (key) => {
        into.push(key);
        return 0;
      },
      sweep: () => undefined,
    });
    const app = make(changes, {
      rateLimiter: recording(taken.shared),
      ...(ownPool ? { pubnetRateLimiter: recording(taken.pubnet) } : {}),
      networkLimiter: {
        takeLimit: (key) => {
          taken.network.push(key);
          return 0;
        },
        sweep: () => undefined,
      },
      ...deps,
    });
    return { app, taken };
  }

  const pay = (
    app: ReturnType<typeof make>,
    host: string,
    network: string,
    address: string,
    headers: Record<string, string> = {},
  ) => {
    const requirements = {
      scheme: "exact",
      network,
      asset: USDC,
      payTo: Keypair.random().publicKey(),
      amount: "10000",
      maxTimeoutSeconds: 60,
      extra: {},
    };
    return app.request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json", host, "x-forwarded-for": address, ...headers },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: "AAAA" } },
        paymentRequirements: requirements,
      }),
    });
  };

  it("limits a pubnet key holder through pubnet's limiter and nobody else there through a shared one", async () => {
    const { app, taken } = limited(required);
    const settled = await pay(app, MAINNET, "stellar:pubnet", "198.51.100.1", { "x-api-key": holder.key });
    expect(settled.status).toBe(200);
    expect(taken).toEqual({
      shared: [],
      pubnet: ["key:mainnet-1"],
      network: ["n:stellar:pubnet|k:mainnet-1"],
    });

    // No key, an unknown key, a testnet-only key or two different keys: the key is decided in memory
    // first, so none of them reaches a database-backed limiter before it is refused.
    const refused: Record<string, string>[] = [
      {},
      { "x-api-key": "not-a-key" },
      { "x-api-key": tester.key },
      { authorization: "Bearer one", "x-api-key": "two" },
    ];
    for (const headers of refused) {
      const answer = await pay(app, MAINNET, "stellar:pubnet", "198.51.100.2", headers);
      expect(answer.status, JSON.stringify(headers)).toBeOneOf([401, 403]);
    }
    const supported = await app.request("/supported", {
      headers: { host: MAINNET, "x-forwarded-for": "198.51.100.2" },
    });
    expect(supported.status).toBe(200);
    expect(taken).toEqual({
      shared: [],
      pubnet: ["key:mainnet-1"],
      network: ["n:stellar:pubnet|k:mainnet-1"],
    });

    // The testnet host and unlisted hosts, where the network is known only from the body, keep the
    // shared limiter.
    expect((await pay(app, TESTNET, "stellar:testnet", "203.0.113.1")).status).toBe(200);
    const unlisted = await pay(app, "facilitator:8080", "stellar:pubnet", "203.0.113.2", {
      "x-api-key": holder.key,
    });
    expect(unlisted.status).toBe(200);
    expect(taken.shared).toEqual(["addr:203.0.113.1", "key:mainnet-1"]);
    expect(taken.pubnet).toEqual(["key:mainnet-1"]);
  });

  it("still limits keyless callers of the pubnet host, in the process", async () => {
    const { app, taken } = limited({ ...required, RATE_LIMIT_PER_MINUTE: "2" });
    const statuses = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await pay(app, MAINNET, "stellar:pubnet", "198.51.100.3")).status);
    expect(statuses).toEqual([401, 401, 429]);
    expect(taken).toEqual({ shared: [], pubnet: [], network: [] });
  });

  it("serves keyless callers where pubnet allows them, limited in the process and by pubnet's keyless limit", async () => {
    const { app, taken } = limited({ ...keys, RATE_LIMIT_PER_MINUTE: "2" });
    const statuses = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await pay(app, MAINNET, "stellar:pubnet", "198.51.100.4")).status);
    expect(statuses).toEqual([200, 200, 429]);
    expect(taken.shared).toEqual([]);
    expect(taken.pubnet).toEqual([]);
    expect(taken.network).toEqual(["n:stellar:pubnet|ip:198.51.100.4", "n:stellar:pubnet|ip:198.51.100.4"]);
    // A key holder there is still limited through pubnet's limiter.
    await pay(app, MAINNET, "stellar:pubnet", "198.51.100.5", { "x-api-key": holder.key });
    expect(taken.pubnet).toEqual(["key:mainnet-1"]);
  });

  it("decides the key first in a process that serves pubnet alone, through its one database limiter", async () => {
    const alone = {
      NETWORKS: "stellar:pubnet",
      PUBNET_REQUIRE_API_KEY: "true",
      TRUSTED_PROXY_HOPS: "1",
      API_KEYS_FILE: pubnetKeys,
    };
    // With its host listed, and without PUBLIC_HOSTS, where every request is pubnet's anyway.
    for (const [hosts, host] of [
      [`${MAINNET}=stellar:pubnet`, MAINNET],
      ["", "facilitator:8080"],
    ] as const) {
      const { app, taken } = limited({ ...alone, PUBLIC_HOSTS: hosts }, {}, false);
      const anonymous: Record<string, string>[] = [{}, { "x-api-key": "not-a-key" }];
      for (const headers of anonymous) {
        expect((await pay(app, host, "stellar:pubnet", "198.51.100.8", headers)).status).toBe(401);
      }
      expect(taken.shared).toEqual([]);
      const settled = await pay(app, host, "stellar:pubnet", "198.51.100.9", { "x-api-key": holder.key });
      expect(settled.status).toBe(200);
      expect(taken).toEqual({
        shared: ["key:mainnet-1"],
        pubnet: [],
        network: ["n:stellar:pubnet|k:mainnet-1"],
      });
    }
  });

  it("without the Bazaar, limits a discovery path like any other: no anonymous write for pubnet", async () => {
    const discovery: string[] = [];
    const discoveryLimiter = {
      enabled: true,
      take: (key: string) => {
        discovery.push(key);
        return 0;
      },
      takeLimit: (key: string) => {
        discovery.push(key);
        return 0;
      },
      sweep: () => undefined,
    };
    const lookup = (app: ReturnType<typeof make>, host: string, headers: Record<string, string> = {}) =>
      app.request("/discovery/resources", {
        headers: { host, "x-forwarded-for": "198.51.100.11", ...headers },
      });
    // The pubnet host of a process serving both networks, and a process serving pubnet alone.
    const both = limited(required, { discoveryLimiter }, true);
    const alone = limited(
      { ...required, NETWORKS: "stellar:pubnet", PUBLIC_HOSTS: "", API_KEYS_FILE: pubnetKeys },
      { discoveryLimiter },
      false,
    );
    for (const [{ app, taken }, host] of [
      [both, MAINNET],
      [alone, "facilitator:8080"],
    ] as const) {
      expect((await lookup(app, host)).status).toBe(404);
      expect((await lookup(app, host, { "x-api-key": "not-a-key" })).status).toBe(404);
      expect(discovery).toEqual([]);
      expect(taken.shared).toEqual([]);
      expect(taken.pubnet).toEqual([]);
    }
    // A key pubnet admits is limited through the database as on any other path.
    expect((await lookup(both.app, MAINNET, { "x-api-key": holder.key })).status).toBe(404);
    expect(both.taken.pubnet).toEqual(["addr:198.51.100.11"]);
    expect(discovery).toEqual([]);
  });

  it("limits a pubnet key holder in the process while pubnet's limiter cannot answer", async () => {
    const metrics = new Metrics();
    const unavailable = () => Promise.reject(new Error("timeout exceeded when trying to connect"));
    const { app, taken } = limited(
      { ...required, RATE_LIMIT_PER_MINUTE: "1", PUBNET_KEY_DEFAULT_REQUESTS_PER_MINUTE: "1" },
      {
        metrics,
        pubnetRateLimiter: {
          enabled: true,
          take: unavailable,
          takeLimit: unavailable,
          sweep: () => undefined,
        },
      },
    );
    const headers = { "x-api-key": holder.key };
    expect((await pay(app, MAINNET, "stellar:pubnet", "198.51.100.6", headers)).status).toBe(200);
    expect((await pay(app, MAINNET, "stellar:pubnet", "198.51.100.6", headers)).status).toBe(429);
    expect(taken.shared).toEqual([]);
    expect(await metrics.registry.getSingleMetricAsString("rail402_rate_limiter_failures_total")).toContain(
      'scope="key"} 2',
    );
  });
});

describe("a key holder's own limit", () => {
  const MAINNET = "mainnet.rail402.example";
  const TESTNET = "testnet.rail402.example";
  const UNLISTED = "facilitator:8080";
  const payer = newAccessKey("payer-1");
  const tester = newAccessKey("tester-2");
  const both = newAccessKey("both-1");
  const plain = newAccessKey("plain-1");
  const lifetime = { expiresAt: "2099-01-01T00:00:00Z", createdAt: "2098-06-01T00:00:00Z" };
  const pubnetOnly = { networks: ["stellar:pubnet"], sponsorBudgetXlmPerHour: "1", ...lifetime };
  const limits = {
    TRUSTED_PROXY_HOPS: "1",
    PUBNET_REQUIRE_API_KEY: "true",
    API_KEYS_FILE: secretFile(
      JSON.stringify({
        schemaVersion: 1,
        keys: [
          { id: "payer-1", sha256: payer.sha256, requestsPerMinute: 4, ...pubnetOnly },
          {
            id: "tester-2",
            sha256: tester.sha256,
            networks: ["stellar:testnet"],
            requestsPerMinute: 4,
            ...lifetime,
          },
          {
            id: "both-1",
            sha256: both.sha256,
            requestsPerMinute: 2,
            ...pubnetOnly,
            networks: ["stellar:testnet", "stellar:pubnet"],
          },
          { id: "plain-1", sha256: plain.sha256, ...pubnetOnly },
        ],
      }),
    ),
  };

  const call = (
    app: ReturnType<typeof make>,
    operation: "verify" | "settle",
    host: string,
    network: string,
    address: string,
    headers: Record<string, string> = {},
  ) => {
    const requirements = {
      scheme: "exact",
      network,
      asset: USDC,
      payTo: Keypair.random().publicKey(),
      amount: "10000",
      maxTimeoutSeconds: 60,
      extra: {},
    };
    return app.request(`/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json", host, "x-forwarded-for": address, ...headers },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: "AAAA" } },
        paymentRequirements: requirements,
      }),
    });
  };

  /** Anonymous traffic of both networks from `address`, on every kind of host, until its limits refuse it. */
  async function spend(app: ReturnType<typeof make>, address: string) {
    const statuses: number[] = [];
    for (const host of [TESTNET, UNLISTED]) {
      statuses.push((await call(app, "settle", host, "stellar:testnet", address)).status);
      statuses.push((await app.request("/nope", { headers: { host, "x-forwarded-for": address } })).status);
    }
    for (let i = 0; i < 3; i++) {
      statuses.push((await call(app, "settle", MAINNET, "stellar:pubnet", address)).status);
    }
    statuses.push(
      (await call(app, "settle", UNLISTED, "stellar:pubnet", address, { "x-api-key": "not-a-key" })).status,
    );
    return statuses;
  }

  it("never lets anonymous or other-network traffic from its address or /64 spend a key holder's limit", async () => {
    const holders = [
      { host: MAINNET, network: "stellar:pubnet", key: payer.key },
      { host: UNLISTED, network: "stellar:pubnet", key: payer.key },
      { host: TESTNET, network: "stellar:testnet", key: tester.key },
    ];
    const places = [
      { spentFrom: "203.0.113.50", holderAt: "203.0.113.50" },
      { spentFrom: "2001:db8:aa:1::1", holderAt: "2001:db8:aa:1::ffff" },
    ];
    for (const { host, network, key } of holders) {
      for (const { spentFrom, holderAt } of places) {
        const metrics = new Metrics();
        const app = make({ ...limits, RATE_LIMIT_PER_MINUTE: "2" }, { metrics });
        // The address's limit of 2 a minute is spent; its keyless pubnet callers are limited in the process.
        expect(await spend(app, spentFrom)).toEqual([200, 404, 429, 429, 401, 401, 429, 429]);
        // The key holder there is served up to its own 4 a minute, above the address's limit.
        const statuses: number[] = [];
        for (const operation of ["verify", "settle", "verify", "settle", "settle"] as const) {
          statuses.push((await call(app, operation, host, network, holderAt, { "x-api-key": key })).status);
        }
        expect(statuses, `${host} ${holderAt}`).toEqual([200, 200, 200, 200, 429]);
        const limited = await metrics.registry.getSingleMetricAsString("rail402_rate_limited_total");
        expect(limited).toContain('scope="ip"} 4');
        expect(limited).toContain('scope="key"} 1');
      }
    }
  });

  it("sizes a key's own limit to every network it may use, never below RATE_LIMIT_PER_MINUTE", async () => {
    const app = make({ ...limits, RATE_LIMIT_PER_MINUTE: "1", PUBNET_KEY_DEFAULT_REQUESTS_PER_MINUTE: "3" });
    const headers = { "x-api-key": both.key };
    // Two a minute on each of its networks, from one address and one host.
    const statuses: number[] = [];
    for (const network of ["stellar:testnet", "stellar:pubnet", "stellar:testnet", "stellar:pubnet"]) {
      statuses.push((await call(app, "settle", UNLISTED, network, "198.51.100.60", headers)).status);
    }
    statuses.push((await call(app, "settle", UNLISTED, "stellar:pubnet", "198.51.100.60", headers)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
    // A key without a limit of its own reaches its network's default.
    const defaults: number[] = [];
    for (let i = 0; i < 4; i++) {
      defaults.push(
        (await call(app, "settle", MAINNET, "stellar:pubnet", "198.51.100.61", { "x-api-key": plain.key }))
          .status,
      );
    }
    expect(defaults).toEqual([200, 200, 200, 429]);
  });

  it("keeps a key the host's network does not admit on its address's limit", async () => {
    const app = make({ ...limits, RATE_LIMIT_PER_MINUTE: "1" });
    const settle = async (key: string) =>
      (await call(app, "settle", TESTNET, "stellar:testnet", "198.51.100.62", { "x-api-key": key })).status;
    // A pubnet key on the testnet host pays as a keyless caller there, and is limited like one.
    expect([await settle(payer.key), await settle(payer.key)]).toEqual([200, 429]);
    // A testnet key from the same address keeps its own limit.
    expect([await settle(tester.key), await settle(tester.key)]).toEqual([200, 200]);
  });

  it("never lets a key carry payments past its address's limit on a network that does not admit it", async () => {
    const app = make({ ...limits, RATE_LIMIT_PER_MINUTE: "2" });
    const settle = async (verb: "verify" | "settle", network: string, key?: string) =>
      (
        await call(
          app,
          verb,
          UNLISTED,
          network,
          "198.51.100.63",
          key === undefined ? {} : { "x-api-key": key },
        )
      ).status;
    // Testnet does not admit the pubnet key: there it pays as a keyless caller, from its address's limit.
    const keyless = [
      await settle("settle", "stellar:testnet", payer.key),
      await settle("verify", "stellar:testnet", payer.key),
      await settle("settle", "stellar:testnet", payer.key),
    ];
    expect(keyless).toEqual([200, 200, 429]);
    // That limit is the address's: anonymous callers there are refused too.
    expect(await settle("settle", "stellar:testnet")).toBe(429);
    // Its pubnet payments still draw on its own limit of 4, which the three above spent from.
    expect(await settle("settle", "stellar:pubnet", payer.key)).toBe(200);
    expect(await settle("settle", "stellar:pubnet", payer.key)).toBe(429);
  });
});
