import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { currentCaller, silentLogger, type StellarFacilitator } from "@rail402.dev/facilitator";
import {
  AccessKeys,
  ConfigError,
  Metrics,
  createApp,
  legacyKeys,
  loadConfig,
  newAccessKey,
  parseAccessKeys,
  presentedKey,
  type AccessKeyRules,
  type KeyedRateLimiter,
} from "@rail402.dev/service";
import { Catalog, MemoryCatalogStore, SchemaSandbox } from "@rail402.dev/bazaar";
import { AssetRegistry, SearchService } from "@rail402.dev/search";
import { COLD_SIGNER, secretFile, sponsorKeyFile } from "./secret-fixtures.ts";

const TESTNET = "stellar:testnet";
const PUBNET = "stellar:pubnet";
const rules: AccessKeyRules = {
  networks: [TESTNET, PUBNET],
  futureNetworks: false,
  maxLifetimeDays: 400,
  max: 1_000,
};
const pubnetKey = newAccessKey("acme-prod-1");
const testnetKey = newAccessKey("tester-1");
const record = (key: { sha256: string }, id: string, changes: Record<string, unknown> = {}) => ({
  id,
  sha256: key.sha256,
  networks: [PUBNET],
  sponsorBudgetXlmPerHour: "2",
  expiresAt: "2099-01-01T00:00:00Z",
  createdAt: "2098-06-01T00:00:00Z",
  ...changes,
});
const keyFile = (keys: readonly unknown[]) => JSON.stringify({ schemaVersion: 1, keys });
const both = keyFile([
  record(pubnetKey, "acme-prod-1"),
  record(testnetKey, "tester-1", {
    networks: [TESTNET],
    sponsorBudgetXlmPerHour: undefined,
    expiresAt: undefined,
  }),
]);
const key = (value: string) => presentedKey(undefined, value);

