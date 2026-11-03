/**
 * How the settlement engine finishes a recorded `upto` settlement: confirmation, expiry, on-chain
 * failures named by the settlement's own classifier, and a payment another transaction landed first.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Address,
  FeeBumpTransaction,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  MemoryChannelPool,
  MemorySettlementLedger,
  SettlementEngine,
  StellarUptoScheme,
  explainFailedUptoTransaction,
  repeatOf,
  signedAuthorizationOf,
  silentObserver,
  type SequenceConflictEvent,
  type SettlementObserver,
  type SettlementRecord,
} from "@rail402.dev/facilitator";
import {
  CONTRACT,
  FakeServer,
  NETWORK,
  PASSPHRASE,
  authority,
  channel,
  errorEvent,
  payer,
  payment,
  policy,
  recipient,
  requirements,
  settlementEvents,
  sponsor,
  TOKEN,
  uptoPolicy,
} from "./upto-helpers.ts";

/**
 * A settlement whose envelope was broadcast and not confirmed within the request. `prepare` sets the
 * server up before the settlement is submitted (for example, how it answers the first send).
 */
async function pendingSettlement(
  amount = 250_000n,
  observer?: SettlementObserver,
  prepare?: (server: FakeServer) => void,
) {
  const server = new FakeServer();
  server.status = "NOT_FOUND";
  prepare?.(server);
  const ledger = new MemorySettlementLedger();
  const channels = new MemoryChannelPool([channel.publicKey()]);
  const engine = new SettlementEngine({
    network: NETWORK,
    passphrase: PASSPHRASE,
    rpcUrl: "http://127.0.0.1:1/rpc",
    server: server.asServer(),
    policy,
    ledger,
    channels,
    channelKeys: new Map([[channel.publicKey(), channel]]),
    sponsor,
    authority,
    // Records are written as if by a crashed process: the reconciler takes them at once.
    timing: { pollIntervalMs: 5, confirmTimeoutMs: 30, duplicateWaitMs: 50, reconcileIdleMs: 0 },
    ...(observer === undefined ? {} : { observer }),
  });
  const scheme = new StellarUptoScheme({
    network: NETWORK,
    passphrase: PASSPHRASE,
    server: server.asServer(),
    policy,
    upto: uptoPolicy,
    engine,
  });
  const payload = payment();
  const settleRequirements = requirements({ amount: amount.toString() });
  const pending = await scheme.settle(payload, settleRequirements);
  expect(pending).toMatchObject({
    success: false,
    errorReason: "settlement_pending",
    amount: amount.toString(),
  });
  const [record] = await ledger.unfinished(NETWORK);
  if (record === undefined) throw new Error("no unfinished settlement");
  return {
    server,
    ledger,
    engine,
    channels,
    scheme,
    payload,
    settleRequirements,
    record,
    hash: pending.transaction,
  };
}

function failedWith(server: FakeServer, events: xdr.DiagnosticEvent[]) {
  server.status = "FAILED";
  server.failureEvents = events;
}

/** A successful transaction in `ledger` that carries the recorded authorization and settled `amount`. */
function thirdParty(record: SettlementRecord, amount: bigint, ledgerSeq: number): rpc.Api.TransactionInfo {
  const envelope = new FeeBumpTransaction(record.envelopeXdr ?? "", PASSPHRASE);
  return {
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    ledger: ledgerSeq,
    createdAt: Math.floor(Date.now() / 1_000) + 5,
    applicationOrder: 1,
    feeBump: true,
    envelopeXdr: envelope.toEnvelope(),
    txHash: "d".repeat(64),
    events: {
      transactionEventsXdr: [],
      contractEventsXdr: [settlementEvents(amount).map((event) => event.event())],
    },
  } as unknown as rpc.Api.TransactionInfo;
}

describe("recorded upto settlements", () => {
  it("record the scheme and the amount, and succeed with the amount once included", async () => {
    const { server, ledger, engine, record, hash } = await pendingSettlement();
    expect(record).toMatchObject({
      scheme: "upto",
      amount: "250000",
      state: "submitted",
      transactionHash: hash,
    });
    server.status = "SUCCESS";
    expect(await engine.reconcile()).toBe(1);
    expect((await ledger.get(record.id))?.response).toEqual({
      success: true,
      transaction: hash,
      network: NETWORK,
      payer: payer.publicKey(),
      amount: "250000",
    });
  });

  it("expire with the upto code once their time bound passed", async () => {
    const { server, ledger, engine, record, hash, channels } = await pendingSettlement();
    server.latestLedgerCloseTime = (record.validUntil ?? 0) + 10;
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({
      state: "expired",
      response: {
        success: false,
        errorReason: "settle_upto_stellar_transaction_expired",
        transaction: hash,
        amount: "250000",
      },
    });
    expect(await channels.inUse()).toBe(0);
  });

  it("name an on-chain failure with the settlement contract's code", async () => {
    const { server, ledger, engine, record, hash } = await pendingSettlement();
    failedWith(server, [contractError(CONTRACT, 3)]);
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({
      state: "failed",
      response: {
        errorReason: "invalid_upto_stellar_payload_settlement_exceeds_amount",
        transaction: hash,
        amount: "250000",
      },
    });
  });

  it("keep a consumed nonce as a failure when no other transaction settled it", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    failedWith(server, [errorEvent(xdr.ScError.sceAuth(xdr.ScErrorCode.scecExistingValue()))]);
    // The nonce was consumed, but no transaction in the consuming ledger carried the authorization.
    server.nonceConsumedIn = server.ledger - 1;
    await engine.reconcile();
    expect((await ledger.get(record.id))?.response).toMatchObject({
      errorReason: "invalid_upto_stellar_payload_nonce_already_used",
      amount: "250000",
    });
  });

  it("name a failure without diagnostics as a failed settlement transaction", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    failedWith(server, []);
    await engine.reconcile();
    const response = (await ledger.get(record.id))?.response;
    expect(response).toMatchObject({
      errorReason: "settle_upto_stellar_transaction_failed",
      amount: "250000",
    });
    expect(response?.errorMessage).toContain(`ledger ${server.ledger}`);
  });

  it("succeed in another transaction that settled the same amount first", async () => {
    const { server, ledger, engine, record, scheme, payload, settleRequirements } = await pendingSettlement();
    failedWith(server, [errorEvent(xdr.ScError.sceAuth(xdr.ScErrorCode.scecExistingValue()))]);
    server.nonceConsumedIn = server.ledger;
    server.transactions = [thirdParty(record, 250_000n, server.ledger)];
    await engine.reconcile();
    const finished = await ledger.get(record.id);
    expect(finished).toMatchObject({
      state: "succeeded",
      settledBy: "third_party",
      response: { success: true, transaction: "d".repeat(64), amount: "250000" },
    });
    const repeat = await scheme.settle(payload, settleRequirements);
    expect(repeatOf(repeat)).toEqual({ repeat: true, settledBy: "third_party" });
  });

  it("answer settled_elsewhere when another transaction settled a different amount first", async () => {
    const { server, ledger, engine, record, hash } = await pendingSettlement();
    failedWith(server, [errorEvent(xdr.ScError.sceAuth(xdr.ScErrorCode.scecExistingValue()))]);
    server.nonceConsumedIn = server.ledger;
    server.transactions = [thirdParty(record, 100_000n, server.ledger)];
    await engine.reconcile();
    const finished = await ledger.get(record.id);
    expect(finished).toMatchObject({
      state: "failed",
      settledBy: "third_party",
      response: {
        success: false,
        errorReason: "settle_upto_stellar_settled_elsewhere",
        transaction: "d".repeat(64),
        amount: "250000",
      },
    });
    expect(finished?.response?.errorMessage).toContain("100000");
    expect(finished?.response?.errorMessage).toContain(hash);
  });
});

