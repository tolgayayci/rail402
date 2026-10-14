/**
 * Front-running on the private Stellar network (1 s ledgers).
 *
 * The RPC proxy runs an attacker before Rail402's `sendTransaction` is forwarded: the attacker copies
 * the payer's signed authorization entry out of the settlement envelope into a transaction of their
 * own, from their own funded account, and waits for it to land. Rail402's transaction then lands in a
 * later ledger and fails on the consumed nonce. The payment did settle, exactly as signed, so the
 * answer is a success with the attacker's hash.
 *
 * An `upto` authorization cannot be front-run this way: the settlement also needs the facilitator's
 * settlement authority as the operation's source, so a copy landed by anyone else fails and Rail402's
 * own settlement proceeds. Only a transaction the authority itself signed (another replica sharing
 * the sponsor) can land first; Rail402 then answers with it when it settled the same amount, and with
 * `settle_upto_stellar_settled_elsewhere` otherwise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FeeBumpTransaction,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import {
  MemorySettlementLedger,
  acceptedAsset,
  createStellarFacilitator,
  deriveAuthorityKeypair,
  deriveChannelKeypairs,
  findThirdPartySettlement,
  provisionAuthority,
  provisionChannels,
  repeatOf,
  signedAuthorizationOf,
  silentObserver,
  type FinalizedEvent,
  type SettlementRecord,
} from "@rail402.dev/facilitator";
import { inspectExactTransaction, payerAuthorization, recordedUptoSettlement } from "@rail402.dev/stellar";
import {
  authorityEntry,
  decodeAuthorizationEntry,
  inspectUptoAuthorization,
  settleInvokeArgs,
} from "@rail402.dev/upto";
import { UptoStellarScheme as UptoClient } from "@rail402.dev/upto/client";
import {
  LocalNetwork,
  classicTestAsset,
  deployUpto,
  onChainSettlement,
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
const PRICE = 1_000_000n;

function innerOf(envelopeXdr: string): Transaction {
  const envelope = TransactionBuilder.fromXDR(envelopeXdr, net.passphrase);
  return envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
}

/**
 * Lands the payer's authorization from a settlement envelope in the attacker's own transaction: the
 * same host function and authorization entries, a different source account and fee payer.
 */
async function frontRun(attacker: Keypair, envelopeXdr: string): Promise<string> {
  const inner = innerOf(envelopeXdr);
  const operation = inner.operations[0];
  if (operation?.type !== "invokeHostFunction") throw new Error("not a settlement envelope");
  const sorobanData = inner.toEnvelope().v1().tx().ext().sorobanData();
  const account = await net.server.getAccount(attacker.publicKey());
  const copy = new TransactionBuilder(account, { fee: inner.fee, networkPassphrase: net.passphrase })
    .addOperation(Operation.invokeHostFunction({ func: operation.func, auth: operation.auth ?? [] }))
    .setSorobanData(sorobanData)
    .setTimeout(60)
    .build();
  copy.sign(attacker);
  const landed = await net.submit(copy);
  return landed.txHash;
}

