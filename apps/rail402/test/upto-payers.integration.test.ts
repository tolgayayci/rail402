/**
 * `upto` payments from every kind of payer, through the whole service (HTTP, Postgres, the private
 * Stellar network with the committed settlement contract deployed per run):
 *
 * - a `G…` account (stock ed25519 signer), a simple custom account (`C…`, one ed25519 owner) and an
 *   OpenZeppelin smart account (`C…`, an agent key under an approve-aware spending limit) each settle
 *   zero, part of and all of the cap, and every settlement is proven non-custodial: the payer loses
 *   exactly the amount, payTo gains it, the sponsor pays only the network fee, and neither the
 *   authority, the channels nor the contract ever hold the token or move XLM;
 * - an OpenZeppelin smart account whose rule's only signer is `Signer::Delegated(G…)` settles with the
 *   delegate's `__check_auth` entry in `signerAuthorizations`, and is refused without it or with a forged one;
 * - an 18-decimal SEP-41 token settles the same way;
 * - the smart account's own limits hold: over its spending limit it refuses (`smart_account_rejected`),
 *   over the x402 cap Rail402 refuses before simulating (`settlement_exceeds_amount`), and the agent
 *   key cannot pick the owner's policy-free rule.
 *
 * Each settlement's fee is attached to its test as an annotation. Needs `docker compose --profile
 * stellar up -d` and Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import {
  LocalNetwork,
  OZ_DEFAULT_RULE,
  addOzContextRule,
  callContract,
  deployContract,
  deployOzSmartAccount,
  deploySimpleAccount,
  deploySpendingLimitPolicy,
  deployUpto,
  fixtureWasm,
  mintTo,
  ozDelegatedAuthorizer,
  ozSmartAccountSigner,
  pinHorizon,
  simpleAccountSigner,
  spendingLimitParams,
  spentInWindow,
  type HorizonPin,
  type IssuedAsset,
  type LocalUptoContract,
  type OzSmartAccount,
} from "@rail402.dev/testkit";
import {
  CAP,
  LEDGER_SECONDS,
  accountPayer,
  codeOf,
  contractPayer,
  custody,
  expectSettledOnce,
  post,
  startUptoService,
  uptoPayment,
  uptoRequirements,
  withAmount,
  type Payer,
  type UptoService,
} from "./upto-harness.ts";

const net = new LocalNetwork();
const available = await net.available();
/** Base units every payer starts with. */
const FUNDS = 10_000_000n;
/** The spending-limit policy's window, in ledgers. */
const PERIOD = 17_280;
/** 18-decimal amounts: a cap of 5 tokens, and 1.234… tokens settled. */
const TEST18_CAP = 5n * 10n ** 18n;
const TEST18_AMOUNT = 1_234_567_890_123_456_789n;