/**
 * The record with an `exact` envelope instead: a sponsored `transfer(payer, payTo, amount)` carrying
 * the payer's authorization with the record's nonce and `expiration`.
 */
function asExact(record: SettlementRecord, expiration: number): SettlementRecord {
  const args = [
    new Address(payer.publicKey()).toScVal(),
    new Address(recipient.publicKey()).toScVal(),
    nativeToScVal(250_000n, { type: "i128" }),
  ];
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(payer.publicKey()).toScAddress(),
        nonce: xdr.Int64.fromString(record.key.nonce),
        signatureExpirationLedger: expiration,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(TOKEN).toScAddress(),
          functionName: "transfer",
          args,
        }),
      ),
      subInvocations: [],
    }),
  });
  const inner = new TransactionBuilder(new Account(channel.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({ contract: TOKEN, function: "transfer", args, auth: [auth] }),
    )
    .setTimeout(300)
    .build();
  inner.sign(channel);
  const bump = TransactionBuilder.buildFeeBumpTransaction(sponsor, "10000", inner, PASSPHRASE);
  bump.sign(sponsor);
  return { ...record, scheme: "exact", envelopeXdr: bump.toXDR() };
}

/** The recorded inner transaction's exclusive upper ledger bound and the authorization's expiration ledger. */
function boundsOf(record: SettlementRecord) {
  const inner = new FeeBumpTransaction(record.envelopeXdr ?? "", PASSPHRASE).innerTransaction;
  const maxLedger = inner.ledgerBounds?.maxLedger ?? 0;
  const expiration = signedAuthorizationOf(record, PASSPHRASE)?.signatureExpirationLedger ?? 0;
  expect(maxLedger).toBeGreaterThan(0);
  expect(expiration).toBe(maxLedger - 1);
  return { maxLedger, expiration };
}

/** A `sendTransaction` answer refusing the envelope with `code`. */
function refused(code: "txTooLate" | "txBadAuth" | "txBadSeq"): rpc.Api.SendTransactionResponse {
  return {
    status: "ERROR",
    hash: "0".repeat(64),
    latestLedger: 0,
    latestLedgerCloseTime: 0,
    errorResult: new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString("0"),
      result:
        code === "txTooLate"
          ? xdr.TransactionResultResult.txTooLate()
          : code === "txBadSeq"
            ? xdr.TransactionResultResult.txBadSeq()
            : xdr.TransactionResultResult.txBadAuth(),
      ext: new xdr.TransactionResultExt(0),
    }),
  };
}

/** A `sendTransaction` answer that holds nothing: the network's queue is full. */
function tryAgainLater(): rpc.Api.SendTransactionResponse {
  return { status: "TRY_AGAIN_LATER", hash: "0".repeat(64), latestLedger: 0, latestLedgerCloseTime: 0 };
}

/** A NOT_FOUND answer for `hash` from an RPC whose latest ledger is `latestLedger`. */
function notFound(
  hash: string,
  latestLedger: number,
  oldestLedgerCloseTime = 0,
): rpc.Api.GetTransactionResponse {
  return {
    status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    txHash: hash,
    latestLedger,
    latestLedgerCloseTime: 0,
    oldestLedger: 1,
    oldestLedgerCloseTime,
  };
}

/**
 * Someone else's fee bump of the recorded inner transaction, included successfully in `landedIn`, and
 * the answer of an RPC at `latestLedger` that looks it up by the inner hash.
 */
function foreignFeeBump(record: SettlementRecord, landedIn: number, latestLedger: number) {
  const inner = new FeeBumpTransaction(record.envelopeXdr ?? "", PASSPHRASE).innerTransaction;
  const outsider = Keypair.random();
  const foreign = TransactionBuilder.buildFeeBumpTransaction(outsider, "10000000", inner, PASSPHRASE);
  foreign.sign(outsider);
  const found: rpc.Api.GetTransactionResponse = {
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    txHash: record.innerTransactionHash ?? "",
    latestLedger,
    latestLedgerCloseTime: 0,
    oldestLedger: 1,
    oldestLedgerCloseTime: 0,
    ledger: landedIn,
    createdAt: 0,
    applicationOrder: 1,
    feeBump: true,
    envelopeXdr: foreign.toEnvelope(),
    resultXdr: {} as xdr.TransactionResult,
    resultMetaXdr: {} as xdr.TransactionMeta,
    events: { transactionEventsXdr: [], contractEventsXdr: [] },
  };
  return { hash: foreign.hash().toString("hex"), envelope: foreign, found };
}

