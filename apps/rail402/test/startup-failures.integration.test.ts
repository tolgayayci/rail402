/**
 * Startup with one network whose RPC makes the chain checks throw something that is not an Error (a
 * JSON-RPC error object, a string, `null`, `undefined`): that network is held with a code, the other
 * one serves, and nothing stops the process. Needs `docker compose --profile stellar up -d`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { deriveChannelKeypairs, silentLogger } from "@rail402.dev/facilitator";
import { Metrics, createApp, createRuntime, loadConfig, type Runtime } from "@rail402.dev/service";
import {
  LocalNetwork,
  requirementsFor,
  startRpcProxy,
  startTlsRpcProxy,
  type IssuedAsset,
  type RpcProxy,
  type TlsRpcProxy,
} from "@rail402.dev/testkit";
import { COLD_SIGNER, sponsorKeyFile } from "./secret-fixtures.ts";

const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("startup when an RPC throws something that is not an Error", () => {
  let usdc: IssuedAsset;
  let seller: Keypair;
  let proxy: RpcProxy;
  let tls: TlsRpcProxy;
  let env: Record<string, string>;
  const runtimes: Runtime[] = [];

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    const testnetSponsor = Keypair.random();
    const pubnetSponsor = Keypair.random();
    await net.fund(testnetSponsor);
    await net.fund(pubnetSponsor);
    for (const channel of deriveChannelKeypairs(pubnetSponsor, "stellar:pubnet", 1)) await net.fund(channel);
    proxy = await startRpcProxy(net.rpcUrl);
    tls = await startTlsRpcProxy(proxy.url);
    tls.trust();
    env = {
      STORE: "memory",
      NETWORKS: "stellar:testnet,stellar:pubnet",
      BAZAAR_ENABLED: "false",
      RATE_LIMIT_PER_MINUTE: "0",
      TESTNET_RPC_URL: net.rpcUrl,
      TESTNET_SPONSOR_SECRET: testnetSponsor.secret(),
      TESTNET_CHANNEL_COUNT: "1",
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
      PUBNET_CHANNEL_COUNT: "1",
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    proxy.reset();
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  });

  afterAll(async () => {
    await tls.close();
    await proxy.close();
  });

  /** Starts the runtime; it must not throw whatever pubnet's RPC does. */
  const start = async () => {
    const config = loadConfig(env);
    const runtime = await createRuntime(config, new Metrics(), silentLogger);
    runtimes.push(runtime);
    return { config, runtime };
  };

  const expectPubnetHeldOnly = (runtime: Runtime) => {
    expect(runtime.networkReadiness("stellar:pubnet")).toMatchObject({
      state: "held",
      holdReason: "rpc_unreachable",
    });
    expect(runtime.refusal("stellar:pubnet")).toMatch(/^stellar:pubnet is not serving: /);
    expect(runtime.refusal("stellar:pubnet")).not.toContain("[object");
    expect(runtime.networkReadiness("stellar:testnet")).toMatchObject({ state: "serving" });
    expect(runtime.refusal("stellar:testnet")).toBeUndefined();
  };

  it("holds pubnet only when its RPC answers with a JSON-RPC error object, and testnet settles", async () => {
    proxy.answerError({ code: -32603, message: "captive core is not ready" });
    const { config, runtime } = await start();
    expectPubnetHeldOnly(runtime);

    const app = createApp({
      config,
      facilitator: runtime.facilitator,
      metrics: new Metrics(),
      log: silentLogger,
      readiness: () => runtime.readiness(),
      networkReadiness: (network) => runtime.networkReadiness(network),
      refusal: (network) => runtime.refusal(network),
      health: () => runtime.health(),
      version: "test",
    });
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const requirements = requirementsFor(usdc.sac, seller.publicKey(), 1_000_000n);
    const payload = await net.payment(payer, requirements);
    const settled = await app.request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
    });
    expect(await settled.json()).toMatchObject({ success: true, network: "stellar:testnet" });
  });

  it.each([
    ["a string", "overloaded"],
    ["null", null],
  ])("holds pubnet only when its RPC answers with %s as the JSON-RPC error", async (_kind, error) => {
    proxy.answerError(error);
    const { runtime } = await start();
    expectPubnetHeldOnly(runtime);
  });

  it.each([
    ["undefined", undefined],
    ["a string", "socket closed"],
    ["a plain object", { status: 503 }],
  ])("holds pubnet only when an RPC call itself throws %s", async (_kind, thrown) => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied to its own server below
    const original = rpc.Server.prototype.getLedgerEntries;
    // Only calls to pubnet's RPC throw; testnet's go to the network directly.
    vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation(function (
      this: rpc.Server,
      ...keys
    ) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the test
      if (this.serverURL.toString().startsWith(tls.url)) return Promise.reject(thrown);
      return original.apply(this, keys);
    });
    const { runtime } = await start();
    expectPubnetHeldOnly(runtime);
  });

  it("holds a network whose sponsor does not exist as sponsor_missing, not as an unreachable RPC", async () => {
    // Testnet creates its channel accounts at startup, from a sponsor that was never funded.
    const config = loadConfig({ ...env, TESTNET_SPONSOR_SECRET: Keypair.random().secret() });
    const runtime = await createRuntime(config, new Metrics(), silentLogger);
    runtimes.push(runtime);
    expect(runtime.networkReadiness("stellar:testnet")).toMatchObject({
      state: "held",
      holdReason: "sponsor_missing",
    });
    expect(runtime.refusal("stellar:testnet")).toBe(
      "stellar:testnet is not serving: its fee sponsor account does not exist. Retry later.",
    );
  });

  it("serves pubnet once its RPC answers properly again, without a restart", async () => {
    proxy.answerError({ code: -32603, message: "captive core is not ready" });
    const { runtime } = await start();
    runtime.start();
    expectPubnetHeldOnly(runtime);
    proxy.answerError(undefined);
    await expect
      .poll(() => runtime.networkReadiness("stellar:pubnet")?.state, { timeout: 60_000, interval: 1_000 })
      .toBe("serving");
  });
});
