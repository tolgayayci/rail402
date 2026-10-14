import { describe, expect, it, vi } from "vitest";
import { Account, Keypair, Networks, Operation, TransactionBuilder, rpc } from "@stellar/stellar-sdk";
import {
  HISTORY_MARGIN_SECONDS,
  MemoryChannelPool,
  MemorySettlementLedger,
  SettlementEngine,
  historyCovers,
  settleSucceeded,
  type NetworkPolicy,
  type SettlementObserver,
  type SettlementRecord,
} from "@rail402.dev/facilitator";

const NETWORK = "stellar:testnet";
const HASH = "e".repeat(64);
/** The recorded transaction's upper time bound; every stubbed ledger below closed after it. */
const VALID_UNTIL = 1_700_000_000;

function recordingObserver() {
  const events: [string, ...unknown[]][] = [];
  const observer: SettlementObserver = {
    leaseWait: (...args) => events.push(["leaseWait", ...args]),
    submission: (...args) => events.push(["submission", ...args]),
    finalized: (...args) => events.push(["finalized", ...args]),
    reconciled: (...args) => events.push(["reconciled", ...args]),
    unresolvable: (...args) => events.push(["unresolvable", ...args]),
    repeat: (...args) => events.push(["repeat", ...args]),
    ledgerReadFailed: (...args) => events.push(["ledgerReadFailed", ...args]),
  };
  return { observer, events };
}

/** A settlement whose envelope was recorded and never confirmed, as a crashed process leaves it. */
async function setup(getTransaction: (hash: string) => Promise<rpc.Api.GetTransactionResponse>) {
  const channel = Keypair.random();
  const ledger = new MemorySettlementLedger();
  const channels = new MemoryChannelPool([channel.publicKey()]);
  const sendTransaction = vi.fn(() => Promise.reject(new Error("must not broadcast")));
  const { observer, events } = recordingObserver();
  const engine = new SettlementEngine({
    network: NETWORK,
    passphrase: Networks.TESTNET,
    rpcUrl: "http://127.0.0.1:1/rpc",
    server: { getTransaction, sendTransaction } as unknown as rpc.Server,
    policy: {} as NetworkPolicy,
    ledger,
    channels,
    channelKeys: new Map([[channel.publicKey(), channel]]),
    sponsor: Keypair.random(),
    // The record below is left by a crashed process: the reconciler takes it at once.
    timing: { pollIntervalMs: 10, reconcileIdleMs: 0 },
    observer,
  });
  const leased = await channels.acquire(0);
  const { record } = await ledger.claim(
    { network: NETWORK, payer: Keypair.random().publicKey(), nonce: "7" },
    { payloadHash: "a".repeat(64), requestHash: "b".repeat(64) },
    "crashed",
    60_000,
  );
  await ledger.recordEnvelope(record.id, "crashed", {
    channel: leased ?? "",
    transactionHash: HASH,
    innerTransactionHash: "f".repeat(64),
    envelopeXdr: "AAAA",
    validUntil: VALID_UNTIL,
    maxFeeStroops: "30000",
  });
  const stored = (await ledger.get(record.id)) as SettlementRecord;
  return { engine, ledger, channels, sendTransaction, events, record: stored };
}

const notFound = (oldestLedgerCloseTime: number) =>
  ({
    status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    latestLedgerCloseTime: VALID_UNTIL + 600,
    oldestLedgerCloseTime,
  }) as rpc.Api.GetTransactionResponse;

describe("recorded settlements past their time bound", () => {
  it("covers a settlement only when retained history starts a margin before its claim", () => {
    const record = { createdAt: 1_750_000_000_500 } as SettlementRecord;
    const claimed = 1_750_000_000;
    expect(HISTORY_MARGIN_SECONDS).toBe(60);
    expect(historyCovers(record, claimed - 3_600)).toBe(true);
    expect(historyCovers(record, claimed - HISTORY_MARGIN_SECONDS)).toBe(true);
    expect(historyCovers(record, claimed - HISTORY_MARGIN_SECONDS + 1)).toBe(false);
    expect(historyCovers(record, claimed + 3_600)).toBe(false);
  });

  it("expires one whose absence the RPC's retained history proves", async () => {
    const { engine, ledger, channels, events, record, sendTransaction } = await setup(() =>
      Promise.resolve(notFound(Math.floor(Date.now() / 1_000) - 86_400)),
    );
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({
      state: "expired",
      response: {
        success: false,
        errorReason: "settle_exact_stellar_transaction_expired",
        transaction: HASH,
      },
    });
    expect(await channels.inUse()).toBe(0);
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(events).toContainEqual(["reconciled", NETWORK, "expired"]);
    expect(events).toContainEqual(["unresolvable", NETWORK, 0]);
  });

  it("never declares one expired once the RPC no longer retains the ledgers that could hold it", async () => {
    // The RPC's oldest ledger closed after the settlement was claimed: an inclusion before that
    // ledger would also answer NOT_FOUND.
    const getTransaction = vi.fn(() =>
      Promise.resolve(notFound(Math.floor(Date.now() / 1_000) - HISTORY_MARGIN_SECONDS + 5)),
    );
    const { engine, ledger, channels, events, record, sendTransaction } = await setup(getTransaction);

    expect(await engine.reconcile()).toBe(0);
    expect(await engine.reconcile()).toBe(0);
    const stored = await ledger.get(record.id);
    expect(stored?.state).toBe("submitted");
    expect(stored?.response).toBeUndefined();
    expect(await ledger.unfinished(NETWORK)).toHaveLength(1);
    // The channel stays leased: its sequence may have been consumed by the unproven transaction.
    expect(await channels.inUse()).toBe(1);
    // Rebroadcasting bytes past their time bound can only be refused, and a refusal proves nothing.
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(events.filter(([name]) => name === "reconciled")).toEqual([
      ["reconciled", NETWORK, "unresolvable"],
      ["reconciled", NETWORK, "unresolvable"],
    ]);
    expect(events).toContainEqual(["unresolvable", NETWORK, 1]);
    expect(events.some(([name]) => name === "finalized")).toBe(false);

    // A request for it is told the settlement is pending, with the recorded transaction.
    expect(await engine.confirm(record, 0)).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
      transaction: HASH,
    });

    // Once the transaction is found (for example an RPC with longer history), it finishes normally.
    getTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      latestLedgerCloseTime: VALID_UNTIL + 600,
      oldestLedgerCloseTime: VALID_UNTIL - 86_400,
      resultXdr: { feeCharged: () => ({ toString: () => "12345" }) },
    } as unknown as rpc.Api.GetTransactionResponse);
    expect(await engine.reconcile()).toBe(1);
    expect(await ledger.get(record.id)).toMatchObject({
      state: "succeeded",
      feeChargedStroops: "12345",
      response: { success: true, transaction: HASH },
    });
    expect(await channels.inUse()).toBe(0);
    expect(events.at(-1)).toEqual(["unresolvable", NETWORK, 0]);
  });
});