/** The host's error for an authorization whose nonce another transaction consumed first. */
function nonceUsed(): xdr.DiagnosticEvent {
  return errorEvent(xdr.ScError.sceAuth(xdr.ScErrorCode.scecExistingValue()));
}

/** The host's error for an authorization applied after its expiration ledger. */
function signatureExpired(): xdr.DiagnosticEvent {
  return errorEvent(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidInput()), "signature has expired");
}

/**
 * The answer for `envelope` included in `ledgerSeq` and failed with `events`, from an RPC whose latest
 * ledger is `latestLedger`.
 */
function failedIn(
  envelope: FeeBumpTransaction,
  ledgerSeq: number,
  latestLedger: number,
  events: xdr.DiagnosticEvent[],
): rpc.Api.GetTransactionResponse {
  return {
    status: rpc.Api.GetTransactionStatus.FAILED,
    txHash: envelope.hash().toString("hex"),
    latestLedger,
    latestLedgerCloseTime: 0,
    oldestLedger: 1,
    oldestLedgerCloseTime: 0,
    ledger: ledgerSeq,
    createdAt: 0,
    applicationOrder: 1,
    feeBump: true,
    envelopeXdr: envelope.toEnvelope(),
    resultXdr: new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString("0"),
      result: xdr.TransactionResultResult.txFailed([]),
      ext: new xdr.TransactionResultExt(0),
    }),
    resultMetaXdr: {} as xdr.TransactionMeta,
    diagnosticEventsXdr: events,
    events: { transactionEventsXdr: [], contractEventsXdr: [] },
  };
}

describe("recorded upto settlements whose own hash reads NOT_FOUND", () => {
  it("stay pending when a rebroadcast is refused as too late: the transaction may have landed", async () => {
    const { server, ledger, engine, record, hash } = await pendingSettlement();
    server.sendResult = refused("txTooLate");
    expect(await engine.confirm(record, Date.now() + 40)).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
      transaction: hash,
    });
    expect(server.sent.length).toBeGreaterThan(1);
    expect((await ledger.get(record.id))?.state).toBe("submitted");

    // Past its ledger bound, the payer's consumed nonce leads to the transaction that settled it.
    server.ledger = boundsOf(record).maxLedger;
    server.nonceConsumedIn = server.ledger - 1;
    server.transactions = [thirdParty(record, 250_000n, server.ledger - 1)];
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({
      state: "succeeded",
      response: { success: true, transaction: "d".repeat(64), amount: "250000" },
    });
  });

  it("expire at the ledger bound, before the time bound, once nothing carried the authorization", async () => {
    const { server, ledger, engine, record, channels } = await pendingSettlement();
    const { maxLedger } = boundsOf(record);
    server.latestLedgerCloseTime = (record.validUntil ?? 0) - 60;
    server.ledger = maxLedger - 1;
    expect(await engine.reconcile()).toBe(0);
    server.ledger = maxLedger;
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({
      state: "expired",
      response: { errorReason: "settle_upto_stellar_transaction_expired" },
    });
    expect(await channels.inUse()).toBe(0);
  });

  it("stay unresolved when the authorization was consumed by a transaction nobody can identify", async () => {
    const { server, ledger, engine, record, channels } = await pendingSettlement();
    server.ledger = boundsOf(record).maxLedger;
    server.latestLedgerCloseTime = (record.validUntil ?? 0) + 10;
    server.nonceConsumedIn = server.ledger - 1;
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
    expect(await channels.inUse()).toBe(1);
  });

  it("stay unresolved past the expiration ledger when the RPC no longer retains the claim's ledgers", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    server.ledger = boundsOf(record).maxLedger;
    server.oldestLedgerCloseTime = Math.floor(Date.now() / 1_000);
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });

  it("succeed with the hash of someone else's fee bump that landed the recorded transaction", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    const foreign = foreignFeeBump(record, server.ledger, server.ledger);
    server.byHash.set(record.innerTransactionHash ?? "", foreign.found);
    server.latestLedgerCloseTime = (record.validUntil ?? 0) + 10;
    expect(await engine.reconcile()).toBe(1);
    const finished = await ledger.get(record.id);
    expect(finished).toMatchObject({
      state: "succeeded",
      settledBy: "third_party",
      response: { success: true, transaction: foreign.hash, amount: "250000" },
    });
    // The sponsor paid nothing for it.
    expect(finished?.feeChargedStroops).toBeUndefined();
  });

  it("succeed as Rail402's own settlement when the inner-hash lookup finds the recorded fee bump", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    const own = new FeeBumpTransaction(record.envelopeXdr ?? "", PASSPHRASE);
    server.byHash.set(record.innerTransactionHash ?? "", {
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      txHash: record.innerTransactionHash ?? "",
      latestLedger: server.ledger,
      latestLedgerCloseTime: 0,
      oldestLedger: 1,
      oldestLedgerCloseTime: 0,
      ledger: server.ledger,
      createdAt: 0,
      applicationOrder: 1,
      feeBump: true,
      envelopeXdr: own.toEnvelope(),
      resultXdr: new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString("123456"),
        result: xdr.TransactionResultResult.txSuccess([]),
        ext: new xdr.TransactionResultExt(0),
      }),
      resultMetaXdr: {} as xdr.TransactionMeta,
      events: { transactionEventsXdr: [], contractEventsXdr: [] },
    });
    server.latestLedgerCloseTime = (record.validUntil ?? 0) + 10;
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({
      state: "succeeded",
      settledBy: "rail402",
      feeChargedStroops: "123456",
      response: { success: true, transaction: record.transactionHash },
    });
  });

  it("succeed as Rail402's own settlement when the consumed nonce leads to the recorded envelope", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    server.ledger = boundsOf(record).maxLedger;
    server.nonceConsumedIn = server.ledger - 1;
    server.transactions = [
      { ...thirdParty(record, 250_000n, server.ledger - 1), txHash: record.transactionHash ?? "" },
    ];
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({
      state: "succeeded",
      settledBy: "rail402",
      response: { success: true, transaction: record.transactionHash },
    });
  });

  it("decide absence from the ledger of the nonce read, not from an earlier transaction lookup", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    const { expiration } = boundsOf(record);
    // The transaction lookup still reports a ledger before the expiration, past the time bound; the
    // nonce read comes from a node already past the expiration, where a consumed entry may be gone.
    server.ledger = expiration;
    server.entriesLedger = expiration + 5_000;
    server.latestLedgerCloseTime = (record.validUntil ?? 0) + 10;
    server.oldestLedgerCloseTime = Math.floor(Date.now() / 1_000);
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });

  it("keep an exact record open until its authorization expires, since another transaction can still carry it", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    const { expiration } = boundsOf(record);
    server.ledger = expiration - 1;
    server.latestLedgerCloseTime = (record.validUntil ?? 0) + 10;
    // An exact record for the same payer and nonce: an unconsumed nonce before E proves nothing yet.
    expect(await engine.confirm(asExact(record, expiration), Date.now() + 20)).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
    });
    expect((await ledger.get(record.id))?.state).toBe("submitted");
    // The upto record itself is finished: only its settlement authority could have settled it.
    expect(await engine.confirm(record, Date.now() + 20)).toMatchObject({
      success: false,
      errorReason: "settle_upto_stellar_transaction_expired",
    });
  });

  it("fail a permanently refused rebroadcast only once the unconsumed nonce proves nothing landed", async () => {
    const { server, ledger, engine, record, hash } = await pendingSettlement();
    server.sendResult = refused("txBadAuth");
    server.ledger = boundsOf(record).expiration;
    server.oldestLedgerCloseTime = Math.floor(Date.now() / 1_000);
    expect(await engine.confirm(record, Date.now() + 40)).toMatchObject({
      success: false,
      errorReason: "settle_upto_stellar_transaction_submission_failed",
      transaction: hash,
    });
    expect((await ledger.get(record.id))?.state).toBe("failed");
  });

  it("succeed on a permanently refused rebroadcast when the authorization settled as recorded", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    server.sendResult = refused("txBadAuth");
    server.nonceConsumedIn = server.ledger;
    server.transactions = [thirdParty(record, 250_000n, server.ledger)];
    expect(await engine.confirm(record, Date.now() + 40)).toMatchObject({
      success: true,
      transaction: "d".repeat(64),
    });
    expect((await ledger.get(record.id))?.state).toBe("succeeded");
  });
});