describe.skipIf(!available)("front-running reconciliation for exact payments", () => {
  let usdc: IssuedAsset;
  let sponsor: Keypair;
  let seller: Keypair;
  let attacker: Keypair;
  let proxy: RpcProxy;
  let horizon: HorizonPin;
  /** The first test's settlement record, reused to probe the finder's refusals. */
  let frontRunRecord: SettlementRecord | undefined;

  beforeAll(async () => {
    horizon = pinHorizon({ seconds: 5 });
    usdc = await net.issueAsset("USDC");
    sponsor = Keypair.random();
    attacker = Keypair.random();
    await net.fund(sponsor, attacker);
    await provisionChannels({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      channels: deriveChannelKeypairs(sponsor, NETWORK, 2),
    });
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    proxy = await startRpcProxy(net.rpcUrl);
  });

  afterAll(async () => {
    horizon.restore();
    await proxy.close();
  });

  const setup = (reconcileThirdParty?: boolean) => {
    const ledger = new MemorySettlementLedger();
    const finalized: FinalizedEvent[] = [];
    const facilitator = createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: proxy.url,
          sponsorSecret: sponsor.secret(),
          channelCount: 2,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          policy: { maxTransactionFeeStroops: 2_000_000 },
          ledger,
          timing: { pollIntervalMs: 250 },
          ...(reconcileThirdParty === undefined ? {} : { reconcileThirdParty }),
        },
      ],
      observer: { ...silentObserver, finalized: (event) => finalized.push(event) },
    });
    return { facilitator, ledger, finalized };
  };

  const pay = async (payer: Keypair) => {
    const terms = requirementsFor(usdc.sac, seller.publicKey(), PRICE, 120);
    const payload = (await net.payment(payer, terms)) as PaymentPayload;
    const inspection = inspectExactTransaction(
      (payload.payload as { transaction: string }).transaction,
      net.passphrase,
    );
    if (!inspection.ok) throw new Error(inspection.code);
    const nonce = payerAuthorization(inspection.transfer)?.nonce;
    if (nonce === undefined) throw new Error("no payer authorization");
    const key = { network: NETWORK, payer: payer.publicKey(), nonce: nonce.toString() };
    return { payload, requirements: terms as PaymentRequirements, key };
  };

  /** Settles with the attacker landing a copy of the authorization right before ours is forwarded. */
  const settleFrontRun = async (facilitator: ReturnType<typeof setup>["facilitator"], payer: Keypair) => {
    const { payload, requirements, key } = await pay(payer);
    const attackerHashes: string[] = [];
    proxy.injectBefore("sendTransaction", async (params) => {
      if (attackerHashes.length > 0) return;
      const envelope = (params as { transaction: string }).transaction;
      attackerHashes.push(await frontRun(attacker, envelope));
    });
    let result: SettleResponse;
    try {
      result = await facilitator.core.settle(payload, requirements);
    } finally {
      proxy.injectBefore("sendTransaction", undefined);
    }
    const [attackerHash] = attackerHashes;
    if (attackerHash === undefined) throw new Error("the attacker never ran");
    return { payload, requirements, key, result, attackerHash };
  };

  it("answers success with the attacker's hash; the payment moves once and our fee is wasted", async () => {
    const { facilitator, ledger, finalized } = setup();
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const sellerBefore = await net.tokenBalance(usdc.sac, seller.publicKey());
    const sponsorBefore = await net.nativeBalance(sponsor.publicKey());

    const { payload, requirements, key, result, attackerHash } = await settleFrontRun(facilitator, payer);

    expect(result).toEqual({
      success: true,
      transaction: attackerHash,
      network: NETWORK,
      payer: payer.publicKey(),
    });

    // Our own transaction was included and failed on the consumed nonce.
    const record = await ledger.find(key);
    expect(record).toMatchObject({ state: "succeeded", settledBy: "third_party" });
    frontRunRecord = record;
    const ours = record?.transactionHash ?? "";
    expect(ours).not.toBe(attackerHash);
    const onChain = await net.server.getTransaction(ours);
    expect(onChain.status).toBe(rpc.Api.GetTransactionStatus.FAILED);

    // The attacker's transaction moved the payment exactly once; the sponsor paid none of it.
    const landed = await onChainSettlement(net.server, net.passphrase, attackerHash);
    expect(landed.feeSource).toBe(attacker.publicKey());
    expect(landed.transfers).toEqual([
      { contract: usdc.sac, from: payer.publicKey(), to: seller.publicKey(), amount: PRICE },
    ]);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START - PRICE);
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(sellerBefore + PRICE);

    // Exactly one wasted fee: the one our failed transaction was charged.
    expect(finalized).toHaveLength(1);
    const [event] = finalized as [FinalizedEvent];
    expect(event).toMatchObject({ state: "succeeded", settledBy: "third_party", onChainFailure: true });
    expect(event.feeChargedStroops).toBeGreaterThan(0n);
    expect(record?.feeChargedStroops).toBe(event.feeChargedStroops?.toString());
    expect(await net.nativeBalance(sponsor.publicKey())).toBe(
      sponsorBefore - (event.feeChargedStroops ?? 0n),
    );

    // A repeat returns the same response, marked as settled by a third party, and moves nothing.
    const sent = proxy.sent.length;
    const repeat = await facilitator.core.settle(payload, requirements);
    expect(repeatOf(repeat)).toEqual({ repeat: true, settledBy: "third_party" });
    const { extensionResponses: _marker, ...body } = repeat;
    expect(body).toEqual(result);
    expect(proxy.sent.length).toBe(sent);
    expect(finalized).toHaveLength(1);

    // Verify names the transaction the payment landed in.
    const verified = await facilitator.core.verify(payload, requirements);
    expect(verified).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_nonce_already_used",
    });
    expect(verified.invalidMessage).toContain(attackerHash);
    recordOps("front-run", {
      attackerTransaction: attackerHash,
      ourFailedTransaction: ours,
      answer: "success with the attacker's hash",
      wastedFeeStroops: event.feeChargedStroops,
      payerDebitedOnce: PRICE,
    });
  });

  it("answers the failure when the reconciliation is turned off", async () => {
    const { facilitator, ledger, finalized } = setup(false);
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];

    const { key, result, attackerHash } = await settleFrontRun(facilitator, payer);

    expect(result).toMatchObject({
      success: false,
      errorReason: "invalid_exact_stellar_payload_nonce_already_used",
      payer: payer.publicKey(),
    });
    expect(result.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(result.transaction).not.toBe(attackerHash);
    expect(await ledger.find(key)).toMatchObject({ state: "failed", settledBy: "rail402" });
    expect(finalized).toEqual([
      expect.objectContaining({ state: "failed", settledBy: "rail402", onChainFailure: true }),
    ]);
  });

  describe("accepts only proof from the chain", () => {
    const record = (): SettlementRecord => {
      if (frontRunRecord === undefined) throw new Error("the front-run case did not record a settlement");
      return frontRunRecord;
    };

    it("finds the attacker's transaction for the recorded settlement", async () => {
      const found = await findThirdPartySettlement(net.server, record(), net.passphrase);
      expect(found).toMatchObject({ found: true });
    });

    it("refuses an authorization consumed before the request was claimed", async () => {
      const late = { ...record(), createdAt: Date.now() + 60_000 };
      expect(await findThirdPartySettlement(net.server, late, net.passphrase)).toEqual({
        found: false,
        miss: "consumed_before_request",
      });
    });

    it("refuses when the consuming transaction carried a different invocation for the same nonce", async () => {
      // The payer signed this nonce into another transfer (a different amount): the entry that
      // consumed it is not the one Rail402 was asked to settle.
      const original = record();
      const bump = TransactionBuilder.fromXDR(original.envelopeXdr ?? "", net.passphrase);
      if (!(bump instanceof FeeBumpTransaction)) throw new Error("expected a fee bump");
      const envelope = bump.toEnvelope();
      const operation = envelope.feeBump().tx().innerTx().v1().tx().operations()[0];
      const auth = operation?.body().invokeHostFunctionOp().auth()[0];
      const call = auth?.rootInvocation().function().contractFn();
      if (call === undefined) throw new Error("no authorized call");
      const [from, to] = call.args();
      call.args([from as xdr.ScVal, to as xdr.ScVal, nativeToScVal(PRICE + 1n, { type: "i128" })]);
      const altered = { ...original, envelopeXdr: envelope.toXDR("base64") };
      expect(signedAuthorizationOf(altered, net.passphrase)?.amount).toBe(PRICE + 1n);
      expect(await findThirdPartySettlement(net.server, altered, net.passphrase)).toEqual({
        found: false,
        miss: "no_matching_transaction",
      });
    });

    it("refuses an authorization whose nonce was never consumed", async () => {
      const unused = { ...record(), key: { ...record().key, nonce: "12345" } };
      // Re-key the recorded authorization entry to the unused nonce so it still decodes.
      const bump = TransactionBuilder.fromXDR(unused.envelopeXdr ?? "", net.passphrase) as FeeBumpTransaction;
      const envelope = bump.toEnvelope();
      const auth = envelope
        .feeBump()
        .tx()
        .innerTx()
        .v1()
        .tx()
        .operations()[0]
        ?.body()
        .invokeHostFunctionOp()
        .auth()[0];
      auth?.credentials().address().nonce(xdr.Int64.fromString("12345"));
      const rekeyed = { ...unused, envelopeXdr: envelope.toXDR("base64") };
      expect(await findThirdPartySettlement(net.server, rekeyed, net.passphrase)).toEqual({
        found: false,
        miss: "nonce_not_consumed",
      });
    });
  });
});