function refusal(load: () => unknown): ConfigError {
  try {
    load();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("accepted");
}

describe("the access-key file", () => {
  it("parses keys with their networks, limits, budgets and expiry", () => {
    const [pubnet, testnet] = parseAccessKeys(both, rules);
    expect(pubnet).toMatchObject({
      id: "acme-prod-1",
      networks: [PUBNET],
      sponsorBudgetStroopsPerHour: 20_000_000n,
      revoked: false,
      legacy: false,
    });
    expect(testnet?.networks).toEqual([TESTNET]);
    expect(testnet?.sponsorBudgetStroopsPerHour).toBeUndefined();
  });

  it.each([
    ["not JSON", "{", /not valid JSON/],
    ["no schema version", JSON.stringify({ keys: [] }), /schemaVersion/],
    ["an unknown field", keyFile([{ ...record(pubnetKey, "acme-prod-1"), secret: "x" }]), /key 0/],
    ["a bad id", keyFile([record(pubnetKey, "Acme")]), /key 0: id/],
    [
      "an unknown network",
      keyFile([record(pubnetKey, "acme-prod-1", { networks: ["stellar:futurenet"] })]),
      /unknown network/,
    ],
    [
      "a pubnet key without a budget",
      keyFile([record(pubnetKey, "acme-prod-1", { sponsorBudgetXlmPerHour: undefined })]),
      /needs sponsorBudgetXlmPerHour/,
    ],
    [
      "a pubnet key without expiry",
      keyFile([record(pubnetKey, "acme-prod-1", { expiresAt: undefined })]),
      /needs expiresAt/,
    ],
    [
      "a key living too long",
      keyFile([record(pubnetKey, "acme-prod-1", { expiresAt: "2100-01-01T00:00:00Z" })]),
      /ACCESS_KEY_MAX_LIFETIME_DAYS/,
    ],
    [
      "a zero budget",
      keyFile([record(pubnetKey, "acme-prod-1", { sponsorBudgetXlmPerHour: "0" })]),
      /above zero/,
    ],
    [
      "an id used twice",
      keyFile([record(pubnetKey, "acme-prod-1"), record(testnetKey, "acme-prod-1")]),
      /used twice/,
    ],
    [
      "a digest used twice",
      keyFile([record(pubnetKey, "acme-prod-1"), record(pubnetKey, "acme-prod-2")]),
      /used by another key/,
    ],
  ])("refuses %s with config_access_keys_invalid", (_label, text, pattern) => {
    const error = refusal(() => parseAccessKeys(text, rules));
    expect(error.code).toBe("config_access_keys_invalid");
    expect(error.message).toMatch(pattern);
    expect(error.message).not.toContain(pubnetKey.sha256);
  });

  it("refuses more keys than ACCESS_KEYS_MAX and keys for networks not served", () => {
    expect(refusal(() => parseAccessKeys(both, { ...rules, max: 1 })).message).toMatch(/more than 1/);
    expect(refusal(() => parseAccessKeys(both, { ...rules, networks: [TESTNET] })).message).toMatch(
      /ACCESS_KEYS_FUTURE_NETWORKS/,
    );
    expect(parseAccessKeys(both, { ...rules, networks: [TESTNET], futureNetworks: true })).toHaveLength(2);
  });
});

describe("access decisions", () => {
  const keys = new AccessKeys(parseAccessKeys(both, rules), { rules });

  it("refuses a testnet-only key on pubnet and accepts it on testnet", () => {
    expect(keys.decide(key(testnetKey.key), PUBNET, true)).toMatchObject({
      kind: "forbidden",
      keyId: "tester-1",
    });
    expect(keys.decide(key(testnetKey.key), TESTNET, false)).toMatchObject({
      kind: "served",
      record: { id: "tester-1" },
    });
    expect(keys.decide(key(pubnetKey.key), PUBNET, true)).toMatchObject({
      kind: "served",
      record: { id: "acme-prod-1" },
    });
  });

  it("follows the table of outcomes for a network that requires keys and one that does not", () => {
    const revoked = newAccessKey("revoked-1");
    const expired = newAccessKey("expired-1");
    const table = new AccessKeys(
      parseAccessKeys(
        keyFile([
          record(pubnetKey, "acme-prod-1"),
          record(revoked, "revoked-1", { revoked: true }),
          record(expired, "expired-1", {
            createdAt: "2020-01-01T00:00:00Z",
            expiresAt: "2020-06-01T00:00:00Z",
          }),
        ]),
        rules,
      ),
      { rules },
    );
    const forged = `r402_acme-prod-1_${"A".repeat(43)}`;
    const cases = [
      [presentedKey(undefined, undefined), "unauthorized", "public"],
      [key("nonsense"), "unauthorized", "public"],
      [key(forged), "unauthorized", "public"],
      [key(revoked.key), "unauthorized", "public"],
      [key(expired.key), "unauthorized", "public"],
    ] as const;
    for (const [presented, required, keyless] of cases) {
      expect(table.decide(presented, PUBNET, true).kind).toBe(required);
      expect(table.decide(presented, PUBNET, false).kind).toBe(keyless);
    }
    expect(table.decide(key(revoked.key), PUBNET, true)).toMatchObject({
      reason: "The API key was revoked.",
    });
    expect(table.decide(key(expired.key), PUBNET, true)).toMatchObject({
      reason: "The API key has expired.",
    });
    expect(table.decide(key(forged), PUBNET, true)).toMatchObject({ keyId: "invalid" });
  });

  it("refuses two different keys in Authorization and X-API-Key", () => {
    const presented = presentedKey(`Bearer ${pubnetKey.key}`, testnetKey.key);
    expect(presented).toEqual({ kind: "conflict" });
    expect(keys.decide(presented, TESTNET, false).kind).toBe("unauthorized");
    expect(presentedKey(`Bearer ${pubnetKey.key}`, pubnetKey.key)).toEqual({
      kind: "key",
      key: pubnetKey.key,
    });
  });

  it("keeps the usage subject of a key from API_KEY_SHA256", () => {
    const digest = createHash("sha256").update("legacy-key").digest("hex");
    const legacy = new AccessKeys([], { rules, legacy: legacyKeys([digest], [TESTNET]) });
    expect(legacy.decide(key("legacy-key"), TESTNET, true)).toMatchObject({
      kind: "served",
      record: { id: digest.slice(0, 16) },
    });
    expect(legacy.holder(key("legacy-key"))?.id).toBe(digest.slice(0, 16));
  });
});

describe("reloading the key file", () => {
  it("refuses a revoked key without a restart, and keeps the last good keys when the file breaks", () => {
    const path = secretFile(keyFile([record(pubnetKey, "acme-prod-1")]), 0o600);
    const outcomes: boolean[] = [];
    const keys = new AccessKeys(parseAccessKeys(keyFile([record(pubnetKey, "acme-prod-1")]), rules), {
      path,
      rules,
      onReload: (outcome) => outcomes.push(outcome.ok),
    });
    expect(keys.reload()).toBe(false); // unchanged
    const replace = (text: string) => {
      writeFileSync(`${path}.new`, text, { mode: 0o600 });
      chmodSync(`${path}.new`, 0o600);
      renameSync(`${path}.new`, path);
    };
    replace(keyFile([record(pubnetKey, "acme-prod-1", { revoked: true })]));
    expect(keys.reload()).toBe(true);
    expect(keys.decide(key(pubnetKey.key), PUBNET, true)).toMatchObject({
      kind: "unauthorized",
      reason: "The API key was revoked.",
    });
    expect(keys.status().keys).toEqual({ active: 0, expired: 0, revoked: 1 });

    replace(keyFile([record(pubnetKey, "acme-prod-1")]) + "garbage");
    expect(keys.reload()).toBe(false);
    expect(keys.status().reloadError).toMatch(/^config_access_keys_invalid: /);
    // The revoked key stays revoked: the broken file changed nothing.
    expect(keys.decide(key(pubnetKey.key), PUBNET, true).kind).toBe("unauthorized");
    replace(keyFile([record(pubnetKey, "acme-prod-1")]));
    expect(keys.reload()).toBe(true);
    expect(keys.status().reloadError).toBeNull();
    expect(outcomes).toEqual([true, false, true]);
  });

  it("sees a file replaced by rename inside its directory, even with the same size and time", () => {
    const directory = mkdtempSync(join(tmpdir(), "rail402-keys-"));
    const path = join(directory, "keys.json");
    // "false" is one character longer than "true"; the labels even the sizes out.
    const active = keyFile([record(pubnetKey, "acme-prod-1", { revoked: false, label: "ab" })]);
    const revoked = keyFile([record(pubnetKey, "acme-prod-1", { revoked: true, label: "abc" })]);
    expect(revoked.length).toBe(active.length);
    writeFileSync(path, active, { mode: 0o600 });
    const keys = new AccessKeys(parseAccessKeys(active, rules), { path, source: "API_KEYS_DIR", rules });
    const before = keys.status().fileSha256;
    expect(before).toBe(createHash("sha256").update(active).digest("hex"));
    const { mtime } = statSync(path);
    writeFileSync(`${path}.new`, revoked, { mode: 0o600 });
    utimesSync(`${path}.new`, mtime, mtime);
    renameSync(`${path}.new`, path);
    expect(keys.reload()).toBe(true);
    expect(keys.decide(key(pubnetKey.key), PUBNET, true)).toMatchObject({ kind: "unauthorized" });
    expect(keys.status().fileSha256).toBe(createHash("sha256").update(revoked).digest("hex"));
    // Errors name the variable that configured the file.
    writeFileSync(`${path}.new`, "{", { mode: 0o600 });
    renameSync(`${path}.new`, path);
    expect(keys.reload()).toBe(false);
    expect(keys.status().reloadError).toMatch(/^config_access_keys_invalid: API_KEYS_DIR: /);
  });

  it("applies a file renamed into place between loading the configuration and starting", () => {
    const directory = mkdtempSync(join(tmpdir(), "rail402-keys-"));
    const path = join(directory, "keys.json");
    const active = keyFile([record(pubnetKey, "acme-prod-1")]);
    const revoked = keyFile([record(pubnetKey, "acme-prod-1", { revoked: true })]);
    writeFileSync(path, active, { mode: 0o600 });
    const loaded = parseAccessKeys(active, rules);
    // The revocation lands after the startup read, before the keys are built.
    writeFileSync(`${path}.new`, revoked, { mode: 0o600 });
    renameSync(`${path}.new`, path);
    const keys = new AccessKeys(loaded, { path, source: "API_KEYS_DIR", rules });
    expect(keys.decide(key(pubnetKey.key), PUBNET, true)).toMatchObject({
      kind: "unauthorized",
      reason: "The API key was revoked.",
    });
    expect(keys.status()).toMatchObject({
      keys: { active: 0, expired: 0, revoked: 1 },
      reloadError: null,
      fileSha256: createHash("sha256").update(revoked).digest("hex"),
    });
    expect(keys.reload()).toBe(false); // already in force
  });

  it("reports no digest for a file it could not apply at start, and reports the file on the first reload", () => {
    const directory = mkdtempSync(join(tmpdir(), "rail402-keys-"));
    const path = join(directory, "keys.json");
    const active = keyFile([record(pubnetKey, "acme-prod-1")]);
    writeFileSync(path, active, { mode: 0o600 });
    const loaded = parseAccessKeys(active, rules);
    writeFileSync(`${path}.new`, "{", { mode: 0o600 });
    renameSync(`${path}.new`, path);
    const outcomes: boolean[] = [];
    const keys = new AccessKeys(loaded, {
      path,
      source: "API_KEYS_DIR",
      rules,
      onReload: (outcome) => outcomes.push(outcome.ok),
    });
    // The keys read at startup stay in force, but nothing claims the broken file was applied.
    expect(keys.decide(key(pubnetKey.key), PUBNET, true).kind).toBe("served");
    expect(keys.status()).toMatchObject({ fileSha256: null, lastReloadAt: null });
    expect(keys.reload()).toBe(false);
    expect(keys.status().reloadError).toMatch(/^config_access_keys_invalid: API_KEYS_DIR: /);
    expect(outcomes).toEqual([false]);
  });
});

describe("access-key configuration", () => {
  const pubnet = {
    NETWORKS: "stellar:testnet,stellar:pubnet",
    STORE: "memory",
    METRICS_PRIVATE_TOKEN_SHA256: "ab".repeat(32),
    TESTNET_RPC_URL: "https://soroban-testnet.stellar.org",
    TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
    PUBNET_RPC_SINGLE_PROVIDER: "true",
    PUBNET_RPC_URL: "https://mainnet.sorobanrpc.com",
    PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(Keypair.random().secret()),
    PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
    PUBNET_REQUIRE_API_KEY: "true",
    API_KEYS_FILE: secretFile(both),
    PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "10",
    PUBNET_MAX_TX_FEE_STROOPS: "300000",
    PUBNET_INCLUSION_FEE_STROOPS: "200",
    PUBNET_ASSETS: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75:USDC:7:10000",
  };

  it("loads the key file at startup and refuses a bad one with its code", () => {
    expect(loadConfig(pubnet).auth.keys.map((entry) => entry.id)).toEqual(["acme-prod-1", "tester-1"]);
    expect(refusal(() => loadConfig({ ...pubnet, API_KEYS_FILE: secretFile("{") })).code).toBe(
      "config_access_keys_invalid",
    );
    expect(refusal(() => loadConfig({ ...pubnet, API_KEYS_FILE: secretFile(both, 0o666) })).code).toBe(
      "config_secret_file_insecure",
    );
  });

  it("reads keys.json from API_KEYS_DIR, and refuses it together with API_KEYS_FILE", () => {
    const directory = mkdtempSync(join(tmpdir(), "rail402-keys-"));
    writeFileSync(join(directory, "keys.json"), both, { mode: 0o600 });
    const { API_KEYS_FILE: file, ...withoutFile } = pubnet;
    const config = loadConfig({ ...withoutFile, API_KEYS_DIR: directory });
    expect(config.auth.keysFile).toBe(join(directory, "keys.json"));
    expect(config.auth.keysSource).toBe("API_KEYS_DIR");
    expect(config.auth.keys.map((entry) => entry.id)).toEqual(["acme-prod-1", "tester-1"]);
    const conflict = refusal(() =>
      loadConfig({ ...withoutFile, API_KEYS_FILE: file, API_KEYS_DIR: directory }),
    );
    expect(conflict.code).toBe("config_access_keys_invalid");
    expect(conflict.message).toMatch(/not both/);
    expect(refusal(() => loadConfig({ ...withoutFile, API_KEYS_DIR: "relative/dir" })).code).toBe(
      "config_access_keys_invalid",
    );
    const empty = mkdtempSync(join(tmpdir(), "rail402-keys-"));
    expect(refusal(() => loadConfig({ ...withoutFile, API_KEYS_DIR: empty })).message).toMatch(
      /^API_KEYS_DIR: /,
    );
  });

  it("refuses API_KEY_SHA256 once pubnet is enabled", () => {
    expect(refusal(() => loadConfig({ ...pubnet, API_KEY_SHA256: "ab".repeat(32) })).code).toBe(
      "config_legacy_api_keys_with_pubnet",
    );
  });

  it("requires a key file when pubnet requires keys, and limits when it does not", () => {
    const { API_KEYS_FILE: _file, ...noKeys } = pubnet;
    expect(refusal(() => loadConfig(noKeys)).code).toBe("config_access_keys_missing");
    const keyless = { ...noKeys, PUBNET_REQUIRE_API_KEY: "false" };
    expect(refusal(() => loadConfig(keyless)).code).toBe("config_pubnet_keyless_limits_missing");
    const limited = loadConfig({
      ...keyless,
      PUBNET_RATE_LIMIT_PER_MINUTE: "30",
      PUBNET_KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR: "0.5",
    });
    expect(limited.networks[1]).toMatchObject({
      keylessRequestsPerMinute: 30,
      keylessSponsorBudgetStroopsPerHour: 5_000_000n,
      keyRequestsPerMinute: 60,
    });
  });

  it("refuses keyless upto on pubnet", () => {
    const error = refusal(() =>
      loadConfig({
        ...pubnet,
        PUBNET_REQUIRE_API_KEY: "false",
        PUBNET_RATE_LIMIT_PER_MINUTE: "30",
        PUBNET_KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR: "1",
        PUBNET_UPTO_ENABLED: "true",
      }),
    );
    expect(error.code).toBe("config_pubnet_api_key_policy_missing");
  });
});

describe("access in the service", () => {
  const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
  function make(limiter?: KeyedRateLimiter, env: Record<string, string> = {}) {
    const config = loadConfig({
      NETWORKS: "stellar:testnet,stellar:pubnet",
      STORE: "memory",
      METRICS_PRIVATE_TOKEN_SHA256: "ab".repeat(32),
      TESTNET_RPC_URL: "http://localhost:8000/rpc",
      TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
      TESTNET_RATE_LIMIT_PER_MINUTE: "100",
      PUBNET_RPC_SINGLE_PROVIDER: "true",
      PUBNET_RPC_URL: "https://mainnet.sorobanrpc.com",
      PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(Keypair.random().secret()),
      PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
      PUBNET_REQUIRE_API_KEY: "true",
      API_KEYS_FILE: secretFile(
        keyFile([
          record(pubnetKey, "acme-prod-1", { requestsPerMinute: 2 }),
          record(testnetKey, "tester-1", {
            networks: [TESTNET],
            sponsorBudgetXlmPerHour: undefined,
            expiresAt: undefined,
          }),
        ]),
      ),
      PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "10",
      PUBNET_MAX_TX_FEE_STROOPS: "300000",
      PUBNET_INCLUSION_FEE_STROOPS: "200",
      PUBNET_ASSETS: `${PUBNET_USDC}:USDC:7:10000`,
      ...env,
    });
    const callers: (string | undefined)[] = [];
    const answer = (network: string) => {
      const caller = currentCaller();
      callers.push(
        caller === undefined
          ? undefined
          : `${caller.subject}${caller.sponsorBudgetStroopsPerHour === undefined ? "" : `@${String(caller.sponsorBudgetStroopsPerHour)}`}`,
      );
      return Promise.resolve({ success: true, transaction: "a".repeat(64), network });
    };
    const facilitator = {
      core: {
        getSupported: () => ({
          kinds: [TESTNET, PUBNET].map((network) => ({
            x402Version: 2,
            scheme: "exact",
            network,
            extra: {},
          })),
          extensions: [],
          signers: {},
        }),
        verify: () => Promise.resolve({ isValid: true }),
        settle: (_payload: unknown, requirements: { network: string }) => answer(requirements.network),
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
      ...(limiter === undefined ? {} : { networkLimiter: limiter }),
    });
    const settle = (network: string, headers: Record<string, string> = {}) => {
      const requirements = {
        scheme: "exact",
        network,
        asset: PUBNET_USDC,
        payTo: Keypair.random().publicKey(),
        amount: "10000",
        maxTimeoutSeconds: 60,
        extra: {},
      };
      return app.request("/settle", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: "AAAA" } },
          paymentRequirements: requirements,
        }),
      });
    };
    return { app, settle, callers, metrics };
  }

  it("serves each key only on its networks and settles under its caller and budget", async () => {
    const { settle, callers } = make();
    expect((await settle(PUBNET)).status).toBe(401);
    const forbidden = await settle(PUBNET, { "x-api-key": testnetKey.key });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      errorReason: "forbidden",
      error: { reason: "The API key is not allowed on stellar:pubnet." },
    });
    expect((await settle(PUBNET, { authorization: `Bearer ${pubnetKey.key}` })).status).toBe(200);
    expect((await settle(TESTNET, { "x-api-key": testnetKey.key })).status).toBe(200);
    // A pubnet key on keyless testnet is served as public.
    expect((await settle(TESTNET, { "x-api-key": pubnetKey.key })).status).toBe(200);
    expect(callers).toEqual(["key:acme-prod-1@20000000", "key:tester-1", "public"]);
  });

  it("does not rate-limit a pubnet key while testnet clients from the same address are limited", async () => {
    const { settle, metrics } = make(undefined, {
      RATE_LIMIT_PER_MINUTE: "2",
      TESTNET_RATE_LIMIT_PER_MINUTE: "1",
    });
    // Keyless testnet clients spend testnet's limit, then the service-wide limit of their address.
    expect((await settle(TESTNET)).status).toBe(200);
    expect((await settle(TESTNET)).status).toBe(429);
    expect((await settle(TESTNET)).status).toBe(429);
    expect((await settle(PUBNET)).status).toBe(429);
    // A pubnet key from the same address draws on its own limit of 2 per minute, nothing else.
    const headers = { "x-api-key": pubnetKey.key };
    expect((await settle(PUBNET, headers)).status).toBe(200);
    expect((await settle(PUBNET, headers)).status).toBe(200);
    const limited = await settle(PUBNET, headers);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ errorReason: "rate_limited" });
    const refusals = await metrics.registry.getSingleMetricAsString("rail402_rate_limited_total");
    expect(refusals).toContain('scope="network"} 1');
    expect(refusals).toContain('scope="ip"} 2');
    expect(refusals).toContain('scope="key"} 1');
  });

  it("refuses pubnet settlements with a retryable code while the rate limiter is unavailable", async () => {
    const broken: KeyedRateLimiter = {
      takeLimit: () => Promise.reject(new Error("database down")),
      sweep: () => undefined,
    };
    const { settle, metrics } = make(broken);
    const refused = await settle(PUBNET, { "x-api-key": pubnetKey.key });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      errorReason: "service_unavailable",
      error: { retryable: true, reason: "Rate limiting is unavailable; retry shortly." },
    });
    // Testnet keeps serving.
    expect((await settle(TESTNET)).status).toBe(200);
    expect(await metrics.registry.getSingleMetricAsString("rail402_rate_limiter_failures_total")).toContain(
      'scope="network"} 2',
    );
  });

  it("shows a key holder its usage, and refuses an unknown key", async () => {
    const { app } = make();
    expect((await app.request("/usage", { headers: { "x-api-key": "nope" } })).status).toBe(401);
    const usage = await app.request("/usage", { headers: { "x-api-key": pubnetKey.key } });
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({ subject: "key:acme-prod-1" });
  });
});

