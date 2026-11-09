import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { silentLogger, type StellarFacilitator } from "@rail402.dev/facilitator";
import type { IssueLimits, IssueOutcome, IssueRequest, IssuedKeyRow } from "@rail402.dev/store-postgres";
import {
  AccessKeys,
  ConfigError,
  Metrics,
  SIGNUP_STATE_COOKIE,
  createApp,
  issuedRecord,
  loadConfig,
  newAccessKey,
  parseAccessKeyFile,
  presentedKey,
  type AccessKeyRules,
  type IssuedKeyStore,
} from "@rail402.dev/service";
import { COLD_SIGNER, secretFile, sponsorKeyFile } from "./secret-fixtures.ts";

const TESTNET = "stellar:testnet";
const PUBNET = "stellar:pubnet";
const MAINNET_HOST = "mainnet.example.org";
const TESTNET_HOST = "testnet.example.org";
const DAY = 86_400_000;
const rules: AccessKeyRules = {
  networks: [TESTNET, PUBNET],
  futureNetworks: false,
  maxLifetimeDays: 400,
  max: 1_000,
};
const fileKey = newAccessKey("acme-prod-1");
const keyFile = (issuedKeys?: string) =>
  JSON.stringify({
    schemaVersion: 1,
    ...(issuedKeys === undefined ? {} : { issuedKeys }),
    keys: [
      {
        id: "acme-prod-1",
        sha256: fileKey.sha256,
        networks: [PUBNET],
        sponsorBudgetXlmPerHour: "2",
        expiresAt: "2099-01-01T00:00:00Z",
        createdAt: "2098-06-01T00:00:00Z",
      },
    ],
  });

const env = (changes: Record<string, string> = {}) => ({
  NETWORKS: `${TESTNET},${PUBNET}`,
  STORE: "postgres",
  DATABASE_URL_FILE: secretFile("postgres://rail402@localhost/rail402", 0o440),
  MIGRATE_ON_START: "false",
  METRICS_PRIVATE_TOKEN_SHA256: "ab".repeat(32),
  TESTNET_RPC_URL: "https://soroban-testnet.stellar.org",
  TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
  PUBNET_RPC_SINGLE_PROVIDER: "true",
  PUBNET_RPC_URL: "https://mainnet.sorobanrpc.com",
  PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(Keypair.random().secret()),
  PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
  PUBNET_REQUIRE_API_KEY: "true",
  API_KEYS_FILE: secretFile(keyFile()),
  PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "10",
  PUBNET_MAX_TX_FEE_STROOPS: "300000",
  PUBNET_INCLUSION_FEE_STROOPS: "200",
  PUBNET_ASSETS: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75:USDC:7:10000",
  PUBLIC_HOSTS: `${TESTNET_HOST}=${TESTNET},${MAINNET_HOST}=${PUBNET}`,
  KEY_SIGNUP: "github",
  KEY_SIGNUP_GITHUB_CLIENT_ID: "Iv1.client",
  KEY_SIGNUP_GITHUB_CLIENT_SECRET_FILE: secretFile("client-secret", 0o440),
  KEY_SIGNUP_CALLBACK_URL: `https://${MAINNET_HOST}/keys/callback`,
  ...changes,
});