describe.skipIf(!available)("front-running upto settlements", () => {
  const CAP = 1_000_000n;
  const ACTUAL = 600_000n;
  let usdc: IssuedAsset;
  let contract: LocalUptoContract;
  let sponsor: Keypair;
  let authority: Keypair;
  let seller: Keypair;
  let attacker: Keypair;
  let proxy: RpcProxy;
  let driver: PaymentDriver;

  beforeAll(async () => {
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    sponsor = Keypair.random();
    attacker = Keypair.random();
    await net.fund(sponsor, attacker);
    await provisionChannels({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      channels: deriveChannelKeypairs(sponsor, NETWORK, 2),
    });
    authority = deriveAuthorityKeypair(sponsor, NETWORK);
    await provisionAuthority({ server: net.server, passphrase: net.passphrase, sponsor, authority });
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    driver = uptoDriver(net, classicTestAsset(net, usdc), {
      contract: contract.address,
      authority: authority.publicKey(),
      client: (...args: ConstructorParameters<typeof UptoClient>) => new UptoClient(...args),
    });
    proxy = await startRpcProxy(net.rpcUrl);
  }, 180_000);

  afterAll(async () => {
    await proxy.close();
  });

  const setup = () => {
    const ledger = new MemorySettlementLedger();
    const finalized: FinalizedEvent[] = [];
    const facilitator = createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: proxy.url,
          sponsorSecret: sponsor.secret(),
          channelCount: 2,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          ledger,
          timing: { pollIntervalMs: 250 },
          upto: { contract: contract.address, contractWasmHash: contract.wasmHash, ledgerSeconds: 5 },
        },
      ],
      observer: { ...silentObserver, finalized: (event) => finalized.push(event) },
    });
    return { facilitator, ledger, finalized };
  };

  const pay = async (payer: Keypair) => {
    const published = driver.requirements(seller.publicKey(), CAP, { maxTimeoutSeconds: 120 });
    const payload = (await driver.pay(
      { kind: "G", address: payer.publicKey(), keypair: payer },
      published,
    )) as unknown as PaymentPayload;
    const nonce = decodeAuthorizationEntry((payload.payload as { authorization: string }).authorization)
      .credentials()
      .address()
      .nonce()
      .toString();
    return {
      payload,
      requirements: published as PaymentRequirements,
      settle: driver.settleRequirements(published, ACTUAL) as PaymentRequirements,
      key: { network: NETWORK, payer: payer.publicKey(), nonce },
    };
  };

  /** Runs `attack` with the settlement envelope right before Rail402's submission is forwarded. */
  const settleAttacked = async (
    facilitator: ReturnType<typeof setup>["facilitator"],
    payment: Awaited<ReturnType<typeof pay>>,
    attack: (envelopeXdr: string) => Promise<string>,
  ) => {
    const outcomes: PromiseSettledResult<string>[] = [];
    proxy.injectBefore("sendTransaction", async (params) => {
      if (outcomes.length > 0) return;
      outcomes.push(...(await Promise.allSettled([attack((params as { transaction: string }).transaction)])));
    });
    try {
      return { result: await facilitator.core.settle(payment.payload, payment.settle), outcomes };
    } finally {
      proxy.injectBefore("sendTransaction", undefined);
    }
  };

  it("cannot be landed by an attacker without the settlement authority; Rail402's settlement proceeds", async () => {
    const { facilitator, ledger } = setup();
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const payment = await pay(payer);

    const { result, outcomes } = await settleAttacked(facilitator, payment, (envelope) =>
      frontRun(attacker, envelope),
    );

    // The copied authorization failed for the attacker: the authority's source-account credential
    // is not satisfied by anyone else's transaction.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("rejected");
    expect(result).toMatchObject({ success: true, payer: payer.publicKey(), amount: ACTUAL.toString() });
    expect(await ledger.find(payment.key)).toMatchObject({ state: "succeeded", settledBy: "rail402" });
    const landed = await onChainSettlement(net.server, net.passphrase, result.transaction);
    expect(landed.feeSource).toBe(sponsor.publicKey());
    expect(landed.transfers).toEqual(
      driver.expectedTransfers(payer.publicKey(), seller.publicKey(), CAP, ACTUAL),
    );
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START - ACTUAL);
  });

  it("cannot be settled by a payload holder for another amount: the host refuses without the authority", async () => {
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const payment = await pay(payer);
    const inspected = inspectUptoAuthorization(
      (payment.payload.payload as { authorization: string }).authorization,
      contract.address,
    );
    if (!inspected.ok) throw new Error(inspected.rejection.reason);
    const { entry, terms } = inspected.authorization;

    // The holder names itself as the operation source and claims the whole cap: the payer's entry is
    // valid, but terms.facilitator (the settlement authority) authorized nothing in this transaction.
    const account = await net.server.getAccount(attacker.publicKey());
    const draft = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: net.passphrase })
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(
            settleInvokeArgs(contract.address, payer.publicKey(), terms, CAP),
          ),
          auth: [entry, authorityEntry(contract.address, payer.publicKey(), terms, CAP)],
        }),
      )
      .setTimeout(60)
      .build();
    const simulated = await net.server.simulateTransaction(draft);
    expect(rpc.Api.isSimulationError(simulated)).toBe(true);
    expect((simulated as rpc.Api.SimulateTransactionErrorResponse).error).toMatch(/Error\(Auth, /);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START);

    // The payment is still Rail402's to settle, for the amount the seller asked.
    const { facilitator } = setup();
    const result = await facilitator.core.settle(payment.payload, payment.settle);
    expect(result).toMatchObject({ success: true, amount: ACTUAL.toString() });
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START - ACTUAL);
  });

  it("answers with the authority's own earlier transaction for the same amount; our fee is wasted", async () => {
    const { facilitator, ledger, finalized } = setup();
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const payment = await pay(payer);
    const sponsorBefore = await net.nativeBalance(sponsor.publicKey());

    const { result, outcomes } = await settleAttacked(facilitator, payment, (envelope) =>
      landWithAuthority(envelope, ACTUAL),
    );
    const [landed] = outcomes;
    if (landed?.status !== "fulfilled") throw new Error("the other settlement did not land");

    expect(result).toEqual({
      success: true,
      transaction: landed.value,
      network: NETWORK,
      payer: payer.publicKey(),
      amount: ACTUAL.toString(),
    });
    const record = await ledger.find(payment.key);
    expect(record).toMatchObject({ scheme: "upto", state: "succeeded", settledBy: "third_party" });
    expect((await net.server.getTransaction(record?.transactionHash ?? "")).status).toBe(
      rpc.Api.GetTransactionStatus.FAILED,
    );
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START - ACTUAL);

    expect(finalized).toHaveLength(1);
    const [event] = finalized as [FinalizedEvent];
    expect(event).toMatchObject({
      scheme: "upto",
      state: "succeeded",
      settledBy: "third_party",
      onChainFailure: true,
    });
    expect(event.feeChargedStroops).toBeGreaterThan(0n);
    expect(await net.nativeBalance(sponsor.publicKey())).toBe(
      sponsorBefore - (event.feeChargedStroops ?? 0n),
    );

    const sent = proxy.sent.length;
    const repeat = await facilitator.core.settle(payment.payload, payment.settle);
    expect(repeatOf(repeat)).toEqual({ repeat: true, settledBy: "third_party" });
    expect(proxy.sent.length).toBe(sent);
    const verified = await facilitator.core.verify(payment.payload, payment.requirements);
    expect(verified).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_nonce_already_used",
    });
    expect(verified.invalidMessage).toContain(landed.value);
  });

  /**
   * Lands the recorded authorization for `amount` in a transaction of its own, with the settlement
   * authority as operation source (as another replica sharing the sponsor would) and a separate fee
   * payer.
   */
  async function landWithAuthority(envelopeXdr: string, amount: bigint): Promise<string> {
    const recorded = recordedUptoSettlement(envelopeXdr, net.passphrase);
    if (recorded?.payerEntry === undefined) throw new Error("not an upto settlement envelope");
    const account = await net.server.getAccount(attacker.publicKey());
    const draft = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: net.passphrase })
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(
            settleInvokeArgs(recorded.contract, recorded.payer, recorded.terms, amount),
          ),
          auth: [
            recorded.payerEntry,
            authorityEntry(recorded.contract, recorded.payer, recorded.terms, amount),
          ],
          source: authority.publicKey(),
        }),
      )
      .setTimeout(60)
      .build();
    const prepared: Transaction = await net.server.prepareTransaction(draft);
    prepared.sign(attacker, authority);
    return (await net.submit(prepared)).txHash;
  }
});
