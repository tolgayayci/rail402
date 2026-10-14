/**
 * Authorization expiry on the private Stellar network (1 s ledgers), with upstream's ledger-time
 * estimate pinned to 5 s (horizon-pin.ts).
 *
 * The window a payment's authorization may use is `[current + margin, maxLedger + 2]`:
 * - the upper bound belongs to the upstream verifier, `maxLedger = latest + ceil(maxTimeoutSeconds / est)`,
 *   with 2 ledgers of tolerance (`…_expiration_too_far`);
 * - the lower bound belongs to Rail402's preflight: an expiration before the current ledger is
 *   `…_signature_expired`, and one within the margin (1 ledger) is `…_expiration_too_soon`.
 * Exact boundaries are asserted with the RPC proxy pinning the latest ledger, so a ledger closing
 * between signing and verifying cannot move the edge; simulation still runs against the real state.
 *
 * `upto` follows the same window against the contract's `expiration_ledger`, which the scheme requires
 * to equal the credential's `signatureExpirationLedger`; its upper bound uses the facilitator's own
 * ledger-time estimate (the same pinned Horizon reading) and its codes are `invalid_upto_stellar_*`.
 */
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  MemorySettlementLedger,
  acceptedAsset,
  createStellarFacilitator,
  deriveAuthorityKeypair,
  deriveChannelKeypairs,
  markRepeat,
  provisionAuthority,
  provisionChannels,
  silentObserver,
  type FinalizedEvent,
  type StellarFacilitator,
} from "@rail402.dev/facilitator";
import { inspectExactTransaction, payerAuthorization } from "@rail402.dev/stellar";
import { inspectUptoAuthorization } from "@rail402.dev/upto";
import { UptoStellarScheme as UptoClient } from "@rail402.dev/upto/client";
import {
  LocalNetwork,
  classicTestAsset,
  deployUpto,
  pinHorizon,
  recordOps,
  requirementsFor,
  startRpcProxy,
  uptoDriver,
  type HorizonPin,
  type IssuedAsset,
  type LocalUptoContract,
  type PaymentDriver,
  type RpcProxy,
} from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";
const START = 1_000_000_000n; // net.holders(…, "100") in base units

/** The payer's authorization in a payment: who signed it, its nonce and its expiration ledger. */
function authorizationOf(payload: PaymentPayload) {
  const inspection = inspectExactTransaction(
    (payload.payload as { transaction: string }).transaction,
    net.passphrase,
  );
  if (!inspection.ok) throw new Error(inspection.code);
  const authorization = payerAuthorization(inspection.transfer);
  if (authorization === undefined) throw new Error("no payer authorization");
  return { payer: inspection.transfer.from, ...authorization };
}

