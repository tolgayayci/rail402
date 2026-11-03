/**
 * What a settlement holds when its transaction can never land or never gets signed: a first
 * submission the network refuses for good frees its channel and fee budget once nothing can carry the
 * payer's authorization any more (an `exact` one once it expired unused), a settlement whose channel
 * sequence number another transaction took gives its channel back at once, and a settlement that has
 * signed nothing by the end of its claim window stops there, so a hung RPC can never let two
 * settlements share a channel.
 */
import { describe, expect, it } from "vitest";
import {
  Account,
  Address,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  type rpc,
  nativeToScVal,
  xdr,
  type FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import {
  FIRST_SEND,
  repeatOf,
  silentLogger,
  silentObserver,
  type Logger,
  type SequenceConflictEvent,
  MemoryChannelPool,
  MemorySettlementLedger,
  SettlementEngine,
  type SettlementExecution,
  type SettlementIntent,
  type SubmissionContext,
} from "@rail402.dev/facilitator";
import {
  FakeServer,
  LEDGER,
  NETWORK,
  PASSPHRASE,
  TOKEN,
  channel,
  contractEvent,
  errorEvent,
  policy,
  sponsor,
} from "./upto-helpers.ts";

const SUBMISSION_FAILED = "settle_exact_stellar_transaction_submission_failed";

function setup(
  timing: {
    claimTtlMs?: number;
    channelQuarantineMs?: number;
    confirmTimeoutMs?: number;
    reconcileIdleMs?: number;
    /** False: a settlement ledger without `releaseChannel`. */
    channelRelease?: boolean;
    /** The payer's address; a random G… account by default. */
    payer?: string;
    /** Whether the token is known as a Stellar Asset Contract, whose errors are named. */
    sac?: boolean;
  } = {},
) {
  const conflicts: SequenceConflictEvent[] = [];
  const warnings: string[] = [];
  const log: Logger = {
    ...silentLogger,
    warn: (_fields: unknown, message?: string) => {
      warnings.push(message ?? "");
    },
  };
  const server = new FakeServer();
  server.status = "NOT_FOUND";
  const ledger = new MemorySettlementLedger();
  if (timing.channelRelease === false) Object.assign(ledger, { releaseChannel: undefined });
  const channels = new MemoryChannelPool([channel.publicKey()]);
  const { channelRelease: _, payer: payerOption, sac, ...settlementTiming } = timing;
  const engine = new SettlementEngine({
    network: NETWORK,
    passphrase: PASSPHRASE,
    rpcUrl: "http://127.0.0.1:1/rpc",
    server: server.asServer(),
    policy:
      sac === true
        ? {
            ...policy,
            assets: new Map(
              [...policy.assets].map(([contract, asset]) => [contract, { ...asset, kind: "sac" as const }]),
            ),
          }
        : policy,
    ledger,
    channels,
    channelKeys: new Map([[channel.publicKey(), channel]]),
    sponsor,
    timing: { pollIntervalMs: 5, confirmTimeoutMs: 60, duplicateWaitMs: 50, ...settlementTiming },
    observer: { ...silentObserver, sequenceConflict: (_network, event) => conflicts.push(event) },
    log,
  });
  const payer = payerOption ?? Keypair.random().publicKey();
  const intent: SettlementIntent = {
    scheme: "exact",
    key: engine.keyOf(payer, 7n),
    fingerprint: { payloadHash: "a".repeat(64), requestHash: "b".repeat(64) },
    payer,
    payTo: Keypair.random().publicKey(),
  };
  return { server, ledger, channels, engine, intent, payer, conflicts, warnings };
}

/** Signs a fee bump of a channel transaction through the engine's recording sponsor. */
async function signThroughSponsor(context: SubmissionContext, payer?: string) {
  const builder = new TransactionBuilder(new Account(context.channel, "1"), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
  });
  if (payer === undefined) {
    builder.addOperation(Operation.bumpSequence({ bumpTo: "9" }));
  } else {
    // A transfer carrying the payer's authorization (nonce 7, as the intent's key), valid well past
    // the fake RPC's ledger: the authorization another transaction could carry if the bytes are public.
    const args = [
      new Address(payer).toScVal(),
      new Address(Keypair.random().publicKey()).toScVal(),
      nativeToScVal(250_000n, { type: "i128" }),
    ];
    const auth = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(payer).toScAddress(),
          nonce: xdr.Int64.fromString("7"),
          signatureExpirationLedger: LEDGER + 1_000,
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
    builder.addOperation(
      Operation.invokeContractFunction({ contract: TOKEN, function: "transfer", args, auth: [auth] }),
    );
  }
  const inner = builder.setTimeout(60).build();
  inner.sign(channel);
  const bump = TransactionBuilder.buildFeeBumpTransaction(sponsor.publicKey(), "200", inner, PASSPHRASE);
  return context.feeBumpSigner.signTransaction(bump.toXDR(), { networkPassphrase: PASSPHRASE });
}

/** A scheme that signs, is refused at its own first broadcast, and reports it as upstream does. */
function refusedAtFirstSend(payer: string, sent: () => void): SettlementExecution {
  return {
    async submit(context) {
      const signed = await signThroughSponsor(context, payer);
      expect(signed.error).toBeUndefined();
      sent();
      return {
        success: false,
        transaction: "",
        network: NETWORK,
        errorReason: SUBMISSION_FAILED,
        payer,
      };
    },
    unsigned: (result) => Promise.resolve(result),
  };
}

function refused(code: "txBadAuth" | "txInsufficientFee" | "txBadSeq"): rpc.Api.SendTransactionResponse {
  return {
    status: "ERROR",
    hash: "0".repeat(64),
    latestLedger: 0,
    latestLedgerCloseTime: 0,
    errorResult: new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString("0"),
      result:
        code === "txBadAuth"
          ? xdr.TransactionResultResult.txBadAuth()
          : code === "txBadSeq"
            ? xdr.TransactionResultResult.txBadSeq()
            : xdr.TransactionResultResult.txInsufficientFee(),
      ext: new xdr.TransactionResultExt(0),
    }),
  };
}