function refusal(load: () => unknown): ConfigError {
  try {
    load();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("accepted");
}

/** An in-memory store with the database's rules: one key per account, the interval and the hourly cap. */
class FakeStore implements IssuedKeyStore {
  readonly rows = new Map<string, IssuedKeyRow & { readonly issuedAt: number }>();
  failing = false;
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  issue(request: IssueRequest, limits: IssueLimits): Promise<IssueOutcome> {
    if (this.failing) return Promise.reject(new Error("database down"));
    const now = this.now();
    const existing = this.rows.get(request.githubUserId);
    if (existing?.revoked === true) return Promise.resolve({ kind: "revoked" });
    const age = existing === undefined ? Infinity : (now - existing.issuedAt) / 1_000;
    if (age < limits.reissueSeconds)
      return Promise.resolve({ kind: "too_soon", retryAfterSeconds: Math.ceil(limits.reissueSeconds - age) });
    const recent = [...this.rows.values()].filter((row) => now - row.issuedAt < 3_600_000).length;
    if (recent >= limits.perHour) return Promise.resolve({ kind: "cap_reached" });
    const row = {
      id: request.id,
      githubUserId: request.githubUserId,
      githubLogin: request.githubLogin,
      sha256: request.sha256,
      networks: request.networks,
      requestsPerMinute: request.requestsPerMinute,
      sponsorBudgetStroopsPerHour: request.sponsorBudgetStroopsPerHour,
      createdAt: new Date(now),
      expiresAt: new Date(now + request.lifetimeDays * DAY),
      issuedCount: (existing?.issuedCount ?? 0) + 1,
      revoked: false,
      issuedAt: now,
    };
    this.rows.set(request.githubUserId, row);
    return Promise.resolve({ kind: "issued", row });
  }
  list(): Promise<IssuedKeyRow[]> {
    return Promise.resolve([...this.rows.values()]);
  }
}

interface GitHubUser {
  id: number;
  login: string;
  created_at: string;
  type?: string;
}

function make(changes: Record<string, string> = {}) {
  let clock = Date.parse("2026-11-09T12:00:00Z");
  const now = () => clock;
  const config = loadConfig(env(changes));
  const accessKeys = new AccessKeys(config.auth.keys, {
    ...(config.auth.keysFile === undefined ? {} : { path: config.auth.keysFile }),
    rules: config.auth.rules,
    now,
  });
  const store = new FakeStore(now);
  const github = {
    user: { id: 583231, login: "octocat", created_at: "2011-01-25T18:44:36Z", type: "User" } as GitHubUser,
    tokenStatus: 200,
    calls: [] as { url: string; body?: string; authorization?: string }[],
  };
  const fakeFetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const headers = new Headers(init?.headers);
    github.calls.push({
      url,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      ...(headers.get("authorization") === null ? {} : { authorization: headers.get("authorization") ?? "" }),
    });
    if (url === "https://github.com/login/oauth/access_token")
      return Promise.resolve(Response.json({ access_token: "gho_token" }, { status: github.tokenStatus }));
    if (url === "https://api.github.com/user") return Promise.resolve(Response.json(github.user));
    return Promise.reject(new Error(`unexpected ${url}`));
  };
  const metrics = new Metrics();
  const facilitator = {
    core: {
      getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
      verify: () => Promise.resolve({ isValid: true }),
      settle: () => Promise.resolve({ success: true, transaction: "a".repeat(64), network: PUBNET }),
    },
    networks: new Map(),
  } as unknown as StellarFacilitator;
  const app = createApp({
    config,
    facilitator,
    metrics,
    log: silentLogger,
    readiness: () => Promise.resolve({ ready: true, checks: {} }),
    version: "test",
    accessKeys,
    issuedKeys: store,
    signupFetch: fakeFetch,
  });
  const get = (path: string, headers: Record<string, string> = {}, host = MAINNET_HOST) =>
    app.request(`https://${host}${path}`, { headers: { host, ...headers } });
  /** The whole sign-in: `/keys/new`, then GitHub's redirect back to `/keys/callback`. */
  const signIn = async (address = "198.51.100.7") => {
    const started = await get("/keys/new", { "x-forwarded-for": address });
    const location = new URL(started.headers.get("location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    const cookie = `${SIGNUP_STATE_COOKIE}=${state}`;
    return get(`/keys/callback?code=abc&state=${state}`, { cookie, "x-forwarded-for": address });
  };
  return {
    app,
    get,
    signIn,
    store,
    github,
    accessKeys,
    metrics,
    config,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("key sign-up configuration", () => {
  it("is off by default and reads its settings, with the client secret from a file", () => {
    expect(loadConfig(env({ KEY_SIGNUP: "off" })).keySignup).toBeUndefined();
    const signup = loadConfig(env()).keySignup;
    expect(signup).toMatchObject({
      clientId: "Iv1.client",
      clientSecret: "client-secret",
      network: PUBNET,
      requestsPerMinute: 60,
      sponsorBudgetStroopsPerHour: 5_000_000n,
      lifetimeDays: 90,
      perHour: 30,
      reissueSeconds: 3_600,
      minAccountAgeDays: 30,
    });
    expect(signup?.callbackUrl.href).toBe(`https://${MAINNET_HOST}/keys/callback`);
  });

  it.each([
    ["without a database", { STORE: "memory" }, /STORE=postgres/],
    ["without a client id", { KEY_SIGNUP_GITHUB_CLIENT_ID: "" }, /CLIENT_ID|client id/],
    [
      "with a plain-http callback",
      { KEY_SIGNUP_CALLBACK_URL: `http://${MAINNET_HOST}/keys/callback` },
      /https/,
    ],
    ["with another path", { KEY_SIGNUP_CALLBACK_URL: `https://${MAINNET_HOST}/callback` }, /keys\/callback/],
    [
      "on the testnet host",
      { KEY_SIGNUP_CALLBACK_URL: `https://${TESTNET_HOST}/keys/callback` },
      /PUBLIC_HOSTS for stellar:pubnet/,
    ],
    ["for a network not served", { KEY_SIGNUP_NETWORK: "stellar:futurenet" }, /not a network listed/],
    ["living longer than keys may", { KEY_SIGNUP_DAYS: "500" }, /ACCESS_KEY_MAX_LIFETIME_DAYS/],
  ])("refuses sign-up %s", (_name, changes, message) => {
    const error = refusal(() => loadConfig(env(changes)));
    expect(error.message).toMatch(message);
  });

  it("refuses the client secret from the environment once pubnet is enabled", () => {
    const error = refusal(() =>
      loadConfig({
        ...env({ KEY_SIGNUP_GITHUB_CLIENT_SECRET: "client-secret" }),
        KEY_SIGNUP_GITHUB_CLIENT_SECRET_FILE: undefined,
      }),
    );
    expect(error.message).toMatch(/KEY_SIGNUP_GITHUB_CLIENT_SECRET/);
  });
});

describe("the issued-keys switch of the key file", () => {
  it("defaults to on, accepts no-new and off, and refuses anything else", () => {
    expect(parseAccessKeyFile(keyFile(), rules).issuedKeys).toBe("on");
    expect(parseAccessKeyFile(keyFile("no-new"), rules).issuedKeys).toBe("no-new");
    expect(parseAccessKeyFile(keyFile("off"), rules).issuedKeys).toBe("off");
    expect(() => parseAccessKeyFile(keyFile("paused"), rules)).toThrow(/issuedKeys/);
  });

  it("keeps the gh- ids for issued keys", () => {
    const key = newAccessKey("gh-1234");
    const file = JSON.stringify({
      schemaVersion: 1,
      keys: [{ id: "gh-1234", sha256: key.sha256, networks: [TESTNET], createdAt: "2026-01-01T00:00:00Z" }],
    });
    expect(() => parseAccessKeyFile(file, rules)).toThrow(/kept for keys issued through sign-in/);
  });
});

describe("key sign-up through GitHub", () => {
  it("sends the browser to GitHub with a state cookie and no scope", async () => {
    const { get } = make();
    const response = await get("/keys/new");
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("Iv1.client");
    expect(location.searchParams.get("redirect_uri")).toBe(`https://${MAINNET_HOST}/keys/callback`);
    expect(location.searchParams.get("scope")).toBe("");
    const state = location.searchParams.get("state") ?? "";
    expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SIGNUP_STATE_COOKIE}=${state}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("issues one key shown once, which then pays on pubnet only, and keeps only its digest", async () => {
    const { signIn, store, accessKeys, github, metrics } = make();
    const response = await signIn();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      keyId: "gh-583231",
      github: "octocat",
      network: PUBNET,
      limits: { requestsPerMinute: 60, sponsorBudgetXlmPerHour: "0.5" },
      expiresAt: "2027-02-07T12:00:00.000Z",
      replacedPreviousKey: false,
    });
    const key = body["key"] as string;
    expect(key).toMatch(/^r402_gh-583231_[A-Za-z0-9_-]{43}$/);
    const row = store.rows.get("583231");
    expect(row?.sha256).toBe(createHash("sha256").update(key).digest("hex"));
    expect(
      JSON.stringify([...store.rows.values()], (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v)),
    ).not.toContain(key);
    // The client secret goes to GitHub's token endpoint only; the token only to the profile read.
    expect(github.calls.map((call) => call.url)).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
    ]);
    expect(github.calls[0]?.body).toContain('"client_secret":"client-secret"');
    expect(github.calls[1]?.authorization).toBe("Bearer gho_token");

    const decision = accessKeys.decide(presentedKey(`Bearer ${key}`, undefined), PUBNET, true);
    expect(decision).toMatchObject({ kind: "served", record: { id: "gh-583231", issued: true } });
    expect(accessKeys.decide(presentedKey(`Bearer ${key}`, undefined), TESTNET, true).kind).toBe("forbidden");
    expect(await metrics.registry.getSingleMetricAsString("rail402_key_signups_total")).toContain(
      'outcome="issued"} 1',
    );
  });

  it("serves sign-up on the mainnet host only", async () => {
    const { get } = make();
    expect((await get("/keys/new", {}, TESTNET_HOST)).status).toBe(404);
    expect((await get("/keys/new", {}, "rail402.internal")).status).toBe(404);
  });

  it("refuses a callback without the state it started with", async () => {
    const { get, store } = make();
    const started = await get("/keys/new");
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    for (const headers of [{} as Record<string, string>, { cookie: `${SIGNUP_STATE_COOKIE}=${state}x` }]) {
      const response = await get(`/keys/callback?code=abc&state=${state}`, headers);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "key_signup_state_invalid" } });
    }
    expect(store.rows.size).toBe(0);
  });

  it("reports a cancelled sign-in and a GitHub that does not answer", async () => {
    const { get, github } = make();
    const cancelled = await get(`/keys/callback?error=access_denied&state=s`, {
      cookie: `${SIGNUP_STATE_COOKIE}=s`,
    });
    expect(await cancelled.json()).toMatchObject({ error: { code: "key_signup_cancelled" } });
    github.tokenStatus = 401;
    const failed = await get(`/keys/callback?code=abc&state=s`, { cookie: `${SIGNUP_STATE_COOKIE}=s` });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({
      error: { code: "key_signup_provider_failed", retryable: true },
    });
  });

  it("refuses accounts younger than the minimum and organisations", async () => {
    const young = make();
    young.github.user = { ...young.github.user, created_at: "2026-11-01T00:00:00Z" };
    const response = await young.signIn();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "key_signup_account_too_new" } });
    const organisation = make();
    organisation.github.user = { ...organisation.github.user, type: "Organization" };
    expect(await (await organisation.signIn()).json()).toMatchObject({
      error: { code: "key_signup_provider_failed" },
    });
  });

  it("replaces an account's key no sooner than the interval, and the old key stops working", async () => {
    const { signIn, tick, accessKeys } = make();
    const first = ((await (await signIn()).json()) as { key: string }).key;
    const again = await signIn();
    expect(again.status).toBe(429);
    expect(again.headers.get("retry-after")).toBe("3600");
    expect(await again.json()).toMatchObject({ error: { code: "key_signup_too_soon" } });
    tick(3_600_000);
    const replaced = (await (await signIn()).json()) as { key: string; replacedPreviousKey: boolean };
    expect(replaced.replacedPreviousKey).toBe(true);
    expect(replaced.key).not.toBe(first);
    expect(accessKeys.decide(presentedKey(`Bearer ${first}`, undefined), PUBNET, true).kind).toBe(
      "unauthorized",
    );
    expect(accessKeys.decide(presentedKey(`Bearer ${replaced.key}`, undefined), PUBNET, true).kind).toBe(
      "served",
    );
  });

  it("stops at the hourly cap and refuses a revoked account", async () => {
    const capped = make({ KEY_SIGNUP_PER_HOUR: "1" });
    expect((await capped.signIn()).status).toBe(200);
    capped.github.user = { ...capped.github.user, id: 2, login: "other" };
    const refused = await capped.signIn();
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: { code: "key_signup_limit_reached" } });

    const revoked = make();
    await revoked.signIn();
    const row = revoked.store.rows.get("583231");
    if (row !== undefined) revoked.store.rows.set("583231", { ...row, revoked: true });
    revoked.tick(3_600_000);
    expect(await (await revoked.signIn()).json()).toMatchObject({
      error: { code: "key_signup_account_refused" },
    });
  });

  it("answers a database failure with a retryable internal error and issues nothing", async () => {
    const { signIn, store } = make();
    store.failing = true;
    const response = await signIn();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error", retryable: true } });
  });

  it("limits sign-up requests per client address", async () => {
    const { get } = make({ TRUSTED_PROXY_HOPS: "1" });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push((await get("/keys/new", { "x-forwarded-for": "203.0.113.9" })).status);
    expect(statuses.slice(0, 10).every((status) => status === 302)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await get("/keys/new", { "x-forwarded-for": "203.0.113.10" })).status).toBe(302);
  });
});

