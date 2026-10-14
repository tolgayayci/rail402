import { describe, expect, it, vi } from "vitest";
import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  MemoryChannelPool,
  MemorySettlementLedger,
  SettlementEngine,
  canonicalJson,
  containedObserver,
  fingerprintOf,
  markRepeat,
  repeatOf,
  requestHash,
  sameRequest,
  settleSucceeded,
  silentLogger,
  type NetworkPolicy,
  type PreflightedPayment,
  type SettlementObserver,
  type SettlementRecord,
  type SettlementTerms,
} from "@rail402.dev/facilitator";

const NETWORK = "stellar:testnet";

const terms: SettlementTerms = {
  scheme: "exact",
  network: NETWORK,
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  amount: "10000",
  transaction: "AAAA",
};

const payloadOf = (transaction: string) =>
  ({ x402Version: 2, payload: { transaction } }) as unknown as PaymentPayload;
const requirementsOf = (overrides: Partial<SettlementTerms> = {}) =>
  ({
    ...terms,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
    ...overrides,
  }) as PaymentRequirements;

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

function engineWith(server: Partial<rpc.Server> = {}) {
  const channel = Keypair.random();
  const ledger = new MemorySettlementLedger();
  const channels = new MemoryChannelPool([channel.publicKey()]);
  const { observer, events } = recordingObserver();
  const engine = new SettlementEngine({
    network: NETWORK,
    passphrase: Networks.TESTNET,
    rpcUrl: "http://127.0.0.1:1/rpc",
    server: server as rpc.Server,
    policy: {} as NetworkPolicy,
    ledger,
    channels,
    channelKeys: new Map([[channel.publicKey(), channel]]),
    sponsor: Keypair.random(),
    // Records are written as if by a crashed process: the reconciler takes them at once.
    timing: { duplicateWaitMs: 50, pollIntervalMs: 10, channelWaitMs: 20, reconcileIdleMs: 0 },
    observer,
  });
  return { engine, ledger, channels, channel: channel.publicKey(), events };
}

/** A settlement recorded and, optionally, finished in the ledger, as an earlier request left it. */
async function recorded(
  ledger: MemorySettlementLedger,
  channel: string,
  options: { transaction?: string; requirements?: PaymentRequirements; finish?: boolean } = {},
) {
  const payer = Keypair.random().publicKey();
  const key = { network: NETWORK, payer, nonce: "42" };
  const fingerprint = fingerprintOf(
    payloadOf(options.transaction ?? "AAAA"),
    options.requirements ?? requirementsOf(),
  );
  const { record } = await ledger.claim(key, fingerprint, "original", 60_000);
  const hash = "c".repeat(64);
  await ledger.recordEnvelope(record.id, "original", {
    channel,
    transactionHash: hash,
    innerTransactionHash: "d".repeat(64),
    envelopeXdr: "AAAA",
    validUntil: 1_700_000_000,
    maxFeeStroops: "30000",
  });
  const response = settleSucceeded(NETWORK, hash, payer);
  if (options.finish !== false) await ledger.finish(record.id, "succeeded", response);
  return { key, fingerprint, hash, response, id: record.id };
}

describe("request fingerprints", () => {
  it("serialise objects canonically, whatever the key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,{"e":0,"f":1}]},"b":1}',
    );
  });

  it("change with every term, including the settle-time amount", () => {
    const base = requestHash(terms);
    expect(requestHash({ ...terms })).toBe(base);
    for (const field of Object.keys(terms) as (keyof SettlementTerms)[]) {
      expect(requestHash({ ...terms, [field]: `${terms[field]}0` }), field).not.toBe(base);
    }
  });

  it("keep the signed transaction's hash separately, for records that predate request hashes", () => {
    const a = fingerprintOf(payloadOf("AAAA"), requirementsOf());
    const b = fingerprintOf(payloadOf("AAAA"), requirementsOf({ amount: "20000" }));
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.requestHash).not.toBe(b.requestHash);
    expect(a.requestHash).toBe(requestHash(terms));

    const legacy = { payloadHash: a.payloadHash } as SettlementRecord;
    expect(sameRequest(legacy, b)).toBe(true);
    expect(sameRequest(legacy, fingerprintOf(payloadOf("BBBB"), requirementsOf()))).toBe(false);
    expect(sameRequest({ ...legacy, requestHash: a.requestHash }, b)).toBe(false);
  });

  it("ignore terms outside the fingerprint and tolerate malformed requirements", () => {
    const a = fingerprintOf(payloadOf("AAAA"), requirementsOf());
    const b = fingerprintOf(payloadOf("AAAA"), { ...requirementsOf(), maxTimeoutSeconds: 300 });
    expect(b).toEqual(a);
    const malformed = {
      ...requirementsOf(),
      amount: 10_000,
      payTo: undefined,
    } as unknown as PaymentRequirements;
    expect(fingerprintOf(payloadOf("AAAA"), malformed).requestHash).not.toBe(a.requestHash);
  });
});

