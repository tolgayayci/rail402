/**
 * One process, two networks: a held network refuses its own /verify and /settle with a coded,
 * retryable 503, the other keeps serving, and readiness is reported per network.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { silentLogger, type StellarFacilitator } from "@rail402.dev/facilitator";
import {
  HOLD_REASONS,
  Metrics,
  NetworkGate,
  createApp,
  loadConfig,
  publicHealth,
  type HealthSnapshot,
  type NetworkReadiness,
} from "@rail402.dev/service";
import { COLD_SIGNER, secretFile, sponsorKeyFile } from "./secret-fixtures.ts";

const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const bothNetworks = {
  NETWORKS: "stellar:testnet,stellar:pubnet",
  DATABASE_URL_FILE: secretFile("postgres://rail402:rail402@localhost:5432/rail402"),
  TESTNET_RPC_URL: "http://localhost:8000/rpc",
  TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
  METRICS_PRIVATE_TOKEN_SHA256: "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff",
  PUBNET_RPC_SINGLE_PROVIDER: "true",
  PUBNET_RPC_URL: "https://127.0.0.1:1/rpc",
  PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(Keypair.random().secret()),
  PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
  PUBNET_REQUIRE_API_KEY: "false",
  PUBNET_RATE_LIMIT_PER_MINUTE: "60",
  PUBNET_KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR: "1",
  PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "10",
  PUBNET_MAX_TX_FEE_STROOPS: "300000",
  PUBNET_INCLUSION_FEE_STROOPS: "200",
  PUBNET_ASSETS: `${PUBNET_USDC}:USDC:7:10000`,
};

describe("NetworkGate", () => {
  it("starts, serves, holds and refuses with a public reason", () => {
    const changes: string[] = [];
    const gate = new NetworkGate("stellar:pubnet", (snapshot) => changes.push(snapshot.state));
    expect(gate.snapshot()).toEqual({ state: "starting", holdReason: null, servingSince: null });
    expect(gate.refusal()).toBe("stellar:pubnet is not serving: it is starting. Retry later.");
    gate.serve(new Date(1_000));
    expect(gate.snapshot()).toEqual({ state: "serving", holdReason: null, servingSince: new Date(1_000) });
    expect(gate.refusal()).toBeUndefined();
    gate.hold("sponsor_below_reserve");
    expect(gate.refusal()).toBe(
      "stellar:pubnet is not serving: its fee sponsor is below its reserve. Retry later.",
    );
    gate.hold("sponsor_below_reserve");
    gate.serve();
    expect(changes).toEqual(["serving", "held", "serving"]);
  });

  it("never serves again by itself once the chain contradicts the configuration", () => {
    const gate = new NetworkGate("stellar:pubnet");
    gate.hold("upto_contract_mismatch");
    gate.serve();
    gate.hold("rpc_unreachable");
    expect(gate.snapshot()).toMatchObject({ state: "held", holdReason: "upto_contract_mismatch" });
  });

  it("gives every hold reason a public text without numbers", () => {
    for (const reason of HOLD_REASONS) {
      const gate = new NetworkGate("stellar:pubnet");
      gate.hold(reason);
      expect(gate.refusal(), reason).toMatch(/^stellar:pubnet is not serving: [A-Za-z' ]+\. Retry later\.$/);
    }
  });
});

describe("the serving gate in the service", () => {
  const config = loadConfig(bothNetworks);
  const settled: string[] = [];
  const facilitator = {
    core: {
      getSupported: () => ({
        kinds: ["stellar:testnet", "stellar:pubnet"].map((network) => ({
          x402Version: 2,
          scheme: "exact",
          network,
          extra: { areFeesSponsored: true },
        })),
        extensions: [],
        signers: {},
      }),
      verify: (_payload: unknown, requirements: { network: string }) => {
        settled.push(`verify ${requirements.network}`);
        return Promise.resolve({ isValid: true, payer: "GPAYER" });
      },
      settle: (_payload: unknown, requirements: { network: string }) => {
        settled.push(`settle ${requirements.network}`);
        return Promise.resolve({ success: true, transaction: "a".repeat(64), network: requirements.network });
      },
    },
    networks: new Map(),
  } as unknown as StellarFacilitator;
  const readiness = (network: string): NetworkReadiness =>
    network === "stellar:pubnet"
      ? {
          ready: false,
          checks: { rpc: { ok: false, detail: "connection refused" } },
          network,
          state: "held",
          holdReason: "rpc_unreachable",
        }
      : { ready: true, checks: { rpc: { ok: true } }, network, state: "serving", holdReason: null };
  const app = createApp({
    config,
    facilitator,
    metrics: new Metrics(),
    log: silentLogger,
    readiness: () => Promise.resolve({ ready: true, checks: {} }),
    networkReadiness: readiness,
    refusal: (network) =>
      network === "stellar:pubnet"
        ? "stellar:pubnet is not serving: its RPC cannot be reached. Retry later."
        : undefined,
    version: "test",
  });
  const request = (path: string, network: string) => {
    const requirements = {
      scheme: "exact",
      network,
      asset: PUBNET_USDC,
      payTo: Keypair.random().publicKey(),
      amount: "10000",
      maxTimeoutSeconds: 60,
      extra: {},
    };
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: "AAAA" } },
        paymentRequirements: requirements,
      }),
    });
  };

  it("refuses pubnet settlements, not testnet ones, while pubnet is held", async () => {
    for (const path of ["/verify", "/settle"]) {
      const refused = await request(path, "stellar:pubnet");
      expect(refused.status).toBe(503);
      expect(refused.headers.get("retry-after")).toBe("30");
      const body = (await refused.json()) as Record<string, unknown>;
      expect(body["error"]).toMatchObject({
        code: "service_unavailable",
        retryable: true,
        reason: "stellar:pubnet is not serving: its RPC cannot be reached. Retry later.",
      });
      expect(body[path === "/verify" ? "invalidReason" : "errorReason"]).toBe("service_unavailable");
      expect((await request(path, "stellar:testnet")).status).toBe(200);
    }
    expect(settled).toEqual(["verify stellar:testnet", "settle stellar:testnet"]);
  });

  it("reports readiness per network and keeps /ready process-wide", async () => {
    const pubnet = await app.request("/ready/pubnet");
    expect(pubnet.status).toBe(503);
    expect(await pubnet.json()).toMatchObject({
      network: "stellar:pubnet",
      state: "held",
      holdReason: "rpc_unreachable",
    });
    const testnet = await app.request("/ready/testnet");
    expect(testnet.status).toBe(200);
    expect(await testnet.json()).toMatchObject({ network: "stellar:testnet", state: "serving" });
    expect((await app.request("/ready")).status).toBe(200);
  });

  it("answers 404 for the readiness of a network it does not serve", async () => {
    const single = createApp({
      config: loadConfig({
        STORE: "memory",
        TESTNET_RPC_URL: "http://localhost:8000/rpc",
        TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
      }),
      facilitator,
      metrics: new Metrics(),
      log: silentLogger,
      readiness: () => Promise.resolve({ ready: true, checks: {} }),
      networkReadiness: readiness,
      version: "test",
    });
    expect((await single.request("/ready/pubnet")).status).toBe(404);
    expect((await single.request("/ready/testnet")).status).toBe(200);
  });
});

describe("the public /health view", () => {
  const network = (balance: string) => ({
    state: "serving" as const,
    holdReason: null,
    servingSince: null,
    status: "degraded" as const,
    rpc: { ok: true, latestLedger: 1, ledgerAgeSeconds: 1, transportErrors1h: 0 },
    sponsor: {
      address: "GSPONSOR",
      funded: false,
      balanceStroops: balance,
      committed1hStroops: "4800",
      wasted1hStroops: "900",
    },
    channels: { total: 8, inUse: 3, leaseWaitP95Ms: 12, leaseTimeouts1h: 0 },
    settlements: { last1h: null, unfinished: null, unresolvable: 0, repeats1h: 0 },
    sequenceConflicts1h: 0,
    contracts: {},
  });
  const warning = (network: string, balance: string) => ({
    code: "sponsor_below_floor" as const,
    severity: "critical" as const,
    network,
    message: `The fee sponsor holds ${balance} stroops, below the minimum of 250000000.`,
    publicMessage: "The fee sponsor holds less than its minimum balance.",
  });
  const snapshot: HealthSnapshot = {
    status: "ok",
    version: "test",
    state: "degraded",
    checkedAt: null,
    warnings: [warning("stellar:testnet", "111111111"), warning("stellar:pubnet", "123456789")],
    networks: { "stellar:testnet": network("111111111"), "stellar:pubnet": network("123456789") },
  };

  it("omits the pubnet sponsor balance from public health and shows funded instead", () => {
    const view = publicHealth(snapshot);
    expect(view.networks["stellar:pubnet"]?.sponsor).toEqual({ address: "GSPONSOR", funded: false });
    expect(view.networks["stellar:pubnet"]?.channels).toEqual({ total: 8, leaseTimeouts1h: 0 });
    // Testnet stays fully public.
    expect(view.networks["stellar:testnet"]).toEqual(snapshot.networks["stellar:testnet"]);
    const text = JSON.stringify(view);
    expect(text).not.toContain("123456789");
    expect(text).not.toContain("publicMessage");
    expect(text).toContain("111111111");
  });
});