describe("the issued-keys switches", () => {
  it("no-new stops sign-up and keeps issued keys; off refuses them too; file keys never change", () => {
    const now = () => Date.parse("2026-11-09T12:00:00Z");
    const issuedKey = newAccessKey("gh-42");
    const row: IssuedKeyRow = {
      id: "gh-42",
      githubUserId: "42",
      githubLogin: "someone",
      sha256: issuedKey.sha256,
      networks: [PUBNET],
      requestsPerMinute: 60,
      sponsorBudgetStroopsPerHour: 5_000_000n,
      createdAt: new Date(now()),
      expiresAt: new Date(now() + 90 * DAY),
      issuedCount: 1,
      revoked: false,
    };
    const decide = (keys: AccessKeys, key: string) =>
      keys.decide(presentedKey(`Bearer ${key}`, undefined), PUBNET, true);
    for (const [mode, issuedServed] of [
      ["on", true],
      ["no-new", true],
      ["off", false],
    ] as const) {
      const keys = new AccessKeys([], { path: secretFile(keyFile(mode)), rules, now });
      keys.setIssued([issuedRecord(row)]);
      expect(keys.issuedKeys).toBe(mode);
      const decision = decide(keys, issuedKey.key);
      expect(decision.kind === "served").toBe(issuedServed);
      if (!issuedServed) {
        expect(decision).toMatchObject({ kind: "unauthorized", keyId: "issued" });
        expect(decision.kind === "unauthorized" && decision.reason).toMatch(/switched off/);
      }
      expect(decide(keys, fileKey.key).kind).toBe("served");
    }
  });

  it("refuses sign-up with key_signup_closed while new keys are switched off", async () => {
    const { get, github } = make({ API_KEYS_FILE: secretFile(keyFile("no-new")) });
    const response = await get("/keys/new");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "key_signup_closed", retryable: true } });
    // A sign-in started before the switch is refused at the callback, before GitHub is asked.
    const late = await get("/keys/callback?code=abc&state=s", { cookie: `${SIGNUP_STATE_COOKIE}=s` });
    expect(await late.json()).toMatchObject({ error: { code: "key_signup_closed" } });
    expect(github.calls).toEqual([]);
  });

  it("counts issued keys under one metric label", () => {
    const keys = new AccessKeys([], { rules });
    keys.setIssued([
      issuedRecord({
        id: "gh-7",
        githubUserId: "7",
        githubLogin: "seven",
        sha256: newAccessKey("gh-7").sha256,
        networks: [PUBNET],
        requestsPerMinute: 60,
        sponsorBudgetStroopsPerHour: 1n,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + DAY),
        issuedCount: 1,
        revoked: true,
      }),
    ]);
    const unknown = keys.decide(presentedKey("Bearer r402_gh-7_" + "a".repeat(43), undefined), PUBNET, true);
    expect(unknown).toMatchObject({ kind: "unauthorized", keyId: "invalid" });
    expect(keys.status().keys).toEqual({ active: 0, expired: 0, revoked: 1 });
  });
});