describe("repeat marker", () => {
  it("travels in extensionResponses and leaves the recorded response intact", () => {
    const response = settleSucceeded(NETWORK, "e".repeat(64), "GPAYER");
    const marked = markRepeat(response, "rail402");
    const { extensionResponses, ...body } = marked;
    expect(body).toEqual(response);
    expect(extensionResponses).toEqual({ rail402: { settlement: { repeat: true, settledBy: "rail402" } } });
    expect(repeatOf(marked)).toEqual({ repeat: true, settledBy: "rail402" });
    expect(repeatOf(response)).toBeUndefined();
    expect(repeatOf(markRepeat(response, "third_party"))?.settledBy).toBe("third_party");
  });
});

describe("settlement lookup", () => {
  it("starts a settlement when the ledger holds nothing, or only a claim that signed nothing", async () => {
    const { engine, ledger } = engineWith();
    const fingerprint = fingerprintOf(payloadOf("AAAA"), requirementsOf());
    const key = { network: NETWORK, payer: "GPAYER", nonce: "1" };
    expect(await engine.lookup(key, fingerprint)).toEqual({ kind: "none" });
    await ledger.claim(key, fingerprint, "another-worker", 60_000);
    expect(await engine.lookup(key, fingerprint)).toEqual({ kind: "none" });
    expect(await engine.answerRepeat("exact", key, fingerprint)).toBeUndefined();
  });

  it("answers the same request from the record, marked as a repeat", async () => {
    const { engine, ledger, channel, events } = engineWith();
    const { key, fingerprint, response } = await recorded(ledger, channel);
    expect(await engine.lookup(key, fingerprint)).toMatchObject({ kind: "existing" });
    const answer = await engine.answerRepeat("exact", key, fingerprint);
    expect(answer).toEqual(markRepeat(response, "rail402"));
    expect(events).toContainEqual(["repeat", NETWORK, "exact"]);
  });

  it("refuses a different request for the same authorization, naming the recorded transaction", async () => {
    const { engine, ledger, channel, events } = engineWith();
    const { key, hash } = await recorded(ledger, channel);
    for (const different of [
      fingerprintOf(payloadOf("BBBB"), requirementsOf()),
      fingerprintOf(payloadOf("AAAA"), requirementsOf({ amount: "9999" })),
      fingerprintOf(payloadOf("AAAA"), requirementsOf({ payTo: Keypair.random().publicKey() })),
    ]) {
      expect(await engine.lookup(key, different)).toMatchObject({ kind: "conflict" });
      const answer = await engine.answerRepeat("exact", key, different);
      expect(answer).toMatchObject({
        success: false,
        errorReason: "settle_exact_stellar_idempotency_conflict",
        transaction: "",
        payer: key.payer,
      });
      expect(answer?.errorMessage).toContain(hash);
      expect(answer?.extensionResponses).toBeUndefined();
    }
    expect(events.filter(([name]) => name === "repeat")).toHaveLength(0);
  });

  it("waits for an in-flight original, then answers settlement_pending with its transaction", async () => {
    const { engine, ledger, channel } = engineWith();
    const { key, fingerprint, hash } = await recorded(ledger, channel, { finish: false });
    const answer = await engine.answerRepeat("exact", key, fingerprint);
    expect(answer).toMatchObject({ success: false, errorReason: "settlement_pending", transaction: hash });
    expect(answer?.extensionResponses).toEqual({
      rail402: { settlement: { repeat: true, settledBy: "rail402" } },
    });
  });

  it("returns the original's final response once it finishes during the wait", async () => {
    const { engine, ledger, channel } = engineWith();
    const { key, fingerprint, id, response } = await recorded(ledger, channel, { finish: false });
    const answer = engine.answerRepeat("exact", key, fingerprint);
    await ledger.finish(id, "succeeded", response);
    expect(await answer).toEqual(markRepeat(response, "rail402"));
  });

  it("answers a repeat that loses the claim race from the winner's record", async () => {
    const { engine, ledger, channel } = engineWith();
    const { key, fingerprint, response } = await recorded(ledger, channel);
    const payment = {
      transfer: { from: key.payer },
      authorization: { nonce: 42n },
    } as unknown as PreflightedPayment;
    expect(await engine.settle(payloadOf("AAAA"), requirementsOf(), payment)).toEqual(
      markRepeat(response, "rail402"),
    );
    expect(fingerprint).toEqual(fingerprintOf(payloadOf("AAAA"), requirementsOf()));
    expect(await engine.settle(payloadOf("AAAA"), requirementsOf({ amount: "1" }), payment)).toMatchObject({
      errorReason: "settle_exact_stellar_idempotency_conflict",
    });
  });

  it("counts and rethrows a ledger read failure", async () => {
    const { engine, ledger, events } = engineWith();
    vi.spyOn(ledger, "find").mockRejectedValue(new Error("database unavailable"));
    await expect(engine.findSettlement({ network: NETWORK, payer: "G", nonce: "1" })).rejects.toThrow(
      "database unavailable",
    );
    expect(events).toContainEqual(["ledgerReadFailed", NETWORK]);
  });
});

