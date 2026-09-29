/**
 * The whole service — configuration, Postgres stores, channel provisioning, HTTP — on a random port,
 * driven by upstream's stock HTTPFacilitatorClient. Needs `docker compose --profile stellar up -d`.
 */
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Keypair } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { SettleError, VerifyError, type PaymentPayload, type PaymentRequirements } from "@x402/core/types";
import { silentLogger } from "@rail402.dev/facilitator";
import { createDatabase } from "@rail402.dev/store-postgres";
import { Metrics, createApp, createRuntime, loadConfig, type Runtime } from "@rail402.dev/service";
import { LocalNetwork, requirementsFor, type IssuedAsset } from "@rail402.dev/testkit";
import { sql } from "kysely";

const net = new LocalNetwork();
const DATABASE_URL =
  process.env["RAIL402_TEST_DATABASE_URL"] ?? "postgres://rail402:rail402@localhost:5432/rail402";
const available = await net.available();

describe.skipIf(!available)("service over HTTP with the stock facilitator client", () => {
  let usdc: IssuedAsset;
  let seller: Keypair;
  let runtime: Runtime;
  let server: ServerType;
  let client: HTTPFacilitatorClient;
  let schema: string;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    const sponsor = Keypair.random();
    await net.fund(sponsor);
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];

    schema = `svc_${randomBytes(6).toString("hex")}`;
    const admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    await admin.destroy();

    const config = loadConfig({
      DATABASE_URL: `${DATABASE_URL}?options=-c%20search_path%3D${schema}`,
      TESTNET_RPC_URL: net.rpcUrl,
      TESTNET_SPONSOR_SECRET: sponsor.secret(),
      TESTNET_CHANNEL_COUNT: "4",
      TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
      TESTNET_MAX_TX_FEE_STROOPS: "2000000",
      TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
      RATE_LIMIT_PER_MINUTE: "0",
    });
    const metrics = new Metrics();
    runtime = await createRuntime(config, metrics, silentLogger);
    runtime.start();
    const app = createApp({
      config,
      facilitator: runtime.facilitator,
      metrics,
      log: silentLogger,
      readiness: () => runtime.readiness(),
      version: "test",
    });
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    client = new HTTPFacilitatorClient({ url: `http://127.0.0.1:${String(port)}` });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await runtime.stop();
    const admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin);
    await admin.destroy();
  });

  it("is ready once channels are provisioned, the sponsor is funded and search is indexed", async () => {
    await expect.poll(async () => (await runtime.readiness()).ready, { timeout: 30_000 }).toBe(true);
    const { checks } = await runtime.readiness();
    expect(Object.keys(checks)).toEqual(expect.arrayContaining(["search", "stellar:testnet:channels"]));
  });

  it("advertises stellar:testnet with sponsored fees to the stock client", async () => {
    const supported = await client.getSupported();
    expect(supported.kinds).toContainEqual({
      x402Version: 2,
      scheme: "exact",
      network: "stellar:testnet",
      extra: { areFeesSponsored: true },
    });
  });

  it("verifies and settles a payment through the stock client", async () => {
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const requirements = requirementsFor(usdc.sac, seller.publicKey(), 1_000_000n) as PaymentRequirements;
    const payload = (await net.payment(
      payer,
      requirementsFor(usdc.sac, seller.publicKey(), 1_000_000n),
    )) as PaymentPayload;

    expect(await client.verify(payload, requirements)).toMatchObject({
      isValid: true,
      payer: payer.publicKey(),
    });
    const settled = await client.settle(payload, requirements);
    expect(settled).toMatchObject({ success: true, network: "stellar:testnet", payer: payer.publicKey() });
    expect(settled.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(await client.settle(payload, requirements)).toEqual(settled);
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBeGreaterThanOrEqual(1_000_000n);
  });

  it("returns coded rejections the stock client can read", async () => {
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const requirements = requirementsFor(usdc.sac, seller.publicKey(), 1_000n) as PaymentRequirements;
    const payload = (await net.payment(
      payer,
      requirementsFor(usdc.sac, seller.publicKey(), 1_000n),
    )) as PaymentPayload;
    const wrongAmount = { ...requirements, amount: "2000" };
    const accepted = { ...payload, accepted: wrongAmount };

    const verify = await client.verify(accepted, wrongAmount);
    expect(verify).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_wrong_amount",
    });
    expect(verify.invalidMessage?.trim()).not.toBe("");

    const settle = await client.settle(accepted, wrongAmount);
    expect(settle).toMatchObject({
      success: false,
      errorReason: "invalid_exact_stellar_payload_wrong_amount",
    });
  });

  it("surfaces transport-level rejections as typed client errors", async () => {
    const broken = { ...requirementsFor(usdc.sac, seller.publicKey(), 1n), maxTimeoutSeconds: "soon" };
    const payload = { x402Version: 2, accepted: broken, payload: {} } as unknown as PaymentPayload;
    await expect(client.verify(payload, broken as unknown as PaymentRequirements)).resolves.toMatchObject({
      isValid: false,
    });
    const missing = { x402Version: 2 } as unknown as PaymentPayload;
    await expect(client.verify(missing, broken as unknown as PaymentRequirements)).rejects.toBeInstanceOf(
      VerifyError,
    );
    await expect(client.settle(missing, broken as unknown as PaymentRequirements)).rejects.toBeInstanceOf(
      SettleError,
    );
  });
});