describe("a first submission the network refuses for good", () => {
  it("finishes as a submission failure once the authorization expired unused, freeing the channel and fee budget", async () => {
    const { server, ledger, channels, engine, intent, payer } = setup({ reconcileIdleMs: 0 });
    server.sendResult = refused("txBadAuth");
    let firstSends = 0;
    // Anyone who holds the payment can still carry its authorization: the settlement waits.
    expect(
      await engine.execute(
        intent,
        refusedAtFirstSend(payer, () => firstSends++),
      ),
    ).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(firstSends).toBe(1);
    expect((await ledger.find(intent.key))?.state).toBe("submitted");

    server.ledger = EXPIRATION + 1;
    expect(await engine.reconcile()).toBe(1);
    const record = await ledger.find(intent.key);
    expect(record).toMatchObject({ state: "failed", feeChargedStroops: "0" });
    expect(record?.response).toMatchObject({ success: false, errorReason: SUBMISSION_FAILED });
    expect(record?.response?.transaction).toBe(record?.transactionHash);
    expect(record?.response?.errorMessage).toMatch(/txBadAuth/);
    expect(await channels.acquire(0)).toBe(channel.publicKey());
    expect(await ledger.committedFeesSince(NETWORK, new Date(Date.now() - 60_000))).toBe(0n);
    // A repeat is answered from the record.
    expect(await engine.answerRepeat("exact", intent.key, intent.fingerprint)).toMatchObject({
      errorReason: SUBMISSION_FAILED,
    });
  });

  it("stays open when the resend is refused for a reason that can pass", async () => {
    const { server, ledger, channels, engine, intent, payer } = setup();
    server.sendResult = refused("txInsufficientFee");
    const result = await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect((await ledger.find(intent.key))?.state).toBe("submitted");
    expect(await channels.acquire(0)).toBeUndefined();
  });

  it("stays open when the transaction is already known to the network", async () => {
    const { server, ledger, engine, intent, payer } = setup();
    server.status = "SUCCESS";
    server.sendResult = refused("txBadAuth");
    const result = await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    expect(result).toMatchObject({ success: true });
    expect(server.sent).toHaveLength(0);
    expect((await ledger.find(intent.key))?.state).toBe("succeeded");
  });
});

/**
 * The recovery drill: something else submits from the leased channel account, so the settlement's
 * first broadcast is refused with txBadSeq. The channel transaction signed above uses sequence 2
 * (`new Account(channel, "1")`); the RPC's account read decides whether that number was taken.
 */
describe("a first submission refused because another transaction took the channel's sequence", () => {
  it("quarantines the channel at once instead of holding it, and finishes with nothing charged once the authorization expired", async () => {
    const { server, ledger, channels, engine, intent, payer } = setup({
      channelQuarantineMs: 150,
      reconcileIdleMs: 0,
    });
    server.sendResult = refused("txBadSeq");
    server.accountSequence = "5";
    const started = Date.now();
    const result = await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    // Seconds at most, not the transaction's time bound or the authorization's expiry.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(await ledger.find(intent.key)).toMatchObject({ state: "submitted", channelReleased: true });
    // The engine resent the recorded bytes once to read the refusal; nothing else was ever sent.
    expect(server.sent).toHaveLength(1);
    // The channel is not leased, but stays out of rotation for its cooldown.
    expect(await channels.inUse()).toBe(0);
    expect(await channels.acquire(0)).toBeUndefined();
    const next = await channels.acquire(2_000);
    expect(next).toBe(channel.publicKey());
    await channels.release(next ?? "");

    server.ledger = EXPIRATION + 1;
    expect(await engine.reconcile()).toBe(1);
    const record = await ledger.find(intent.key);
    expect(record).toMatchObject({ state: "failed", feeChargedStroops: "0" });
    expect(record?.response?.errorMessage).toMatch(/txBadSeq.*no funds moved/);
    expect(await ledger.committedFeesSince(NETWORK, new Date(Date.now() - 60_000))).toBe(0n);
    // The same payment again is answered from the record: it can never settle twice.
    expect(await engine.answerRepeat("exact", intent.key, intent.fingerprint)).toMatchObject({
      errorReason: SUBMISSION_FAILED,
    });
    expect(server.sent).toHaveLength(1);
  });

  it("stays open while the channel's sequence number has not reached the transaction's", async () => {
    // A sequence number above the account's next one is refused too, but can still become valid.
    const { server, ledger, channels, engine, intent, payer } = setup();
    server.sendResult = refused("txBadSeq");
    server.accountSequence = "0";
    const result = await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect((await ledger.find(intent.key))?.state).toBe("submitted");
    expect(await channels.acquire(0)).toBeUndefined();
  });

  it("stays open when the RPC that looked the transaction up is behind the account read", async () => {
    const { server, ledger, engine, intent, payer } = setup();
    server.sendResult = refused("txBadSeq");
    server.accountSequence = "5";
    server.entriesLedger = server.ledger + 3;
    const result = await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect((await ledger.find(intent.key))?.state).toBe("submitted");
  });

  it("stays open when the RPC no longer retains the ledgers since the claim", async () => {
    const { server, ledger, engine, intent, payer } = setup();
    server.sendResult = refused("txBadSeq");
    server.accountSequence = "5";
    server.oldestLedgerCloseTime = Math.floor(Date.now() / 1_000);
    const result = await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect((await ledger.find(intent.key))?.state).toBe("submitted");
  });

  it("never finishes as failed when the transaction landed inside another fee bump", async () => {
    const { server, ledger, engine, intent, payer } = setup();
    server.sendResult = refused("txBadSeq");
    server.accountSequence = "5";
    const execution: SettlementExecution = {
      async submit(context) {
        const signed = await signThroughSponsor(context);
        const bump = TransactionBuilder.fromXDR(signed.signedTxXdr, PASSPHRASE) as FeeBumpTransaction;
        // Someone wrapped the very same channel transaction in a fee bump of their own and it landed.
        server.byHash.set(bump.innerTransaction.hash().toString("hex"), {
          status: "SUCCESS",
          ledger: server.ledger,
          latestLedger: server.ledger,
          latestLedgerCloseTime: 0,
          oldestLedger: 1,
          oldestLedgerCloseTime: 0,
        } as unknown as rpc.Api.GetTransactionResponse);
        return { success: false, transaction: "", network: NETWORK, errorReason: SUBMISSION_FAILED, payer };
      },
      unsigned: (result) => Promise.resolve(result),
    };
    const result = await engine.execute(intent, execution);
    expect(result.errorReason).not.toBe(SUBMISSION_FAILED);
    expect((await ledger.find(intent.key))?.state).not.toBe("failed");
  });
});