describe("recorded upto settlements whose rebroadcast is refused for good before their bounds", () => {
  it("keep waiting while a send may have been accepted, then succeed through someone else's fee bump", async () => {
    const { server, ledger, engine, channels, record, hash, scheme, payload, settleRequirements } =
      await pendingSettlement();
    const { maxLedger } = boundsOf(record);
    // The scheme's own send was accepted, so the inner transaction is public. The sponsor can no
    // longer sign (its key was frozen): every rebroadcast is refused, while anyone can still wrap the
    // inner transaction in a fee bump of their own until its bounds pass.
    server.sendResult = refused("txBadAuth");
    expect(server.ledger).toBeLessThan(maxLedger - 1);
    expect(await engine.confirm(record, Date.now() + 40)).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
      transaction: hash,
    });
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
    expect(await channels.inUse()).toBe(1);

    // Someone else's fee bump lands it before the bounds: the payment settled.
    server.ledger += 1;
    const foreign = foreignFeeBump(record, server.ledger, server.ledger);
    server.byHash.set(record.innerTransactionHash ?? "", foreign.found);
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({
      state: "succeeded",
      settledBy: "third_party",
      response: { success: true, transaction: foreign.hash, amount: "250000" },
    });
    expect(await scheme.settle(payload, settleRequirements)).toMatchObject({
      success: true,
      transaction: foreign.hash,
    });
  });

  it("expire once the ledger bound passed and nothing carried the authorization", async () => {
    const { server, ledger, engine, channels, record } = await pendingSettlement();
    const { maxLedger } = boundsOf(record);
    server.sendResult = refused("txBadAuth");
    server.ledger = maxLedger - 2;
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");

    server.ledger = maxLedger;
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({
      state: "expired",
      response: { errorReason: "settle_upto_stellar_transaction_expired", amount: "250000" },
    });
    expect(await channels.inUse()).toBe(0);
  });

  it("keep waiting when a send the look's copy of the settlement predates was accepted", async () => {
    const { server, ledger, engine, record } = await pendingSettlement(250_000n, undefined, (fake) => {
      fake.sendResult = tryAgainLater();
    });
    // Every send so far was answered TRY_AGAIN_LATER: the network holds nothing.
    expect(record).toMatchObject({ broadcastAccepted: false, sendsInFlight: [] });
    server.sendResult = undefined;
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.broadcastAccepted).toBe(true);

    // The next look starts from the copy read before that send, and the send after it is refused.
    server.sendResult = refused("txBadAuth");
    expect(await engine.confirm(record, Date.now() + 40)).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
    });
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });

  it("fail at once when no send of the bytes was ever accepted", async () => {
    const { server, ledger, engine, channels, record, hash } = await pendingSettlement(
      250_000n,
      undefined,
      (fake) => {
        fake.sendResult = tryAgainLater();
      },
    );
    server.sendResult = refused("txBadAuth");
    expect(await engine.confirm(record, Date.now() + 40)).toMatchObject({
      success: false,
      errorReason: "settle_upto_stellar_transaction_submission_failed",
      transaction: hash,
    });
    expect((await ledger.get(record.id))?.state).toBe("failed");
    expect(await channels.inUse()).toBe(0);
  });
});

