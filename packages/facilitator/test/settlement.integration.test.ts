/**
 * End-to-end settlement against the private Stellar network (docker compose --profile stellar up -d).
 * Everything goes through the unmodified @x402/stellar verifier and settlement path, with real
 * channel accounts, a real fee-bump sponsor and real balance changes.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Account,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import {
  MemoryChannelPool,
  MemorySettlementLedger,
  acceptedAsset,
  createStellarFacilitator,
  deriveChannelKeypairs,
  provisionChannels,
  type SettlementTiming,
  type SponsorGuard,
  type StellarFacilitator,
} from "@rail402.dev/facilitator";
import { inspectExactTransaction, payerAuthorization } from "@rail402.dev/stellar";
import {
  LocalNetwork,
  buildTransfer,
  deploySimpleAccount,
  mintTo,
  requirementsFor,
  smartAccountPayment,
  startRpcProxy,
  type IssuedAsset,
  type RpcProxy,
} from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";

describe.skipIf(!available)("exact settlement on a live network", () => {
  let usdc: IssuedAsset;
  let sponsor: Keypair;
  let seller: Keypair;
  let facilitator: StellarFacilitator;

  const setup = (
    options: {
      rpcUrl?: string;
      channelCount?: number;
      ledger?: MemorySettlementLedger;
      channels?: MemoryChannelPool;
      confirmTimeoutMs?: number;
      guard?: SponsorGuard;
      timing?: Partial<SettlementTiming>;
    } = {},
  ) =>
    createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: options.rpcUrl ?? net.rpcUrl,
          sponsorSecret: sponsor.secret(),
          channelCount: options.channelCount ?? 4,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          // The private network prices Soroban resources higher than testnet.
          policy: { maxTransactionFeeStroops: 2_000_000 },
          ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
          ...(options.channels === undefined ? {} : { channels: options.channels }),
          ...(options.guard === undefined ? {} : { guard: options.guard }),
          timing: {
            pollIntervalMs: 250,
            channelWaitMs: 60_000,
            ...(options.confirmTimeoutMs === undefined ? {} : { confirmTimeoutMs: options.confirmTimeoutMs }),
            ...options.timing,
          },
        },
      ],
    });

  const channelAddresses = (count: number) =>
    deriveChannelKeypairs(sponsor, NETWORK, count).map((keypair) => keypair.publicKey());

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    sponsor = Keypair.random();
    await net.fund(sponsor);
    await provisionChannels({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      channels: deriveChannelKeypairs(sponsor, NETWORK, 12),
    });
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    facilitator = setup();
  });

  const pay = async (payer: Keypair, amount: bigint, payTo = seller.publicKey()) => {
    const requirements = requirementsFor(usdc.sac, payTo, amount) as PaymentRequirements;
    const payload = (await net.payment(payer, requirementsFor(usdc.sac, payTo, amount))) as PaymentPayload;
    return { requirements, payload };
  };

  const transferEvents = async (hash: string) => {
    const transaction = await net.server.getTransaction(hash);
    if (transaction.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(transaction.status);
    const meta = transaction.resultMetaXdr;
    const events =
      meta.switch() === 4
        ? meta
            .v4()
            .operations()
            .flatMap((op) => op.events())
        : [];
    return {
      transaction,
      events: events.filter((event) => event.body().v0().topics()[0]?.sym().toString() === "transfer"),
    };
  };

  it("advertises the network with sponsored fees and every facilitator signer", () => {
    const supported = facilitator.core.getSupported();
    expect(supported.kinds).toEqual([
      { x402Version: 2, scheme: "exact", network: NETWORK, extra: { areFeesSponsored: true } },
    ]);
    const signers = supported.signers["stellar:*"] ?? [];
    expect(signers).toContain(sponsor.publicKey());
    expect(signers).toEqual(expect.arrayContaining(channelAddresses(4)));
  });

  it("settles a G-account payment: payer debited, payTo credited, facilitator only pays the fee", async () => {
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const amount = 12_345_678n; // 1.2345678 USDC, exercising all 7 decimals
    const { payload, requirements } = await pay(payer, amount);

    const channels = channelAddresses(4);
    const before = {
      payer: await net.tokenBalance(usdc.sac, payer.publicKey()),
      seller: await net.tokenBalance(usdc.sac, seller.publicKey()),
      sponsorXlm: await net.nativeBalance(sponsor.publicKey()),
      sponsorToken: await net.tokenBalance(usdc.sac, sponsor.publicKey()),
      channelsXlm: await Promise.all(channels.map((channel) => net.nativeBalance(channel))),
    };

    const verified = await facilitator.core.verify(payload, requirements);
    expect(verified).toEqual({ isValid: true, payer: payer.publicKey() });

    const settled = await facilitator.core.settle(payload, requirements);
    expect(settled).toMatchObject({ success: true, network: NETWORK, payer: payer.publicKey() });
    expect(settled.transaction).toMatch(/^[0-9a-f]{64}$/);

    const { transaction, events } = await transferEvents(settled.transaction);
    const fee = transaction.resultXdr.feeCharged().toBigInt();

    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(before.payer - amount);
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(before.seller + amount);
    expect(await net.nativeBalance(sponsor.publicKey())).toBe(before.sponsorXlm - fee);
    expect(await net.tokenBalance(usdc.sac, sponsor.publicKey())).toBe(before.sponsorToken);
    expect(await Promise.all(channels.map((channel) => net.nativeBalance(channel)))).toEqual(
      before.channelsXlm,
    );

    // Exactly one transfer event: payer → payTo for the exact amount, from the required asset.
    expect(events).toHaveLength(1);
    const [event] = events;
    const topics = event?.body().v0().topics() ?? [];
    expect(strkey(topics[1])).toBe(payer.publicKey());
    expect(strkey(topics[2])).toBe(seller.publicKey());
    expect(amountOf(event?.body().v0().data())).toBe(amount);
  });

  it("answers a repeated settle with the original result and moves funds once", async () => {
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const { payload, requirements } = await pay(payer, 1_000_000n);

    const first = await facilitator.core.settle(payload, requirements);
    const again = await facilitator.core.settle(payload, requirements);
    expect(first.success).toBe(true);
    expect(again).toEqual(first);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(1_000_000_000n - 1_000_000n);
  });

  it("settles concurrent duplicates exactly once, all callers getting the same result", async () => {
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const { payload, requirements } = await pay(payer, 2_000_000n);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => facilitator.core.settle(payload, requirements)),
    );
    const hashes = new Set(results.map((result) => result.transaction));
    expect(results.every((result) => result.success)).toBe(true);
    expect(hashes.size).toBe(1);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(1_000_000_000n - 2_000_000n);
  });

  it("refuses a settled authorization in a different envelope, and verify names the replay", async () => {
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const { payload, requirements } = await pay(payer, 1_500_000n);
    expect((await facilitator.core.settle(payload, requirements)).success).toBe(true);

    // Same signed authorization, different envelope bytes (another fee bid).
    const original = TransactionBuilder.fromXDR(
      (payload.payload as { transaction: string }).transaction,
      net.passphrase,
    ) as Transaction;
    const envelope = original.toEnvelope();
    envelope
      .v1()
      .tx()
      .fee(original.operations.length * 999);
    const repackaged = { ...payload, payload: { transaction: envelope.toXDR("base64") } };

    const conflict = await facilitator.core.settle(repackaged, requirements);
    expect(conflict).toMatchObject({
      success: false,
      errorReason: "settle_exact_stellar_idempotency_conflict",
    });

    const replay = await facilitator.core.verify(payload, requirements);
    expect(replay).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_nonce_already_used",
    });
    expect(replay.invalidMessage?.trim()).not.toBe("");
  });

  it("rejects tampering: a changed amount breaks the signed authorization", async () => {
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const { payload } = await pay(payer, 1_000_000n);
    const tamperedRequirements = requirementsFor(
      usdc.sac,
      seller.publicKey(),
      9_000_000n,
    ) as PaymentRequirements;

    // Operation changed, authorization left as signed: the authorization no longer covers the call.
    const envelope = xdr.TransactionEnvelope.fromXDR(
      (payload.payload as { transaction: string }).transaction,
      "base64",
    );
    const operation = envelope.v1().tx().operations()[0]?.body().invokeHostFunctionOp();
    if (!operation) throw new Error("fixture");
    operation.hostFunction().invokeContract().args()[2] = nativeToScVal(9_000_000n, { type: "i128" });
    const opOnly = {
      ...payload,
      accepted: tamperedRequirements,
      payload: { transaction: envelope.toXDR("base64") },
    };
    expect(await facilitator.core.verify(opOnly, tamperedRequirements)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_auth_invocation_mismatch",
    });

    // Operation and authorization both changed: the payer's signature no longer verifies.
    const signedCall = operation.auth()[0]?.rootInvocation().function().contractFn();
    if (!signedCall) throw new Error("fixture");
    signedCall.args()[2] = nativeToScVal(9_000_000n, { type: "i128" });
    const both = { ...opOnly, payload: { transaction: envelope.toXDR("base64") } };
    expect(await facilitator.core.verify(both, tamperedRequirements)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_invalid_signature",
    });
    const settled = await facilitator.core.settle(both, tamperedRequirements);
    expect(settled).toMatchObject({
      success: false,
      errorReason: "invalid_exact_stellar_payload_invalid_signature",
    });
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(1_000_000_000n);
  });

  describe("names the on-chain cause of a payment that cannot settle", () => {
    const offline = async (payer: Keypair, to: string, amount: bigint) => {
      const built = await buildTransfer({
        payer,
        asset: usdc.sac,
        to,
        amount,
        nonce: BigInt(Math.floor(Math.random() * 2 ** 40)),
        expirationLedger: (await net.latestLedger()) + 10,
      });
      const requirements = requirementsFor(usdc.sac, to, amount) as PaymentRequirements;
      const payload = {
        x402Version: 2,
        resource: { url: "https://seller.example/resource" },
        accepted: requirements,
        payload: { transaction: built.xdr },
      } as PaymentPayload;
      return { payload, requirements };
    };

    it("payTo without a trustline", async () => {
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const noTrust = Keypair.random();
      await net.fund(noTrust);
      const { payload, requirements } = await offline(payer, noTrust.publicKey(), 1_000n);
      expect(await facilitator.core.verify(payload, requirements)).toMatchObject({
        invalidReason: "invalid_exact_stellar_payload_recipient_trustline_missing",
      });
      expect(await facilitator.core.settle(payload, requirements)).toMatchObject({
        success: false,
        errorReason: "invalid_exact_stellar_payload_recipient_trustline_missing",
        transaction: "",
      });
    });

    it("payer without a trustline", async () => {
      const payer = Keypair.random();
      await net.fund(payer);
      const { payload, requirements } = await offline(payer, seller.publicKey(), 1_000n);
      expect(await facilitator.core.verify(payload, requirements)).toMatchObject({
        invalidReason: "invalid_exact_stellar_payload_payer_trustline_missing",
      });
    });

    it("insufficient balance", async () => {
      const [payer] = (await net.holders(usdc, 1, "0.0000001")) as [Keypair];
      const { payload, requirements } = await offline(payer, seller.publicKey(), 1_000n);
      expect(await facilitator.core.verify(payload, requirements)).toMatchObject({
        invalidReason: "insufficient_funds",
      });
    });

    it("expired and about-to-expire authorizations", async () => {
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const requirements = requirementsFor(usdc.sac, seller.publicKey(), 1_000n) as PaymentRequirements;
      const latest = await net.latestLedger();
      const expired = (await net.payment(payer, requirementsFor(usdc.sac, seller.publicKey(), 1_000n), {
        expirationLedger: latest - 1,
      })) as PaymentPayload;
      expect(await facilitator.core.verify(expired, requirements)).toMatchObject({
        invalidReason: "invalid_exact_stellar_signature_expired",
      });
      const now = await net.latestLedger();
      const tooSoon = (await net.payment(payer, requirementsFor(usdc.sac, seller.publicKey(), 1_000n), {
        expirationLedger: now,
      })) as PaymentPayload;
      const result = await facilitator.core.settle(tooSoon, requirements);
      expect([
        "invalid_exact_stellar_signature_expiration_too_soon",
        "invalid_exact_stellar_signature_expired",
      ]).toContain(result.errorReason);
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(1_000_000_000n);
    });
  });

  describe("smart accounts (C… addresses)", () => {
    let owner: Keypair;
    let account: string;
    let deployer: Keypair;

    beforeAll(async () => {
      owner = Keypair.random();
      deployer = Keypair.random();
      await net.fund(deployer);
      account = await deploySimpleAccount(net, deployer, owner);
      await mintTo(net, usdc, account, 50_000_000n);
    });

    it("settles a payment authorized by a contract account's __check_auth", async () => {
      const amount = 7_654_321n;
      const requirements = requirementsFor(usdc.sac, seller.publicKey(), amount) as PaymentRequirements;
      const payload = (await smartAccountPayment(net, {
        account,
        owner,
        source: deployer,
        requirements: requirementsFor(usdc.sac, seller.publicKey(), amount),
      })) as PaymentPayload;
      const before = {
        account: await net.tokenBalance(usdc.sac, account),
        seller: await net.tokenBalance(usdc.sac, seller.publicKey()),
      };

      expect(await facilitator.core.verify(payload, requirements)).toEqual({ isValid: true, payer: account });
      const settled = await facilitator.core.settle(payload, requirements);
      expect(settled).toMatchObject({ success: true, payer: account });
      expect(await net.tokenBalance(usdc.sac, account)).toBe(before.account - amount);
      expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(before.seller + amount);
    });

    it("rejects a smart-account payment signed by the wrong key", async () => {
      const requirements = requirementsFor(usdc.sac, seller.publicKey(), 1_000n) as PaymentRequirements;
      const payload = (await smartAccountPayment(net, {
        account,
        owner,
        signWith: Keypair.random(),
        source: deployer,
        requirements: requirementsFor(usdc.sac, seller.publicKey(), 1_000n),
      })) as PaymentPayload;
      const result = await facilitator.core.verify(payload, requirements);
      expect(result.isValid).toBe(false);
      expect([
        "invalid_exact_stellar_payload_invalid_signature",
        "invalid_exact_stellar_payload_smart_account_rejected",
      ]).toContain(result.invalidReason);
      expect((await facilitator.core.settle(payload, requirements)).success).toBe(false);
    });

    it("pays a contract address as payTo", async () => {
      const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
      const before = await net.tokenBalance(usdc.sac, account);
      const { payload, requirements } = await pay(payer, 2_500_000n, account);
      expect(await facilitator.core.settle(payload, requirements)).toMatchObject({ success: true });
      expect(await net.tokenBalance(usdc.sac, account)).toBe(before + 2_500_000n);
    });
  });

  it("runs 3 batches of 20 concurrent settlements with no double settlement or sequence collision", async () => {
    const concurrent = setup({ channelCount: 12 });
    for (let batch = 0; batch < 3; batch++) {
      const payers = await net.holders(usdc, 20, "10");
      const payments = await Promise.all(payers.map((payer) => pay(payer, 3_000_000n)));
      const results = await Promise.all(
        payments.map(({ payload, requirements }) => concurrent.core.settle(payload, requirements)),
      );
      const failures = results.filter((result) => !result.success);
      expect(failures, JSON.stringify(failures)).toEqual([]);
      expect(new Set(results.map((result) => result.transaction)).size).toBe(20);
      const balances = await Promise.all(
        payers.map((payer) => net.tokenBalance(usdc.sac, payer.publicKey())),
      );
      expect(balances.every((balance) => balance === 100_000_000n - 3_000_000n)).toBe(true);
      expect(await concurrent.networks.get(NETWORK)?.channels.inUse()).toBe(0);
    }
  }, 300_000);

  describe("refuses or finishes settlements it cannot complete, and says why", () => {
    it("refuses while the sponsor guard is closed, then settles once it reopens", async () => {
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 1_000_000n);
      let open = false;
      const guarded = setup({
        guard: {
          admit: () =>
            Promise.resolve(open ? { ok: true } : { ok: false, reason: "The sponsor is below its reserve." }),
        },
      });

      expect(await guarded.core.settle(payload, requirements)).toMatchObject({
        success: false,
        errorReason: "settle_exact_stellar_sponsor_unavailable",
        errorMessage: "The sponsor is below its reserve.",
      });
      open = true;
      expect(await guarded.core.settle(payload, requirements)).toMatchObject({ success: true });
    });

    it("refuses when no channel frees up in time, leaving the payment retryable", async () => {
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 1_000_000n);
      const channels = new MemoryChannelPool(channelAddresses(1));
      const busy = setup({ channelCount: 1, channels, timing: { channelWaitMs: 100 } });

      const held = await channels.acquire(0);
      expect(await busy.core.settle(payload, requirements)).toMatchObject({
        success: false,
        errorReason: "settle_exact_stellar_channel_unavailable",
      });
      await channels.release(held ?? "");
      expect(await busy.core.settle(payload, requirements)).toMatchObject({ success: true });
    });

    it("broadcasts nothing when the envelope cannot be recorded first, leaving the payment retryable", async () => {
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 1_000_000n);
      const ledger = new MemorySettlementLedger();
      const recordEnvelope = ledger.recordEnvelope.bind(ledger);
      let failWrites = true;
      ledger.recordEnvelope = (...args) =>
        failWrites ? Promise.reject(new Error("ledger unavailable")) : recordEnvelope(...args);
      const unrecorded = setup({ ledger });

      expect(await unrecorded.core.settle(payload, requirements)).toMatchObject({
        success: false,
        errorReason: "settle_exact_stellar_fee_bump_signing_failed",
      });
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(1_000_000_000n);
      failWrites = false;
      expect(await unrecorded.core.settle(payload, requirements)).toMatchObject({ success: true });
    });

    it("tells a duplicate that the original is still being settled elsewhere", async () => {
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 1_000_000n);
      const transaction = (payload.payload as { transaction: string }).transaction;
      const inspection = inspectExactTransaction(transaction, net.passphrase);
      if (!inspection.ok) throw new Error(inspection.code);
      const nonce = payerAuthorization(inspection.transfer)?.nonce ?? 0n;
      const ledger = new MemorySettlementLedger();
      // Another worker holds the claim and has not signed anything yet.
      await ledger.claim(
        { network: NETWORK, payer: payer.publicKey(), nonce: nonce.toString() },
        createHash("sha256").update(transaction).digest("hex"),
        "another-worker",
        60_000,
      );

      const duplicate = setup({ ledger, timing: { duplicateWaitMs: 200 } });
      expect(await duplicate.core.settle(payload, requirements)).toMatchObject({
        success: false,
        errorReason: "settle_exact_stellar_settlement_in_progress",
      });
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(1_000_000_000n);
    });

    const recorded = async (
      ledger: MemorySettlementLedger,
      envelope: { hash: string; xdr: string; validUntil: number },
    ) => {
      const owner = "crashed-worker";
      const { record } = await ledger.claim(
        { network: NETWORK, payer: Keypair.random().publicKey(), nonce: "1" },
        "0".repeat(64),
        owner,
        60_000,
      );
      await ledger.recordEnvelope(record.id, owner, {
        channel: channelAddresses(1)[0] ?? "",
        transactionHash: envelope.hash,
        innerTransactionHash: envelope.hash,
        envelopeXdr: envelope.xdr,
        validUntil: envelope.validUntil,
        maxFeeStroops: "100",
      });
      return record.id;
    };

    it("expires a recorded settlement whose time bound has passed", async () => {
      const ledger = new MemorySettlementLedger();
      const id = await recorded(ledger, { hash: randomBytes(32).toString("hex"), xdr: "", validUntil: 1 });

      expect(await setup({ ledger }).reconcile()).toBe(1);
      expect(await ledger.get(id)).toMatchObject({
        state: "expired",
        response: { success: false, errorReason: "settle_exact_stellar_transaction_expired" },
      });
    });

    it("fails a recorded settlement whose envelope the network refuses", async () => {
      // Neither account exists, so the network can never accept these bytes.
      const source = Keypair.random();
      const feeSource = Keypair.random();
      const inner = new TransactionBuilder(new Account(source.publicKey(), "1"), {
        fee: "100",
        networkPassphrase: net.passphrase,
      })
        .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
        .setTimeout(300)
        .build();
      inner.sign(source);
      const bump = TransactionBuilder.buildFeeBumpTransaction(feeSource, "200", inner, net.passphrase);
      bump.sign(feeSource);
      const ledger = new MemorySettlementLedger();
      const id = await recorded(ledger, {
        hash: bump.hash().toString("hex"),
        xdr: bump.toXDR(),
        validUntil: Number(inner.timeBounds?.maxTime ?? 0),
      });

      expect(await setup({ ledger }).reconcile()).toBe(1);
      expect(await ledger.get(id)).toMatchObject({
        state: "failed",
        response: { success: false, errorReason: "settle_exact_stellar_transaction_submission_failed" },
      });
    });
  });

  describe("recovers after a lost submission response without submitting a replacement", () => {
    let proxy: RpcProxy;
    beforeAll(async () => {
      proxy = await startRpcProxy(net.rpcUrl);
    });
    afterAll(async () => {
      await proxy.close();
    });

    it("finds the original transaction when the broadcast response is lost", async () => {
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 4_000_000n);
      const faulty = setup({ rpcUrl: proxy.url, channelCount: 12 });

      proxy.loseSendResponses = true;
      proxy.sent.length = 0;
      const settled = await faulty.core.settle(payload, requirements);
      proxy.loseSendResponses = false;

      expect(settled).toMatchObject({ success: true, payer: payer.publicKey() });
      expect(distinctHashes(proxy.sent, net.passphrase)).toEqual([settled.transaction]);
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(1_000_000_000n - 4_000_000n);
    });

    it("answers settlement_pending within the confirmation window while confirmation is slow", async () => {
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 3_000_000n);
      const ledger = new MemorySettlementLedger();
      const slow = setup({ rpcUrl: proxy.url, channelCount: 12, ledger, confirmTimeoutMs: 1_000 });

      proxy.hideTransactions = true;
      const started = Date.now();
      const pending = await slow.core.settle(payload, requirements);
      const elapsed = Date.now() - started;
      proxy.hideTransactions = false;

      // Upstream alone would keep polling for maxTimeoutSeconds (60 s here).
      expect(elapsed).toBeLessThan(15_000);
      expect(pending).toMatchObject({ success: false, errorReason: "settlement_pending" });
      await waitFor(async () => (await slow.reconcile()) > 0);
      expect(await slow.core.settle(payload, requirements)).toMatchObject({
        success: true,
        transaction: pending.transaction,
      });
    });

    it("finishes a pending settlement after a restart, from the recorded envelope", async () => {
      const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
      const { payload, requirements } = await pay(payer, 5_000_000n);
      const ledger = new MemorySettlementLedger();
      const channels = new MemoryChannelPool(channelAddresses(12));

      // First process: broadcast succeeds but the response is lost, and it gives up immediately.
      proxy.loseSendResponses = true;
      proxy.sent.length = 0;
      const crashed = setup({ rpcUrl: proxy.url, channelCount: 12, ledger, channels, confirmTimeoutMs: 0 });
      const pending: SettleResponse = await crashed.core.settle(payload, requirements);
      proxy.loseSendResponses = false;
      expect(pending).toMatchObject({ success: false, errorReason: "settlement_pending" });
      expect(pending.transaction).toMatch(/^[0-9a-f]{64}$/);
      expect(await channels.inUse()).toBe(1);

      // Second process: same durable state, reconciles and reports the original transaction.
      const restarted = setup({ channelCount: 12, ledger, channels });
      await waitFor(async () => (await restarted.reconcile()) > 0);
      const replay = await restarted.core.settle(payload, requirements);
      expect(replay).toMatchObject({ success: true, transaction: pending.transaction });
      expect(distinctHashes(proxy.sent, net.passphrase)).toEqual([pending.transaction]);
      expect(await channels.inUse()).toBe(0);
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(1_000_000_000n - 5_000_000n);
    });
  });
});

function strkey(value: xdr.ScVal | undefined): string {
  if (value === undefined) throw new Error("missing topic");
  return String(scvNative(value));
}

function amountOf(value: xdr.ScVal | undefined): bigint {
  if (value === undefined) throw new Error("missing data");
  // Protocol 23+ SAC events carry either the i128 amount or a map { amount, to_muxed_id }.
  const native = scvNative(value) as bigint | { amount: bigint };
  return typeof native === "bigint" ? native : native.amount;
}

function scvNative(value: xdr.ScVal): unknown {
  return scValToNative(value);
}

function distinctHashes(envelopes: readonly string[], passphrase: string): string[] {
  return [
    ...new Set(
      envelopes.map((envelope) => TransactionBuilder.fromXDR(envelope, passphrase).hash().toString("hex")),
    ),
  ];
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("condition not met in time");
}