/** A `sendTransaction` answer with only a status: TRY_AGAIN_LATER or DUPLICATE. */
function answered(status: "TRY_AGAIN_LATER" | "DUPLICATE"): rpc.Api.SendTransactionResponse {
  return { status, hash: "0".repeat(64), latestLedger: 0, latestLedgerCloseTime: 0 };
}

/**
 * Makes the fake RPC answer the engine's sends in order (a thrown error is a lost answer); the last
 * answer repeats.
 */
function sendsAnswer(server: FakeServer, answers: (rpc.Api.SendTransactionResponse | Error)[]): void {
  const replace = server as unknown as {
    sendTransaction: (transaction: FeeBumpTransaction) => Promise<rpc.Api.SendTransactionResponse>;
  };
  replace.sendTransaction = (transaction) => {
    server.sent.push(transaction);
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    return answer instanceof Error || answer === undefined
      ? Promise.reject(answer ?? new Error("no answer"))
      : Promise.resolve(answer);
  };
}

/** A scheme whose own send is lost: it signed and recorded, then its sendTransaction threw. */
function lostAtFirstSend(payer: string): SettlementExecution {
  return {
    async submit(context) {
      const signed = await signThroughSponsor(context, payer);
      expect(signed.error).toBeUndefined();
      return {
        success: false,
        transaction: "",
        network: NETWORK,
        errorReason: "unexpected_settle_error",
        payer,
      };
    },
    unsigned: (result) => Promise.resolve(result),
  };
}

/**
 * The live drill: the channel's queue slot is held by another transaction, so the first send and the
 * engine's resend answer TRY_AGAIN_LATER (no txBadSeq yet); once that transaction applies, the next
 * rebroadcast answers txBadSeq. Whether the payer's authorization may be public is decided from the
 * recorded answers of every send, on any replica.
 */
