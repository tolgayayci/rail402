/**
 * What the fee sponsor can be made to pay, on the private Stellar network (1 s ledgers).
 *
 * The sponsor pays the fee of every settlement it submits, including one that is included and fails.
 * These tests show where Rail402 refuses before anything is signed (the fee ceiling, the hourly
 * budget, a balance that moved between verify and settle) and the one race it cannot close: the payer
 * spending the balance after the settle-time simulation and before inclusion, or a smart account
 * changing what its `__check_auth` accepts in that window. That transaction fails on chain, the fee is
 * spent, and the failure is named and counted as wasted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, Operation, rpc } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  MemorySettlementLedger,
  SponsorBudget,
  acceptedAsset,
  createStellarFacilitator,
  deriveChannelKeypairs,
  provisionChannels,
  silentObserver,
  type FinalizedEvent,
  type SponsorGuard,
  type SubmissionEvent,
} from "@rail402.dev/facilitator";
import {
  LocalNetwork,
  addOzContextRule,
  deployOzSmartAccount,
  mintTo,
  ozSmartAccountSigner,
  recordOps,
  removeOzContextRule,
  requirementsFor,
  smartAccountPayment,
  startRpcProxy,
  type IssuedAsset,
  type RpcProxy,
} from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";
const START = 1_000_000_000n; // net.holders(…, "100") in base units
const PRICE = 1_000_000n;
/** The private network prices Soroban resources higher than testnet. */
const CEILING = 2_000_000;