describe("the internal discovery identity", () => {
  const internal = newAccessKey("discovery-front");
  const entry = {
    id: "discovery-front",
    sha256: internal.sha256,
    networks: [],
    scopes: ["discovery-internal"],
    discoveryRequestsPerMinute: 3,
    forwardedClientRequestsPerMinute: 2,
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("names no network and keeps discovery limits to discovery keys", () => {
    expect(parseAccessKeys(keyFile([entry]), rules)[0]).toMatchObject({
      scopes: ["discovery-internal"],
      networks: [],
    });
    expect(
      refusal(() => parseAccessKeys(keyFile([{ ...entry, networks: [TESTNET] }]), rules)).message,
    ).toMatch(/names no networks/);
    expect(refusal(() => parseAccessKeys(keyFile([{ ...entry, scopes: undefined }]), rules)).message).toMatch(
      /at least one network/,
    );
    expect(
      refusal(() =>
        parseAccessKeys(
          keyFile([record(pubnetKey, "acme-prod-1", { discoveryRequestsPerMinute: 5 })]),
          rules,
        ),
      ).message,
    ).toMatch(/for discovery-internal keys/);
  });

  function service() {
    return createApp({
      config: loadConfig({
        STORE: "memory",
        TESTNET_RPC_URL: "http://localhost:8000/rpc",
        TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
        RATE_LIMIT_PER_MINUTE: "1",
        TRUSTED_PROXY_HOPS: "1",
        API_KEYS_FILE: secretFile(keyFile([entry])),
      }),
      facilitator: {
        core: {
          getSupported: () => ({
            kinds: [{ x402Version: 2, scheme: "exact", network: TESTNET, extra: {} }],
            extensions: [],
            signers: {},
          }),
          verify: () => Promise.resolve({ isValid: true }),
        },
        networks: new Map(),
      } as unknown as StellarFacilitator,
      metrics: new Metrics(),
      log: silentLogger,
      readiness: () => Promise.resolve({ ready: true, checks: {} }),
      version: "test",
    });
  }

  it("draws on its own bucket, per forwarded client, instead of the per-address limit", async () => {
    const app = service();
    const from = (headers: Record<string, string> = {}) => ({
      headers: { "x-forwarded-for": "10.1.1.1", ...headers },
    });
    const search = (headers?: Record<string, string>) =>
      app.request("/discovery/search?query=x", from(headers));
    expect((await search()).status).not.toBe(429);
    expect((await search()).status).toBe(429);
    const key = { "x-api-key": internal.key };
    expect((await search({ ...key, "x-rail402-client": "agent-a" })).status).not.toBe(429);
    expect((await search({ ...key, "x-rail402-client": "agent-a" })).status).not.toBe(429);
    // agent-a has used its 2; agent-b still has room, until the identity's 3 are spent.
    expect((await search({ ...key, "x-rail402-client": "agent-a" })).status).toBe(429);
    expect((await search({ ...key, "x-rail402-client": "agent-b" })).status).not.toBe(429);
    expect((await search({ ...key, "x-rail402-client": "agent-c" })).status).toBe(429);
  });

  it("charges discovery costs to each forwarded client and to the identity, never to the identity's address", async () => {
    const generous = { ...entry, discoveryRequestsPerMinute: 100, forwardedClientRequestsPerMinute: 50 };
    const store = new MemoryCatalogStore();
    const app = createApp({
      config: loadConfig({
        STORE: "memory",
        TESTNET_RPC_URL: "http://localhost:8000/rpc",
        TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
        RATE_LIMIT_PER_MINUTE: "100",
        TRUSTED_PROXY_HOPS: "1",
        SEARCH_RATE_LIMIT_PER_MINUTE: "3",
        API_KEYS_FILE: secretFile(keyFile([generous])),
      }),
      facilitator: {
        core: {
          getSupported: () => ({
            kinds: [{ x402Version: 2, scheme: "exact", network: TESTNET, extra: {} }],
            extensions: [],
            signers: {},
          }),
        },
        networks: new Map(),
      } as unknown as StellarFacilitator,
      bazaar: {
        store,
        catalog: new Catalog({ store, sandbox: new SchemaSandbox() }),
        search: new SearchService({
          store,
          assets: new AssetRegistry([]),
          cursorSecret: Buffer.alloc(32, 1),
        }),
      },
      metrics: new Metrics(),
      log: silentLogger,
      readiness: () => Promise.resolve({ ready: true, checks: {} }),
      version: "test",
    });
    const list = (headers: Record<string, string> = {}) =>
      app.request("/discovery/resources", { headers: { "x-forwarded-for": "10.3.3.3", ...headers } });
    const statuses = async (count: number, headers?: Record<string, string>) => {
      const seen: number[] = [];
      for (let i = 0; i < count; i++) seen.push((await list(headers)).status);
      return seen;
    };
    const key = { "x-api-key": internal.key };
    // agent-a spends its own cost budget (3 units a minute) and is refused; agent-b still has its own.
    expect(await statuses(4, { ...key, "x-rail402-client": "agent-a" })).toEqual([200, 200, 200, 429]);
    expect(await statuses(3, { ...key, "x-rail402-client": "agent-b" })).toEqual([200, 200, 200]);
    // A direct caller from the identity's address has a budget of its own, untouched by both.
    expect(await statuses(4)).toEqual([200, 200, 200, 429]);
    // So does an address written like a forwarded client, as a proxy passing on a client's claim shows it:
    // agent-c's budget stays whole.
    expect(await statuses(4, { "x-forwarded-for": "k:discovery-front|c:agent-c" })).toEqual([
      200, 200, 200, 429,
    ]);
    expect(await statuses(3, { ...key, "x-rail402-client": "agent-c" })).toEqual([200, 200, 200]);
  });

  it("never reaches verify or settle", async () => {
    const app = service();
    const requirements = {
      scheme: "exact",
      network: TESTNET,
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      payTo: Keypair.random().publicKey(),
      amount: "1",
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const refused = await app.request("/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": internal.key,
        "x-forwarded-for": "10.2.2.2",
      },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: "AAAA" } },
        paymentRequirements: requirements,
      }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      invalidReason: "forbidden",
      error: { reason: "This key may call the discovery routes only." },
    });
  });
});