describe("a sequence conflict first answered TRY_AGAIN_LATER", () => {
  it("quarantines the channel at the first txBadSeq when no send was ever accepted", async () => {
    const { server, ledger, channels, engine, intent, payer } = setup({ channelQuarantineMs: 150 });
    server.accountSequence = "5";
    sendsAnswer(server, [answered("TRY_AGAIN_LATER"), answered("TRY_AGAIN_LATER"), refused("txBadSeq")]);
    const started = Date.now();
    const result = await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    // The payer's authorization stays valid, so the payment's outcome waits; the channel does not.
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(await ledger.find(intent.key)).toMatchObject({
      state: "submitted",
      broadcastAccepted: false,
      sendsInFlight: [],
      channelReleased: true,
    });
    expect(await channels.inUse()).toBe(0);
    expect(await channels.acquire(0)).toBeUndefined();
  });

  it("sends nothing more once it gave its channel back, while the same request still waits", async () => {
    const { server, engine, intent, payer } = setup({ confirmTimeoutMs: 200 });
    server.accountSequence = "5";
    sendsAnswer(server, [answered("TRY_AGAIN_LATER"), answered("TRY_AGAIN_LATER"), refused("txBadSeq")]);
    expect(
      await engine.execute(
        intent,
        refusedAtFirstSend(payer, () => undefined),
      ),
    ).toMatchObject({ errorReason: "settlement_pending" });
    // The engine's resend and one rebroadcast were deferred, the next met the conflict; the bytes can
    // never apply after it, so none follows within the request's 200 ms.
    expect(server.sent).toHaveLength(3);
  });

  it("keeps waiting when a send's answer was lost: it may have been accepted", async () => {
    const { server, ledger, channels, engine, intent, payer } = setup();
    server.accountSequence = "5";
    sendsAnswer(server, [new Error("socket hang up"), refused("txBadSeq")]);
    const result = await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    const record = await ledger.find(intent.key);
    expect(record?.state).toBe("submitted");
    expect(record?.sendsInFlight).toHaveLength(1);
    expect(await channels.acquire(0)).toBeUndefined();
  });

  it("reports a decline once per settlement, however many rebroadcasts meet it", async () => {
    // A ledger that cannot mark a channel given back keeps it, and its bytes keep being rebroadcast.
    const { server, engine, intent, payer, conflicts, warnings } = setup({
      confirmTimeoutMs: 200,
      channelRelease: false,
    });
    server.accountSequence = "5";
    sendsAnswer(server, [answered("TRY_AGAIN_LATER"), new Error("socket hang up"), refused("txBadSeq")]);
    const result = await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    expect(result).toMatchObject({ errorReason: "settlement_pending" });
    // Many rebroadcasts answered txBadSeq within the confirmation window …
    expect(server.sent.length).toBeGreaterThan(4);
    // … but the decline was logged and counted once.
    const declines = warnings.filter((message) => message.startsWith("sequence conflict not finished early"));
    expect(declines).toHaveLength(1);
    expect(conflicts).toEqual([{ outcome: "declined", reason: "may_be_public" }]);
  });

  it("reports a settlement finished at the conflict, with its reason", async () => {
    const { server, engine, intent, payer, conflicts } = setup({ reconcileIdleMs: 0 });
    server.accountSequence = "5";
    sendsAnswer(server, [answered("TRY_AGAIN_LATER"), refused("txBadSeq")]);
    await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    expect(conflicts).toEqual([{ outcome: "declined", reason: "may_be_public" }]);
    // Once the authorization expired unused, the conflict finishes the settlement.
    server.ledger = EXPIRATION + 1;
    expect(await engine.reconcile()).toBe(1);
    expect(conflicts).toEqual([
      { outcome: "declined", reason: "may_be_public" },
      { outcome: "finished_early", reason: "never_accepted" },
    ]);
  });

  it("keeps waiting when the payer's nonce is read from an RPC behind the sequence proof", async () => {
    const { server, ledger, engine, intent, payer, conflicts } = setup({ confirmTimeoutMs: 200 });
    server.accountSequence = "5";
    sendsAnswer(server, [answered("TRY_AGAIN_LATER"), refused("txBadSeq")]);
    // The nonce read lands on a lagging provider (or another one after a failover): an unused nonce
    // there proves nothing about the ledger the channel's sequence number was read at.
    const fake = server as unknown as { getLedgerEntries: (...keys: xdr.LedgerKey[]) => Promise<unknown> };
    const read = fake.getLedgerEntries.bind(server);
    fake.getLedgerEntries = async (...keys) => {
      const answer = (await read(...keys)) as { entries: unknown[]; latestLedger: number };
      const nonceRead = keys.some((key) => key.switch() === xdr.LedgerEntryType.contractData());
      return nonceRead ? { ...answer, latestLedger: server.ledger - 3 } : answer;
    };
    const result = await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect((await ledger.find(intent.key))?.state).toBe("submitted");
    expect(conflicts).toEqual([{ outcome: "declined", reason: "rpc_behind" }]);
  });

  it("reports a decline again when its reason changes", async () => {
    const { server, engine, intent, payer, conflicts } = setup({ confirmTimeoutMs: 200 });
    // The channel's sequence number first lags the transaction's, then is taken from a lost send.
    server.accountSequence = "0";
    let sends = 0;
    sendsAnswer(server, [answered("TRY_AGAIN_LATER"), new Error("socket hang up"), refused("txBadSeq")]);
    const replace = server as unknown as { sendTransaction: (tx: FeeBumpTransaction) => Promise<unknown> };
    const send = replace.sendTransaction;
    replace.sendTransaction = (tx) => {
      if (++sends === 4) server.accountSequence = "5";
      return send(tx);
    };
    await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    expect(conflicts).toEqual([
      { outcome: "declined", reason: "sequence_not_reached" },
      { outcome: "declined", reason: "may_be_public" },
    ]);
  });

  it("keeps waiting when the scheme's own send was lost", async () => {
    const { server, ledger, engine, intent, payer } = setup();
    server.accountSequence = "5";
    sendsAnswer(server, [refused("txBadSeq")]);
    const result = await engine.execute(intent, lostAtFirstSend(payer));
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(await ledger.find(intent.key)).toMatchObject({ state: "submitted", sendsInFlight: [FIRST_SEND] });
  });

  it("keeps waiting when a send was answered DUPLICATE: the network held the bytes", async () => {
    const { server, ledger, engine, intent, payer } = setup();
    server.accountSequence = "5";
    sendsAnswer(server, [answered("TRY_AGAIN_LATER"), answered("DUPLICATE"), refused("txBadSeq")]);
    const result = await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(await ledger.find(intent.key)).toMatchObject({ state: "submitted", broadcastAccepted: true });
  });

  it("is finished by another replica's reconciler from the recorded answers", async () => {
    const { server, ledger, channels, engine, intent, payer } = setup({ channelQuarantineMs: 60_000 });
    server.accountSequence = "5";
    // The request's replica only ever hears TRY_AGAIN_LATER and answers settlement_pending.
    sendsAnswer(server, [answered("TRY_AGAIN_LATER")]);
    expect(
      await engine.execute(
        intent,
        refusedAtFirstSend(payer, () => undefined),
      ),
    ).toMatchObject({ errorReason: "settlement_pending" });
    // Another replica, sharing the ledger and the channel pool, reconciles once the conflict applied.
    const other = new SettlementEngine({
      network: NETWORK,
      passphrase: PASSPHRASE,
      rpcUrl: "http://127.0.0.1:1/rpc",
      server: server.asServer(),
      policy,
      ledger,
      channels,
      channelKeys: new Map([[channel.publicKey(), channel]]),
      sponsor,
      timing: { pollIntervalMs: 5, reconcileIdleMs: 0, channelQuarantineMs: 60_000 },
    });
    sendsAnswer(server, [refused("txBadSeq")]);
    // It gives the channel back at once; the payment's outcome waits for the authorization.
    expect(await other.reconcile()).toBe(0);
    expect(await ledger.find(intent.key)).toMatchObject({ state: "submitted", channelReleased: true });
    expect(await channels.inUse()).toBe(0);
    expect(await channels.acquire(0)).toBeUndefined();
    server.ledger = EXPIRATION + 1;
    expect(await other.reconcile()).toBe(1);
    expect(await ledger.find(intent.key)).toMatchObject({
      state: "failed",
      response: { errorReason: SUBMISSION_FAILED },
    });
    expect(await channels.acquire(0)).toBeUndefined();
  });

  it("is left waiting by another replica's reconciler when a send's answer was lost", async () => {
    const { server, ledger, channels, engine, intent, payer } = setup();
    server.accountSequence = "5";
    sendsAnswer(server, [answered("TRY_AGAIN_LATER"), new Error("timeout")]);
    await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    const other = new SettlementEngine({
      network: NETWORK,
      passphrase: PASSPHRASE,
      rpcUrl: "http://127.0.0.1:1/rpc",
      server: server.asServer(),
      policy,
      ledger,
      channels,
      channelKeys: new Map([[channel.publicKey(), channel]]),
      sponsor,
      timing: { pollIntervalMs: 5, reconcileIdleMs: 0 },
    });
    sendsAnswer(server, [refused("txBadSeq")]);
    expect(await other.reconcile()).toBe(0);
    expect((await ledger.find(intent.key))?.state).toBe("submitted");
  });
});

