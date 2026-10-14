/**
 * `upto` against an archived settlement contract, on a private network of the test's own whose
 * contracts are archived about ten ledgers after their last extension (test/stellar/short-ttl.json,
 * started in its own container on a free port; the shared network is never touched).
 *
 * Since protocol 23 a freshly simulated invocation would restore an archived contract inside the
 * payment and bill the rent to whoever pays the fee. The service refuses instead, with a coded
 * reason and no transaction, until the contract is restored outside any payment: by an operator
 * (`upto ttl restore`) or by the TTL keeper where automatic restoration is allowed. Payments then
 * settle again. Needs Docker; set RAIL402_TEST_ARCHIVAL=0 to skip.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import {
  MemoryTaskLock,
  contractLiveness,
  deriveAuthorityKeypair,
  extendContractTtl,
  silentLogger,
} from "@rail402.dev/facilitator";
import { readContractTtl } from "@rail402.dev/stellar";
import { UptoStellarScheme as UptoClient } from "@rail402.dev/upto/client";
import { Metrics, UptoTtlKeeper } from "@rail402.dev/service";
import {
  deployUpto,
  dockerAvailable,
  pinHorizon,
  startArchivalNetwork,
  type ArchivalNetwork,
  type HorizonPin,
  type IssuedAsset,
  type LocalNetwork,
  type LocalUptoContract,
} from "@rail402.dev/testkit";
import { upto } from "./channels-cli.ts";
import { startService, type RunningService } from "./service-harness.ts";

const enabled = process.env["RAIL402_TEST_ARCHIVAL"] !== "0" && (await dockerAvailable());
const NETWORK = "stellar:testnet" as const;
const CAP = 1_000_000n;
const LEDGER_SECONDS = 5;
/** Ledgers an extension reaches here: long enough to pay once, short enough to see it archived again. */
const EXTEND_TO = 40;

