/**
 * One process serving testnet and pubnet: a pubnet problem holds pubnet only. The "pubnet" here is a
 * second network on the same local Stellar network behind an https proxy whose answers the test
 * controls. Needs `docker compose --profile stellar up -d`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { deriveChannelKeypairs, silentLogger } from "@rail402.dev/facilitator";
import {
  Metrics,
  createApp,
  createRuntime,
  loadConfig,
  newAccessKey,
  type Runtime,
} from "@rail402.dev/service";
import {
  LocalNetwork,
  requirementsFor,
  startRpcProxy,
  startTlsRpcProxy,
  type IssuedAsset,
  type RpcProxy,
  type TlsRpcProxy,
} from "@rail402.dev/testkit";
import { COLD_SIGNER, secretFile, sponsorKeyFile } from "./secret-fixtures.ts";

const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("one process, two networks", () => {
  let usdc: IssuedAsset;
  let seller: Keypair;
  let proxy: RpcProxy;
  let tls: TlsRpcProxy;
  let runtime: Runtime;
  let app: ReturnType<typeof createApp>;
  let configEnv: Record<string, string>;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    const testnetSponsor = Keypair.random();
    const pubnetSponsor = Keypair.random();
    await net.fund(testnetSponsor);
    await net.fund(pubnetSponsor);
    // Pubnet never creates channel accounts at startup; these stand in for `channels provision`.
    for (const channel of deriveChannelKeypairs(pubnetSponsor, "stellar:pubnet", 2)) await net.fund(channel);

    proxy = await startRpcProxy(net.rpcUrl);
    tls = await startTlsRpcProxy(proxy.url);
    tls.trust();
    // Pubnet's RPC is down when the process starts.
    proxy.failRequests(503);

    configEnv = {
      STORE: "memory",
      NETWORKS: "stellar:testnet,stellar:pubnet",
      BAZAAR_ENABLED: "false",
      RATE_LIMIT_PER_MINUTE: "0",
      TESTNET_RPC_URL: net.rpcUrl,
      TESTNET_SPONSOR_SECRET: testnetSponsor.secret(),
      TESTNET_CHANNEL_COUNT: "2",
      TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
      TESTNET_MAX_TX_FEE_STROOPS: "2000000",
      TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
      TESTNET_UPTO_ENABLED: "false",
      METRICS_PRIVATE_TOKEN_SHA256: "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff",
      PUBNET_RPC_SINGLE_PROVIDER: "true",
      PUBNET_ALLOW_SINGLE_SIGNER_SPONSOR: "true",
      PUBNET_RPC_URL: tls.url,
      PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(pubnetSponsor.secret()),
      PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
      PUBNET_CHANNEL_COUNT: "2",
      PUBNET_REQUIRE_API_KEY: "false",
      PUBNET_RATE_LIMIT_PER_MINUTE: "60",
      PUBNET_KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR: "1",
      PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "10",
      PUBNET_MAX_TX_FEE_STROOPS: "2000000",
      PUBNET_INCLUSION_FEE_STROOPS: "200",
      PUBNET_ASSETS: `${usdc.sac}:USDC:7:1`,
      PUBNET_MIN_SPONSOR_BALANCE_XLM: "1",
      PUBNET_STARTUP_TIMEOUT_MS: "5000",
    };
    const config = loadConfig(configEnv);
    const metrics = new Metrics();
    runtime = await createRuntime(config, metrics, silentLogger);
    runtime.start();
    app = createApp({
      config,
      facilitator: runtime.facilitator,
      metrics,
      log: silentLogger,
      readiness: () => runtime.readiness(),
      networkReadiness: (network) => runtime.networkReadiness(network),
      refusal: (network) => runtime.refusal(network),
      health: () => runtime.health(),
      version: "test",
    });
  });

  afterAll(async () => {
    await runtime.stop();
    await tls.close();
    await proxy.close();
  });

  const post = (path: string, payload: unknown, requirements: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
    });

  it("refuses pubnet settlements, not testnet ones, while the pubnet RPC is down", async () => {
    expect((await app.request("/ready")).status).toBe(200);
    await expect
      .poll(async () => (await app.request("/ready/testnet")).status, { timeout: 30_000 })
      .toBe(200);
    const pubnet = await app.request("/ready/pubnet");
    expect(pubnet.status).toBe(503);
    expect(await pubnet.json()).toMatchObject({ state: "held", holdReason: "rpc_unreachable" });

    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const testnet = requirementsFor(usdc.sac, seller.publicKey(), 1_000_000n);
    const payload = await net.payment(payer, testnet);
    const settled = await post("/settle", payload, testnet);
    expect(await settled.json()).toMatchObject({ success: true, network: "stellar:testnet" });

    const onPubnet = { ...testnet, network: "stellar:pubnet" };
    const refused = await post("/settle", { ...(payload as object), accepted: onPubnet }, onPubnet);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ errorReason: "service_unavailable" });

    const health = (await (await app.request("/health")).json()) as {
      networks: Record<string, { state: string; status: string; sponsor: Record<string, unknown> }>;
    };
    expect(health.networks["stellar:pubnet"]).toMatchObject({ state: "held", status: "degraded" });
    expect(health.networks["stellar:testnet"]?.state).toBe("serving");
  });

  it("serves pubnet once its RPC answers again, without a restart", async () => {
    proxy.failRequests(undefined);
    await expect
      .poll(async () => (await app.request("/ready/pubnet")).status, { timeout: 60_000, interval: 1_000 })
      .toBe(200);
    expect(runtime.refusal("stellar:pubnet")).toBeUndefined();
    const health = (await (await app.request("/health")).json()) as {
      networks: Record<string, { state: string; sponsor: Record<string, unknown> }>;
    };
    // The public view says whether the pubnet sponsor is funded, never how much it holds.
    expect(health.networks["stellar:pubnet"]?.sponsor).toEqual({
      address: expect.any(String) as string,
      funded: true,
    });
    const readiness = (await (await app.request("/ready/pubnet")).json()) as {
      checks: Record<string, { detail?: string }>;
    };
    expect(readiness.checks["sponsor"]?.detail).toBe("funded");
  });
  it("holds pubnet when its upto contract is absent, without touching testnet", async () => {
    // Runs after the RPC came back (the test above).
    const pubnetSponsor = Keypair.random();
    await net.fund(pubnetSponsor);
    for (const channel of deriveChannelKeypairs(pubnetSponsor, "stellar:pubnet", 1)) await net.fund(channel);
    const key = newAccessKey("absent-upto-1");
    const held = await createRuntime(
      loadConfig({
        ...configEnv,
        PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(pubnetSponsor.secret()),
        PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
        PUBNET_CHANNEL_COUNT: "1",
        TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
        TESTNET_AUTO_PROVISION_CHANNELS: "false",
        PUBNET_REQUIRE_API_KEY: "true",
        PUBNET_RATE_LIMIT_PER_MINUTE: "",
        PUBNET_KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR: "",
        API_KEYS_FILE: secretFile(
          JSON.stringify({
            schemaVersion: 1,
            keys: [
              {
                id: "absent-upto-1",
                sha256: key.sha256,
                networks: ["stellar:pubnet"],
                sponsorBudgetXlmPerHour: "1",
                expiresAt: "2099-01-01T00:00:00Z",
                createdAt: "2098-06-01T00:00:00Z",
              },
            ],
          }),
        ),
        PUBNET_UPTO_ENABLED: "true",
        PUBNET_UPTO_ZERO_SETTLEMENT: "onchain",
        PUBNET_UPTO_CONTRACT: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        PUBNET_UPTO_WASM_HASH: "ab".repeat(32),
        PUBNET_UPTO_MAX_TX_FEE_STROOPS: "2000000",
        PUBNET_UPTO_TTL_MAX_FEE_STROOPS: "50000000",
      }),
      new Metrics(),
      silentLogger,
    );
    try {
      expect(held.networkReadiness("stellar:pubnet")).toMatchObject({
        state: "held",
        holdReason: "upto_contract_mismatch",
      });
      expect(held.refusal("stellar:pubnet")).toMatch(/upto contract/);
      expect(held.refusal("stellar:testnet")).toBeUndefined();
    } finally {
      await held.stop();
    }
  });
});