/** A scheme whose settlement lands: signed, recorded, and found in a ledger. */
function settles(server: FakeServer, payer: string): SettlementExecution {
  return {
    async submit(context) {
      const signed = await signThroughSponsor(context, payer);
      const hash = (TransactionBuilder.fromXDR(signed.signedTxXdr, PASSPHRASE) as FeeBumpTransaction)
        .hash()
        .toString("hex");
      server.byHash.set(hash, {
        status: "SUCCESS",
        ledger: server.ledger,
        latestLedger: server.ledger,
        latestLedgerCloseTime: 0,
        oldestLedger: 1,
        oldestLedgerCloseTime: 0,
      } as unknown as rpc.Api.GetTransactionResponse);
      return { success: true, transaction: hash, network: NETWORK, payer };
    },
    unsigned: (result) => Promise.resolve(result),
  };
}

describe("a channel coming back from a quarantine", () => {
  const conflicted = async (quarantineMs: number) => {
    const context = setup({ channelQuarantineMs: quarantineMs });
    context.server.accountSequence = "5";
    sendsAnswer(context.server, [refused("txBadSeq")]);
    // The channel is quarantined at the conflict, while the request still runs.
    const started = Date.now();
    expect(
      await context.engine.execute(
        context.intent,
        refusedAtFirstSend(context.payer, () => undefined),
      ),
      // The payment's outcome waits for its authorization; the channel is quarantined at once.
    ).toMatchObject({ errorReason: "settlement_pending" });
    const next: SettlementIntent = { ...context.intent, key: context.engine.keyOf(context.payer, 8n) };
    return { ...context, next, started };
  };

  it("serves again once its sequence number stayed where the conflict left it", async () => {
    const { server, engine, next, payer, warnings, started } = await conflicted(80);
    expect(await engine.execute(next, settles(server, payer))).toMatchObject({ success: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(warnings.filter((message) => message.includes("moved again"))).toEqual([]);
  });

  it("is quarantined again, for twice as long, when its sequence number moved since", async () => {
    const { server, engine, channels, next, payer, warnings, started } = await conflicted(80);
    // Someone kept using the account during the quarantine.
    server.accountSequence = "9";
    expect(await engine.execute(next, settles(server, payer))).toMatchObject({ success: true });
    // 80 ms of the first quarantine, then 160 ms of the second, before the unmoved number serves.
    expect(Date.now() - started).toBeGreaterThanOrEqual(220);
    expect(warnings.filter((message) => message.includes("moved again"))).toHaveLength(1);
    expect(await channels.inUse()).toBe(0);
  });
});

describe("a settlement that signed nothing within its claim window", () => {
  it("stops there, signs nothing later and frees its claim and channel", async () => {
    const { ledger, channels, engine, intent } = setup({ claimTtlMs: 40 });
    let late: { signedTxXdr: string; error?: unknown } | undefined;
    let release: () => void = () => undefined;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execution: SettlementExecution = {
      async submit(context) {
        // A provider that answers only after the claim window closed.
        await hung;
        late = await signThroughSponsor(context);
        return { success: false, transaction: "", network: NETWORK, errorReason: "unexpected_settle_error" };
      },
      unsigned: (result) => Promise.resolve(result),
    };
    const started = Date.now();
    const result = await engine.execute(intent, execution);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toMatchObject({ success: false, errorReason: "unexpected_settle_error" });
    expect(result.errorMessage).toMatch(/did not answer in time/);
    expect(await ledger.find(intent.key)).toBeUndefined();
    expect(await channels.acquire(0)).toBe(channel.publicKey());

    // The hung call resumes: the sponsor refuses to sign, so nothing can reach the network.
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(late?.signedTxXdr).toBe("");
    expect(late?.error).toBeDefined();
    expect(await ledger.find(intent.key)).toBeUndefined();
  });

  it("is driven as usual when it recorded its envelope just in time", async () => {
    const { server, ledger, engine, intent } = setup({ claimTtlMs: 200 });
    server.status = "SUCCESS";
    const execution: SettlementExecution = {
      async submit(context) {
        const signed = await signThroughSponsor(context);
        const bump = TransactionBuilder.fromXDR(signed.signedTxXdr, PASSPHRASE) as FeeBumpTransaction;
        return {
          success: true,
          transaction: bump.hash().toString("hex"),
          network: NETWORK,
        };
      },
      unsigned: (result) => Promise.resolve(result),
    };
    expect(await engine.execute(intent, execution)).toMatchObject({ success: true });
    expect((await ledger.find(intent.key))?.state).toBe("succeeded");
  });
});

/** The payer authorization's expiration ledger in the transfers `signThroughSponsor` signs. */
const EXPIRATION = LEDGER + 1_000;

/**
 * A successful transaction in `ledgerSeq` that carries the payer's authorization from a signed
 * settlement envelope and moved the transfer it authorizes: a copy that a holder of the payment (its
 * payer, the seller, anyone it passed through) landed in a transaction of their own.
 */
function copyOf(envelopeXdr: string, ledgerSeq: number): rpc.Api.TransactionInfo {
  const bump = TransactionBuilder.fromXDR(envelopeXdr, PASSPHRASE) as FeeBumpTransaction;
  const operation = bump.innerTransaction.operations[0];
  if (operation?.type !== "invokeHostFunction") throw new Error("not a transfer");
  const [from, to, amount] = operation.func.invokeContract().args();
  if (from === undefined || to === undefined || amount === undefined) throw new Error("not a transfer");
  const transfer = contractEvent(TOKEN, [xdr.ScVal.scvSymbol("transfer"), from, to], amount);
  return {
    status: "SUCCESS",
    ledger: ledgerSeq,
    createdAt: Math.floor(Date.now() / 1_000) + 5,
    applicationOrder: 1,
    feeBump: true,
    envelopeXdr: bump.toEnvelope(),
    txHash: "d".repeat(64),
    events: { transactionEventsXdr: [], contractEventsXdr: [[transfer.event()]] },
  } as unknown as rpc.Api.TransactionInfo;
}

/** A scheme whose first broadcast was refused while a copy of the payer's authorization had landed. */
function refusedAfterCopy(server: FakeServer, payer: string): SettlementExecution {
  return {
    async submit(context) {
      const signed = await signThroughSponsor(context, payer);
      expect(signed.error).toBeUndefined();
      server.nonceConsumedIn = server.ledger;
      server.transactions = [copyOf(signed.signedTxXdr, server.ledger)];
      return { success: false, transaction: "", network: NETWORK, errorReason: SUBMISSION_FAILED, payer };
    },
    unsigned: (result) => Promise.resolve(result),
  };
}

/** A scheme whose own send the network accepted, reported with its hash and not yet confirmed. */
function acceptedAtFirstSend(payer: string, sent: (envelopeXdr: string) => void): SettlementExecution {
  return {
    async submit(context) {
      const signed = await signThroughSponsor(context, payer);
      expect(signed.error).toBeUndefined();
      sent(signed.signedTxXdr);
      const hash = TransactionBuilder.fromXDR(signed.signedTxXdr, PASSPHRASE).hash().toString("hex");
      return {
        success: false,
        transaction: hash,
        network: NETWORK,
        errorReason: "unexpected_settle_error",
        payer,
      };
    },
    unsigned: (result) => Promise.resolve(result),
  };
}

/**
 * An `exact` authorization can be carried by anyone who holds the payment until it expires, whatever
 * became of Rail402's own transaction. A settlement whose bytes the network refused, or can never
 * apply, is therefore answered from the payer's nonce, and finished as failed only once the
 * authorization expired unused.
 */
describe("an exact settlement whose own transaction can never land", () => {
  it("answers a copy of the authorization that landed before its first submission was refused", async () => {
    const { server, ledger, engine, intent, payer } = setup();
    server.sendResult = refused("txBadAuth");
    const result = await engine.execute(intent, refusedAfterCopy(server, payer));
    expect(result).toMatchObject({ success: true, transaction: "d".repeat(64) });
    expect(await ledger.find(intent.key)).toMatchObject({ state: "succeeded", settledBy: "third_party" });
    const repeat = await engine.answerRepeat("exact", intent.key, intent.fingerprint);
    expect(repeat).toMatchObject({ success: true, transaction: "d".repeat(64) });
    expect(repeat === undefined ? undefined : repeatOf(repeat)).toEqual({
      repeat: true,
      settledBy: "third_party",
    });
  });

  it("answers the same copy alike when the refusal came at a later rebroadcast", async () => {
    const { server, ledger, engine, intent, payer } = setup();
    const result = await engine.execute(
      intent,
      acceptedAtFirstSend(payer, (envelopeXdr) => {
        server.sendResult = refused("txBadAuth");
        server.nonceConsumedIn = server.ledger;
        server.transactions = [copyOf(envelopeXdr, server.ledger)];
      }),
    );
    expect(result).toMatchObject({ success: true, transaction: "d".repeat(64) });
    expect(await ledger.find(intent.key)).toMatchObject({ state: "succeeded", settledBy: "third_party" });
  });

  it("keeps a refused first submission open while its authorization is valid, and answers a later copy", async () => {
    const { server, ledger, channels, engine, intent, payer } = setup({ reconcileIdleMs: 0 });
    server.sendResult = refused("txBadAuth");
    const result = await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    const record = await ledger.find(intent.key);
    expect(record?.state).toBe("submitted");
    // Its bytes may still be sent through, so the settlement keeps its channel.
    expect(await channels.acquire(0)).toBeUndefined();

    // A holder of the payment lands the authorization two ledgers later.
    server.ledger += 2;
    server.nonceConsumedIn = server.ledger;
    server.transactions = [copyOf(record?.envelopeXdr ?? "", server.ledger)];
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.find(intent.key)).toMatchObject({ state: "succeeded", settledBy: "third_party" });
    const repeat = await engine.answerRepeat("exact", intent.key, intent.fingerprint);
    expect(repeat === undefined ? undefined : repeatOf(repeat)).toEqual({
      repeat: true,
      settledBy: "third_party",
    });
    expect(await channels.acquire(0)).toBe(channel.publicKey());
  });

  it("gives its channel back at a proven sequence conflict, and answers a later copy", async () => {
    const { server, ledger, channels, engine, intent, payer, conflicts } = setup({
      channelQuarantineMs: 100,
      reconcileIdleMs: 0,
    });
    server.sendResult = refused("txBadSeq");
    server.accountSequence = "5";
    const result = await engine.execute(
      intent,
      refusedAtFirstSend(payer, () => undefined),
    );
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    const record = await ledger.find(intent.key);
    expect(record).toMatchObject({ state: "submitted", channelReleased: true });
    expect(conflicts).toEqual([{ outcome: "declined", reason: "may_be_public" }]);
    // The bytes can never apply: the channel is quarantined at once, not held until the expiration.
    expect(await channels.inUse()).toBe(0);
    expect(await channels.acquire(0)).toBeUndefined();
    const next = await channels.acquire(2_000);
    expect(next).toBe(channel.publicKey());

    // A holder of the payment lands the authorization; the next look answers it, and finishing the
    // settlement leaves the channel with the settlement that leased it since.
    const sent = server.sent.length;
    server.ledger += 2;
    server.nonceConsumedIn = server.ledger;
    server.transactions = [copyOf(record?.envelopeXdr ?? "", server.ledger)];
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.find(intent.key)).toMatchObject({ state: "succeeded", settledBy: "third_party" });
    expect(server.sent).toHaveLength(sent);
    expect(await channels.inUse()).toBe(1);
    expect(await channels.acquire(0)).toBeUndefined();
  });

  it("finishes a sequence conflict as failed once the authorization expired unused, releasing nothing twice", async () => {
    const { server, ledger, channels, engine, intent, payer } = setup({
      channelQuarantineMs: 50,
      reconcileIdleMs: 0,
    });
    server.sendResult = refused("txBadSeq");
    server.accountSequence = "5";
    expect(
      await engine.execute(
        intent,
        refusedAtFirstSend(payer, () => undefined),
      ),
    ).toMatchObject({ errorReason: "settlement_pending" });
    const next = await channels.acquire(1_000);
    expect(next).toBe(channel.publicKey());

    server.ledger = EXPIRATION + 1;
    expect(await engine.reconcile()).toBe(1);
    const finished = await ledger.find(intent.key);
    expect(finished).toMatchObject({ state: "failed", feeChargedStroops: "0" });
    expect(finished?.response?.errorReason).toBe(SUBMISSION_FAILED);
    expect(finished?.response?.errorMessage).toMatch(/expired/);
    expect(await channels.inUse()).toBe(1);
    expect(await channels.acquire(0)).toBeUndefined();
  });
});