describe.skipIf(!enabled)("upto against an archived settlement contract", () => {
  let archival: ArchivalNetwork;
  let net: LocalNetwork;
  let horizon: HorizonPin;
  let usdc: IssuedAsset;
  let contract: LocalUptoContract;
  let recipient: Keypair;
  let service: RunningService;
  let authority: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    horizon = pinHorizon({ seconds: LEDGER_SECONDS });
    archival = await startArchivalNetwork();
    net = archival.network;
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    // The token contract archives as fast as any other; keep it live so only the settlement
    // contract's state changes in this test.
    const keeper = Keypair.random();
    await net.fund(keeper);
    await extendContractTtl({
      server: net.server,
      passphrase: net.passphrase,
      sponsor: keeper,
      contract: usdc.sac,
      extendToLedgers: 100_000,
      maxFeeStroops: 100_000_000,
    });
    recipient = await net.holder(usdc, "0");
    const uptoEnv = {
      TESTNET_UPTO_ENABLED: "true",
      TESTNET_UPTO_CONTRACT: contract.address,
      TESTNET_UPTO_WASM_HASH: contract.wasmHash,
      TESTNET_UPTO_TTL_KEEPER: "false",
      TESTNET_UPTO_TTL_AUTO_RESTORE: "false",
      TESTNET_UPTO_TTL_EXTEND_BELOW_LEDGERS: "5",
      TESTNET_UPTO_TTL_EXTEND_TO_LEDGERS: String(EXTEND_TO),
      CONTRACT_TTL_POLL_MS: "10000",
      BAZAAR_ENABLED: "false",
    };
    service = await startService(net, usdc, uptoEnv);
    authority = deriveAuthorityKeypair(service.sponsor, NETWORK).publicKey();
    env = {
      STORE: "memory",
      TESTNET_RPC_URL: net.rpcUrl,
      TESTNET_SPONSOR_SECRET: service.sponsor.secret(),
      TESTNET_ASSETS: `${usdc.sac}:USDC:7`,
      ...uptoEnv,
    };
  }, 360_000);

  afterAll(async () => {
    // beforeAll may have failed part way: stop what it started.
    await (service as RunningService | undefined)?.stop();
    await (archival as ArchivalNetwork | undefined)?.stop();
    (horizon as HorizonPin | undefined)?.restore();
  });

  function requirements(amount = CAP): PaymentRequirements {
    return {
      scheme: "upto",
      network: NETWORK,
      amount: amount.toString(),
      asset: usdc.sac,
      payTo: recipient.publicKey(),
      maxTimeoutSeconds: 120,
      extra: { areFeesSponsored: true, facilitatorAddress: authority },
    };
  }

  async function pay(payer: Keypair): Promise<PaymentPayload> {
    const client = new UptoClient(createEd25519Signer(payer.secret(), NETWORK), {
      rpcConfig: { url: net.rpcUrl },
      contracts: contract.address,
      ledgerSeconds: LEDGER_SECONDS,
    });
    const accepted = requirements();
    const created = await client.createPaymentPayload(2, accepted);
    return { x402Version: 2, accepted, payload: created.payload };
  }

  async function post(path: "/verify" | "/settle", payload: PaymentPayload, amount = CAP) {
    const response = await fetch(`${service.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: payload,
        paymentRequirements: requirements(amount),
      }),
    });
    return (await response.json()) as Record<string, unknown>;
  }

  async function liveness() {
    const reading = await readContractTtl(net.server, [contract.address]);
    return contractLiveness(reading.contracts.get(contract.address), reading.latestLedger);
  }

  async function untilArchived(): Promise<void> {
    await expect
      .poll(
        async () => {
          const now = await liveness();
          return now.instanceArchived && now.codeArchived;
        },
        { timeout: 90_000, interval: 1_000 },
      )
      .toBe(true);
  }

  /** Verifies and settles part of the cap, and checks exactly that part moved. */
  async function settlesAgain(): Promise<void> {
    const payer = await net.holder(usdc, "1");
    const payload = await pay(payer);
    expect(await post("/verify", payload)).toEqual({ isValid: true, payer: payer.publicKey() });
    const before = await net.tokenBalance(usdc.sac, recipient.publicKey());
    expect(await post("/settle", payload, 400_000n)).toMatchObject({ success: true, amount: "400000" });
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(10_000_000n - 400_000n);
    expect(await net.tokenBalance(usdc.sac, recipient.publicKey())).toBe(before + 400_000n);
  }

  it("refuses payments while the contract is archived, and settles once an operator restores it", async () => {
    await untilArchived();

    const status = await upto(["ttl", "status"], env);
    expect(status.lines[0]).toMatchObject({
      contract: contract.address,
      liveWasmHash: contract.wasmHash,
      archived: { instance: true, code: true },
      plan: "restore_required",
    });

    // A coded refusal, and no transaction: the restoration is never paid inside a payment.
    const payer = await net.holder(usdc, "1");
    const payload = await pay(payer);
    const sponsorBefore = await net.nativeBalance(service.sponsor.publicKey());
    expect(await post("/verify", payload)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_settlement_contract_archived",
      invalidMessage: expect.stringMatching(/\S/) as unknown,
    });
    expect(await post("/settle", payload, 400_000n)).toMatchObject({
      success: false,
      errorReason: "invalid_upto_stellar_settlement_contract_archived",
      transaction: "",
    });
    expect(await net.nativeBalance(service.sponsor.publicKey())).toBe(sponsorBefore);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(10_000_000n);
    expect(await liveness()).toMatchObject({ instanceArchived: true, codeArchived: true });

    // /health names the archived contract; readiness does not depend on it.
    await expect
      .poll(() => service.runtime.health().warnings.map((warning) => [warning.code, warning.contract]), {
        timeout: 60_000,
        interval: 1_000,
      })
      .toContainEqual(["contract_archived", "upto"]);
    expect((await service.runtime.readiness()).ready).toBe(true);

    const restored = await upto(["ttl", "restore"], env);
    expect(restored.code).toBe(0);
    expect(restored.lines[0]).toMatchObject({
      plan: "restore",
      transactions: [{ action: "restore" }, { action: "extend" }],
      archived: { instance: false, code: false },
    });
    const live = await liveness();
    expect(live.instanceTtlLedgers).toBeGreaterThan(EXTEND_TO - 10);
    expect(live.codeTtlLedgers).toBeGreaterThan(EXTEND_TO - 10);

    await settlesAgain();
  });

  it("is restored by the TTL keeper where automatic restoration is allowed", async () => {
    await untilArchived();
    const metrics = new Metrics();
    const keeper = new UptoTtlKeeper({
      network: NETWORK,
      server: net.server,
      passphrase: net.passphrase,
      sponsor: service.sponsor,
      contract: contract.address,
      wasmHash: contract.wasmHash,
      ttl: {
        keeper: true,
        extendBelowLedgers: 5,
        extendToLedgers: 500,
        autoRestore: true,
        maxFeeStroops: 100_000_000,
      },
      inclusionFeeStroops: 100,
      sponsorReserveStroops: 50_000_000n,
      lock: new MemoryTaskLock(),
      metrics,
      log: silentLogger,
    });
    expect(await keeper.tick()).toBe(true);
    expect(keeper.snapshot()).toMatchObject({ plan: "none", lastAction: { action: "extend" } });
    expect((await metrics.uptoTtlKeeperActions.get()).values.map((entry) => entry.labels)).toEqual([
      { network: NETWORK, action: "restore", outcome: "ok" },
      { network: NETWORK, action: "extend", outcome: "ok" },
    ]);
    expect((await liveness()).instanceTtlLedgers).toBeGreaterThan(400);
    // Nothing to do on the next round.
    expect(await keeper.tick()).toBe(false);

    await settlesAgain();
  });
});
