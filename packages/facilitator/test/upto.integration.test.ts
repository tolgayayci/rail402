/**
 * `upto` through Rail402's facilitator on the private Stellar network (1 s ledgers), with the
 * committed contract build deployed per run: the derived settlement authority provisioned like a
 * channel, partial, zero and off-chain zero settlements with balance assertions that prove the
 * facilitator holds nothing, idempotent repeats, a different amount refused, and a settlement another
 * transaction landed first — for the same amount and for a different one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FeeBumpTransaction,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import {
  MemorySettlementLedger,
  acceptedAsset,
  authorityStatus,
  createStellarFacilitator,
  deriveAuthorityKeypair,
  deriveChannelKeypairs,
  provisionAuthority,
  provisionChannels,
  repeatOf,
  type UptoSetup,
} from "@rail402.dev/facilitator";
import { recordedUptoSettlement } from "@rail402.dev/stellar";
import { authorityEntry, decodeAuthorizationEntry, settleInvokeArgs } from "@rail402.dev/upto";
import { UptoStellarScheme as UptoClient } from "@rail402.dev/upto/client";
import {
  LocalNetwork,
  deployUpto,
  startRpcProxy,
  type IssuedAsset,
  type LocalUptoContract,
  type RpcProxy,
} from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet" as const;
const CAP = 1_000_000n;
/** Seconds per ledger both sides assume; the private network is faster, so authorizations outlive this. */
const LEDGER_SECONDS = 5;