describe.skipIf(!available)("authorization expiry for exact payments", () => {
  let usdc: IssuedAsset;
  let sponsor: Keypair;
  let seller: Keypair;
  let proxy: RpcProxy;
  let horizon: HorizonPin;
  /** The local network seen through the proxy, so the client reads a pinned ledger too. */
  let proxied: LocalNetwork;

  beforeAll(async () => {
    horizon = pinHorizon({ seconds: 5 });
    usdc = await net.issueAsset("USDC");
    sponsor = Keypair.random();
    await net.fund(sponsor);
    await provisionChannels({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      channels: deriveChannelKeypairs(sponsor, NETWORK, 4),
    });
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    proxy = await startRpcProxy(net.rpcUrl);
    proxied = new LocalNetwork(proxy.url);
  });

  afterAll(async () => {
    horizon.restore();
    await proxy.close();
  });

  /**
   * A facilitator reading the chain through the proxy. Each call builds a new one, so its cached
   * latest-ledger reading never predates a `pinLedger`.
   */
  const setup = (ledger = new MemorySettlementLedger()) => {
    const finalized: FinalizedEvent[] = [];
    const facilitator: StellarFacilitator = createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: proxy.url,
          sponsorSecret: sponsor.secret(),
          channelCount: 4,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          policy: { maxTransactionFeeStroops: 2_000_000 },
          ledger,
          timing: { pollIntervalMs: 250, channelWaitMs: 60_000 },
        },
      ],
      observer: { ...silentObserver, finalized: (event) => finalized.push(event) },
    });
    return { facilitator, ledger, finalized };
  };

  const pay = async (
    payer: Keypair,
    options: { maxTimeoutSeconds?: number; expirationLedger?: number; via?: LocalNetwork } = {},
  ) => {
    const terms = requirementsFor(usdc.sac, seller.publicKey(), 1_000_000n, options.maxTimeoutSeconds ?? 60);
    const payload = (await (options.via ?? net).payment(payer, terms, {
      ...(options.expirationLedger === undefined ? {} : { expirationLedger: options.expirationLedger }),
    })) as PaymentPayload;
    return { payload, requirements: terms as PaymentRequirements };
  };

  const waitPast = (ledger: number) =>
    expect.poll(() => net.latestLedger(), { timeout: 60_000, interval: 250 }).toBeGreaterThan(ledger);

  it("derives the expiration ledger from maxTimeoutSeconds like the stock client", async () => {
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const pinned = await net.latestLedger();
    proxy.pinLedger(pinned);
    try {
      const sixty = await pay(payer, { maxTimeoutSeconds: 60, via: proxied });
      expect(authorizationOf(sixty.payload).signatureExpirationLedger).toBe(pinned + 12);
      const max = await pay(payer, { maxTimeoutSeconds: 300, via: proxied });
      expect(authorizationOf(max.payload).signatureExpirationLedger).toBe(pinned + 60);
    } finally {
      proxy.pinLedger(undefined);
    }
  });

  it("settles before the expiration ledger and refuses the same window after it", async () => {
    const { facilitator, finalized } = setup();
    const [first, second] = (await net.holders(usdc, 2, "100")) as [Keypair, Keypair];
    const expiration = (await net.latestLedger()) + 10;
    const p1 = await pay(first, { expirationLedger: expiration });
    const p2 = await pay(second, { expirationLedger: expiration });

    // Accept before: both verify; P1 settles and lands no later than its expiration ledger.
    expect(await facilitator.core.verify(p1.payload, p1.requirements)).toEqual({
      isValid: true,
      payer: first.publicKey(),
    });
    expect(await facilitator.core.verify(p2.payload, p2.requirements)).toEqual({
      isValid: true,
      payer: second.publicKey(),
    });
    const settled = await facilitator.core.settle(p1.payload, p1.requirements);
    expect(settled).toMatchObject({ success: true, payer: first.publicKey() });
    const landed = await net.server.getTransaction(settled.transaction);
    if (landed.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(landed.status);
    expect(landed.ledger).toBeLessThanOrEqual(expiration);

    // Reject after: P2, verified valid in the same window, is refused once the window has passed.
    await waitPast(expiration);
    const submissions = proxy.sent.length;
    expect(await facilitator.core.verify(p2.payload, p2.requirements)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_signature_expired",
    });
    expect(await facilitator.core.settle(p2.payload, p2.requirements)).toMatchObject({
      success: false,
      errorReason: "invalid_exact_stellar_signature_expired",
      transaction: "",
    });
    expect(proxy.sent.length).toBe(submissions);
    expect(await net.tokenBalance(usdc.sac, second.publicKey())).toBe(START);

    // Late repeat: P1 still answers with its original success, and nothing moves again.
    expect(await facilitator.core.settle(p1.payload, p1.requirements)).toEqual(
      markRepeat(settled, "rail402"),
    );
    expect(proxy.sent.length).toBe(submissions);
    expect(await net.tokenBalance(usdc.sac, first.publicKey())).toBe(START - 1_000_000n);
    expect(finalized.map((event) => event.state)).toEqual(["succeeded"]);
  });

  it("holds the lower edge at the current ledger plus a one-ledger margin", async () => {
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    // Pinned ahead of the network, so the payment is still valid on chain when it is simulated.
    const pinned = (await net.latestLedger()) + 5;
    const expiring = async (expirationLedger: number) => pay(payer, { expirationLedger });
    const [before, at, margin] = await Promise.all([
      expiring(pinned - 1),
      expiring(pinned),
      expiring(pinned + 1),
    ]);
    proxy.pinLedger(pinned);
    try {
      const { facilitator } = setup();
      expect(await facilitator.core.verify(before.payload, before.requirements)).toMatchObject({
        isValid: false,
        invalidReason: "invalid_exact_stellar_signature_expired",
      });
      expect(await facilitator.core.verify(at.payload, at.requirements)).toMatchObject({
        isValid: false,
        invalidReason: "invalid_exact_stellar_signature_expiration_too_soon",
      });
      expect(await facilitator.core.verify(margin.payload, margin.requirements)).toEqual({
        isValid: true,
        payer: payer.publicKey(),
      });
    } finally {
      proxy.pinLedger(undefined);
    }
  });

  it("holds the upper edge at maxLedger plus 2, from upstream's ledger-time estimate", async () => {
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const pinned = (await net.latestLedger()) + 5;
    const at = (offset: number) => pay(payer, { expirationLedger: pinned + offset });
    const [twelve, thirteen, fourteen, fifteen] = await Promise.all([at(12), at(13), at(14), at(15)]);
    const tooFar = { isValid: false, invalidReason: "invalid_exact_stellar_signature_expiration_too_far" };
    const valid = { isValid: true, payer: payer.publicKey() };
    proxy.pinLedger(pinned);
    try {
      const { facilitator } = setup();
      const verify = (payment: typeof twelve) =>
        facilitator.core.verify(payment.payload, payment.requirements);

      // 5 s ledgers: maxLedger = pinned + ceil(60 / 5) = pinned + 12, tolerated up to + 14.
      expect(await verify(fourteen)).toEqual(valid);
      expect(await verify(fifteen)).toMatchObject(tooFar);

      // Horizon unreachable: upstream falls back to 5 s, so the edge stays put.
      horizon.set({ status: 500 });
      expect(await verify(fourteen)).toEqual(valid);
      expect(await verify(fifteen)).toMatchObject(tooFar);

      // 6 s ledgers: maxLedger = pinned + 10, tolerated up to + 12.
      horizon.set({ seconds: 6 });
      expect(await verify(twelve)).toEqual(valid);
      expect(await verify(thirteen)).toMatchObject(tooFar);
    } finally {
      horizon.set({ seconds: 5 });
      proxy.pinLedger(undefined);
    }
  });

  it("names an authorization that expires between submission and inclusion; the fee is spent", async () => {
    const { facilitator, ledger, finalized } = setup();
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    // The transaction's time bound (60 s) outlives the authorization (3 ledgers).
    const expiration = (await net.latestLedger()) + 3;
    const { payload, requirements } = await pay(payer, { expirationLedger: expiration });
    const sponsorBefore = await net.nativeBalance(sponsor.publicKey());

    proxy.onSendTransaction = () => "hold";
    const held = once(proxy.events, "held");
    const settling = facilitator.core.settle(payload, requirements);
    try {
      await held;
      await waitPast(expiration);
    } finally {
      proxy.onSendTransaction = undefined;
      await proxy.releaseHeld();
    }
    const result = await settling;

    expect(result).toMatchObject({
      success: false,
      errorReason: "invalid_exact_stellar_signature_expired",
      payer: payer.publicKey(),
    });
    expect(result.transaction).toMatch(/^[0-9a-f]{64}$/);
    const onChain = await net.server.getTransaction(result.transaction);
    expect(onChain.status).toBe(rpc.Api.GetTransactionStatus.FAILED);

    const { nonce } = authorizationOf(payload);
    const record = await ledger.find({ network: NETWORK, payer: payer.publicKey(), nonce: nonce.toString() });
    expect(record).toMatchObject({ state: "failed", transactionHash: result.transaction });

    // Counted as a wasted fee: included, failed, and charged to the sponsor.
    expect(finalized).toHaveLength(1);
    const [event] = finalized as [FinalizedEvent];
    expect(event).toMatchObject({ state: "failed", onChainFailure: true });
    expect(event.feeChargedStroops).toBeGreaterThan(0n);
    expect(await net.nativeBalance(sponsor.publicKey())).toBe(
      sponsorBefore - (event.feeChargedStroops ?? 0n),
    );
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START);
    recordOps("expiry-race", {
      scheme: "exact",
      expirationLedger: expiration,
      transaction: result.transaction,
      settle: result.errorReason,
      wastedFeeStroops: event.feeChargedStroops,
    });
  });
});