describe.skipIf(!available)("fee sponsor exposure for exact payments", () => {
  let usdc: IssuedAsset;
  let sponsor: Keypair;
  let seller: Keypair;
  let sink: Keypair;
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
    [seller, sink] = (await net.holders(usdc, 2, "0")) as [Keypair, Keypair];
    proxy = await startRpcProxy(net.rpcUrl);
  });

  afterAll(async () => {
    await proxy.close();
  });

  const setup = (options: { maxTransactionFeeStroops?: number; guard?: SponsorGuard } = {}) => {
    const ledger = new MemorySettlementLedger();
    const finalized: FinalizedEvent[] = [];
    const submissions: SubmissionEvent[] = [];
    const facilitator = createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: proxy.url,
          sponsorSecret: sponsor.secret(),
          channelCount: 2,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          policy: { maxTransactionFeeStroops: options.maxTransactionFeeStroops ?? CEILING },
          ledger,
          ...(options.guard === undefined ? {} : { guard: options.guard }),
          timing: { pollIntervalMs: 250 },
        },
      ],
      observer: {
        ...silentObserver,
        finalized: (event) => finalized.push(event),
        submission: (_network, event) => submissions.push(event),
      },
    });
    return { facilitator, ledger, finalized, submissions };
  };

  const pay = async (payer: Keypair) => {
    const terms = requirementsFor(usdc.sac, seller.publicKey(), PRICE, 120);
    const payload = (await net.payment(payer, terms)) as PaymentPayload;
    return { payload, requirements: terms as PaymentRequirements };
  };

  /** Moves the payer's whole balance away with a classic payment the payer signs itself. */
  const spendAll = async (payer: Keypair) => {
    const balance = await net.tokenBalance(usdc.sac, payer.publicKey());
    await net.classic(payer, [
      Operation.payment({
        destination: sink.publicKey(),
        asset: usdc.asset,
        amount: (Number(balance) / 1e7).toFixed(7),
      }),
    ]);
  };

  it("refuses a payment whose settlement would cost more than the fee ceiling, before signing anything", async () => {
    const { facilitator, ledger, submissions } = setup({ maxTransactionFeeStroops: 20_000 });
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const { payload, requirements } = await pay(payer);
    const sponsorBefore = await net.nativeBalance(sponsor.publicKey());
    const sent = proxy.sent.length;

    const verified = await facilitator.core.verify(payload, requirements);
    expect(verified).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_payload_fee_exceeds_maximum",
      payer: payer.publicKey(),
    });
    const settled = await facilitator.core.settle(payload, requirements);
    expect(settled).toMatchObject({
      success: false,
      errorReason: "invalid_exact_stellar_payload_fee_exceeds_maximum",
    });

    expect(proxy.sent.length).toBe(sent);
    expect(submissions).toEqual([]);
    expect(await ledger.countByState(NETWORK, new Date(0))).toEqual(
      expect.objectContaining({ claimed: 0, submitted: 0, succeeded: 0, failed: 0, expired: 0 }),
    );
    expect(await net.nativeBalance(sponsor.publicKey())).toBe(sponsorBefore);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(START);
    recordOps("ceiling-refusal", {
      ceilingStroops: 20_000,
      verify: verified.invalidReason,
      settle: settled.errorReason,
      submissions: 0,
      sponsorDeltaStroops: 0n,
    });
  });

  it("stops settling once the hourly fee budget is committed, before any RPC work", async () => {
    const ledger = new MemorySettlementLedger();
    const refusals: string[] = [];
    const guard = new SponsorBudget({
      network: NETWORK,
      ledger,
      balance: () => undefined,
      minBalanceStroops: 0n,
      maxSpendPerHourStroops: 1n,
      onRefusal: (limit) => refusals.push(limit),
    });
    const facilitator = createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: proxy.url,
          sponsorSecret: sponsor.secret(),
          channelCount: 2,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          policy: { maxTransactionFeeStroops: CEILING },
          ledger,
          guard,
          timing: { pollIntervalMs: 250 },
        },
      ],
    });
    const [first, second] = (await net.holders(usdc, 2, "100")) as [Keypair, Keypair];

    const one = await pay(first);
    const settled = await facilitator.core.settle(one.payload, one.requirements);
    expect(settled).toMatchObject({ success: true });

    const two = await pay(second);
    const sent = proxy.sent.length;
    const sponsorBefore = await net.nativeBalance(sponsor.publicKey());
    const refused = await facilitator.core.settle(two.payload, two.requirements);
    expect(refused).toMatchObject({
      success: false,
      errorReason: "settle_exact_stellar_sponsor_unavailable",
    });
    expect(refused.errorMessage).toMatch(/hourly fee budget/);
    expect(refusals).toEqual(["budget"]);
    expect(proxy.sent.length).toBe(sent);
    expect(await net.nativeBalance(sponsor.publicKey())).toBe(sponsorBefore);
    expect(await net.tokenBalance(usdc.sac, second.publicKey())).toBe(START);
    recordOps("budget-trip", {
      budgetStroops: 1n,
      firstSettlement: settled.transaction,
      refusal: refused.errorReason,
      submissionsAfterTrip: 0,
    });
  });

  it("refuses at settle, with nothing submitted, a payment whose balance moved after verify", async () => {
    const { facilitator, submissions } = setup();
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const { payload, requirements } = await pay(payer);

    expect(await facilitator.core.verify(payload, requirements)).toMatchObject({ isValid: true });
    await spendAll(payer);
    const sent = proxy.sent.length;
    const sponsorBefore = await net.nativeBalance(sponsor.publicKey());

    const settled = await facilitator.core.settle(payload, requirements);
    expect(settled).toMatchObject({
      success: false,
      errorReason: "insufficient_funds",
      payer: payer.publicKey(),
    });
    expect(proxy.sent.length).toBe(sent);
    expect(submissions).toEqual([]);
    expect(await net.nativeBalance(sponsor.publicKey())).toBe(sponsorBefore);
    recordOps("balance-race", {
      phase: "between verify and settle",
      settle: settled.errorReason,
      submissions: 0,
      sponsorDeltaStroops: 0n,
    });
  });

  it("names a balance spent between the settle-time simulation and inclusion; the fee is spent and counted as wasted", async () => {
    const { facilitator, ledger, finalized } = setup();
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const { payload, requirements } = await pay(payer);
    const sellerBefore = await net.tokenBalance(usdc.sac, seller.publicKey());
    const sponsorBefore = await net.nativeBalance(sponsor.publicKey());

    let raced = false;
    proxy.injectBefore("sendTransaction", async () => {
      if (raced) return;
      raced = true;
      await spendAll(payer);
    });
    let settled;
    try {
      settled = await facilitator.core.settle(payload, requirements);
    } finally {
      proxy.injectBefore("sendTransaction", undefined);
    }

    expect(raced).toBe(true);
    expect(settled).toMatchObject({
      success: false,
      errorReason: "insufficient_funds",
      payer: payer.publicKey(),
    });
    const hash = settled.transaction;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const onChain = await net.server.getTransaction(hash);
    expect(onChain.status).toBe(rpc.Api.GetTransactionStatus.FAILED);

    // Nothing reached the seller; the sponsor paid the fee of the failed transaction, and only that.
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(sellerBefore);
    expect(finalized).toHaveLength(1);
    const [event] = finalized as [FinalizedEvent];
    expect(event).toMatchObject({ state: "failed", reason: "insufficient_funds", onChainFailure: true });
    const fee = event.feeChargedStroops ?? 0n;
    expect(fee).toBeGreaterThan(0n);
    expect(fee).toBeLessThanOrEqual(BigInt(CEILING));
    expect(await net.nativeBalance(sponsor.publicKey())).toBe(sponsorBefore - fee);

    // A repeat answers the recorded failure and submits nothing more.
    const sent = proxy.sent.length;
    const { extensionResponses: _marker, ...repeat } = await facilitator.core.settle(payload, requirements);
    expect(repeat).toEqual(settled);
    expect(proxy.sent.length).toBe(sent);
    expect(await ledger.countByState(NETWORK, new Date(0))).toEqual(expect.objectContaining({ failed: 1 }));
    recordOps("balance-race", {
      phase: "between the settle-time simulation and inclusion",
      transaction: hash,
      ledger: onChain.status === rpc.Api.GetTransactionStatus.FAILED ? onChain.ledger : undefined,
      settle: settled.errorReason,
      wastedFeeStroops: fee,
      sponsorDeltaStroops: -fee,
    });
  });
  it("names a smart account whose __check_auth passes the settle-time simulation and fails at inclusion; the fee is counted as wasted", async () => {
    const { facilitator, finalized } = setup();
    // An OpenZeppelin smart account: rule 0 is its owner; a second rule lets a delegate key pay.
    const deployer = Keypair.random();
    await net.fund(deployer);
    const owner = Keypair.random();
    const delegate = Keypair.random();
    const account = await deployOzSmartAccount(net, deployer, owner);
    const rule = await addOzContextRule(net, account, {
      submitter: deployer,
      context: { kind: "default" },
      name: "delegate",
      signers: [delegate],
    });
    await mintTo(net, usdc, account.address, PRICE * 10n);
    const requirements = requirementsFor(usdc.sac, seller.publicKey(), PRICE, 120);
    const payload = (await smartAccountPayment(net, {
      account: account.address,
      owner,
      source: deployer,
      requirements,
      signEntry: ozSmartAccountSigner({ verifier: account.verifier, key: delegate, contextRuleIds: [rule] }),
    })) as PaymentPayload;
    expect(await facilitator.core.verify(payload, requirements as PaymentRequirements)).toMatchObject({
      isValid: true,
    });
    const accountBefore = await net.tokenBalance(usdc.sac, account.address);
    const sellerBefore = await net.tokenBalance(usdc.sac, seller.publicKey());
    const sponsorBefore = await net.nativeBalance(sponsor.publicKey());

    // After the settle-time simulation, the owner removes the rule the payment was signed under.
    let raced = false;
    proxy.injectBefore("sendTransaction", async () => {
      if (raced) return;
      raced = true;
      await removeOzContextRule(net, account, deployer, rule);
    });
    let settled;
    try {
      settled = await facilitator.core.settle(payload, requirements);
    } finally {
      proxy.injectBefore("sendTransaction", undefined);
    }

    expect(raced).toBe(true);
    expect(settled).toMatchObject({
      success: false,
      errorReason: "invalid_exact_stellar_payload_smart_account_rejected",
      payer: account.address,
    });
    const hash = settled.transaction;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const onChain = await net.server.getTransaction(hash);
    expect(onChain.status).toBe(rpc.Api.GetTransactionStatus.FAILED);

    // Nothing moved; the sponsor paid the failed transaction's fee, and only that, counted as wasted.
    expect(await net.tokenBalance(usdc.sac, account.address)).toBe(accountBefore);
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(sellerBefore);
    expect(finalized).toHaveLength(1);
    const [event] = finalized as [FinalizedEvent];
    expect(event).toMatchObject({ state: "failed", onChainFailure: true });
    const fee = event.feeChargedStroops ?? 0n;
    expect(fee).toBeGreaterThan(0n);
    expect(fee).toBeLessThanOrEqual(BigInt(CEILING));
    expect(await net.nativeBalance(sponsor.publicKey())).toBe(sponsorBefore - fee);
    recordOps("smart-account-apply-failure", {
      payer: account.address,
      phase: "between the settle-time simulation and inclusion",
      transaction: hash,
      ledger: onChain.status === rpc.Api.GetTransactionStatus.FAILED ? onChain.ledger : undefined,
      settle: settled.errorReason,
      wastedFeeStroops: fee,
      sponsorDeltaStroops: -fee,
    });
  });
});