describe.skipIf(!available)("upto through the Rail402 facilitator", () => {
  let usdc: IssuedAsset;
  let contract: LocalUptoContract;
  let sponsor: Keypair;
  let authority: Keypair;
  let channels: Keypair[];
  let recipient: Keypair;
  let proxy: RpcProxy;

  beforeAll(async () => {
    sponsor = Keypair.random();
    await net.fund(sponsor);
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    authority = deriveAuthorityKeypair(sponsor, NETWORK);
    channels = deriveChannelKeypairs(sponsor, NETWORK, 2);
    await provisionChannels({ server: net.server, passphrase: net.passphrase, sponsor, channels });
    expect(
      await provisionAuthority({ server: net.server, passphrase: net.passphrase, sponsor, authority }),
    ).toBe(true);
    recipient = await net.holder(usdc, "0");
    proxy = await startRpcProxy(net.rpcUrl);
  }, 180_000);

  afterAll(async () => {
    await proxy.close();
  });

  function facilitator(upto: Partial<UptoSetup> = {}) {
    const ledger = new MemorySettlementLedger();
    const built = createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: proxy.url,
          sponsorSecret: sponsor.secret(),
          channelCount: 2,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          ledger,
          timing: { pollIntervalMs: 250 },
          upto: {
            contract: contract.address,
            contractWasmHash: contract.wasmHash,
            ledgerSeconds: LEDGER_SECONDS,
            ...upto,
          },
        },
      ],
    });
    return { core: built.core, ledger, engine: built.networks.get(NETWORK)?.engine };
  }

  function requirements(amount = CAP): PaymentRequirements {
    return {
      scheme: "upto",
      network: NETWORK,
      amount: amount.toString(),
      asset: usdc.sac,
      payTo: recipient.publicKey(),
      maxTimeoutSeconds: 120,
      extra: { areFeesSponsored: true, facilitatorAddress: authority.publicKey() },
    };
  }

  async function pay(payer: Keypair): Promise<PaymentPayload> {
    const client = new UptoClient(createEd25519Signer(payer.secret(), NETWORK), {
      rpcConfig: { url: net.rpcUrl },
      contracts: contract.address,
      ledgerSeconds: LEDGER_SECONDS,
    });
    const accepted = requirements();
    const created = await client.createPaymentPayload(2, accepted);
    return { x402Version: 2, accepted, payload: created.payload };
  }

  function keyOf(payload: PaymentPayload, payer: Keypair) {
    const entry = decodeAuthorizationEntry((payload.payload as { authorization: string }).authorization);
    return {
      network: NETWORK,
      payer: payer.publicKey(),
      nonce: entry.credentials().address().nonce().toString(),
    };
  }

  async function balances(payer: Keypair) {
    const token = (address: string) => net.tokenBalance(usdc.sac, address);
    const facilitatorAccounts = [sponsor, authority, ...channels].map((keypair) => keypair.publicKey());
    return {
      payer: await token(payer.publicKey()),
      recipient: await token(recipient.publicKey()),
      facilitatorTokens: await Promise.all([...facilitatorAccounts, contract.address].map(token)),
      authorityXlm: await net.nativeBalance(authority.publicKey()),
      channelXlm: await Promise.all(channels.map((channel) => net.nativeBalance(channel.publicKey()))),
      sponsorXlm: await net.nativeBalance(sponsor.publicKey()),
    };
  }

  it("provisions the settlement authority with a zero balance and advertises it", async () => {
    expect(await authorityStatus(net.server, authority.publicKey())).toEqual({
      address: authority.publicKey(),
      exists: true,
      balanceStroops: 0n,
      spendableStroops: 0n,
    });
    const supported = facilitator().core.getSupported();
    expect(supported.kinds).toContainEqual({
      x402Version: 2,
      scheme: "upto",
      network: NETWORK,
      extra: { areFeesSponsored: true, facilitatorAddress: authority.publicKey() },
    });
    expect(supported.signers["stellar:*"]).toContain(authority.publicKey());
  });

  it("settles a partial amount once; the facilitator moves no funds and repeats answer from the ledger", async () => {
    const { core, ledger } = facilitator();
    const payer = await net.holder(usdc, "1");
    const payload = await pay(payer);
    expect(await core.verify(payload, requirements())).toEqual({ isValid: true, payer: payer.publicKey() });

    const before = await balances(payer);
    const result = await core.settle(payload, requirements(250_000n));
    expect(result).toMatchObject({
      success: true,
      network: NETWORK,
      payer: payer.publicKey(),
      amount: "250000",
    });
    const after = await balances(payer);
    expect(after.payer).toBe(before.payer - 250_000n);
    expect(after.recipient).toBe(before.recipient + 250_000n);
    expect(after.facilitatorTokens.every((balance) => balance === 0n)).toBe(true);
    expect(after.authorityXlm).toBe(0n);
    expect(after.channelXlm).toEqual(before.channelXlm);
    expect(after.sponsorXlm).toBeLessThan(before.sponsorXlm);

    const record = await ledger.find(keyOf(payload, payer));
    expect(record).toMatchObject({ scheme: "upto", amount: "250000", state: "succeeded" });
    expect(record?.feeChargedStroops).toBe((before.sponsorXlm - after.sponsorXlm).toString());

    const sent = proxy.sent.length;
    const repeat = await core.settle(payload, requirements(250_000n));
    expect(repeatOf(repeat)).toEqual({ repeat: true, settledBy: "rail402" });
    const different = await core.settle(payload, requirements(300_000n));
    expect(different).toMatchObject({
      success: false,
      errorReason: "settle_upto_stellar_idempotency_conflict",
      transaction: result.transaction,
      amount: "300000",
    });
    expect(proxy.sent.length).toBe(sent);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(after.payer);

    // Another facilitator without this ledger still cannot use the authorization: the nonce is spent.
    expect(await facilitator().core.verify(payload, requirements())).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_nonce_already_used",
    });
  });

  it("settles zero on-chain: the nonce is consumed and no funds move", async () => {
    const { core } = facilitator();
    const payer = await net.holder(usdc, "1");
    const payload = await pay(payer);
    const before = await balances(payer);
    const result = await core.settle(payload, requirements(0n));
    expect(result).toMatchObject({ success: true, amount: "0" });
    expect(result.transaction).toMatch(/^[0-9a-f]{64}$/);
    const after = await balances(payer);
    expect(after.payer).toBe(before.payer);
    expect(after.recipient).toBe(before.recipient);
    expect(await facilitator().core.verify(payload, requirements())).toMatchObject({
      invalidReason: "invalid_upto_stellar_payload_nonce_already_used",
    });
  });

  it("settles zero off-chain when configured: no transaction, the authorization used up in the ledger", async () => {
    const { core, ledger } = facilitator({ zeroSettlement: "offchain" });
    const payer = await net.holder(usdc, "1");
    const payload = await pay(payer);
    const sent = proxy.sent.length;
    const before = await balances(payer);
    const result = await core.settle(payload, requirements(0n));
    expect(result).toEqual({
      success: true,
      transaction: "",
      network: NETWORK,
      payer: payer.publicKey(),
      amount: "0",
    });
    expect(proxy.sent.length).toBe(sent);
    expect(await balances(payer)).toEqual(before);
    expect(await ledger.find(keyOf(payload, payer))).toMatchObject({ state: "succeeded", amount: "0" });
    expect(await core.settle(payload, requirements(10n))).toMatchObject({
      errorReason: "settle_upto_stellar_idempotency_conflict",
    });
    expect(await core.verify(payload, requirements())).toMatchObject({
      invalidReason: "invalid_upto_stellar_payload_nonce_already_used",
    });
  });

  describe("a settlement another transaction landed first", () => {
    /**
     * Lands the recorded authorization for `amount` in a transaction of its own, with the settlement
     * authority as operation source (as another replica sharing the sponsor would) and a separate
     * fee payer, before Rail402's transaction reaches the network.
     */
    async function landFirst(envelopeXdr: string, amount: bigint): Promise<string> {
      const recorded = recordedUptoSettlement(envelopeXdr, net.passphrase);
      if (recorded?.payerEntry === undefined) throw new Error("not an upto settlement envelope");
      const submitter = Keypair.random();
      await net.fund(submitter);
      const account = await net.server.getAccount(submitter.publicKey());
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
      prepared.sign(submitter, authority);
      return (await net.submit(prepared)).txHash;
    }

    async function settleAfter(amount: bigint, landed: bigint) {
      const { core, ledger } = facilitator();
      const payer = await net.holder(usdc, "1");
      const payload = await pay(payer);
      const hashes: string[] = [];
      proxy.injectBefore("sendTransaction", async (params) => {
        if (hashes.length > 0) return;
        const envelope = TransactionBuilder.fromXDR(
          (params as { transaction: string }).transaction,
          net.passphrase,
        );
        if (!(envelope instanceof FeeBumpTransaction)) return;
        hashes.push(await landFirst(envelope.toXDR(), landed));
      });
      try {
        const result = await core.settle(payload, requirements(amount));
        const [elsewhere] = hashes;
        if (elsewhere === undefined) throw new Error("nothing landed first");
        return { result, elsewhere, record: await ledger.find(keyOf(payload, payer)), payer };
      } finally {
        proxy.injectBefore("sendTransaction", undefined);
      }
    }

    it("succeeds with that transaction when it settled the same amount", async () => {
      const { result, elsewhere, record, payer } = await settleAfter(200_000n, 200_000n);
      expect(result).toEqual({
        success: true,
        transaction: elsewhere,
        network: NETWORK,
        payer: payer.publicKey(),
        amount: "200000",
      });
      expect(record).toMatchObject({ state: "succeeded", settledBy: "third_party" });
      const ours = await net.server.getTransaction(record?.transactionHash ?? "");
      expect(ours.status).toBe(rpc.Api.GetTransactionStatus.FAILED);
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(10_000_000n - 200_000n);
    });

    it("answers settled_elsewhere when it settled a different amount", async () => {
      const { result, elsewhere, record, payer } = await settleAfter(200_000n, 150_000n);
      expect(result).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_settled_elsewhere",
        transaction: elsewhere,
        amount: "200000",
      });
      expect(result.errorMessage).toContain("150000");
      expect(record).toMatchObject({ state: "failed", settledBy: "third_party" });
      expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(10_000_000n - 150_000n);
    });
  });
});