describe("recorded upto settlements past their bounds, read from an RPC behind the ledger that proved it", () => {
  it("keep waiting while the inner-hash lookup and the nonce read lag, then succeed through the other fee bump", async () => {
    const { server, ledger, engine, channels, record, scheme, payload, settleRequirements } =
      await pendingSettlement();
    const { maxLedger } = boundsOf(record);
    const inner = record.innerTransactionHash ?? "";
    // The own fee bump reads NOT_FOUND at the ledger bound. The recorded inner transaction landed in
    // the ledger before it, inside someone else's fee bump, and the inner-hash lookup and the nonce
    // read come from an RPC that has not ingested that ledger yet (another backend behind a balancer,
    // or another provider after a failover).
    const landedIn = maxLedger - 1;
    server.ledger = maxLedger;
    server.byHash.set(inner, notFound(inner, landedIn - 1));
    server.entriesLedger = landedIn - 1;
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
    expect(await channels.inUse()).toBe(1);

    // Once the reads reach the ledger bound, the other fee bump is found: the payment settled.
    const foreign = foreignFeeBump(record, landedIn, maxLedger + 1);
    server.byHash.set(inner, foreign.found);
    server.entriesLedger = maxLedger + 1;
    server.nonceConsumedIn = landedIn;
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({
      state: "succeeded",
      settledBy: "third_party",
      response: { success: true, transaction: foreign.hash, amount: "250000" },
    });
    expect(await scheme.settle(payload, settleRequirements)).toMatchObject({
      success: true,
      transaction: foreign.hash,
    });
  });

  it("keep a request waiting while the reads lag behind the ledger bound", async () => {
    const { server, ledger, engine, record, hash } = await pendingSettlement();
    const { maxLedger } = boundsOf(record);
    const inner = record.innerTransactionHash ?? "";
    server.ledger = maxLedger;
    server.byHash.set(inner, notFound(inner, maxLedger - 2));
    server.entriesLedger = maxLedger - 2;
    expect(await engine.confirm(record, Date.now() + 40)).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
      transaction: hash,
    });
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });

  it("keep waiting while the reads lag behind the ledger that passed the time bound, and expire once they catch up", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    const { maxLedger } = boundsOf(record);
    const inner = record.innerTransactionHash ?? "";
    // The time bound passed at a ledger before the ledger bound; the reads come from two ledgers back.
    server.ledger = maxLedger - 1;
    server.latestLedgerCloseTime = (record.validUntil ?? 0) + 1;
    server.byHash.set(inner, notFound(inner, maxLedger - 3));
    server.entriesLedger = maxLedger - 3;
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");

    // Reads at that ledger find nothing: no transaction carried the authorization, so it expired.
    server.byHash.delete(inner);
    server.entriesLedger = undefined;
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({
      state: "expired",
      response: { errorReason: "settle_upto_stellar_transaction_expired" },
    });
  });

  it("keep waiting when only the payer's nonce is read from an RPC behind the ledger bound", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    const { maxLedger } = boundsOf(record);
    server.ledger = maxLedger;
    server.nonceEntriesLedger = maxLedger - 2;
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });

  it("keep waiting when only the inner-hash lookup lags, and the nonce is read past the authorization's expiration", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    const { maxLedger } = boundsOf(record);
    const inner = record.innerTransactionHash ?? "";
    // Past the expiration a consumed nonce entry may be gone: only the lookups can prove absence.
    server.ledger = maxLedger + 10;
    server.byHash.set(inner, notFound(inner, maxLedger - 2));
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });

  it("stay unresolved when the inner-hash lookup comes from an RPC that no longer retains the claim's ledgers", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    const { maxLedger } = boundsOf(record);
    const inner = record.innerTransactionHash ?? "";
    server.ledger = maxLedger + 10;
    server.byHash.set(inner, notFound(inner, maxLedger + 10, Math.floor(Date.now() / 1_000)));
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });

  it("keep an exact record open past its authorization's expiration while the inner-hash lookup lags", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    const { maxLedger, expiration } = boundsOf(record);
    const inner = record.innerTransactionHash ?? "";
    server.ledger = maxLedger + 10;
    server.latestLedgerCloseTime = (record.validUntil ?? 0) + 10;
    server.byHash.set(inner, notFound(inner, expiration - 1));
    expect(await engine.confirm(asExact(record, expiration), Date.now() + 20)).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
    });
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });

  it("keep a permanently refused rebroadcast open while the nonce is read from an RPC behind the transaction lookup", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    server.sendResult = refused("txBadAuth");
    server.ledger = boundsOf(record).expiration;
    server.nonceEntriesLedger = server.ledger - 2;
    expect(await engine.confirm(record, Date.now() + 40)).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
    });
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });

  it("keep waiting when the nonce read's answer carries no latest ledger", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    const { maxLedger } = boundsOf(record);
    server.ledger = maxLedger - 1;
    server.latestLedgerCloseTime = (record.validUntil ?? 0) + 1;
    const fake = server as unknown as {
      getLedgerEntries: (...keys: xdr.LedgerKey[]) => Promise<{ entries: unknown[]; latestLedger?: number }>;
    };
    const read = fake.getLedgerEntries.bind(server);
    fake.getLedgerEntries = async (...keys) => ({ ...(await read(...keys)), latestLedger: undefined });
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });
});