describe("the keys command", () => {
  const KEYS = fileURLToPath(new URL("../src/keys.ts", import.meta.url));
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        ["--conditions=@rail402/source", KEYS, ...args],
        { env: { PATH: process.env["PATH"] ?? "", ...env } },
        (error, stdout, stderr) => {
          resolve({
            code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
            stdout,
            stderr,
          });
        },
      );
    });

  it("creates a key and a record the file accepts, and checks a file", async () => {
    const created = await run(
      [
        "new",
        "--id",
        "acme-prod-2",
        "--networks",
        PUBNET,
        "--sponsor-budget-xlm-per-hour",
        "1.5",
        "--days",
        "30",
      ],
      { NETWORKS: `${TESTNET},${PUBNET}` },
    );
    expect(created.stderr).toBe("");
    const [key, line] = created.stdout.trim().split("\n");
    expect(key).toMatch(/^r402_acme-prod-2_[A-Za-z0-9_-]{43}$/);
    const entry = JSON.parse(line ?? "") as { sha256: string };
    expect(entry.sha256).toBe(
      createHash("sha256")
        .update(key ?? "")
        .digest("hex"),
    );
    const file = secretFile(keyFile([entry]));
    expect(await run(["check", file], { NETWORKS: `${TESTNET},${PUBNET}` })).toMatchObject({ code: 0 });
    const bad = await run(["check", file], { NETWORKS: TESTNET });
    expect(bad.code).toBe(78);
    expect(bad.stderr).toMatch(/^rail402: config_access_keys_invalid: /);
    expect((await run(["new", "--id", "x", "--networks", PUBNET])).code).toBe(78);
  });
});
