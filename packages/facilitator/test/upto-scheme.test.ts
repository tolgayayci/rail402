import { afterEach, describe, expect, it, vi } from "vitest";
import { Address, FeeBumpTransaction, Keypair, xdr, type Transaction } from "@stellar/stellar-sdk";
import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import {
  MemoryChannelPool,
  MemorySettlementLedger,
  SettlementEngine,
  StellarExactScheme,
  StellarUptoScheme,
  recordRestoreHold,
  repeatOf,
  type SponsorGuard,
  type UptoPolicy,
} from "@rail402.dev/facilitator";
import {
  CAP,
  CONTRACT,
  FakeServer,
  LEDGER,
  NETWORK,
  PASSPHRASE,
  authority,
  channel,
  entry,
  errorEvent,
  errorSimulation,
  payer,
  payment,
  policy,
  requirements,
  sponsor,
  successSimulation,
  terms,
  uptoPolicy,
} from "./upto-helpers.ts";

function setup(
  options: {
    upto?: Partial<UptoPolicy>;
    guard?: SponsorGuard;
    channels?: MemoryChannelPool;
    authorityReady?: () => boolean;
    ledger?: MemorySettlementLedger;
  } = {},
) {
  const server = new FakeServer();
  const ledger = options.ledger ?? new MemorySettlementLedger();
  const channels = options.channels ?? new MemoryChannelPool([channel.publicKey()]);
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
    timing: { pollIntervalMs: 5, duplicateWaitMs: 100, channelWaitMs: 20, confirmTimeoutMs: 1_000 },
    ...(options.guard === undefined ? {} : { guard: options.guard }),
  });
  const scheme = new StellarUptoScheme({
    network: NETWORK,
    passphrase: PASSPHRASE,
    server: server.asServer(),
    policy,
    upto: { ...uptoPolicy, ...options.upto },
    engine,
    ...(options.authorityReady === undefined ? {} : { authorityReady: options.authorityReady }),
  });
  return { server, ledger, engine, scheme, channels };
}

const settleRequirements = (amount: bigint) => requirements({ amount: amount.toString() });

/**
 * A ledger whose database was restored to an earlier state, as a backup restore leaves it, with the
 * ledger the hold counts from per network once something recorded it (`recorded`).
 */
class RestoredLedger extends MemorySettlementLedger {
  private readonly from: Map<string, number>;

  constructor(recorded: Readonly<Record<string, number>> = {}) {
    super();
    this.from = new Map(Object.entries(recorded));
  }

  rewindAnchor(network: string): Promise<number | null> {
    return Promise.resolve(this.from.get(network) ?? null);
  }

  rewindLedger(network: string, ledger: number, restartedBelow?: number): Promise<number> {
    const recorded = this.from.get(network);
    const restarted =
      recorded !== undefined && restartedBelow !== undefined && recorded > ledger + restartedBelow;
    const from = recorded === undefined || restarted ? ledger : recorded;
    this.from.set(network, from);
    return Promise.resolve(from);
  }
}

/**
 * Ledgers on-chain settlement waits after a restore with the helpers' policy: the longest window rule 7
 * accepts at the shortest ledger time it counts, ceil(300 s / 1 s) + 2 ledgers, and 5 more for a ledger
 * reading up to 5 s old.
 */
const RESTORE_HOLD_LEDGERS = 300 + 2 + 5;

/** A payment whose authorization expires `ledgers` after `ledger`. */
const paymentAt = (ledger: number, ledgers = 12) =>
  payment({ authorization: entry({ terms: terms({ expirationLedger: ledger + ledgers }) }) });

function keyOf(payload: PaymentPayload) {
  const body = payload.payload as { authorization: string };
  const decoded = xdr.SorobanAuthorizationEntry.fromXDR(body.authorization, "base64");
  return {
    network: NETWORK,
    payer: payer.publicKey(),
    nonce: decoded.credentials().address().nonce().toBigInt().toString(),
  };
}

function withoutMarker(response: SettleResponse): SettleResponse {
  const { extensionResponses: _, ...body } = response;
  return body;
}

