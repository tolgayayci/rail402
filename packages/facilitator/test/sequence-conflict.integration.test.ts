/**
 * A channel account used behind the facilitator's back, on the private Stellar network: while a
 * settlement's first broadcast is held at the RPC proxy, another transaction from the same channel
 * account takes its sequence number, so the network refuses the settlement with txBadSeq.
 *
 * Invariants: the settlement gives its channel back within seconds (not when its time bound or the
 * payer's authorization expires), and the channel is quarantined rather than reused at once; no funds
 * move and the sponsor is charged nothing; the same payment is answered from its record and never
 * submitted again; a new payment settles on the other channel, and the quarantined one can be leased
 * again once its cooldown has passed. Anyone who holds the payment could still carry the payer's
 * authorization until it expires, so the settlement is answered as failed only once it expired unused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BASE_FEE,
  type FeeBumpTransaction,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  acceptedAsset,
  createStellarFacilitator,
  deriveChannelKeypairs,
  provisionChannels,
  type StellarFacilitator,
} from "@rail402.dev/facilitator";
import { inspectExactTransaction, payerAuthorization } from "@rail402.dev/stellar";
import {
  LocalNetwork,
  classicTestAsset,
  exactDriver,
  onChainSettlement,
  startRpcProxy,
  type HeldEvent,
  type IssuedAsset,
  type PaymentDriver,
  type RpcProxy,
} from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";
const CHANNELS = 2;
const AMOUNT = 3_000_000n;
const START = 100_000_000n; // net.holders(…, "10") in base units
const QUARANTINE_MS = 8_000;
const SUBMISSION_FAILED = "settle_exact_stellar_transaction_submission_failed";

describe.skipIf(!available)("a channel sequence number taken by another transaction", () => {
  let usdc: IssuedAsset;
  let sponsor: Keypair;
  let funder: Keypair;
  let seller: Keypair;
  let proxy: RpcProxy;
  let facilitator: StellarFacilitator;
  let driver: PaymentDriver;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    sponsor = Keypair.random();
    funder = Keypair.random();
    await Promise.all([net.fund(sponsor), net.fund(funder)]);
    await provisionChannels({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      channels: deriveChannelKeypairs(sponsor, NETWORK, CHANNELS),
    });
    driver = exactDriver(net, classicTestAsset(net, usdc));
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    proxy = await startRpcProxy(net.rpcUrl);
    facilitator = createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: proxy.url,
          sponsorSecret: sponsor.secret(),
          channelCount: CHANNELS,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          policy: { maxTransactionFeeStroops: 2_000_000 },
          timing: {
            pollIntervalMs: 250,
            channelWaitMs: 0,
            channelQuarantineMs: QUARANTINE_MS,
            confirmTimeoutMs: 3_000,
            duplicateWaitMs: 500,
            reconcileIdleMs: 1_000,
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await (proxy as RpcProxy | undefined)?.close();
  });

  const pay = async (payer: Keypair, maxTimeoutSeconds?: number) => {
    const published = driver.requirements(
      seller.publicKey(),
      AMOUNT,
      maxTimeoutSeconds === undefined ? undefined : { maxTimeoutSeconds },
    );
    const payload = (await driver.pay(
      { kind: "G", address: payer.publicKey(), keypair: payer },
      published,
    )) as unknown as PaymentPayload;
    return { payload, requirements: driver.settleRequirements(published, AMOUNT) as PaymentRequirements };
  };

  /** The expiration ledger of the payer's authorization in a payment. */
  const expirationOf = (payload: PaymentPayload): number => {
    const inspection = inspectExactTransaction(
      (payload.payload as { transaction: string }).transaction,
      net.passphrase,
    );
    if (!inspection.ok) throw new Error(inspection.code);
    const expiration = payerAuthorization(inspection.transfer)?.signatureExpirationLedger;
    if (expiration === undefined) throw new Error("no payer authorization");
    return expiration;
  };

  /** Spends the channel's next sequence number from outside, as the drill's injector did. */
  const takeSequence = async (channelAddress: string) => {
    const channel = deriveChannelKeypairs(sponsor, NETWORK, CHANNELS).find(
      (keypair) => keypair.publicKey() === channelAddress,
    );
    if (channel === undefined) throw new Error(`${channelAddress} is not a channel`);
    const inner = new TransactionBuilder(await net.server.getAccount(channelAddress), {
      fee: BASE_FEE,
      networkPassphrase: net.passphrase,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
      .setTimeout(30)
      .build();
    inner.sign(channel);
    const bump = TransactionBuilder.buildFeeBumpTransaction(funder, "200", inner, net.passphrase);
    bump.sign(funder);
    await net.submit(bump);
  };

  it("gives its channel back within seconds, moves nothing, never settles twice and fails once the authorization expired", async () => {
    const channels = facilitator.networks.get(NETWORK)?.channels;
    if (channels === undefined) throw new Error("no channel pool");
    const [payer, second, third] = (await net.holders(usdc, 3, "10")) as [Keypair, Keypair, Keypair];
    const { payload, requirements } = await pay(payer);

    let first = true;
    proxy.onSendTransaction = () => {
      if (!first) return "forward";
      first = false;
      return "hold";
    };
    const held = new Promise<HeldEvent>((resolve) => proxy.events.once("held", resolve));
    const started = Date.now();
    const settling = facilitator.core.settle(payload, requirements);
    const { transaction } = await held;
    const envelope = TransactionBuilder.fromXDR(transaction ?? "", net.passphrase) as FeeBumpTransaction;
    const conflicted = envelope.innerTransaction.source;
    await takeSequence(conflicted);
    await proxy.releaseHeld();
    const result = await settling;
    const elapsedMs = Date.now() - started;
    proxy.onSendTransaction = undefined;

    // Anyone who holds the payment can still carry its authorization: the outcome waits for it.
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(result.transaction).toBe(envelope.hash().toString("hex"));
    // Bounded by a few RPC round trips, far below the payment's time bound.
    expect(elapsedMs).toBeLessThan(15_000);
    // A fee bump's refusal names the inner result: ERROR:txFeeBumpInnerFailed:txBadSeq.
    expect(proxy.answers.some((answer) => answer.status.endsWith("txBadSeq"))).toBe(true);

    // Nothing landed: neither the settlement nor its channel transaction, and no funds moved.
    for (const hash of [envelope.hash(), envelope.innerTransaction.hash()]) {
      const status = await net.server.getTransaction(hash.toString("hex"));
      expect(status.status).toBe(rpc.Api.GetTransactionStatus.NOT_FOUND);
    }
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START);

    // The lease is gone at once; the channel stays out of rotation for its cooldown.
    expect(await channels.inUse()).toBe(0);
    const repeated = await facilitator.core.settle(payload, requirements);
    expect(repeated).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(proxy.sent.filter((sent) => sent === transaction).length).toBeLessThanOrEqual(2);

    // A new payment settles at once on the other channel.
    const next = await pay(second);
    const settled = await facilitator.core.settle(next.payload, next.requirements);
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    const onChain = await onChainSettlement(net.server, net.passphrase, settled.transaction);
    expect(onChain.innerSource).not.toBe(conflicted);
    // Only the other channel can be leased while the quarantine lasts.
    const other = await channels.acquire(0);
    expect(other).toBe(onChain.innerSource);
    expect(await channels.acquire(0)).toBeUndefined();
    await channels.release(other ?? "");

    // After the cooldown both channels can be leased again.
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, started + elapsedMs + QUARANTINE_MS + 500 - Date.now())),
    );
    const leased = [await channels.acquire(0), await channels.acquire(0)];
    expect(leased).toContain(conflicted);
    for (const address of leased) await channels.release(address ?? "");
    const later = await pay(third);
    const again = await facilitator.core.settle(later.payload, later.requirements);
    expect(again.success, JSON.stringify(again)).toBe(true);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START);
    expect(await channels.inUse()).toBe(0);

    // Once the authorization expired unused, reconciliation finishes the settlement with nothing
    // charged, sending nothing more and releasing no channel.
    const expiration = expirationOf(payload);
    await expect
      .poll(() => net.latestLedger(), { timeout: 120_000, interval: 250 })
      .toBeGreaterThan(expiration);
    await facilitator.reconcile();
    const final = await facilitator.core.settle(payload, requirements);
    expect(final).toMatchObject({ success: false, errorReason: SUBMISSION_FAILED });
    expect(final.errorMessage).toMatch(/txBadSeq.*expired.*no funds moved/);
    expect(proxy.sent.filter((sent) => sent === transaction).length).toBeLessThanOrEqual(2);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START);
    expect(await channels.inUse()).toBe(0);
  });

  it("gives its channel back the same way when the channel's queue slot was taken first (TRY_AGAIN_LATER)", async () => {
    // The live sequence: another transaction from the channel sits in the network's queue, so the
    // scheme's own send and the engine's resend answer TRY_AGAIN_LATER; once it applies, the next
    // rebroadcast answers txBadSeq. The RPC proxy answers TRY_AGAIN_LATER itself until the other
    // transaction has applied, so the real network then answers the rebroadcast with txBadSeq.
    const channels = facilitator.networks.get(NETWORK)?.channels;
    if (channels === undefined) throw new Error("no channel pool");
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    // An authorization that outlives the test even at the private network's fast ledgers: only the
    // recorded answers, not an expired authorization, may let the settlement give its channel back.
    const { payload, requirements } = await pay(payer, 300);
    let taken: Promise<void> | undefined;
    let applied = false;
    let deferred = 0;
    let conflicted: string | undefined;
    proxy.answerResult("sendTransaction", (params) => {
      if (applied) return undefined;
      const transaction = (params as { transaction?: string }).transaction ?? "";
      if (taken === undefined) {
        const envelope = TransactionBuilder.fromXDR(transaction, net.passphrase) as FeeBumpTransaction;
        conflicted = envelope.innerTransaction.source;
        taken = takeSequence(conflicted).then(() => {
          applied = true;
        });
      }
      deferred++;
      return {
        status: "TRY_AGAIN_LATER",
        hash: TransactionBuilder.fromXDR(transaction, net.passphrase).hash().toString("hex"),
        latestLedger: 1,
        latestLedgerCloseTime: "0",
      };
    });
    const started = Date.now();
    const result = await facilitator.core.settle(payload, requirements);
    const elapsedMs = Date.now() - started;
    proxy.answerResult("sendTransaction", undefined);
    await taken;
    // When the request's window closed before the other transaction applied, the reconciler's next
    // rebroadcast meets the conflict.
    await expect
      .poll(
        async () => {
          await facilitator.reconcile();
          return channels.inUse();
        },
        { timeout: 30_000, interval: 500 },
      )
      .toBe(0);

    // At least the scheme's send and the engine's resend were deferred before the conflict applied.
    expect(deferred).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(proxy.answers.some((answer) => answer.status.endsWith("txBadSeq"))).toBe(true);
    // The request answers within its confirmation window (3 s here), not at the authorization's expiry.
    expect(elapsedMs).toBeLessThan(10_000);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START);
    expect(await channels.inUse()).toBe(0);
    const leasable = [await channels.acquire(0), await channels.acquire(0)];
    expect(leasable).not.toContain(conflicted);
    for (const address of leasable) if (address !== undefined) await channels.release(address);
  });
});
