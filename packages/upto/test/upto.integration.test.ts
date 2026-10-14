/**
 * The upto mechanism against the private Stellar network (docker compose --profile stellar up -d),
 * with the committed contract fixture: `G…` payers settling partial, maximum and zero amounts
 * through a channel account, the authority as operation source and a fee-bump sponsor, with
 * balance assertions that prove the facilitator never holds funds; tampering, replay and
 * concurrency.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Address, Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { LocalNetwork, deployUpto, sponsoredAccount, type IssuedAsset } from "@rail402.dev/testkit";
import { decodeAuthorizationEntry, encodeAuthorizationEntry } from "@rail402.dev/upto";
import { UptoStellarScheme as UptoClient } from "@rail402.dev/upto/client";
import { UptoStellarScheme as UptoFacilitator } from "@rail402.dev/upto/facilitator";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet" as const;
const CAP = 1_000_000n;
/** The private network closes a ledger every second. */
const LEDGER_SECONDS = 1;

describe.skipIf(!available)("upto on a local network", () => {
  let usdc: IssuedAsset;
  let contract: string;
  let sponsor: Keypair;
  let authority: Keypair;
  let channels: Keypair[];
  let recipient: Keypair;

  beforeAll(async () => {
    sponsor = Keypair.random();
    await net.fund(sponsor);
    const [issued, deployed] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    usdc = issued;
    contract = deployed.address;
    authority = await sponsoredAccount(net, sponsor);
    channels = [];
    for (let i = 0; i < 3; i++) channels.push(await sponsoredAccount(net, sponsor));
    recipient = await net.holder(usdc, "0");
  }, 180_000);

  function facilitator(options: ConstructorParameters<typeof UptoFacilitator>[1] = {}) {
    return new UptoFacilitator(
      channels.map((channel) => createEd25519Signer(channel.secret(), NETWORK)),
      {
        settlementAuthority: createEd25519Signer(authority.secret(), NETWORK),
        feeBumpSigner: createEd25519Signer(sponsor.secret(), NETWORK),
        contract,
        rpcConfig: { url: net.rpcUrl },
        ledgerSeconds: LEDGER_SECONDS,
        confirmation: { attempts: 60, intervalMs: 500 },
        ...options,
      },
    );
  }

  function requirements(amount = CAP): PaymentRequirements {
    return {
      scheme: "upto",
      network: NETWORK,
      amount: amount.toString(),
      asset: usdc.sac,
      payTo: recipient.publicKey(),
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true, facilitatorAddress: authority.publicKey() },
    };
  }

  async function pay(payer: Keypair, accepted = requirements(), authV2 = false): Promise<PaymentPayload> {
    const client = new UptoClient(createEd25519Signer(payer.secret(), NETWORK), {
      rpcConfig: { url: net.rpcUrl },
      contracts: contract,
      ledgerSeconds: LEDGER_SECONDS,
      authV2,
    });
    const created = await client.createPaymentPayload(2, accepted);
    return { x402Version: 2, accepted, payload: created.payload };
  }

  /** Token and XLM balances of everyone involved, to prove who paid what. */
  async function balances(payer: Keypair) {
    const token = async (address: string) => net.tokenBalance(usdc.sac, address);
    return {
      payer: await token(payer.publicKey()),
      recipient: await token(recipient.publicKey()),
      facilitatorTokens: [
        await token(authority.publicKey()),
        await token(sponsor.publicKey()),
        await token(contract),
        ...(await Promise.all(channels.map((channel) => token(channel.publicKey())))),
      ],
      authorityXlm: await net.nativeBalance(authority.publicKey()),
      channelXlm: await Promise.all(channels.map((channel) => net.nativeBalance(channel.publicKey()))),
      sponsorXlm: await net.nativeBalance(sponsor.publicKey()),
    };
  }

  async function settledEvents(transaction: string): Promise<string[]> {
    const result = await net.server.getTransaction(transaction);
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS)
      throw new Error(`transaction ${result.status}`);
    return result.events.contractEventsXdr
      .flat()
      .map((event) => event.body().v0().topics()[0]?.sym().toString() ?? "");
  }

  for (const [name, amount] of [
    ["partial", 300_000n],
    ["maximum", CAP],
    ["zero", 0n],
  ] as const) {
    it(`settles a ${name} amount from a G… payer without the facilitator holding funds`, async () => {
      const payer = await net.holder(usdc, "1");
      const payload = await pay(payer);
      const scheme = facilitator();
      expect(await scheme.verify(payload, requirements())).toEqual({
        isValid: true,
        payer: payer.publicKey(),
      });

      const before = await balances(payer);
      const result = await scheme.settle(payload, requirements(amount));
      expect(result).toMatchObject({
        success: true,
        network: NETWORK,
        payer: payer.publicKey(),
        amount: amount.toString(),
      });
      expect(result.transaction).toMatch(/^[0-9a-f]{64}$/);
      const after = await balances(payer);

      expect(after.payer).toBe(before.payer - amount);
      expect(after.recipient).toBe(before.recipient + amount);
      expect(after.facilitatorTokens.every((balance) => balance === 0n)).toBe(true);
      expect(after.authorityXlm).toBe(before.authorityXlm);
      expect(after.channelXlm).toEqual(before.channelXlm);
      expect(after.sponsorXlm).toBeLessThan(before.sponsorXlm);
      expect(before.sponsorXlm - after.sponsorXlm).toBeLessThan(300_000n);

      const events = await settledEvents(result.transaction);
      expect(events.filter((event) => event === "upto_settled")).toHaveLength(1);
      expect(events.filter((event) => event === "transfer")).toHaveLength(amount === 0n ? 0 : 1);
    });
  }

  it("accepts CAP-71 V2 credentials", async () => {
    const payer = await net.holder(usdc, "1");
    const payload = await pay(payer, requirements(), true);
    const result = await facilitator().settle(payload, requirements(5n));
    expect(result).toMatchObject({ success: true, amount: "5" });
  });

  it("refuses a replay of a settled authorization", async () => {
    const payer = await net.holder(usdc, "1");
    const payload = await pay(payer);
    expect((await facilitator().settle(payload, requirements(10n))).success).toBe(true);
    // A new facilitator instance has no memory of the first settlement; the network refuses it.
    const replay = await facilitator().settle(payload, requirements(10n));
    expect(replay).toMatchObject({
      success: false,
      errorReason: "invalid_upto_stellar_payload_nonce_already_used",
    });
    expect((await facilitator().verify(payload, requirements())).invalidReason).toBe(
      "invalid_upto_stellar_payload_nonce_already_used",
    );
  });

  it("submits one transfer for 20 concurrent identical settlements", async () => {
    const payer = await net.holder(usdc, "1");
    const payload = await pay(payer);
    const scheme = facilitator();
    const before = await net.tokenBalance(usdc.sac, payer.publicKey());
    const results = await Promise.all(
      Array.from({ length: 20 }, () => scheme.settle(payload, requirements(7_000n))),
    );
    expect(results.every((result) => result.success)).toBe(true);
    expect(new Set(results.map((result) => result.transaction)).size).toBe(1);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(before - 7_000n);
  });

  describe("tampering fails signature verification", () => {
    function tampered(
      payload: PaymentPayload,
      edit: (entry: xdr.SorobanAuthorizationEntry) => void,
    ): PaymentPayload {
      const entry = decodeAuthorizationEntry(payload.payload["authorization"] as string);
      edit(entry);
      return { ...payload, payload: { authorization: encodeAuthorizationEntry(entry) } };
    }

    it("refuses a changed signature", async () => {
      const payer = await net.holder(usdc, "1");
      const payload = tampered(await pay(payer), (entry) => {
        const signature = entry.credentials().address().signature().vec()?.[0]?.map();
        const bytes = signature
          ?.find((field) => field.key().sym().toString() === "signature")
          ?.val()
          .bytes();
        if (bytes === undefined) throw new Error("no signature");
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      });
      expect((await facilitator().verify(payload, requirements())).invalidReason).toBe(
        "invalid_upto_stellar_payload_invalid_signature",
      );
    });

    it("refuses a changed nonce", async () => {
      const payer = await net.holder(usdc, "1");
      const payload = tampered(await pay(payer), (entry) => {
        const credentials = entry.credentials().address();
        credentials.nonce(xdr.Int64.fromString((credentials.nonce().toBigInt() + 1n).toString()));
      });
      expect((await facilitator().verify(payload, requirements())).invalidReason).toBe(
        "invalid_upto_stellar_payload_invalid_signature",
      );
    });

    it("refuses terms changed consistently in the entry and the requirements", async () => {
      const payer = await net.holder(usdc, "1");
      const other = await net.holder(usdc, "0");
      const original = await pay(payer);
      const changed: PaymentRequirements = { ...requirements(), payTo: other.publicKey() };
      const payload = tampered({ ...original, accepted: changed }, (entry) => {
        const [terms] = entry.rootInvocation().function().contractFn().args();
        for (const field of terms?.map() ?? []) {
          if (field.key().sym().toString() === "recipient") {
            field.val(xdr.ScVal.scvAddress(Address.fromString(other.publicKey()).toScAddress()));
          }
        }
      });
      expect((await facilitator().verify(payload, changed)).invalidReason).toBe(
        "invalid_upto_stellar_payload_invalid_signature",
      );
    });

    it("refuses a signature expiration moved later than signed", async () => {
      const payer = await net.holder(usdc, "1");
      const payload = tampered(await pay(payer), (entry) => {
        const credentials = entry.credentials().address();
        credentials.signatureExpirationLedger(credentials.signatureExpirationLedger() + 1);
      });
      // The terms no longer match the signed expiration: refused before simulation.
      expect((await facilitator().verify(payload, requirements())).invalidReason).toBe(
        "invalid_upto_stellar_payload_expiration_mismatch",
      );
    });
  });

  it("names the cause of an unpayable settlement", async () => {
    const poor = await net.holder(usdc, "0.01");
    expect((await facilitator().verify(await pay(poor), requirements())).invalidReason).toBe(
      "insufficient_funds",
    );

    const stranger = Keypair.random();
    await net.fund(stranger);
    const payer = await net.holder(usdc, "1");
    const toStranger: PaymentRequirements = { ...requirements(), payTo: stranger.publicKey() };
    expect((await facilitator().verify(await pay(payer, toStranger), toStranger)).invalidReason).toBe(
      "invalid_upto_stellar_payload_recipient_trustline_missing",
    );
  });

  it("refuses an authority other than the one the payer named", async () => {
    const payer = await net.holder(usdc, "1");
    const payload = await pay(payer);
    const impostor = await sponsoredAccount(net, sponsor);
    const scheme = facilitator({ settlementAuthority: createEd25519Signer(impostor.secret(), NETWORK) });
    const result = await scheme.settle(payload, requirements(1n));
    expect(result.errorReason).toBe("invalid_upto_stellar_requirements_facilitator_mismatch");
  });
});