/** Makes every transaction the fake RPC reports as included carry a fee charged of `stroops`. */
function chargeFee(server: FakeServer, stroops: string): void {
  const fake = server as unknown as { getTransaction: (hash: string) => Promise<Record<string, unknown>> };
  const lookup = fake.getTransaction.bind(server);
  fake.getTransaction = async (hash) => ({
    ...(await lookup(hash)),
    resultXdr: new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString(stroops),
      result: xdr.TransactionResultResult.txFailed([]),
      ext: new xdr.TransactionResultExt(0),
    }),
  });
}

/**
 * The host rolls a failed transaction back, the payer's nonce included: unless the failure proves the
 * authorization consumed or expired, anyone who holds the payment can still carry it in a transaction
 * of their own until it expires. Such a failure is answered as settled through a copy that lands, and
 * kept with its on-chain cause only once the authorization expired unused.
 */
describe("an exact settlement whose own transaction failed on chain", () => {
  /** Settles through a send the network accepted; the transaction is then included and fails. */
  const failedOnChain = async (
    context: ReturnType<typeof setup>,
    events: xdr.DiagnosticEvent[],
  ): Promise<{
    readonly result: Awaited<ReturnType<SettlementEngine["execute"]>>;
    readonly envelope: string;
  }> => {
    let envelope = "";
    const result = await context.engine.execute(
      context.intent,
      acceptedAtFirstSend(context.payer, (signed) => {
        envelope = signed;
        context.server.status = "FAILED";
        context.server.failureEvents = events;
      }),
    );
    return { result, envelope };
  };

  it("keeps a failure on the payer's balance open while the authorization is valid, and answers a later copy", async () => {
    const context = setup({ reconcileIdleMs: 0 });
    const { server, ledger, channels, engine, intent } = context;
    // The payer's balance dropped after the settle-time simulation: the token refuses the transfer.
    const { result, envelope } = await failedOnChain(context, [
      errorEvent(xdr.ScError.sceContract(10), "balance is not sufficient", TOKEN),
    ]);
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(await ledger.find(intent.key)).toMatchObject({ state: "submitted", channelReleased: true });
    // The failed transaction used its channel's sequence number: the channel serves again at once.
    const next = await channels.acquire(0);
    expect(next).toBe(channel.publicKey());

    // The payer tops up, and a holder of the payment lands the authorization two ledgers later.
    server.ledger += 2;
    server.nonceConsumedIn = server.ledger;
    server.transactions = [copyOf(envelope, server.ledger)];
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.find(intent.key)).toMatchObject({ state: "succeeded", settledBy: "third_party" });
    const repeat = await engine.answerRepeat("exact", intent.key, intent.fingerprint);
    expect(repeat).toMatchObject({ success: true, transaction: "d".repeat(64) });
    // Finishing it released nothing: the channel stays with the settlement that leased it since.
    expect(await channels.inUse()).toBe(1);
    expect(await channels.acquire(0)).toBeUndefined();
  });

  it("keeps a failure on a removed trustline until the authorization expired unused, then names it with the fee charged", async () => {
    const context = setup({ reconcileIdleMs: 0, sac: true });
    const { server, ledger, engine, intent } = context;
    chargeFee(server, "54321");
    const { result } = await failedOnChain(context, [
      errorEvent(xdr.ScError.sceContract(13), "trustline entry is missing for account", TOKEN),
    ]);
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });

    server.ledger = EXPIRATION;
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.find(intent.key))?.state).toBe("submitted");
    server.ledger = EXPIRATION + 1;
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.find(intent.key)).toMatchObject({
      state: "failed",
      feeChargedStroops: "54321",
      response: { errorReason: "invalid_exact_stellar_payload_payer_trustline_missing" },
    });
  });

  it("keeps a smart account's failed signature open while the authorization is valid, and answers a later copy", async () => {
    // A contract account's __check_auth reads its own signers: a signature it refused can pass later.
    const context = setup({ reconcileIdleMs: 0, payer: StrKey.encodeContract(Buffer.alloc(32, 7)) });
    const { server, ledger, engine, intent } = context;
    const { result, envelope } = await failedOnChain(context, [
      errorEvent(xdr.ScError.sceCrypto(xdr.ScErrorCode.scecInvalidInput()), "signature verification failed"),
    ]);
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect((await ledger.find(intent.key))?.state).toBe("submitted");

    server.ledger += 3;
    server.nonceConsumedIn = server.ledger;
    server.transactions = [copyOf(envelope, server.ledger)];
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.find(intent.key)).toMatchObject({ state: "succeeded", settledBy: "third_party" });
  });

  it("names a failure on the used nonce at once when no copy carried the authorization", async () => {
    const context = setup();
    const { ledger, intent } = context;
    // The nonce was consumed by a transaction that did not carry this authorization as signed.
    context.server.nonceConsumedIn = context.server.ledger - 1;
    const { result } = await failedOnChain(context, [
      errorEvent(xdr.ScError.sceAuth(xdr.ScErrorCode.scecExistingValue())),
    ]);
    expect(result).toMatchObject({
      success: false,
      errorReason: "invalid_exact_stellar_payload_nonce_already_used",
    });
    expect((await ledger.find(intent.key))?.state).toBe("failed");
  });

  /**
   * Any contract in the call path can raise an Auth error saying "expired" before it fails: that names
   * the failure, but the payer's own authorization, expiring at EXPIRATION, is still valid.
   */
  const expiredErrorWaits = async (raisedBy: "payer" | "token", payerAddress?: string) => {
    const context = setup({
      reconcileIdleMs: 0,
      ...(payerAddress === undefined ? {} : { payer: payerAddress }),
    });
    const { server, ledger, engine, intent } = context;
    const contract = raisedBy === "payer" ? context.payer : TOKEN;
    const { result, envelope } = await failedOnChain(context, [
      errorEvent(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidInput()), "signature has expired", contract),
      errorEvent(xdr.ScError.sceContract(1), "rejected", contract),
    ]);
    expect(server.ledger).toBeLessThan(EXPIRATION);
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });

    server.ledger += 2;
    server.nonceConsumedIn = server.ledger;
    server.transactions = [copyOf(envelope, server.ledger)];
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.find(intent.key)).toMatchObject({ state: "succeeded", settledBy: "third_party" });
  };

  it("keeps an expired-authorization error raised by a smart account's own check before the payer's expiration open, and answers a later copy", async () => {
    await expiredErrorWaits("payer", StrKey.encodeContract(Buffer.alloc(32, 13)));
  });

  it("keeps an expired-authorization error raised by a token contract before the payer's expiration open, and answers a later copy", async () => {
    await expiredErrorWaits("token");
  });

  it("names an expired authorization at once when the transaction failed past the payer's expiration", async () => {
    const context = setup();
    context.server.ledger = EXPIRATION + 3;
    const { result } = await failedOnChain(context, [
      errorEvent(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidInput()), "signature has expired"),
    ]);
    expect(result).toMatchObject({ success: false, errorReason: "invalid_exact_stellar_signature_expired" });
    expect((await context.ledger.find(context.intent.key))?.state).toBe("failed");
  });

  it("sends nothing more once its transaction failed inside another fee bump and gave its channel back", async () => {
    const context = setup({ confirmTimeoutMs: 300 });
    const { server, ledger, engine, intent, payer } = context;
    // Count the sends made before the channel was given back.
    let sentAtGiveBack: number | undefined;
    const release = ledger.releaseChannel.bind(ledger);
    Object.assign(ledger, {
      releaseChannel: async (id: string) => {
        const marked = await release(id);
        if (marked) sentAtGiveBack ??= server.sent.length;
        return marked;
      },
    });
    // Rail402's own fee bump is never found: someone else wrapped its inner transaction, which failed on
    // the payer's balance. Every rebroadcast of the own fee bump is refused for good.
    const result = await engine.execute(
      intent,
      acceptedAtFirstSend(payer, (signed) => {
        const bump = TransactionBuilder.fromXDR(signed, PASSPHRASE) as FeeBumpTransaction;
        const foreign = TransactionBuilder.buildFeeBumpTransaction(
          Keypair.random(),
          "400",
          bump.innerTransaction,
          PASSPHRASE,
        );
        server.byHash.set(bump.innerTransaction.hash().toString("hex"), {
          status: "FAILED",
          ledger: server.ledger,
          latestLedger: server.ledger,
          latestLedgerCloseTime: 0,
          oldestLedger: 1,
          oldestLedgerCloseTime: 0,
          envelopeXdr: foreign.toEnvelope(),
          diagnosticEventsXdr: [errorEvent(xdr.ScError.sceContract(10), "balance is not sufficient", TOKEN)],
        } as unknown as rpc.Api.GetTransactionResponse);
        server.sendResult = refused("txBadAuth");
      }),
    );
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(await ledger.find(intent.key)).toMatchObject({ state: "submitted", channelReleased: true });
    expect(sentAtGiveBack).toBeDefined();
    expect(server.sent.length - (sentAtGiveBack ?? 0)).toBe(0);
  });

  it("sends nothing after its own failed transaction gave the channel back, when a lagging RPC then misses it", async () => {
    const context = setup({ confirmTimeoutMs: 300 });
    const { server, ledger, engine, intent, payer } = context;
    let looks = 0;
    const fake = server as unknown as { getTransaction: (hash: string) => Promise<unknown> };
    const lookup = fake.getTransaction.bind(server);
    const result = await engine.execute(
      intent,
      acceptedAtFirstSend(payer, () => {
        server.failureEvents = [errorEvent(xdr.ScError.sceContract(10), "balance is not sufficient", TOKEN)];
        // The first look finds the transaction failed; every later one comes from a lagging RPC.
        fake.getTransaction = (hash) => {
          looks++;
          server.status = looks <= 1 ? "FAILED" : "NOT_FOUND";
          return lookup(hash);
        };
      }),
    );
    expect(result).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(await ledger.find(intent.key)).toMatchObject({ state: "submitted", channelReleased: true });
    expect(looks).toBeGreaterThan(3);
    expect(server.sent).toHaveLength(0);
  });
});
