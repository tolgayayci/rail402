/**
 * Muxed (M…) payTo addresses on the private Stellar network (1 s ledgers).
 *
 * A muxed address names a base G… account plus a 64-bit id. A SAC transfer to one credits the base
 * account and, under CAP-67, emits a `transfer` event whose `to` topic is the base account and whose
 * data is `{ amount, to_muxed_id }`. The x402 exact verifier (`@x402/stellar`) matches the simulated
 * event's recipient and amount against payTo literally, so a payment to an M… payTo can never verify:
 * Rail402 refuses one up front with `invalid_exact_stellar_requirements_invalid_pay_to`, before it
 * simulates or submits anything, and no funds move. `upto` refuses a muxed payTo by design (the
 * contract pulls funds with `transfer_from`, which carries no muxed id).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  MuxedAccount,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  MemorySettlementLedger,
  acceptedAsset,
  createStellarFacilitator,
  deriveAuthorityKeypair,
  deriveChannelKeypairs,
  provisionAuthority,
  provisionChannels,
} from "@rail402.dev/facilitator";
import { sacTransferEvents } from "@rail402.dev/stellar";
import { UptoStellarScheme as UptoClient } from "@rail402.dev/upto/client";
import {
  LocalNetwork,
  classicTestAsset,
  deployUpto,
  requirementsFor,
  startRpcProxy,
  uptoDriver,
  type IssuedAsset,
  type LocalUptoContract,
  type RpcProxy,
} from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";
const PRICE = 1_000_000n;

const muxed = (account: string, id: bigint) =>
  new MuxedAccount(new Account(account, "0"), id.toString()).accountId();

describe.skipIf(!available)("exact payments to a muxed payTo", () => {
  let usdc: IssuedAsset;
  let sponsor: Keypair;
  let seller: Keypair;
  let proxy: RpcProxy;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    sponsor = Keypair.random();
    await net.fund(sponsor);
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
    await proxy.close();
  });

  it("refuses the payment before simulating or submitting anything, and nothing moves", async () => {
    const facilitator = createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: proxy.url,
          sponsorSecret: sponsor.secret(),
          channelCount: 2,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          policy: { maxTransactionFeeStroops: 2_000_000 },
          ledger: new MemorySettlementLedger(),
        },
      ],
    });
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const payTo = muxed(seller.publicKey(), 4_242n);
    const terms = requirementsFor(usdc.sac, payTo, PRICE, 120);
    const requirements = terms as PaymentRequirements;
    // Signed the way the stock client signs: the payer authorizes transfer(payer, M…, amount).
    const payload = (await net.payment(payer, terms)) as PaymentPayload;
    const before = {
      payer: await net.tokenBalance(usdc.sac, payer.publicKey()),
      seller: await net.tokenBalance(usdc.sac, seller.publicKey()),
      sponsor: await net.nativeBalance(sponsor.publicKey()),
    };

    const methods: string[] = [];
    const onRequest = ({ method }: { method: string }) => methods.push(method);
    proxy.events.on("request", onRequest);
    try {
      const verified = await facilitator.core.verify(payload, requirements);
      expect(verified).toMatchObject({
        isValid: false,
        invalidReason: "invalid_exact_stellar_requirements_invalid_pay_to",
      });
      expect(verified.invalidMessage).toContain("muxed");
      const settled = await facilitator.core.settle(payload, requirements);
      expect(settled).toMatchObject({
        success: false,
        errorReason: "invalid_exact_stellar_requirements_invalid_pay_to",
        transaction: "",
      });
      expect(settled.errorMessage).toContain("muxed");
    } finally {
      proxy.events.off("request", onRequest);
    }
    expect(methods).not.toContain("simulateTransaction");
    expect(methods).not.toContain("sendTransaction");
    expect(proxy.sent).toEqual([]);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(before.payer);
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(before.seller);
    expect(await net.nativeBalance(sponsor.publicKey())).toBe(before.sponsor);
  });

  it("would have landed with the CAP-67 event shape the exact verifier cannot match", async () => {
    // The same transfer submitted by the payer itself: it lands, credits the base account, and its
    // event names the base account with the muxed id in the data — not the payTo the payer signed.
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const payTo = muxed(seller.publicKey(), 77n);
    const sellerBefore = await net.tokenBalance(usdc.sac, seller.publicKey());
    const source = await net.server.getAccount(payer.publicKey());
    const built = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: net.passphrase })
      .addOperation(
        new Contract(usdc.sac).call(
          "transfer",
          nativeToScVal(payer.publicKey(), { type: "address" }),
          nativeToScVal(payTo, { type: "address" }),
          nativeToScVal(PRICE, { type: "i128" }),
        ),
      )
      .setTimeout(60)
      .build();
    const prepared = await net.server.prepareTransaction(built);
    prepared.sign(payer);
    const sent = await net.server.sendTransaction(prepared);
    const landed = await net.server.pollTransaction(sent.hash, { attempts: 30 });
    if (landed.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(landed.status);
    expect(sacTransferEvents(landed)).toEqual([
      { contract: usdc.sac, from: payer.publicKey(), to: seller.publicKey(), amount: PRICE, toMuxedId: 77n },
    ]);
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(sellerBefore + PRICE);
  });
});

describe.skipIf(!available)("upto payments to a muxed payTo", () => {
  let usdc: IssuedAsset;
  let contract: LocalUptoContract;
  let sponsor: Keypair;
  let authority: Keypair;
  let seller: Keypair;

  beforeAll(async () => {
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    sponsor = Keypair.random();
    await net.fund(sponsor);
    await provisionChannels({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      channels: deriveChannelKeypairs(sponsor, NETWORK, 2),
    });
    authority = deriveAuthorityKeypair(sponsor, NETWORK);
    await provisionAuthority({ server: net.server, passphrase: net.passphrase, sponsor, authority });
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
  }, 180_000);

  it("are refused by the client before signing and by the facilitator, and nothing moves", async () => {
    const facilitator = createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: net.rpcUrl,
          sponsorSecret: sponsor.secret(),
          channelCount: 2,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          policy: { maxTransactionFeeStroops: 2_000_000 },
          upto: { contract: contract.address, contractWasmHash: contract.wasmHash, ledgerSeconds: 5 },
        },
      ],
    });
    const driver = uptoDriver(net, classicTestAsset(net, usdc), {
      contract: contract.address,
      authority: authority.publicKey(),
      client: (...args: ConstructorParameters<typeof UptoClient>) => new UptoClient(...args),
    });
    const payer = await driver.payer("G", 10_000_000n);
    const payTo = muxed(seller.publicKey(), 5n);

    await expect(driver.pay(payer, driver.requirements(payTo, PRICE))).rejects.toThrow();

    // An authorization signed to the base account, presented against a muxed payTo.
    const payload = await driver.pay(payer, driver.requirements(seller.publicKey(), PRICE));
    const requirements = { ...payload.accepted, payTo } as PaymentRequirements;
    const presented = { ...payload, accepted: requirements } as PaymentPayload;
    const before = await net.tokenBalance(usdc.sac, payer.address);
    expect(await facilitator.core.verify(presented, requirements)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_unsupported_recipient",
    });
    expect(await facilitator.core.settle(presented, requirements)).toMatchObject({
      success: false,
      errorReason: "invalid_upto_stellar_payload_unsupported_recipient",
    });
    expect(await net.tokenBalance(usdc.sac, payer.address)).toBe(before);
  });
});
