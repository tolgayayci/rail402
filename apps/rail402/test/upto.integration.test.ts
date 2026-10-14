/**
 * `upto` through the whole service on the private Stellar network, with the committed settlement
 * contract deployed per run: `/supported` and `/health` advertise and report it, a partial settlement
 * over HTTP moves exactly the settled amount and catalogs its MCP tool at the cap, an off-chain zero
 * settlement is never cataloged, startup refuses a contract running other code, a settlement
 * authority that cannot be created yet refuses upto payments with a coded answer until a poll creates
 * it, and the TTL keeper and the `upto` operator command extend the contract.
 * Needs `docker compose --profile stellar up -d`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createEd25519Signer } from "@x402/stellar";
import { deriveAuthorityKeypair, silentLogger } from "@rail402.dev/facilitator";
import { readContractTtl } from "@rail402.dev/stellar";
import { UptoStellarScheme as UptoClient } from "@rail402.dev/upto/client";
import { Metrics, createRuntime, loadConfig } from "@rail402.dev/service";
import {
  LocalNetwork,
  deployUpto,
  pinHorizon,
  type HorizonPin,
  type IssuedAsset,
  type LocalUptoContract,
} from "@rail402.dev/testkit";
import { upto } from "./channels-cli.ts";
import { startService, type RunningService } from "./service-harness.ts";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet" as const;
const CAP = 1_000_000n;
/** Seconds per ledger the client assumes; the pinned Horizon gives the service the same estimate. */
const LEDGER_SECONDS = 5;