describe("settlement observer", () => {
  it("sees a lease that timed out, and the refusal leaves no record", async () => {
    const { engine, ledger, channels, events } = engineWith();
    await channels.acquire(0);
    const payment = {
      transfer: { from: "GPAYER" },
      authorization: { nonce: 9n },
    } as unknown as PreflightedPayment;
    expect(await engine.settle(payloadOf("AAAA"), requirementsOf(), payment)).toMatchObject({
      errorReason: "settle_exact_stellar_channel_unavailable",
    });
    const [lease] = events.filter(([name]) => name === "leaseWait");
    expect(lease?.[1]).toBe(NETWORK);
    expect(lease?.[2]).toBeGreaterThanOrEqual(15);
    expect(lease?.[3]).toBe(false);
    expect(await ledger.find({ network: NETWORK, payer: "GPAYER", nonce: "9" })).toBeUndefined();
  });

  it("sees reconciliation outcomes and each final state once", async () => {
    const getTransaction = vi.fn(() =>
      Promise.resolve({
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        latestLedgerCloseTime: 1_800_000_000,
        oldestLedgerCloseTime: 1_600_000_000,
      } as rpc.Api.GetTransactionResponse),
    );
    const { engine, ledger, channel, events } = engineWith({ getTransaction });
    const { id } = await recorded(ledger, channel, { finish: false });
    expect(await engine.reconcile()).toBe(1);
    expect(await engine.reconcile()).toBe(0);
    expect((await ledger.get(id))?.state).toBe("expired");
    expect(events).toContainEqual(["reconciled", NETWORK, "expired"]);
    const finalized = events.filter(([name]) => name === "finalized");
    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.[1]).toMatchObject({
      network: NETWORK,
      scheme: "exact",
      state: "expired",
      reason: "settle_exact_stellar_transaction_expired",
      onChainFailure: false,
      settledBy: "rail402",
    });
  });

  it("is contained: an observer that throws never breaks settlement", () => {
    const warn = vi.fn();
    const throwing = containedObserver(
      {
        leaseWait: () => {
          throw new Error("boom");
        },
        submission: () => {
          throw new Error("boom");
        },
        finalized: () => {
          throw new Error("boom");
        },
        reconciled: () => {
          throw new Error("boom");
        },
        unresolvable: () => {
          throw new Error("boom");
        },
        repeat: () => {
          throw new Error("boom");
        },
        ledgerReadFailed: () => {
          throw new Error("boom");
        },
      },
      { ...silentLogger, warn },
    );
    expect(() => {
      throwing.leaseWait(NETWORK, 1, true);
      throwing.repeat(NETWORK, "exact");
      throwing.reconciled(NETWORK, "pending");
      throwing.unresolvable(NETWORK, 0);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