function archivedInstance(): xdr.SorobanTransactionData {
  const instance = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(CONTRACT).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  return new xdr.SorobanTransactionData({
    ext: new xdr.SorobanTransactionDataExt(1, new xdr.SorobanResourcesExtV0({ archivedSorobanEntries: [0] })),
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: [instance] }),
      instructions: 1,
      diskReadBytes: 1,
      writeBytes: 1,
    }),
    resourceFee: xdr.Int64.fromString("150000"),
  });
}

describe("the upto scheme in Rail402", () => {
  it("advertises sponsored fees and the derived settlement authority", () => {
    const { scheme } = setup();
    expect(scheme.scheme).toBe("upto");
    expect(scheme.getExtra(NETWORK)).toEqual({
      areFeesSponsored: true,
      facilitatorAddress: authority.publicKey(),
    });
    expect(scheme.getSigners(NETWORK).sort()).toEqual(
      [sponsor.publicKey(), channel.publicKey(), authority.publicKey()].sort(),
    );
  });

  it("treats the authority as a facilitator account for exact payments too", () => {
    const { engine } = setup();
    expect(engine.facilitatorAddresses.has(authority.publicKey())).toBe(true);
    const exact = new StellarExactScheme({
      network: NETWORK,
      passphrase: PASSPHRASE,
      rpcUrl: "http://127.0.0.1:1/rpc",
      server: new FakeServer().asServer(),
      policy,
      engine,
    });
    expect(exact.getSigners(NETWORK)).toContain(authority.publicKey());
  });

  it("refuses an engine without a settlement authority", () => {
    const server = new FakeServer();
    const engine = new SettlementEngine({
      network: NETWORK,
      passphrase: PASSPHRASE,
      rpcUrl: "http://127.0.0.1:1/rpc",
      server: server.asServer(),
      policy,
      ledger: new MemorySettlementLedger(),
      channels: new MemoryChannelPool([channel.publicKey()]),
      channelKeys: new Map([[channel.publicKey(), channel]]),
      sponsor,
    });
    expect(
      () =>
        new StellarUptoScheme({
          network: NETWORK,
          passphrase: PASSPHRASE,
          server: server.asServer(),
          policy,
          upto: uptoPolicy,
          engine,
        }),
    ).toThrow(/settlement authority/);
  });

  it("verifies the cap by simulating settle with the authority as operation source, writing nothing", async () => {
    const { scheme, server, ledger } = setup();
    const payload = payment();
    expect(await scheme.verify(payload, requirements())).toEqual({ isValid: true, payer: payer.publicKey() });
    const [simulated] = server.simulated;
    const operation = simulated?.operations[0];
    expect(operation?.type).toBe("invokeHostFunction");
    if (operation?.type !== "invokeHostFunction") return;
    expect(operation.source).toBe(authority.publicKey());
    expect(operation.auth?.map((auth) => auth.credentials().switch().name)).toEqual([
      "sorobanCredentialsAddress",
      "sorobanCredentialsSourceAccount",
    ]);
    expect(server.sent).toEqual([]);
    expect(await ledger.find(keyOf(payload))).toBeUndefined();
  });

  it("settles a partial amount through a channel, the authority and a sponsor fee bump", async () => {
    const { scheme, server, ledger } = setup();
    const payload = payment();
    const result = await scheme.settle(payload, settleRequirements(250_000n));
    expect(result).toMatchObject({
      success: true,
      network: NETWORK,
      payer: payer.publicKey(),
      amount: "250000",
    });
    expect(result.transaction).toMatch(/^[0-9a-f]{64}$/);

    expect(server.sent).toHaveLength(1);
    const sent = server.sent[0];
    expect(sent).toBeInstanceOf(FeeBumpTransaction);
    if (!(sent instanceof FeeBumpTransaction)) return;
    expect(sent.feeSource).toBe(sponsor.publicKey());
    const inner: Transaction = sent.innerTransaction;
    expect(inner.source).toBe(channel.publicKey());
    expect(inner.operations[0]?.source).toBe(authority.publicKey());
    expect(inner.ledgerBounds?.maxLedger).toBe(terms().expirationLedger + 1);
    expect(inner.signatures).toHaveLength(2);

    expect(await ledger.find(keyOf(payload))).toMatchObject({
      scheme: "upto",
      amount: "250000",
      state: "succeeded",
      transactionHash: result.transaction,
      response: result,
    });
  });

  it("answers a repeat from the ledger and refuses the authorization for another amount", async () => {
    const { scheme, server } = setup();
    const payload = payment();
    const first = await scheme.settle(payload, settleRequirements(250_000n));

    const repeat = await scheme.settle(payload, settleRequirements(250_000n));
    expect(withoutMarker(repeat)).toEqual(first);
    expect(repeatOf(repeat)).toEqual({ repeat: true, settledBy: "rail402" });

    const other = await scheme.settle(payload, settleRequirements(300_000n));
    expect(other).toMatchObject({
      success: false,
      errorReason: "settle_upto_stellar_idempotency_conflict",
      transaction: first.transaction,
      amount: "300000",
      payer: payer.publicKey(),
    });
    expect(other.errorMessage).toContain("250000");
    expect(other.errorMessage).toContain(first.transaction);
    expect(server.sent).toHaveLength(1);

    const verified = await scheme.verify(payload, requirements());
    expect(verified).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_nonce_already_used",
    });
    expect(verified.invalidMessage).toContain(first.transaction);
  });

  it("lets concurrent requests for different amounts settle once", async () => {
    const { scheme, server } = setup();
    const payload = payment();
    const results = await Promise.all(
      [100_000n, 200_000n, 300_000n, 400_000n, 500_000n].map((amount) =>
        scheme.settle(payload, settleRequirements(amount)),
      ),
    );
    expect(results.filter((result) => result.success)).toHaveLength(1);
    const refused = results.filter((result) => !result.success);
    expect(refused.map((result) => result.errorReason)).toEqual(
      refused.map(() => "settle_upto_stellar_idempotency_conflict"),
    );
    expect(server.sent).toHaveLength(1);
  });

  it("settles zero on-chain by default", async () => {
    const { scheme, server } = setup();
    const result = await scheme.settle(payment(), settleRequirements(0n));
    expect(result).toMatchObject({ success: true, amount: "0" });
    expect(result.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(server.sent).toHaveLength(1);
  });

  it("settles zero off-chain when configured: no transaction, the authorization consumed in the ledger", async () => {
    const refusing: SponsorGuard = { admit: () => Promise.resolve({ ok: false, reason: "no funds" }) };
    const { scheme, server, ledger } = setup({ upto: { zeroSettlement: "offchain" }, guard: refusing });
    const payload = payment();
    const result = await scheme.settle(payload, settleRequirements(0n));
    expect(result).toEqual({
      success: true,
      transaction: "",
      network: NETWORK,
      payer: payer.publicKey(),
      amount: "0",
    });
    expect(server.sent).toEqual([]);
    expect(server.simulated).toHaveLength(1);
    const record = await ledger.find(keyOf(payload));
    expect(record).toMatchObject({ scheme: "upto", amount: "0", state: "succeeded", response: result });
    expect(record?.envelopeXdr).toBeUndefined();

    const repeat = await scheme.settle(payload, settleRequirements(0n));
    expect(withoutMarker(repeat)).toEqual(result);
    expect(repeatOf(repeat)?.repeat).toBe(true);
    expect(await scheme.settle(payload, settleRequirements(1n))).toMatchObject({
      errorReason: "settle_upto_stellar_idempotency_conflict",
    });
    expect(await scheme.verify(payload, requirements())).toMatchObject({
      invalidReason: "invalid_upto_stellar_payload_nonce_already_used",
    });

    // A non-zero amount still needs the sponsor, so the guard applies to it.
    expect(await scheme.settle(payment(), settleRequirements(5n))).toMatchObject({
      errorReason: "settle_upto_stellar_sponsor_unavailable",
      amount: "5",
    });
  });

  it("refuses payments with a coded answer while the settlement authority account is missing", async () => {
    let ready = false;
    const { scheme, server, ledger } = setup({
      upto: { zeroSettlement: "offchain" },
      authorityReady: () => ready,
    });
    const payload = payment();
    expect(await scheme.verify(payload, requirements())).toMatchObject({
      isValid: false,
      invalidReason: "settle_upto_stellar_authority_unavailable",
      payer: payer.publicKey(),
    });
    const refused = await scheme.settle(payload, settleRequirements(5n));
    expect(refused).toMatchObject({
      success: false,
      errorReason: "settle_upto_stellar_authority_unavailable",
      transaction: "",
      amount: "5",
    });
    expect(refused.errorMessage?.trim()).not.toBe("");
    expect(server.sent).toEqual([]);
    expect(await ledger.find(keyOf(payload))).toBeUndefined();
    // An off-chain zero needs no authority account.
    expect(await scheme.settle(payment(), settleRequirements(0n))).toMatchObject({
      success: true,
      amount: "0",
    });
    // Once the account exists, the same payment settles.
    ready = true;
    expect(await scheme.settle(payload, settleRequirements(5n))).toMatchObject({
      success: true,
      amount: "5",
    });
  });

  it("drops the claim when an off-chain zero cannot settle, so it may be retried", async () => {
    const { scheme, server, ledger } = setup({ upto: { zeroSettlement: "offchain" } });
    server.simulate = () =>
      errorSimulation([errorEvent(xdr.ScError.sceAuth(xdr.ScErrorCode.scecExistingValue()))]);
    const payload = payment();
    expect(await scheme.settle(payload, settleRequirements(0n))).toMatchObject({
      success: false,
      errorReason: "invalid_upto_stellar_payload_nonce_already_used",
      amount: "0",
    });
    expect(await ledger.find(keyOf(payload))).toBeUndefined();
  });

  it("counts a ledger time under one second as one second, the shortest the restore hold allows for", async () => {
    const { scheme } = setup({ upto: { ledgerSeconds: 0.5 } });
    const accepted = requirements({ maxTimeoutSeconds: 300 });
    // ceil(300 / 0.5) + 2 = 602 ledgers would allow it; at one second, 302 do not.
    const payload = payment({
      accepted,
      authorization: entry({ terms: terms({ expirationLedger: LEDGER + 500 }) }),
    });
    expect(await scheme.verify(payload, accepted)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_signature_expiration_too_far",
    });
  });

  describe("after the settlement ledger was restored to an earlier state", () => {
    it("holds on-chain settlement where zeros settle off-chain, so a zero the restore lost is not charged again", async () => {
      const payload = payment();
      // Settled at zero off-chain: only the ledger record says the authorization was used.
      const live = setup({ upto: { zeroSettlement: "offchain" } });
      expect(await live.scheme.settle(payload, settleRequirements(0n))).toMatchObject({
        success: true,
        transaction: "",
        amount: "0",
      });
      // The database is restored from a backup taken before that record.
      const restored = setup({ upto: { zeroSettlement: "offchain" }, ledger: new RestoredLedger() });
      expect(await restored.ledger.find(keyOf(payload))).toBeUndefined();
      expect(await restored.scheme.verify(payload, requirements())).toMatchObject({
        isValid: false,
        invalidReason: "settle_upto_stellar_authority_unavailable",
        payer: payer.publicKey(),
      });
      const refused = await restored.scheme.settle(payload, settleRequirements(5n));
      expect(refused).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_authority_unavailable",
        transaction: "",
        amount: "5",
      });
      expect(refused.errorMessage).toMatch(/restored/);
      // Nothing has recorded where the hold counts from yet: it holds until something does.
      expect(refused.errorMessage).toContain("ledger the hold counts from is recorded");
      expect(restored.server.sent).toEqual([]);
      expect(await restored.ledger.find(keyOf(payload))).toBeUndefined();
      // A zero moves nothing, so it still settles off-chain.
      expect(await restored.scheme.settle(payment(), settleRequirements(0n))).toMatchObject({
        success: true,
        transaction: "",
        amount: "0",
      });
    });

    it("settles on chain again once the chain has passed the longest window rule 7 can accept", async () => {
      const ledger = new RestoredLedger({ [NETWORK]: LEDGER });
      const last = setup({ upto: { zeroSettlement: "offchain" }, ledger });
      last.server.ledger = LEDGER + RESTORE_HOLD_LEDGERS;
      expect(await last.scheme.settle(paymentAt(last.server.ledger), settleRequirements(5n))).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_authority_unavailable",
      });
      const after = setup({ upto: { zeroSettlement: "offchain" }, ledger });
      after.server.ledger = LEDGER + RESTORE_HOLD_LEDGERS + 1;
      expect(await after.scheme.settle(paymentAt(after.server.ledger), settleRequirements(5n))).toMatchObject(
        {
          success: true,
          amount: "5",
        },
      );
      expect(after.server.sent).toHaveLength(1);
    });

    it("counts the hold in ledgers, so a ledger time set below the real one does not shorten it", async () => {
      // With 2 s per ledger the window is ceil(300 / 2) + 2 = 152 ledgers, whatever time they take.
      const upto = { zeroSettlement: "offchain" as const, ledgerSeconds: 2 };
      const ledger = new RestoredLedger({ [NETWORK]: LEDGER });
      const later = setup({ upto, ledger });
      later.server.ledger = LEDGER + 121;
      expect(await later.scheme.settle(paymentAt(LEDGER, 152), settleRequirements(5n))).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_authority_unavailable",
      });
      expect(later.server.sent).toEqual([]);
    });

    it("keeps the hold whatever ledger time is set now, so raising it at the restore does not shorten it", async () => {
      // Accepted under a 2 s ledger time: rule 7 let it run ceil(300 / 2) + 2 = 152 ledgers.
      const accepted = requirements({ maxTimeoutSeconds: 300 });
      const payload = payment({
        accepted,
        authorization: entry({ terms: terms({ expirationLedger: LEDGER + 150 }) }),
      });
      const live = setup({ upto: { zeroSettlement: "offchain", ledgerSeconds: 2 } });
      expect(await live.scheme.settle(payload, { ...accepted, amount: "0" })).toMatchObject({
        success: true,
        transaction: "",
      });
      // Restored with the default 5 s: the authorization is still valid 125 ledgers later.
      const ledger = new RestoredLedger({ [NETWORK]: LEDGER });
      const later = setup({ upto: { zeroSettlement: "offchain" }, ledger });
      later.server.ledger = LEDGER + 125;
      expect(await later.scheme.settle(payload, { ...accepted, amount: "5" })).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_authority_unavailable",
      });
      expect(later.server.sent).toEqual([]);
    });

    it("holds from its own reading until the ledger the hold counts from is recorded, so a low reading cannot set it", async () => {
      // The restore is on record, but no replica has recorded where the hold counts from yet.
      const ledger = new RestoredLedger();
      const low = setup({ upto: { zeroSettlement: "offchain" }, ledger });
      low.server.ledger = 10;
      expect(await low.scheme.verify(paymentAt(10), requirements())).toMatchObject({
        isValid: false,
        invalidReason: "settle_upto_stellar_authority_unavailable",
      });
      expect(await ledger.rewindAnchor(NETWORK)).toBeNull();
      const honest = setup({ upto: { zeroSettlement: "offchain" }, ledger });
      honest.server.ledger = LEDGER + 20;
      const settled = await honest.scheme.settle(paymentAt(honest.server.ledger), settleRequirements(5n));
      expect(settled).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_authority_unavailable",
      });
      expect(honest.server.sent).toEqual([]);
      expect(await ledger.rewindAnchor(NETWORK)).toBeNull();
    });

    it("never moves the hold for a request's ledger reading far below it, which a lagging or wrong provider can give", async () => {
      const ledger = new RestoredLedger({ [NETWORK]: LEDGER });
      // One reading 400 ledgers below where the hold counts from, with an authorization that fits it.
      const low = setup({ upto: { zeroSettlement: "offchain" }, ledger });
      low.server.ledger = LEDGER - 400;
      expect(await low.scheme.verify(paymentAt(low.server.ledger), requirements())).toMatchObject({
        isValid: false,
        invalidReason: "settle_upto_stellar_authority_unavailable",
      });
      // Back on the real chain, 20 ledgers later: still held.
      const honest = setup({ upto: { zeroSettlement: "offchain" }, ledger });
      honest.server.ledger = LEDGER + 20;
      const settled = await honest.scheme.settle(paymentAt(honest.server.ledger), settleRequirements(5n));
      expect(settled).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_authority_unavailable",
      });
      expect(settled.errorMessage).toContain(`ledger ${String(LEDGER + RESTORE_HOLD_LEDGERS)}`);
      expect(honest.server.sent).toEqual([]);
    });

    it("holds until authorizations accepted before a minute-old first reading have expired", async () => {
      // Under a 1 s ledger time a zero accepted at LEDGER may run ceil(300 / 1) + 2 ledgers.
      const upto = { zeroSettlement: "offchain" as const, ledgerSeconds: 1 };
      const accepted = requirements({ maxTimeoutSeconds: 300 });
      const payload = payment({
        accepted,
        authorization: entry({ terms: terms({ expirationLedger: LEDGER + 302 }) }),
      });
      const live = setup({ upto });
      expect(await live.scheme.settle(payload, { ...accepted, amount: "0" })).toMatchObject({
        success: true,
      });
      // After the restore, the first reading comes from a provider 55 s behind: ledger LEDGER - 10.
      const ledger = new RestoredLedger();
      const now = new Date();
      expect(
        await recordRestoreHold({
          ledger,
          network: NETWORK,
          passphrase: PASSPHRASE,
          timeoutMaxSeconds: 300,
          latestLedger: LEDGER - 10,
          closedAt: new Date(now.getTime() - 55_000),
          now,
          networkPassphrase: () => Promise.resolve(PASSPHRASE),
        }),
      ).toMatchObject({ recorded: expect.any(Number) as number });
      const later = setup({ upto, ledger });
      later.server.ledger = LEDGER + 298;
      expect(await later.scheme.settle(payload, { ...accepted, amount: "5" })).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_authority_unavailable",
      });
      expect(later.server.sent).toEqual([]);
    });

    it("holds with a ledger that can record where the hold counts from but cannot read it", async () => {
      class RecordOnly extends MemorySettlementLedger {
        rewindLedger(_network: string, ledger: number): Promise<number> {
          return Promise.resolve(ledger);
        }
      }
      const { scheme, server } = setup({ upto: { zeroSettlement: "offchain" }, ledger: new RecordOnly() });
      expect(await scheme.verify(payment(), requirements())).toMatchObject({
        isValid: false,
        invalidReason: "settle_upto_stellar_authority_unavailable",
      });
      expect(await scheme.settle(payment(), settleRequirements(5n))).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_authority_unavailable",
      });
      expect(server.sent).toEqual([]);
    });

    it("holds whatever the zero settlement mode, so switching to on-chain zeros does not lift it", async () => {
      // Zeros settled off-chain before the restore spent no nonce, even if zeros now settle on chain.
      const { scheme, server } = setup({ upto: { zeroSettlement: "onchain" }, ledger: new RestoredLedger() });
      expect(await scheme.verify(payment(), requirements())).toMatchObject({
        isValid: false,
        invalidReason: "settle_upto_stellar_authority_unavailable",
      });
      expect(await scheme.settle(payment(), settleRequirements(5n))).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_authority_unavailable",
      });
      expect(server.sent).toEqual([]);
      // A zero on chain moves nothing and uses the authorization up for good.
      expect(await scheme.settle(payment(), settleRequirements(0n))).toMatchObject({
        success: true,
        amount: "0",
      });
      expect(server.sent).toHaveLength(1);
    });
  });

  it("refuses to pay for restoring an archived settlement contract", async () => {
    const { scheme, server } = setup();
    server.simulate = () => successSimulation([], { data: archivedInstance() });
    expect(await scheme.verify(payment(), requirements())).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_settlement_contract_archived",
    });
    expect(await scheme.settle(payment(), settleRequirements(1n))).toMatchObject({
      success: false,
      errorReason: "invalid_upto_stellar_settlement_contract_archived",
      amount: "1",
    });
    expect(server.sent).toEqual([]);
  });

  it("names a payer account that does not exist instead of a bad signature", async () => {
    const { scheme, server } = setup();
    server.simulate = () =>
      errorSimulation([
        errorEvent(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction()), "failed account authentication"),
      ]);
    server.accounts = new Set();
    expect(await scheme.verify(payment(), requirements())).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_account_missing",
    });
    expect(await scheme.settle(payment(), settleRequirements(1n))).toMatchObject({
      errorReason: "invalid_upto_stellar_payload_account_missing",
    });

    server.accounts = new Set([payer.publicKey()]);
    expect(await scheme.verify(payment(), requirements())).toMatchObject({
      invalidReason: "invalid_upto_stellar_payload_invalid_signature",
    });
  });

  it("answers busy channels with the upto code and keeps nothing claimed", async () => {
    const channels = new MemoryChannelPool([channel.publicKey()]);
    await channels.acquire(0);
    const { scheme, ledger } = setup({ channels });
    const payload = payment();
    expect(await scheme.settle(payload, settleRequirements(7n))).toMatchObject({
      success: false,
      errorReason: "settle_upto_stellar_channel_unavailable",
      amount: "7",
    });
    expect(await ledger.find(keyOf(payload))).toBeUndefined();
  });

  it("reports a settlement in progress to verify", async () => {
    const { scheme, ledger, engine } = setup();
    const payload = payment();
    await ledger.claim(
      engine.keyOf(payer.publicKey(), BigInt(keyOf(payload).nonce)),
      {
        payloadHash: "x",
        requestHash: "y",
      },
      "someone",
      60_000,
      { scheme: "upto", amount: "1" },
    );
    expect(await scheme.verify(payload, requirements())).toMatchObject({
      isValid: false,
      invalidReason: "settle_upto_stellar_settlement_in_progress",
    });
  });

  describe("with a ledger reading a few ledgers old", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Verifies once at LEDGER, so the scheme holds that reading, then lets 10 ledgers close in 2 s. */
    async function aged() {
      vi.useFakeTimers({ toFake: ["Date"] });
      const setup_ = setup();
      expect((await setup_.scheme.verify(payment(), requirements())).isValid).toBe(true);
      setup_.server.ledger = LEDGER + 10;
      vi.advanceTimersByTime(2_000);
      return setup_;
    }

    it("decides an expiration past the window again on a fresh reading", async () => {
      const { scheme } = await aged();
      // Signed at LEDGER + 10 for 60 s (12 ledgers): past the window of the old reading.
      const payload = payment({
        authorization: entry({ terms: terms({ expirationLedger: LEDGER + 22 }) }),
      });
      expect(await scheme.verify(payload, requirements())).toEqual({
        isValid: true,
        payer: payer.publicKey(),
      });

      const tooFar = payment({ authorization: entry({ terms: terms({ expirationLedger: LEDGER + 25 }) }) });
      expect(await scheme.verify(tooFar, requirements())).toMatchObject({
        invalidReason: "invalid_upto_stellar_signature_expiration_too_far",
        // Decided on the fresh reading: LEDGER + 10, plus 12 ledgers, plus 2 of tolerance.
        invalidMessage: expect.stringContaining(`at most ledger ${LEDGER + 24}`) as unknown,
      });
    });

    it("decides a start ledger not yet reached again on a fresh reading", async () => {
      const { scheme } = await aged();
      const payload = payment({
        authorization: entry({ terms: terms({ validAfterLedger: LEDGER + 11 }) }),
      });
      expect(await scheme.verify(payload, requirements())).toEqual({
        isValid: true,
        payer: payer.publicKey(),
      });
    });
  });

  it("refuses before any RPC work with the preflight's code and the requested amount", async () => {
    const { scheme, server } = setup();
    const payload = payment({
      authorization: entry({ terms: terms({ recipient: Keypair.random().publicKey() }) }),
    });
    expect(await scheme.settle(payload, settleRequirements(3n))).toMatchObject({
      success: false,
      errorReason: "invalid_upto_stellar_payload_wrong_recipient",
      amount: "3",
      payer: payer.publicKey(),
    });
    expect(await scheme.settle(payment(), settleRequirements(CAP + 1n))).toMatchObject({
      errorReason: "invalid_upto_stellar_payload_settlement_exceeds_amount",
      amount: (CAP + 1n).toString(),
    });
    expect(server.simulated).toEqual([]);
  });
});