describe.skipIf(!available)("upto through the Rail402 service", () => {
  let horizon: HorizonPin;
  let usdc: IssuedAsset;
  let contract: LocalUptoContract;
  let recipient: Keypair;
  let service: RunningService;
  let authority: string;

  const uptoEnv = () => ({
    TESTNET_UPTO_ENABLED: "true",
    TESTNET_UPTO_CONTRACT: contract.address,
    TESTNET_UPTO_WASM_HASH: contract.wasmHash,
    TESTNET_UPTO_TTL_KEEPER: "false",
    TESTNET_UPTO_TTL_EXTEND_BELOW_LEDGERS: "1000",
    TESTNET_UPTO_TTL_EXTEND_TO_LEDGERS: "300000",
    SEARCH_EMBEDDINGS: "false",
  });

  beforeAll(async () => {
    horizon = pinHorizon({ seconds: LEDGER_SECONDS });
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    recipient = await net.holder(usdc, "0");
    service = await startService(net, usdc, uptoEnv());
    authority = deriveAuthorityKeypair(service.sponsor, NETWORK).publicKey();
  }, 180_000);

  afterAll(async () => {
    await service.stop();
    horizon.restore();
  });

  function requirements(amount = CAP, facilitator = authority): PaymentRequirements {
    return {
      scheme: "upto",
      network: NETWORK,
      amount: amount.toString(),
      asset: usdc.sac,
      payTo: recipient.publicKey(),
      maxTimeoutSeconds: 120,
      extra: { areFeesSponsored: true, facilitatorAddress: facilitator },
    };
  }

  async function pay(payer: Keypair, toolName: string, facilitator = authority): Promise<PaymentPayload> {
    const client = new UptoClient(createEd25519Signer(payer.secret(), NETWORK), {
      rpcConfig: { url: net.rpcUrl },
      contracts: contract.address,
      ledgerSeconds: LEDGER_SECONDS,
    });
    const accepted = requirements(CAP, facilitator);
    const created = await client.createPaymentPayload(2, accepted);
    return {
      x402Version: 2,
      resource: { url: `mcp://tools.example/${toolName}`, description: "Metered forecast", mimeType: "" },
      accepted,
      payload: created.payload,
      extensions: declareDiscoveryExtension({
        toolName,
        description: "Forecast for a city, billed by the tokens used",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
      }),
    };
  }

  async function post(url: string, path: "/verify" | "/settle", payload: PaymentPayload, amount = CAP) {
    const facilitator = (payload.accepted.extra as { facilitatorAddress: string }).facilitatorAddress;
    const response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: requirements(amount, facilitator),
      }),
    });
    const header = response.headers.get("extension-responses");
    return {
      body: (await response.json()) as Record<string, unknown>,
      bazaar:
        header === null
          ? undefined
          : (
              JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
                bazaar?: Record<string, unknown>;
              }
            ).bazaar,
    };
  }

  it("advertises upto with its settlement authority and reports it in /health", async () => {
    const supported = (await (await fetch(`${service.url}/supported`)).json()) as {
      kinds: unknown[];
      signers: Record<string, string[]>;
    };
    expect(supported.kinds).toContainEqual({
      x402Version: 2,
      scheme: "upto",
      network: NETWORK,
      extra: { areFeesSponsored: true, facilitatorAddress: authority },
    });
    expect(supported.signers["stellar:*"]).toContain(authority);

    await expect
      .poll(() => service.runtime.health().networks[NETWORK]?.upto?.authority.present, { timeout: 30_000 })
      .toBe(true);
    const health = service.runtime.health();
    expect(health.networks[NETWORK]?.upto).toMatchObject({
      contract: contract.address,
      authority: {
        address: authority,
        present: true,
        balanceStroops: "0",
        spendableStroops: "0",
        tokens: [],
      },
      keeper: { enabled: false, autoRestore: true },
    });
    expect(health.networks[NETWORK]?.contracts["upto"]).toMatchObject({ id: contract.address });
    expect(health.warnings.filter((warning) => warning.code.startsWith("upto_"))).toEqual([]);
    expect((await service.runtime.readiness()).ready).toBe(true);
  });

  it("settles part of the cap over HTTP and catalogs the tool at the cap", async () => {
    const payer = await net.holder(usdc, "1");
    const payload = await pay(payer, "forecast-partial");
    expect((await post(service.url, "/verify", payload)).body).toEqual({
      isValid: true,
      payer: payer.publicKey(),
    });
    const before = await net.tokenBalance(usdc.sac, recipient.publicKey());
    const settled = await post(service.url, "/settle", payload, 250_000n);
    expect(settled.body).toMatchObject({
      success: true,
      network: NETWORK,
      payer: payer.publicKey(),
      amount: "250000",
    });
    expect(settled.body["transaction"]).toMatch(/^[0-9a-f]{64}$/);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(10_000_000n - 250_000n);
    expect(await net.tokenBalance(usdc.sac, recipient.publicKey())).toBe(before + 250_000n);
    expect(await net.tokenBalance(usdc.sac, authority)).toBe(0n);
    expect(settled.bazaar).toMatchObject({ status: "success", code: "cataloged" });

    const listings = (await (
      await fetch(`${service.url}/discovery/resources?type=mcp&payTo=${recipient.publicKey()}`)
    ).json()) as { items: { accepts: unknown[] }[] };
    expect(listings.items).toHaveLength(1);
    expect(listings.items[0]?.accepts).toEqual([
      expect.objectContaining({ scheme: "upto", amount: CAP.toString(), payTo: recipient.publicKey() }),
    ]);

    const counted = await service.metrics.uptoSettlements.get();
    expect(counted.values).toContainEqual(
      expect.objectContaining({ labels: { network: NETWORK, amount: "partial", mode: "onchain" }, value: 1 }),
    );
  });

  it("never catalogs an off-chain zero settlement", async () => {
    const offchain = await startService(net, usdc, {
      ...uptoEnv(),
      TESTNET_UPTO_ZERO_SETTLEMENT: "offchain",
    });
    try {
      const payer = await net.holder(usdc, "1");
      const payload = await pay(
        payer,
        "forecast-zero",
        deriveAuthorityKeypair(offchain.sponsor, NETWORK).publicKey(),
      );
      const settled = await post(offchain.url, "/settle", payload, 0n);
      expect(settled.body).toMatchObject({ success: true, transaction: "", amount: "0" });
      expect(settled.bazaar).toMatchObject({ status: "rejected", code: "bazaar_settlement_offchain" });
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(10_000_000n);
    } finally {
      await offchain.stop();
    }
  });

  it("refuses to start with a contract running other code, and starts without its authority", async () => {
    const sponsor = Keypair.random();
    await net.fund(sponsor);
    const config = (env: Record<string, string>) =>
      loadConfig({
        STORE: "memory",
        BAZAAR_ENABLED: "false",
        TESTNET_RPC_URL: net.rpcUrl,
        TESTNET_SPONSOR_SECRET: sponsor.secret(),
        TESTNET_CHANNEL_COUNT: "1",
        TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
        ...uptoEnv(),
        ...env,
      });
    await expect(
      createRuntime(config({ TESTNET_UPTO_WASM_HASH: "00".repeat(32) }), new Metrics(), silentLogger),
    ).rejects.toThrow(`runs WASM ${contract.wasmHash}, not the configured ${"00".repeat(32)}`);

    // A sponsor that cannot pay yet (its account does not exist): the service starts, exact is
    // unaffected, and upto is refused with a coded answer until the authority exists.
    const unfunded = Keypair.random();
    const runtime = await createRuntime(
      config({ TESTNET_SPONSOR_SECRET: unfunded.secret(), TESTNET_AUTO_PROVISION_CHANNELS: "false" }),
      new Metrics(),
      silentLogger,
    );
    try {
      const missing = deriveAuthorityKeypair(unfunded, NETWORK).publicKey();
      const payload = await pay(Keypair.random(), "no-authority", missing);
      expect(await runtime.facilitator.core.verify(payload, requirements(CAP, missing))).toMatchObject({
        isValid: false,
        invalidReason: "settle_upto_stellar_authority_unavailable",
      });
      expect(await runtime.facilitator.core.settle(payload, requirements(100n, missing))).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_authority_unavailable",
      });

      // Once the sponsor can pay, the next poll creates the authority: no restart needed.
      await net.fund(unfunded);
      runtime.start();
      await expect
        .poll(() => runtime.health().networks[NETWORK]?.upto?.authority.present, { timeout: 30_000 })
        .toBe(true);
      expect(runtime.health().warnings.map((warning) => warning.code)).not.toContain(
        "upto_authority_missing",
      );
      expect(
        (await runtime.facilitator.core.verify(payload, requirements(CAP, missing))).invalidReason,
      ).not.toBe("settle_upto_stellar_authority_unavailable");
    } finally {
      await runtime.stop();
    }
  });

  it("extends the contract from the keeper and the operator command, and reports its TTL", async () => {
    const env = {
      STORE: "memory",
      TESTNET_RPC_URL: net.rpcUrl,
      TESTNET_SPONSOR_SECRET: service.sponsor.secret(),
      TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
      ...uptoEnv(),
    };
    const status = await upto(["ttl", "status"], env);
    expect(status.code).toBe(0);
    const [before] = status.lines;
    expect(before).toMatchObject({
      network: NETWORK,
      contract: contract.address,
      wasmHash: contract.wasmHash,
      liveWasmHash: contract.wasmHash,
      archived: { instance: false, code: false },
      plan: "none",
      keeper: { enabled: false, autoRestore: true },
    });

    // The keeper extends both entries once they are below the threshold (here: forced).
    const keeper = service.runtime.uptoKeepers.get(NETWORK);
    const round = await keeper?.maintain("extend");
    expect(round?.skipped, "a forced round waits for the sponsor's lock instead of skipping").toBeUndefined();
    expect(round?.transactions.map((transaction) => transaction.action)).toEqual(["extend"]);
    expect(round?.liveness.instanceTtlLedgers).toBeGreaterThan(299_000);
    expect(round?.liveness.codeTtlLedgers).toBeGreaterThan(299_000);
    expect(keeper?.snapshot()).toMatchObject({ plan: "none", lastAction: { action: "extend" } });

    const extended = await upto(["ttl", "extend", "--to", "400000"], env);
    expect(extended.code).toBe(0);
    expect(extended.lines[0]).toMatchObject({ plan: "extend", transactions: [{ action: "extend" }] });
    const reading = await readContractTtl(net.server, [contract.address]);
    const ttl = reading.contracts.get(contract.address);
    expect((ttl?.instanceLiveUntil ?? 0) - reading.latestLedger).toBeGreaterThan(399_000);
    expect((ttl?.codeLiveUntil ?? 0) - reading.latestLedger).toBeGreaterThan(399_000);

    const authorityStatus = await upto(["authority", "status"], env);
    expect(authorityStatus.lines).toEqual([
      { network: NETWORK, authority, present: true, balanceStroops: "0", spendableStroops: "0" },
    ]);
    const disabled = await upto(["ttl", "status"], { ...env, TESTNET_UPTO_ENABLED: "false" });
    expect(disabled.code).toBe(64);
    expect(disabled.stderr).toMatch(/no selected network serves upto/);
  });
});