describe.skipIf(!available)("authorization expiry for upto payments", () => {
  const CAP = 1_000_000n;
  const ACTUAL = 400_000n;
  let usdc: IssuedAsset;
  let contract: LocalUptoContract;
  let sponsor: Keypair;
  let seller: Keypair;
  let proxy: RpcProxy;
  let horizon: HorizonPin;
  /** Pays through the local network directly, and through the proxy, so the client can read a pinned ledger. */
  let driver: PaymentDriver;
  let pinnedDriver: PaymentDriver;

  beforeAll(async () => {
    horizon = pinHorizon({ seconds: 5 });
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    sponsor = Keypair.random();
    await net.fund(sponsor);
    await provisionChannels({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      channels: deriveChannelKeypairs(sponsor, NETWORK, 4),
    });
    const authority = deriveAuthorityKeypair(sponsor, NETWORK);
    await provisionAuthority({ server: net.server, passphrase: net.passphrase, sponsor, authority });
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    proxy = await startRpcProxy(net.rpcUrl);
    const options = {
      contract: contract.address,
      authority: authority.publicKey(),
      client: (...args: ConstructorParameters<typeof UptoClient>) => new UptoClient(...args),
    };
    driver = uptoDriver(net, classicTestAsset(net, usdc), options);
    pinnedDriver = uptoDriver(new LocalNetwork(proxy.url), classicTestAsset(net, usdc), options);
  }, 180_000);

  afterAll(async () => {
    horizon.restore();
    await proxy.close();
  });

  /** Seconds per ledger the facilitator below assumes; `rpc` reads the network's own RPC (the default). */
  let ledgerSeconds: number | "rpc" = 5;

  /** A facilitator reading through the proxy, with the ledger time set by `ledgerSeconds`. */
  const setup = (ledger = new MemorySettlementLedger()) => {
    const seconds = ledgerSeconds;
    const finalized: FinalizedEvent[] = [];
    const facilitator: StellarFacilitator = createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: proxy.url,
          sponsorSecret: sponsor.secret(),
          channelCount: 4,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          ledger,
          timing: { pollIntervalMs: 250, channelWaitMs: 60_000 },
          upto: {
            contract: contract.address,
            contractWasmHash: contract.wasmHash,
            ...(seconds === "rpc" ? {} : { ledgerSeconds: seconds }),
          },
        },
      ],
      observer: { ...silentObserver, finalized: (event) => finalized.push(event) },
    });
    return { facilitator, ledger, finalized };
  };

  const payer = async () => {
    const [holder] = (await net.holders(usdc, 1, "100")) as [Keypair];
    return { kind: "G" as const, address: holder.publicKey(), keypair: holder };
  };

  const pay = async (
    from: Awaited<ReturnType<typeof payer>>,
    options: { maxTimeoutSeconds?: number; expirationLedger?: number; pinned?: boolean } = {},
  ) => {
    const cap = driver.requirements(seller.publicKey(), CAP, {
      maxTimeoutSeconds: options.maxTimeoutSeconds ?? 60,
    });
    const payload = (await (options.pinned === true ? pinnedDriver : driver).pay(from, cap, {
      ...(options.expirationLedger === undefined ? {} : { expirationLedger: options.expirationLedger }),
    })) as unknown as PaymentPayload;
    return {
      payload,
      requirements: cap as PaymentRequirements,
      settleRequirements: driver.settleRequirements(cap, ACTUAL) as PaymentRequirements,
    };
  };

  const authorizationOfUpto = (payload: PaymentPayload) => {
    const inspected = inspectUptoAuthorization(
      (payload.payload as { authorization: string }).authorization,
      contract.address,
    );
    if (!inspected.ok) throw new Error(inspected.rejection.code);
    return inspected.authorization;
  };

  const waitPast = (ledger: number) =>
    expect.poll(() => net.latestLedger(), { timeout: 60_000, interval: 250 }).toBeGreaterThan(ledger);

  it("derives expiration_ledger and the credential's expiration from maxTimeoutSeconds", async () => {
    const from = await payer();
    const pinned = await net.latestLedger();
    proxy.pinLedger(pinned);
    try {
      for (const [seconds, ledgers] of [
        [60, 12],
        [300, 60],
      ] as const) {
        const { payload } = await pay(from, { maxTimeoutSeconds: seconds, pinned: true });
        const authorization = authorizationOfUpto(payload);
        expect(authorization.terms.expirationLedger).toBe(pinned + ledgers);
        expect(authorization.signatureExpirationLedger).toBe(pinned + ledgers);
      }
    } finally {
      proxy.pinLedger(undefined);
    }
  });

  it("settles before expiration_ledger and refuses the same window after it", async () => {
    const { facilitator, finalized } = setup();
    // One after the other: both are funded by the same issuer account, whose sequence number is shared.
    const first = await payer();
    const second = await payer();
    const expiration = (await net.latestLedger()) + 10;
    const p1 = await pay(first, { expirationLedger: expiration });
    const p2 = await pay(second, { expirationLedger: expiration });

    expect(await facilitator.core.verify(p1.payload, p1.requirements)).toEqual({
      isValid: true,
      payer: first.address,
    });
    expect(await facilitator.core.verify(p2.payload, p2.requirements)).toEqual({
      isValid: true,
      payer: second.address,
    });
    const settled = await facilitator.core.settle(p1.payload, p1.settleRequirements);
    expect(settled).toMatchObject({ success: true, payer: first.address, amount: ACTUAL.toString() });
    const landed = await net.server.getTransaction(settled.transaction);
    if (landed.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(landed.status);
    expect(landed.ledger).toBeLessThanOrEqual(expiration);

    await waitPast(expiration);
    const submissions = proxy.sent.length;
    expect(await facilitator.core.verify(p2.payload, p2.requirements)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_signature_expired",
    });
    expect(await facilitator.core.settle(p2.payload, p2.settleRequirements)).toMatchObject({
      success: false,
      errorReason: "invalid_upto_stellar_signature_expired",
      transaction: "",
    });
    expect(proxy.sent.length).toBe(submissions);
    expect(await net.tokenBalance(usdc.sac, second.address)).toBe(START);

    // Late repeat: the same amount answers the original success; nothing moves again.
    expect(await facilitator.core.settle(p1.payload, p1.settleRequirements)).toEqual(
      markRepeat(settled, "rail402"),
    );
    expect(proxy.sent.length).toBe(submissions);
    expect(await net.tokenBalance(usdc.sac, first.address)).toBe(START - ACTUAL);
    expect(finalized.map((event) => event.state)).toEqual(["succeeded"]);
  });

  it("holds the lower edge at the current ledger plus a one-ledger margin", async () => {
    const from = await payer();
    const pinned = (await net.latestLedger()) + 5;
    const [before, at, margin] = await Promise.all([
      pay(from, { expirationLedger: pinned - 1 }),
      pay(from, { expirationLedger: pinned }),
      pay(from, { expirationLedger: pinned + 1 }),
    ]);
    proxy.pinLedger(pinned);
    try {
      const { facilitator } = setup();
      expect(await facilitator.core.verify(before.payload, before.requirements)).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_signature_expired",
      });
      expect(await facilitator.core.verify(at.payload, at.requirements)).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_signature_expiration_too_soon",
      });
      expect(await facilitator.core.verify(margin.payload, margin.requirements)).toEqual({
        isValid: true,
        payer: from.address,
      });
    } finally {
      proxy.pinLedger(undefined);
    }
  });

  it("holds the upper edge at maxLedger plus 2, from the facilitator's ledger-time estimate", async () => {
    const from = await payer();
    const pinned = (await net.latestLedger()) + 5;
    const at = (offset: number) => pay(from, { expirationLedger: pinned + offset });
    const [twelve, fourteen, fifteen] = await Promise.all([at(12), at(14), at(15)]);
    const tooFar = { isValid: false, invalidReason: "invalid_upto_stellar_signature_expiration_too_far" };
    const valid = { isValid: true, payer: from.address };
    proxy.pinLedger(pinned);
    try {
      const verify = (payment: typeof twelve) =>
        setup().facilitator.core.verify(payment.payload, payment.requirements);

      // 5 s ledgers: maxLedger = pinned + 12, tolerated up to + 14.
      ledgerSeconds = 5;
      expect(await verify(fourteen)).toEqual(valid);
      expect(await verify(fifteen)).toMatchObject(tooFar);

      // 6 s ledgers: a client that estimated the nominal 5 s signed up to + 12, so the edge stays put.
      ledgerSeconds = 6;
      expect(await verify(fourteen)).toEqual(valid);
      expect(await verify(fifteen)).toMatchObject(tooFar);

      // 4 s ledgers: maxLedger = pinned + 15, tolerated up to + 17.
      ledgerSeconds = 4;
      expect(await verify(fifteen)).toEqual(valid);
      expect(await verify(twelve)).toEqual(valid);

      // The default reads the local network's own RPC (about 1 s per ledger), not Horizon (pinned at
      // 5 s here, which would refuse + 15): about 60 ledgers for 60 s.
      ledgerSeconds = "rpc";
      const hundred = await at(100);
      expect(await verify(fifteen)).toEqual(valid);
      expect(await verify(hundred)).toMatchObject(tooFar);
    } finally {
      ledgerSeconds = 5;
      proxy.pinLedger(undefined);
    }
  });

  it("refuses at the network an upto settlement held past expiration_ledger; no fee is spent", async () => {
    // Unlike exact, the settlement transaction's ledger bounds end with the authorization, so a late
    // submission is rejected before inclusion (txTooLate) and the sponsor pays nothing. The refusal
    // alone proves nothing (bytes that already landed are refused the same way): the settlement is
    // finished as expired once the ledger bound has passed and nothing carried the authorization.
    const { facilitator, ledger, finalized } = setup();
    const from = await payer();
    const expiration = (await net.latestLedger()) + 3;
    const { payload, settleRequirements } = await pay(from, { expirationLedger: expiration });
    const sponsorBefore = await net.nativeBalance(sponsor.publicKey());

    proxy.onSendTransaction = () => "hold";
    const held = once(proxy.events, "held");
    const settling = facilitator.core.settle(payload, settleRequirements);
    try {
      await held;
      await waitPast(expiration + 1);
    } finally {
      proxy.onSendTransaction = undefined;
      await proxy.releaseHeld();
    }
    const result = await settling;

    expect(result).toMatchObject({
      success: false,
      errorReason: "settle_upto_stellar_transaction_expired",
      payer: from.address,
      amount: ACTUAL.toString(),
    });
    expect(proxy.answers.some((answer) => answer.status.includes("txTooLate"))).toBe(true);

    const { nonce } = authorizationOfUpto(payload);
    const record = await ledger.find({ network: NETWORK, payer: from.address, nonce: nonce.toString() });
    expect(record).toMatchObject({ scheme: "upto", state: "expired" });
    const hash = record?.transactionHash ?? "";
    expect((await net.server.getTransaction(hash)).status).toBe(rpc.Api.GetTransactionStatus.NOT_FOUND);

    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({ scheme: "upto", state: "expired", onChainFailure: false });
    expect(await net.nativeBalance(sponsor.publicKey())).toBe(sponsorBefore);
    expect(await net.tokenBalance(usdc.sac, from.address)).toBe(START);
  });
});