describe("recorded settlements whose own transaction failed, searched from an RPC behind its ledger", () => {
  it("keep a failure on the consumed nonce open while the nonce read lags, then succeed through the other transaction", async () => {
    const { server, ledger, engine, channels, record, scheme, payload, settleRequirements } =
      await pendingSettlement();
    // Rail402's transaction failed in this ledger on the nonce another transaction consumed in the
    // ledger before; the nonce is read from an RPC that has not ingested that ledger yet.
    failedWith(server, [nonceUsed()]);
    server.nonceEntriesLedger = server.ledger - 2;
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
    expect(await channels.inUse()).toBe(1);

    // The next pass reads the failure again and searches with reads that have caught up.
    server.nonceEntriesLedger = undefined;
    server.nonceConsumedIn = server.ledger - 1;
    server.transactions = [thirdParty(record, 250_000n, server.ledger - 1)];
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({
      state: "succeeded",
      settledBy: "third_party",
      response: { success: true, transaction: "d".repeat(64), amount: "250000" },
    });
    expect(repeatOf(await scheme.settle(payload, settleRequirements))).toEqual({
      repeat: true,
      settledBy: "third_party",
    });
  });

  it("keep a failure without diagnostics open while the nonce read lags", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    failedWith(server, []);
    server.nonceEntriesLedger = server.ledger - 2;
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");

    server.nonceEntriesLedger = undefined;
    server.nonceConsumedIn = server.ledger - 1;
    server.transactions = [thirdParty(record, 250_000n, server.ledger - 1)];
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({ state: "succeeded", settledBy: "third_party" });
  });

  it("keep an exact failure on the consumed nonce open while the nonce read lags, then succeed through the copy", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    const exact = asExact(record, boundsOf(record).expiration);
    // Someone copied the payer's entry into a transaction of their own, which landed first.
    failedWith(server, [nonceUsed()]);
    server.nonceEntriesLedger = server.ledger - 2;
    expect(await engine.confirm(exact, Date.now() + 20)).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
    });
    expect((await ledger.get(record.id))?.state).toBe("submitted");

    server.nonceEntriesLedger = undefined;
    server.nonceConsumedIn = server.ledger - 1;
    server.transactions = [thirdParty(exact, 250_000n, server.ledger - 1)];
    expect(await engine.confirm(exact, Date.now() + 20)).toMatchObject({
      success: true,
      transaction: "d".repeat(64),
    });
    expect(await ledger.get(record.id)).toMatchObject({ state: "succeeded", settledBy: "third_party" });
  });

  it("keep a failure open while the consuming ledger is scanned on an RPC that has not ingested it", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    failedWith(server, [nonceUsed()]);
    server.nonceConsumedIn = server.ledger - 1;
    server.transactionsLedger = server.ledger - 2;
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });

  it("keep a failure open while the search for the other transaction cannot be read", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    failedWith(server, [nonceUsed()]);
    server.nonceConsumedIn = server.ledger - 1;
    const fake = server as unknown as { getTransactions: () => Promise<unknown> };
    fake.getTransactions = () => Promise.reject(new Error("socket hang up"));
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });

  it("keep waiting past the bounds when someone else's fee bump of it failed and the nonce read lags", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    const { maxLedger } = boundsOf(record);
    const foreign = foreignFeeBump(record, maxLedger - 1, maxLedger);
    server.ledger = maxLedger;
    server.byHash.set(
      record.innerTransactionHash ?? "",
      failedIn(foreign.envelope, maxLedger - 1, maxLedger, [nonceUsed()]),
    );
    server.nonceEntriesLedger = maxLedger - 3;
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });

  it("keep a failure open while the consuming ledger is older than the history of the RPC that scans it", async () => {
    const { server, ledger, engine, record, scheme, payload, settleRequirements } = await pendingSettlement();
    failedWith(server, [nonceUsed()]);
    const consumedIn = server.ledger - 1;
    server.nonceConsumedIn = consumedIn;
    server.transactions = [thirdParty(record, 250_000n, consumedIn)];
    // The scan is answered by a backend that started at the current ledger: healthy, at the tip, and
    // refusing a start ledger before its own history, as a real RPC does.
    const fake = server as unknown as {
      getTransactions: (request: unknown) => Promise<unknown>;
      getHealth: () => Promise<unknown>;
    };
    const scan = fake.getTransactions.bind(server);
    const health = fake.getHealth.bind(server);
    fake.getTransactions = () =>
      Promise.reject(
        new Error(
          `start ledger (${String(consumedIn)}) must be between the oldest ledger: ${String(server.ledger)} and the latest ledger: ${String(server.ledger)}`,
        ),
      );
    fake.getHealth = async () => ({ ...((await health()) as object), oldestLedger: server.ledger });
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");

    // A backend with the whole history finds the transaction that settled the payment.
    fake.getTransactions = scan;
    fake.getHealth = health;
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({ state: "succeeded", settledBy: "third_party" });
    expect(repeatOf(await scheme.settle(payload, settleRequirements))).toEqual({
      repeat: true,
      settledBy: "third_party",
    });
  });

  it("leave a used-nonce failure unresolved when its nonce reads unused at the ledger it failed in", async () => {
    const counts: number[] = [];
    const { server, ledger, engine, record } = await pendingSettlement(250_000n, {
      ...silentObserver,
      unresolvable: (_network, count) => counts.push(count),
    });
    // The failure proves the nonce was consumed by this ledger; a current read showing it unused can
    // only mean its entry lapsed, and the transaction that consumed it can no longer be found from it.
    failedWith(server, [nonceUsed()]);
    server.transactions = [thirdParty(record, 250_000n, server.ledger - 1)];
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
    expect(counts).toEqual([1]);
  });
});

