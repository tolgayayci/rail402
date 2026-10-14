import { afterEach, describe, expect, it, vi } from "vitest";
import { Address, FeeBumpTransaction, Keypair, xdr, type Transaction } from "@stellar/stellar-sdk";
import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import {
  MemoryChannelPool,
  MemorySettlementLedger,
  SettlementEngine,
  StellarExactScheme,
  StellarUptoScheme,
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
  } = {},
) {
  const server = new FakeServer();
  const ledger = new MemorySettlementLedger();
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