describe("reconciliation next to a request that is still confirming", () => {
  it("leaves the settlement to its request, on any replica, until reconcileIdleMs passed", async () => {
    const channel = Keypair.random();
    const sponsor = Keypair.random();
    let clock = Date.now();
    const ledger = new MemorySettlementLedger(() => clock);
    const getTransaction = vi.fn(() =>
      Promise.resolve({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        latestLedgerCloseTime: Math.floor(Date.now() / 1_000),
        oldestLedgerCloseTime: Math.floor(Date.now() / 1_000) - 86_400,
      } as rpc.Api.GetTransactionResponse),
    );
    const sendTransaction = vi.fn(() => Promise.resolve({ status: "DUPLICATE" }));
    const engineFor = () =>
      new SettlementEngine({
        network: NETWORK,
        passphrase: Networks.TESTNET,
        rpcUrl: "http://127.0.0.1:1/rpc",
        server: { getTransaction, sendTransaction } as unknown as rpc.Server,
        policy: {} as NetworkPolicy,
        ledger,
        channels: new MemoryChannelPool([channel.publicKey()]),
        channelKeys: new Map([[channel.publicKey(), channel]]),
        sponsor,
        timing: { pollIntervalMs: 10, confirmTimeoutMs: 1_000 },
      });
    const engine = engineFor();
    const otherReplica = engineFor();

    let recorded: () => void = () => undefined;
    const envelopeRecorded = new Promise<void>((resolve) => (recorded = resolve));
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => (release = resolve));
    const settling = engine.execute(
      {
        scheme: "exact",
        key: { network: NETWORK, payer: Keypair.random().publicKey(), nonce: "9" },
        fingerprint: { payloadHash: "a".repeat(64), requestHash: "b".repeat(64) },
        payer: "GPAYER",
      },
      {
        async submit(context) {
          const inner = new TransactionBuilder(new Account(context.channel, "100"), {
            fee: "100",
            networkPassphrase: Networks.TESTNET,
          })
            .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
            .setTimeout(300)
            .build();
          inner.sign(channel);
          const bump = TransactionBuilder.buildFeeBumpTransaction(
            sponsor.publicKey(),
            "200",
            inner,
            Networks.TESTNET,
          );
          await context.feeBumpSigner.signTransaction(bump.toXDR(), { networkPassphrase: Networks.TESTNET });
          recorded();
          await released;
          return settleSucceeded(NETWORK, bump.hash().toString("hex"), "GPAYER");
        },
        unsigned: (result) => Promise.resolve(result),
      },
    );

    await envelopeRecorded;
    expect(await ledger.unfinished(NETWORK)).toHaveLength(1);
    // Neither the replica confirming the settlement nor another one rebroadcasts it while its request
    // can still be confirming it: confirmTimeoutMs (1 s) plus 5 s since the envelope was recorded.
    expect(await engine.reconcile()).toBe(0);
    clock += 5_999;
    expect(await otherReplica.reconcile()).toBe(0);
    expect(getTransaction).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    // Past that, a replica that cannot know whether the request is alive drives it from its bytes.
    clock += 1;
    expect(await otherReplica.reconcile()).toBe(0);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    // The request's own process still leaves it to the request.
    sendTransaction.mockClear();
    expect(await engine.reconcile()).toBe(0);
    expect(sendTransaction).not.toHaveBeenCalled();

    release();
    expect(await settling).toMatchObject({ success: true });
    expect(await ledger.unfinished(NETWORK)).toEqual([]);
  });
});