describe("recorded exact settlements included after the payer's authorization expired", () => {
  /**
   * An `exact` record whose transaction, its time bound outlasting the authorization, was included two
   * ledgers after the expiration ledger and failed there on the expired authorization.
   */
  async function failedAfterExpiration() {
    const settlement = await pendingSettlement();
    const { expiration } = boundsOf(settlement.record);
    const exact = asExact(settlement.record, expiration);
    settlement.server.ledger = expiration + 2;
    failedWith(settlement.server, [signatureExpired()]);
    return { ...settlement, exact, expiration };
  }

  it("succeed through a copy of the authorization that landed before the expiration", async () => {
    const { server, ledger, engine, record, exact, expiration } = await failedAfterExpiration();
    // Someone copied the payer's entry into a transaction of their own, which landed at the expiration
    // ledger. The host checks the expiration before the nonce, so Rail402's transaction reports the
    // expiry, not the consumed nonce.
    server.nonceConsumedIn = expiration;
    server.transactions = [thirdParty(exact, 250_000n, expiration)];
    expect(await engine.confirm(exact, Date.now() + 20)).toMatchObject({
      success: true,
      transaction: "d".repeat(64),
    });
    expect(await ledger.get(record.id)).toMatchObject({ state: "succeeded", settledBy: "third_party" });
  });

  it("keep the failure open while the nonce read lags behind the ledger it failed in, then succeed", async () => {
    const { server, ledger, engine, record, exact, expiration } = await failedAfterExpiration();
    server.nonceConsumedIn = undefined;
    server.nonceEntriesLedger = expiration;
    expect(await engine.confirm(exact, Date.now() + 20)).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
    });
    expect((await ledger.get(record.id))?.state).toBe("submitted");

    server.nonceEntriesLedger = undefined;
    server.nonceConsumedIn = expiration;
    server.transactions = [thirdParty(exact, 250_000n, expiration)];
    expect(await engine.confirm(exact, Date.now() + 20)).toMatchObject({
      success: true,
      transaction: "d".repeat(64),
    });
    expect(await ledger.get(record.id)).toMatchObject({ state: "succeeded", settledBy: "third_party" });
  });

  it("keep the failure when nothing consumed the nonce", async () => {
    const { ledger, engine, record, exact } = await failedAfterExpiration();
    expect(await engine.confirm(exact, Date.now() + 20)).toMatchObject({
      success: false,
      errorReason: "invalid_exact_stellar_signature_expired",
    });
    expect(await ledger.get(record.id)).toMatchObject({
      state: "failed",
      response: { errorReason: "invalid_exact_stellar_signature_expired" },
    });
  });
});