describe.skipIf(!available)("upto payers through the Rail402 service", () => {
  let horizon: HorizonPin;
  let usdc: IssuedAsset;
  let test18: string;
  let contract: LocalUptoContract;
  let service: UptoService;
  let recipient: Keypair;
  let deployer: Keypair;
  let policy: string;

  beforeAll(async () => {
    horizon = pinHorizon({ seconds: LEDGER_SECONDS });
    deployer = Keypair.random();
    await net.fund(deployer);
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    test18 = await deployContract(net, deployer, fixtureWasm("test_token.wasm"), [
      nativeToScVal("Rail402 Test Token (18 decimals)", { type: "string" }),
      nativeToScVal("TEST18", { type: "string" }),
      nativeToScVal(18, { type: "u32" }),
    ]);
    policy = await deploySpendingLimitPolicy(net, deployer);
    recipient = await net.holder(usdc, "0");
    service = await startUptoService(net, usdc, contract, {
      TESTNET_ASSETS: `${usdc.sac}:USDC:7,${test18}:TEST18:18`,
    });
  }, 240_000);

  afterAll(async () => {
    await service.stop();
    horizon.restore();
  });

  /** An OpenZeppelin account whose agent key pays under a spending limit of `budget`. */
  async function agentAccount(budget: bigint) {
    const owner = Keypair.random();
    const agent = Keypair.random();
    const account = await deployOzSmartAccount(net, deployer, owner);
    const tokenRule = await addOzContextRule(net, account, {
      submitter: deployer,
      context: { kind: "callContract", contract: usdc.sac },
      name: "agent payments",
      signers: [agent],
      policies: new Map([[policy, spendingLimitParams({ spendingLimit: budget, periodLedgers: PERIOD })]]),
    });
    const uptoRule = await addOzContextRule(net, account, {
      submitter: deployer,
      context: { kind: "callContract", contract: contract.address },
      name: "agent upto terms",
      signers: [agent],
    });
    await mintTo(net, usdc, account.address, FUNDS);
    return { account, agent, tokenRule, uptoRule };
  }

  /** The agent paying: the host authorizes `settle` first, then `approve`. */
  function agentPayer(account: OzSmartAccount, agent: Keypair, ruleIds: readonly number[]): Payer {
    return contractPayer(
      account.address,
      ozSmartAccountSigner({ verifier: account.verifier, key: agent, contextRuleIds: ruleIds }),
    );
  }

  function requirements(amount = CAP) {
    return uptoRequirements({
      asset: usdc.sac,
      payTo: recipient.publicKey(),
      authority: service.authority.publicKey(),
      amount,
    });
  }

  /** Verifies at the cap, settles `amount` and proves the settlement moved exactly that. */
  async function settleAndProve(payer: Payer, amount: bigint): Promise<bigint> {
    const payload = await uptoPayment(net, { contract: contract.address, payer, accepted: requirements() });
    expect((await post(service.url, "/verify", payload, requirements())).body).toEqual({
      isValid: true,
      payer: payer.address,
    });
    const before = await custody(net, service, usdc.sac, payer.address, recipient.publicKey());
    const settled = await post(service.url, "/settle", payload, requirements(amount));
    expect(settled.body).toMatchObject({
      success: true,
      payer: payer.address,
      amount: amount.toString(),
    });
    return expectSettledOnce(net, {
      service,
      token: usdc.sac,
      payer: payer.address,
      recipient: recipient.publicKey(),
      amount,
      cap: CAP,
      transaction: settled.body["transaction"] as string,
      before,
    });
  }

  const AMOUNTS = [
    ["zero", 0n],
    ["partial", 300_000n],
    ["maximum", CAP],
  ] as const;

  describe("a G… account", () => {
    let payer: Payer;
    beforeAll(async () => {
      payer = accountPayer(await net.holder(usdc, "1"));
    });

    for (const [name, amount] of AMOUNTS) {
      it(`settles a ${name} amount`, async ({ annotate }) => {
        const fee = await settleAndProve(payer, amount);
        await annotate(`G… payer, ${name}: fee ${fee} stroops`);
      });
    }
  });

  describe("a simple custom account (C…)", () => {
    let payer: Payer;
    beforeAll(async () => {
      const owner = Keypair.random();
      const address = await deploySimpleAccount(net, deployer, owner);
      await mintTo(net, usdc, address, FUNDS);
      payer = contractPayer(address, simpleAccountSigner(owner));
    });

    for (const [name, amount] of AMOUNTS) {
      it(`settles a ${name} amount`, async ({ annotate }) => {
        const fee = await settleAndProve(payer, amount);
        await annotate(`simple C… payer, ${name}: fee ${fee} stroops`);
      });
    }

    it("refuses a signature by another key as the account's own rejection", async () => {
      const impostor = contractPayer(payer.address, simpleAccountSigner(Keypair.random()));
      const payload = await uptoPayment(net, {
        contract: contract.address,
        payer: impostor,
        accepted: requirements(),
      });
      const verified = await post(service.url, "/verify", payload, requirements());
      expect(codeOf(verified)).toBe("invalid_upto_stellar_payload_smart_account_rejected");
      expect(verified.body["invalidMessage"]).toEqual(expect.any(String));
    });
  });

  describe("an OpenZeppelin smart account (C…) paying with an agent key", () => {
    let agent: Awaited<ReturnType<typeof agentAccount>>;
    let payer: Payer;
    beforeAll(async () => {
      // Every payment reserves its full cap, so three payments use the whole budget.
      agent = await agentAccount(3n * CAP);
      payer = agentPayer(agent.account, agent.agent, [agent.uptoRule, agent.tokenRule]);
    }, 120_000);

    for (const [name, amount] of AMOUNTS) {
      it(`settles a ${name} amount within its budget`, async ({ annotate }) => {
        const fee = await settleAndProve(payer, amount);
        await annotate(`OpenZeppelin C… payer, ${name}: fee ${fee} stroops`);
      });
    }

    it("has reserved the full cap of each payment against its budget", async () => {
      expect(await spentInWindow(net, policy, agent.tokenRule, agent.account.address)).toBe(3n * CAP);
    });

    it("refuses a payment over its own spending limit, and nothing moves", async () => {
      const payload = await uptoPayment(net, { contract: contract.address, payer, accepted: requirements() });
      const before = await custody(net, service, usdc.sac, payer.address, recipient.publicKey());
      const verified = await post(service.url, "/verify", payload, requirements());
      expect(codeOf(verified)).toBe("invalid_upto_stellar_payload_smart_account_rejected");
      const settled = await post(service.url, "/settle", payload, requirements(1n));
      expect(codeOf(settled)).toBe("invalid_upto_stellar_payload_smart_account_rejected");
      expect(settled.body["transaction"]).toBe("");
      expect(await custody(net, service, usdc.sac, payer.address, recipient.publicKey())).toEqual(before);
      expect(await spentInWindow(net, policy, agent.tokenRule, agent.account.address)).toBe(3n * CAP);
    });
  });

  describe("an OpenZeppelin smart account (C…) whose rule needs a delegated signer", () => {
    let account: OzSmartAccount;
    let delegate: Keypair;
    let rule: number;
    beforeAll(async () => {
      delegate = Keypair.random();
      await net.fund(delegate);
      account = await deployOzSmartAccount(net, deployer, Keypair.random());
      // The only signer of this rule is `Signer::Delegated(delegate)`: the account's `__check_auth`
      // calls `delegate.require_auth_for_args((auth_digest,))`.
      rule = await addOzContextRule(net, account, {
        submitter: deployer,
        context: { kind: "default" },
        name: "delegated payments",
        signers: [],
        delegates: [delegate.publicKey()],
      });
      await mintTo(net, usdc, account.address, FUNDS);
    }, 120_000);

    function delegatedPayer(options: { signedBy?: Keypair; dropSignerAuthorizations?: boolean } = {}): Payer {
      const authorize = ozDelegatedAuthorizer({
        account: account.address,
        delegate,
        contextRuleIds: [rule, rule],
        ...(options.signedBy === undefined ? {} : { signedBy: options.signedBy }),
      });
      return {
        address: account.address,
        sign: () => Promise.reject(new Error("signed through its delegate")),
        authorize: async (entry, passphrase) => {
          const result = await authorize(entry, passphrase);
          return options.dropSignerAuthorizations === true ? { ...result, signerAuthorizations: [] } : result;
        },
      };
    }

    it("carries the delegate's entry in signerAuthorizations and settles", async ({ annotate }) => {
      const payload = await uptoPayment(net, {
        contract: contract.address,
        payer: delegatedPayer(),
        accepted: requirements(),
      });
      const signerAuthorizations = (payload.payload as { signerAuthorizations?: string[] })
        .signerAuthorizations;
      expect(signerAuthorizations).toHaveLength(1);
      const delegateXlm = await net.nativeBalance(delegate.publicKey());
      const fee = await settleAndProve(delegatedPayer(), 300_000n);
      // The delegate only signs: it pays no fee and holds none of the payment.
      expect(await net.nativeBalance(delegate.publicKey())).toBe(delegateXlm);
      expect(await net.tokenBalance(usdc.sac, delegate.publicKey())).toBe(0n);
      await annotate(`OpenZeppelin C… payer with a delegated signer, partial: fee ${fee} stroops`);
    });

    it("refuses the payment without the delegate's entry, and nothing moves", async () => {
      const payload = await uptoPayment(net, {
        contract: contract.address,
        payer: delegatedPayer({ dropSignerAuthorizations: true }),
        accepted: requirements(),
      });
      expect(payload.payload).not.toHaveProperty("signerAuthorizations");
      const before = await custody(net, service, usdc.sac, account.address, recipient.publicKey());
      const verified = await post(service.url, "/verify", payload, requirements());
      expect(codeOf(verified)).toBe("invalid_upto_stellar_payload_smart_account_rejected");
      expect(verified.body["invalidMessage"]).toEqual(expect.any(String));
      const settled = await post(service.url, "/settle", payload, requirements(1n));
      expect(codeOf(settled)).toBe("invalid_upto_stellar_payload_smart_account_rejected");
      expect(settled.body["transaction"]).toBe("");
      expect(await custody(net, service, usdc.sac, account.address, recipient.publicKey())).toEqual(before);
    });

    it("refuses a delegate's entry signed by another key, and nothing moves", async () => {
      const payload = await uptoPayment(net, {
        contract: contract.address,
        payer: delegatedPayer({ signedBy: Keypair.random() }),
        accepted: requirements(),
      });
      const before = await custody(net, service, usdc.sac, account.address, recipient.publicKey());
      const verified = await post(service.url, "/verify", payload, requirements());
      expect(codeOf(verified)).toBe("invalid_upto_stellar_payload_smart_account_rejected");
      const settled = await post(service.url, "/settle", payload, requirements(1n));
      expect(codeOf(settled)).toBe("invalid_upto_stellar_payload_smart_account_rejected");
      expect(await custody(net, service, usdc.sac, account.address, recipient.publicKey())).toEqual(before);
    });

    it("refuses a delegate's entry that authorizes anything but the account's __check_auth", async () => {
      const payload = await uptoPayment(net, {
        contract: contract.address,
        payer: delegatedPayer(),
        accepted: requirements(),
      });
      // The payer's own entry presented as a signer entry: it is signed, but authorizes settle().
      const body = payload.payload as { authorization: string };
      const tampered = { ...payload, payload: { ...body, signerAuthorizations: [body.authorization] } };
      const verified = await post(service.url, "/verify", tampered, requirements());
      expect(codeOf(verified)).toBe("invalid_upto_stellar_payload_invalid_signer_authorization");
      expect(verified.body["invalidMessage"]).toEqual(expect.any(String));
    });
  });

  describe("the smart account's limits", () => {
    let agent: Awaited<ReturnType<typeof agentAccount>>;
    let payer: Payer;
    beforeAll(async () => {
      agent = await agentAccount(2n * CAP);
      payer = agentPayer(agent.account, agent.agent, [agent.uptoRule, agent.tokenRule]);
    }, 120_000);

    it("refuses an amount over the x402 cap before simulating, and the payment still settles within it", async () => {
      const payload = await uptoPayment(net, { contract: contract.address, payer, accepted: requirements() });
      const sent = await net.nativeBalance(service.sponsor.publicKey());
      const over = await post(service.url, "/settle", payload, requirements(CAP + 1n));
      expect(codeOf(over)).toBe("invalid_upto_stellar_payload_settlement_exceeds_amount");
      expect(over.body["errorMessage"]).toContain(CAP.toString());
      expect(await net.nativeBalance(service.sponsor.publicKey())).toBe(sent);

      const settled = await post(service.url, "/settle", payload, requirements(400_000n));
      expect(settled.body).toMatchObject({ success: true, amount: "400000" });
    });

    it("does not let the agent key use the owner's policy-free default rule", async () => {
      for (const ruleIds of [
        [OZ_DEFAULT_RULE, OZ_DEFAULT_RULE],
        [agent.uptoRule, OZ_DEFAULT_RULE],
        [agent.uptoRule, agent.uptoRule],
      ]) {
        const payload = await uptoPayment(net, {
          contract: contract.address,
          payer: agentPayer(agent.account, agent.agent, ruleIds),
          accepted: requirements(),
        });
        const verified = await post(service.url, "/verify", payload, requirements());
        expect(codeOf(verified)).toBe("invalid_upto_stellar_payload_smart_account_rejected");
      }
      expect(await spentInWindow(net, policy, agent.tokenRule, agent.account.address)).toBe(CAP);
    });

    it("pays up to its budget and refuses the cap that would exceed it", async () => {
      const second = await uptoPayment(net, { contract: contract.address, payer, accepted: requirements() });
      expect((await post(service.url, "/settle", second, requirements(10n))).body).toMatchObject({
        success: true,
      });
      expect(await spentInWindow(net, policy, agent.tokenRule, agent.account.address)).toBe(2n * CAP);

      const third = await uptoPayment(net, { contract: contract.address, payer, accepted: requirements() });
      const refused = await post(service.url, "/verify", third, requirements());
      expect(codeOf(refused)).toBe("invalid_upto_stellar_payload_smart_account_rejected");
      expect(refused.body["invalidMessage"]).toMatch(/smart account rejected/);
    });
  });

  describe("an 18-decimal SEP-41 token", () => {
    it("settles part of the cap to a recipient with no balance yet", async ({ annotate }) => {
      const holder = Keypair.random();
      const payTo = Keypair.random();
      await net.fund(holder, payTo);
      await callContract(net, deployer, test18, "mint_test", [
        nativeToScVal(holder.publicKey(), { type: "address" }),
        nativeToScVal(10n * 10n ** 18n, { type: "i128" }),
      ]);
      const payer = accountPayer(holder);
      const accepted = uptoRequirements({
        asset: test18,
        payTo: payTo.publicKey(),
        authority: service.authority.publicKey(),
        amount: TEST18_CAP,
      });
      const payload = await uptoPayment(net, { contract: contract.address, payer, accepted });
      expect((await post(service.url, "/verify", payload, accepted)).body).toEqual({
        isValid: true,
        payer: payer.address,
      });
      const before = await custody(net, service, test18, payer.address, payTo.publicKey());
      const settled = await post(service.url, "/settle", payload, withAmount(accepted, TEST18_AMOUNT));
      expect(settled.body).toMatchObject({ success: true, amount: TEST18_AMOUNT.toString() });
      const fee = await expectSettledOnce(net, {
        service,
        token: test18,
        payer: payer.address,
        recipient: payTo.publicKey(),
        amount: TEST18_AMOUNT,
        cap: TEST18_CAP,
        transaction: settled.body["transaction"] as string,
        before,
      });
      await annotate(`G… payer, TEST18 partial to a new recipient: fee ${fee} stroops`);
    });
  });
});
