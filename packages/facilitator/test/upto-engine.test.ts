/**
 * How the settlement engine finishes a recorded `upto` settlement: confirmation, expiry, on-chain
 * failures named by the settlement's own classifier, and a payment another transaction landed first.
 */
import { describe, expect, it } from "vitest";
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

/** A settlement whose envelope was broadcast and not confirmed within the request. */
async function pendingSettlement(amount = 250_000n) {
  const server = new FakeServer();
  server.status = "NOT_FOUND";
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
function refused(code: "txTooLate" | "txBadAuth"): rpc.Api.SendTransactionResponse {
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
          : xdr.TransactionResultResult.txBadAuth(),
      ext: new xdr.TransactionResultExt(0),
    }),
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
    const inner = new FeeBumpTransaction(record.envelopeXdr ?? "", PASSPHRASE).innerTransaction;
    const outsider = Keypair.random();
    const foreign = TransactionBuilder.buildFeeBumpTransaction(outsider, "10000000", inner, PASSPHRASE);
    foreign.sign(outsider);
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
      envelopeXdr: foreign.toEnvelope(),
      resultXdr: {} as xdr.TransactionResult,
      resultMetaXdr: {} as xdr.TransactionMeta,
      events: { transactionEventsXdr: [], contractEventsXdr: [] },
    });
    server.latestLedgerCloseTime = (record.validUntil ?? 0) + 10;
    expect(await engine.reconcile()).toBe(1);
    const finished = await ledger.get(record.id);
    expect(finished).toMatchObject({
      state: "succeeded",
      settledBy: "third_party",
      response: { success: true, transaction: foreign.hash().toString("hex"), amount: "250000" },
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