describe("recorded settlements undecided on their reads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A clock for `Date.now` that only moves when told to. */
  function clock() {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    return {
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  function counting() {
    const counts: number[] = [];
    const observer: SettlementObserver = {
      ...silentObserver,
      unresolvable: (_network, count) => counts.push(count),
    };
    return { counts, observer };
  }

  it("report a settlement whose search stays behind for a minute as unresolvable", async () => {
    const { counts, observer } = counting();
    const { server, ledger, engine, record } = await pendingSettlement(250_000n, observer);
    failedWith(server, [nonceUsed()]);
    server.nonceEntriesLedger = server.ledger - 2;
    const time = clock();
    for (let pass = 0; pass < 7; pass++) {
      await engine.reconcile();
      time.advance(10_000);
    }
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect((await ledger.get(record.id))?.state).toBe("submitted");

    // It still finishes on the first pass whose reads decide it.
    server.nonceEntriesLedger = undefined;
    server.nonceConsumedIn = server.ledger - 1;
    server.transactions = [thirdParty(record, 250_000n, server.ledger - 1)];
    expect(await engine.reconcile()).toBe(1);
    expect(counts.at(-1)).toBe(0);
    expect(await ledger.get(record.id)).toMatchObject({ state: "succeeded", settledBy: "third_party" });
  });

  it("never report a lag shorter than a minute", async () => {
    const { counts, observer } = counting();
    const { server, ledger, engine, record } = await pendingSettlement(250_000n, observer);
    failedWith(server, [nonceUsed()]);
    server.nonceEntriesLedger = server.ledger - 2;
    const time = clock();
    for (let pass = 0; pass < 3; pass++) {
      await engine.reconcile();
      time.advance(20_000);
    }
    server.nonceEntriesLedger = undefined;
    server.nonceConsumedIn = server.ledger - 1;
    server.transactions = [thirdParty(record, 250_000n, server.ledger - 1)];
    await engine.reconcile();
    expect(counts).toEqual([0, 0, 0, 0]);
    expect((await ledger.get(record.id))?.state).toBe("succeeded");
  });

  it("report no failed settlement on one lagging pass past the authorization's expiration", async () => {
    const { counts, observer } = counting();
    const { server, ledger, engine, record } = await pendingSettlement(250_000n, observer);
    const { expiration } = boundsOf(record);
    // Rail402's transaction failed before the expiration on a nonce consumed in the ledger before;
    // the reconciler first reads it after the expiration (the consumed nonce is still readable then).
    const failedLedger = expiration - 1;
    const own = new FeeBumpTransaction(record.envelopeXdr ?? "", PASSPHRASE);
    server.ledger = expiration + 1;
    server.byHash.set(
      record.transactionHash ?? "",
      failedIn(own, failedLedger, expiration + 1, [nonceUsed()]),
    );
    server.nonceEntriesLedger = failedLedger - 1;
    await engine.reconcile();
    server.nonceEntriesLedger = undefined;
    server.nonceConsumedIn = failedLedger - 1;
    server.transactions = [thirdParty(record, 250_000n, failedLedger - 1)];
    await engine.reconcile();
    expect(counts).toEqual([0, 0]);
    expect((await ledger.get(record.id))?.state).toBe("succeeded");
  });

  it("report a settlement undecided for a minute even when the passes in between cannot look it up", async () => {
    const { counts, observer } = counting();
    const { server, ledger, engine, record } = await pendingSettlement(250_000n, observer);
    failedWith(server, [nonceUsed()]);
    server.nonceEntriesLedger = server.ledger - 2;
    const fake = server as unknown as { getTransaction: (hash: string) => Promise<unknown> };
    const lookup = fake.getTransaction.bind(server);
    let pass = 0;
    fake.getTransaction = (hash) =>
      pass % 2 === 1 ? Promise.reject(new Error("502 Bad Gateway")) : lookup(hash);
    const time = clock();
    for (pass = 0; pass < 14; pass++) {
      await engine.reconcile();
      time.advance(10_000);
    }
    expect(Math.max(...counts)).toBe(1);
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });
});

/** The sequence number of a recorded settlement's channel transaction. */
function sequenceOf(record: SettlementRecord): string {
  return new FeeBumpTransaction(record.envelopeXdr ?? "", PASSPHRASE).innerTransaction.sequence;
}

describe("recorded settlements whose channel sequence number another transaction took", () => {
  it("finish an upto settlement at once and quarantine the channel, since only the authority could settle it", async () => {
    const { server, ledger, engine, record, channels, hash } = await pendingSettlement();
    server.sendResult = refused("txBadSeq");
    server.accountSequence = sequenceOf(record);
    const started = Date.now();
    expect(await engine.confirm(record, Date.now() + 10_000)).toMatchObject({
      success: false,
      errorReason: "settle_upto_stellar_transaction_submission_failed",
      transaction: hash,
      amount: "250000",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await ledger.get(record.id)).toMatchObject({ state: "failed", feeChargedStroops: "0" });
    expect(await channels.inUse()).toBe(0);
    expect(await channels.acquire(0)).toBeUndefined();
  });

  it("keep an upto settlement open while the payer's nonce is read from an RPC behind the sequence proof", async () => {
    const conflicts: SequenceConflictEvent[] = [];
    const { server, ledger, engine, record, channels } = await pendingSettlement(250_000n, {
      ...silentObserver,
      sequenceConflict: (_network, event) => conflicts.push(event),
    });
    server.sendResult = refused("txBadSeq");
    server.accountSequence = sequenceOf(record);
    server.nonceEntriesLedger = server.ledger - 3;
    expect(await engine.confirm(record, Date.now() + 40)).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
    });
    // Its bytes can never apply: only its outcome waits, and the channel is given back.
    expect(await ledger.get(record.id)).toMatchObject({ state: "submitted", channelReleased: true });
    expect(await channels.inUse()).toBe(0);
    expect(conflicts).toEqual([{ outcome: "declined", reason: "rpc_behind" }]);
  });

  it("keep an exact settlement open whose broadcast bytes may still carry the authorization elsewhere", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    const { expiration } = boundsOf(record);
    server.sendResult = refused("txBadSeq");
    server.accountSequence = sequenceOf(record);
    server.ledger = expiration - 1;
    expect(await engine.confirm(asExact(record, expiration), Date.now() + 40)).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
    });
    expect((await ledger.get(record.id))?.state).toBe("submitted");
  });

  it("succeed when the payer's authorization landed in another transaction as recorded", async () => {
    const { server, ledger, engine, record } = await pendingSettlement();
    server.sendResult = refused("txBadSeq");
    server.accountSequence = sequenceOf(record);
    server.nonceConsumedIn = server.ledger;
    server.transactions = [thirdParty(record, 250_000n, server.ledger)];
    expect(await engine.confirm(record, Date.now() + 40)).toMatchObject({
      success: true,
      transaction: "d".repeat(64),
    });
    expect((await ledger.get(record.id))?.state).toBe("succeeded");
  });

  it("finish an upto settlement refused at its first broadcast without waiting for confirmation", async () => {
    const server = new FakeServer();
    server.status = "NOT_FOUND";
    // FakeServer accounts are at sequence 100: the settlement transaction uses 101, which is taken.
    server.accountSequence = "101";
    server.sendResult = refused("txBadSeq");
    const ledger = new MemorySettlementLedger();
    const channels = new MemoryChannelPool([channel.publicKey()]);
    const engine = new SettlementEngine({
      network: NETWORK,
      passphrase: PASSPHRASE,
      rpcUrl: "http://127.0.0.1:1/rpc",
      server: server.asServer(),
      policy,
      ledger,
      channels,
      channelKeys: new Map([[channel.publicKey(), channel]]),
      sponsor,
      authority,
      timing: { pollIntervalMs: 5, confirmTimeoutMs: 5_000, duplicateWaitMs: 50, channelQuarantineMs: 100 },
    });
    const scheme = new StellarUptoScheme({
      network: NETWORK,
      passphrase: PASSPHRASE,
      server: server.asServer(),
      policy,
      upto: uptoPolicy,
      engine,
    });
    const payload = payment();
    const settleRequirements = requirements({ amount: "250000" });
    const started = Date.now();
    const result = await scheme.settle(payload, settleRequirements);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({
      success: false,
      errorReason: "settle_upto_stellar_transaction_submission_failed",
      amount: "250000",
    });
    expect(result.errorMessage).toMatch(/txBadSeq/);
    // The mechanism's own broadcast and the engine's one resend, nothing more.
    expect(server.sent).toHaveLength(2);
    const [record] = await ledger.unfinished(NETWORK);
    expect(record).toBeUndefined();
    expect(await channels.acquire(500)).toBe(channel.publicKey());
    // A repeat is answered from the record and sends nothing.
    expect((await scheme.settle(payload, settleRequirements)).errorReason).toBe(
      "settle_upto_stellar_transaction_submission_failed",
    );
    expect(server.sent).toHaveLength(2);
  });
});

describe("explaining a failed upto transaction", () => {
  it("needs the recorded settlement to attribute errors", async () => {
    const { record } = await pendingSettlement();
    const failed = {
      status: rpc.Api.GetTransactionStatus.FAILED,
      ledger: 77,
      diagnosticEventsXdr: [contractError(CONTRACT, 5)],
    } as unknown as rpc.Api.GetFailedTransactionResponse;
    const context = { passphrase: PASSPHRASE, facilitatorAddresses: new Set<string>() };
    expect(explainFailedUptoTransaction(failed, record, context).code).toBe(
      "invalid_upto_stellar_signature_expired",
    );
    const { envelopeXdr: _, ...withoutEnvelope } = record;
    expect(explainFailedUptoTransaction(failed, withoutEnvelope as SettlementRecord, context)).toMatchObject({
      code: "settle_upto_stellar_transaction_failed",
    });
  });
});

/** `Error(Contract, #code)` raised by `contract`. */
function contractError(contract: string, code: number): xdr.DiagnosticEvent {
  return errorEvent(xdr.ScError.sceContract(code), "contract error", contract);
}
