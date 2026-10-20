/**
 * Tampering with `upto` payments, through the whole service on the private Stellar network with the
 * committed settlement contract deployed per run.
 *
 * Every field the payer binds — recipient, asset, cap, expiration, nonce, settlement authority,
 * contract, function and the shape of the authorization tree — is changed in two ways:
 * - inconsistently (the entry and the requirements disagree), which the static rules refuse with the
 *   field's own code before anything is simulated;
 * - consistently (the entry rebuilt for the new value, with the original signature), which only the
 *   signature can catch: the simulation refuses it as `invalid_signature`.
 * Both /verify and /settle refuse each one, nothing is submitted, and the sponsor pays nothing.
 *
 * The amount is the one thing the payer does not sign, so it is proven on-chain with transactions a
 * harness lands directly: a submitter other than the settlement authority fails the host's
 * authorization check (the amount is bound to the authority), an amount over the cap fails in the
 * contract (#3) even when the authority signs it, and one authorization submitted through two
 * transaction sources at once settles once — the other fails on the used nonce.
 *
 * Needs `docker compose --profile stellar up -d` and Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Address, Keypair, Operation, xdr } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { authorityEntry, settleInvokeArgs } from "@rail402.dev/upto";
import { hostErrors } from "@rail402.dev/upto/facilitator";
import {
  LocalNetwork,
  accountSigner,
  addressCredentialsOf,
  deploySimpleAccount,
  deployUpto,
  mintTo,
  pinHorizon,
  simpleAccountSigner,
  submitInvocation,
  type HorizonPin,
  type Invocation,
  type IssuedAsset,
  type LocalUptoContract,
} from "@rail402.dev/testkit";
import {
  CAP,
  LEDGER_SECONDS,
  accountPayer,
  authorizationOf,
  codeOf,
  editEntry,
  forgeTerms,
  post,
  signedPayment,
  startUptoService,
  termsOf,
  uptoPayment,
  uptoRequirements,
  withAmount,
  type Payer,
  type UptoService,
} from "./upto-harness.ts";

const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("tampered upto payments", () => {
  let horizon: HorizonPin;
  let usdc: IssuedAsset;
  let eurc: IssuedAsset;
  let contract: LocalUptoContract;
  let service: UptoService;
  let recipient: Keypair;
  let other: Keypair;
  let payerKeys: Keypair;
  let payer: Payer;

  beforeAll(async () => {
    horizon = pinHorizon({ seconds: LEDGER_SECONDS });
    [usdc, eurc, contract] = await Promise.all([
      net.issueAsset("USDC"),
      net.issueAsset("EURC"),
      deployUpto(net),
    ]);
    [recipient, other, payerKeys] = await Promise.all([
      net.holder(usdc, "0"),
      net.holder(usdc, "0"),
      net.holder(usdc, "10"),
    ]);
    payer = accountPayer(payerKeys);
    service = await startUptoService(net, usdc, contract, {
      TESTNET_ASSETS: `${usdc.sac}:USDC:7,${eurc.sac}:EURC:7`,
    });
  }, 240_000);

  afterAll(async () => {
    await service.stop();
    horizon.restore();
  });

  function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
    return {
      ...uptoRequirements({
        asset: usdc.sac,
        payTo: recipient.publicKey(),
        authority: service.authority.publicKey(),
      }),
      ...overrides,
    };
  }

  const SIGNATURE = "invalid_upto_stellar_payload_invalid_signature";

  const pay = (accepted = requirements()) =>
    uptoPayment(net, { contract: contract.address, payer, accepted });

  /** A tampered payment and the requirements a seller would send with it. */
  interface Tampered {
    readonly payload: PaymentPayload;
    /** The requirements at /verify (the cap); /settle asks for 100 base units of them. */
    readonly requirements: PaymentRequirements;
  }

  /** Refused by /verify and /settle with `code`: nothing submitted, nothing paid, nothing moved. */
  async function expectRefused(tampered: Tampered, code: string, payerAddress = payerKeys.publicKey()) {
    const sponsor = await net.nativeBalance(service.sponsor.publicKey());
    const funds = await net.tokenBalance(usdc.sac, payerAddress);
    const verified = await post(service.url, "/verify", tampered.payload, tampered.requirements);
    expect(verified.body).toMatchObject({ isValid: false, invalidReason: code });
    expect(verified.body["invalidMessage"]).toEqual(expect.any(String));
    const settled = await post(
      service.url,
      "/settle",
      tampered.payload,
      withAmount(tampered.requirements, 100n),
    );
    expect(settled.body).toMatchObject({ success: false, errorReason: code, transaction: "" });
    expect(settled.body["errorMessage"]).toEqual(expect.any(String));
    expect(await net.nativeBalance(service.sponsor.publicKey())).toBe(sponsor);
    expect(await net.tokenBalance(usdc.sac, payerAddress)).toBe(funds);
  }

  const setRoot = (entry: xdr.SorobanAuthorizationEntry, edit: (call: xdr.InvokeContractArgs) => void) => {
    edit(entry.rootInvocation().function().contractFn());
  };

  describe("inconsistent changes are refused by the static rules with the field's code", () => {
    const cases: [string, string, () => Promise<Tampered>][] = [
      [
        "recipient",
        "invalid_upto_stellar_payload_wrong_recipient",
        async () => {
          const changed = requirements({ payTo: other.publicKey() });
          return { payload: { ...(await pay()), accepted: changed }, requirements: changed };
        },
      ],
      [
        "asset",
        "invalid_upto_stellar_payload_wrong_asset",
        async () => {
          const changed = requirements({ asset: eurc.sac });
          return { payload: { ...(await pay()), accepted: changed }, requirements: changed };
        },
      ],
      [
        "cap",
        "invalid_upto_stellar_payload_wrong_amount",
        async () => {
          const changed = requirements({ amount: (2n * CAP).toString() });
          return { payload: { ...(await pay()), accepted: changed }, requirements: changed };
        },
      ],
      [
        "expiration",
        "invalid_upto_stellar_payload_expiration_mismatch",
        async () => ({
          payload: editEntry(await pay(), (entry) => {
            const credentials = addressCredentialsOf(entry);
            credentials.signatureExpirationLedger(credentials.signatureExpirationLedger() + 1);
          }),
          requirements: requirements(),
        }),
      ],
      [
        "authority in the requirements",
        "invalid_upto_stellar_requirements_facilitator_mismatch",
        async () => {
          const changed = requirements({
            extra: { areFeesSponsored: true, facilitatorAddress: other.publicKey() },
          });
          return { payload: { ...(await pay()), accepted: changed }, requirements: changed };
        },
      ],
      [
        "authority in the terms",
        "invalid_upto_stellar_payload_facilitator_mismatch",
        async () => ({
          payload: await signedPayment(net, {
            contract: contract.address,
            payer,
            accepted: requirements(),
            terms: { facilitator: other.publicKey() },
          }),
          requirements: requirements(),
        }),
      ],
      [
        "contract",
        "invalid_upto_stellar_payload_wrong_contract",
        async () => ({
          payload: editEntry(await pay(), (entry) => {
            setRoot(entry, (call) => call.contractAddress(Address.fromString(usdc.sac).toScAddress()));
          }),
          requirements: requirements(),
        }),
      ],
      [
        "function",
        "invalid_upto_stellar_payload_wrong_function",
        async () => ({
          payload: editEntry(await pay(), (entry) => {
            setRoot(entry, (call) => call.functionName("transfer"));
          }),
          requirements: requirements(),
        }),
      ],
      [
        "tree without the approve child",
        "invalid_upto_stellar_payload_invalid_authorization_tree",
        async () => ({
          payload: editEntry(await pay(), (entry) => entry.rootInvocation().subInvocations([])),
          requirements: requirements(),
        }),
      ],
      [
        "tree approving another spender",
        "invalid_upto_stellar_payload_invalid_authorization_tree",
        async () => ({
          payload: editEntry(await pay(), (entry) => {
            const [approve] = entry.rootInvocation().subInvocations();
            const args = approve?.function().contractFn().args() ?? [];
            args[1] = xdr.ScVal.scvAddress(Address.fromString(other.publicKey()).toScAddress());
            approve?.function().contractFn().args(args);
          }),
          requirements: requirements(),
        }),
      ],
      [
        "tree approving more than the cap",
        "invalid_upto_stellar_payload_invalid_authorization_tree",
        async () => ({
          payload: editEntry(await pay(), (entry) => {
            const [approve] = entry.rootInvocation().subInvocations();
            const args = approve?.function().contractFn().args() ?? [];
            args[2] = xdr.ScVal.scvI128(
              new xdr.Int128Parts({ hi: xdr.Int64.fromString("0"), lo: xdr.Uint64.fromString("2000000") }),
            );
            approve?.function().contractFn().args(args);
          }),
          requirements: requirements(),
        }),
      ],
      [
        "tree with a second child",
        "invalid_upto_stellar_payload_invalid_authorization_tree",
        async () => ({
          payload: editEntry(await pay(), (entry) => {
            const [approve] = entry.rootInvocation().subInvocations();
            if (approve !== undefined) entry.rootInvocation().subInvocations([approve, approve]);
          }),
          requirements: requirements(),
        }),
      ],
      [
        "tree with a grandchild",
        "invalid_upto_stellar_payload_invalid_authorization_tree",
        async () => ({
          payload: editEntry(await pay(), (entry) => {
            const [approve] = entry.rootInvocation().subInvocations();
            const nested = xdr.SorobanAuthorizedInvocation.fromXDR(approve?.toXDR() ?? Buffer.alloc(0));
            approve?.subInvocations([nested]);
          }),
          requirements: requirements(),
        }),
      ],
      [
        "credentials of the source account",
        "invalid_upto_stellar_payload_unsupported_credential_type",
        async () => ({
          payload: editEntry(await pay(), (entry) =>
            entry.credentials(xdr.SorobanCredentials.sorobanCredentialsSourceAccount()),
          ),
          requirements: requirements(),
        }),
      ],
      [
        "empty signature vector",
        "invalid_upto_stellar_payload_missing_payer_signature",
        async () => ({
          payload: editEntry(await pay(), (entry) =>
            addressCredentialsOf(entry).signature(xdr.ScVal.scvVec([])),
          ),
          requirements: requirements(),
        }),
      ],
      [
        "missing signature",
        "invalid_upto_stellar_payload_missing_payer_signature",
        async () => ({
          payload: editEntry(await pay(), (entry) =>
            addressCredentialsOf(entry).signature(xdr.ScVal.scvVoid()),
          ),
          requirements: requirements(),
        }),
      ],
    ];

    for (const [name, code, build] of cases) {
      it(`refuses a changed ${name}`, async () => {
        await expectRefused(await build(), code);
      });
    }

    it("refuses a settle amount over the cap before simulating", async () => {
      const payload = await pay();
      const sponsor = await net.nativeBalance(service.sponsor.publicKey());
      const settled = await post(service.url, "/settle", payload, withAmount(requirements(), CAP + 1n));
      expect(settled.body).toMatchObject({
        success: false,
        errorReason: "invalid_upto_stellar_payload_settlement_exceeds_amount",
        transaction: "",
        amount: (CAP + 1n).toString(),
      });
      expect(await net.nativeBalance(service.sponsor.publicKey())).toBe(sponsor);
    });
  });

  describe("consistent changes keep the old signature, so the network refuses them", () => {
    const cases: [string, () => Promise<Tampered>][] = [
      [
        "recipient",
        async () => {
          const changed = requirements({ payTo: other.publicKey() });
          return {
            payload: forgeTerms(
              await pay(),
              contract.address,
              (t) => ({ ...t, recipient: other.publicKey() }),
              changed,
            ),
            requirements: changed,
          };
        },
      ],
      [
        "asset",
        async () => {
          const changed = requirements({ asset: eurc.sac });
          return {
            payload: forgeTerms(await pay(), contract.address, (t) => ({ ...t, token: eurc.sac }), changed),
            requirements: changed,
          };
        },
      ],
      [
        "cap",
        async () => {
          const changed = requirements({ amount: (2n * CAP).toString() });
          return {
            payload: forgeTerms(
              await pay(),
              contract.address,
              (t) => ({ ...t, maxAmount: 2n * CAP }),
              changed,
            ),
            requirements: changed,
          };
        },
      ],
      [
        "expiration",
        async () => ({
          payload: forgeTerms(await pay(), contract.address, (t) => ({
            ...t,
            expirationLedger: t.expirationLedger + 1,
          })),
          requirements: requirements(),
        }),
      ],
      [
        "authority",
        async () => {
          // Signed for another authority, then rewritten to name this facilitator's.
          const signed = await signedPayment(net, {
            contract: contract.address,
            payer,
            accepted: requirements(),
            terms: { facilitator: other.publicKey() },
          });
          return {
            payload: forgeTerms(signed, contract.address, (t) => ({
              ...t,
              facilitator: service.authority.publicKey(),
            })),
            requirements: requirements(),
          };
        },
      ],
      [
        "nonce",
        async () => ({
          payload: editEntry(await pay(), (entry) => {
            const credentials = addressCredentialsOf(entry);
            credentials.nonce(xdr.Int64.fromString((credentials.nonce().toBigInt() + 1n).toString()));
          }),
          requirements: requirements(),
        }),
      ],
      [
        "credential version (V1 signature presented as V2)",
        async () => ({
          payload: editEntry(await pay(), (entry) =>
            entry.credentials(
              xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentialsOf(entry)),
            ),
          ),
          requirements: requirements(),
        }),
      ],
      [
        "signature",
        async () => ({
          payload: editEntry(await pay(), (entry) => {
            const [signature] = addressCredentialsOf(entry).signature().vec() ?? [];
            const bytes = signature
              ?.map()
              ?.find((field) => field.key().sym().toString() === "signature")
              ?.val()
              .bytes();
            if (bytes === undefined) throw new Error("no signature");
            bytes[0] = (bytes[0] ?? 0) ^ 0xff;
          }),
          requirements: requirements(),
        }),
      ],
    ];

    for (const [name, build] of cases) {
      it(`refuses a consistently changed ${name}`, async () => {
        await expectRefused(await build(), SIGNATURE);
      });
    }

    it("still settles the untouched payment the forgeries were made from", async () => {
      const payload = await pay();
      await expectRefused(
        {
          payload: forgeTerms(
            payload,
            contract.address,
            (t) => ({ ...t, recipient: other.publicKey() }),
            requirements({ payTo: other.publicKey() }),
          ),
          requirements: requirements({ payTo: other.publicKey() }),
        },
        SIGNATURE,
      );
      const settled = await post(service.url, "/settle", payload, withAmount(requirements(), 100n));
      expect(settled.body).toMatchObject({ success: true, amount: "100" });
    });
  });

  describe("an account that refuses the payer's signature", () => {
    // A G… account's own refusal is raised by the host as Error(Contract, #5) in the settlement
    // contract's frame, the number of the contract's Expired; it must be named a bad signature.
    it("refuses a G… payer signed with a key that is not its signer as a bad signature", async () => {
      const stranger = Keypair.random();
      const forged = await signedPayment(net, {
        contract: contract.address,
        payer: { address: payerKeys.publicKey(), sign: accountSigner(stranger) },
        accepted: requirements(),
      });
      await expectRefused({ payload: forged, requirements: requirements() }, SIGNATURE);
    });

    it("refuses a 2-of-2 multisig G… payer signed with one key as a bad signature", async () => {
      const multisig = await net.holder(usdc, "10");
      const second = Keypair.random();
      await net.classic(multisig, [
        Operation.setOptions({
          signer: { ed25519PublicKey: second.publicKey(), weight: 1 },
          lowThreshold: 2,
          medThreshold: 2,
          highThreshold: 2,
        }),
      ]);
      const underThreshold = await signedPayment(net, {
        contract: contract.address,
        payer: accountPayer(multisig),
        accepted: requirements(),
      });
      await expectRefused(
        { payload: underThreshold, requirements: requirements() },
        SIGNATURE,
        multisig.publicKey(),
      );
    });

    it("refuses a contract account signed with the wrong key as its smart account's refusal", async () => {
      const deployer = Keypair.random();
      await net.fund(deployer);
      const owner = Keypair.random();
      const account = await deploySimpleAccount(net, deployer, owner);
      await mintTo(net, usdc, account, 10_000_000n);
      const forged = await signedPayment(net, {
        contract: contract.address,
        payer: { address: account, sign: simpleAccountSigner(Keypair.random()) },
        accepted: requirements(),
      });
      await expectRefused(
        { payload: forged, requirements: requirements() },
        "invalid_upto_stellar_payload_smart_account_rejected",
        account,
      );
    });
  });

  describe("on-chain, without the facilitator's checks", () => {
    /** The settle call for `payload` at `amount`, with the authority's entry as Rail402 builds it. */
    function settleCall(payload: PaymentPayload, amount: bigint, source: string): Invocation {
      const terms = termsOf(payload);
      return {
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          settleInvokeArgs(contract.address, payerKeys.publicKey(), terms, amount),
        ),
        auth: [
          authorizationOf(payload),
          authorityEntry(contract.address, payerKeys.publicKey(), terms, amount),
        ],
        source,
      };
    }

    async function submitter(): Promise<Keypair> {
      const keypair = Keypair.random();
      await net.fund(keypair);
      return keypair;
    }

    const balances = async () => ({
      payer: await net.tokenBalance(usdc.sac, payerKeys.publicKey()),
      recipient: await net.tokenBalance(usdc.sac, recipient.publicKey()),
    });

    it("fails for a submitter that is not the settlement authority: the amount is bound to it", async () => {
      const payload = await pay();
      const intruder = await submitter();
      const before = await balances();
      const outcome = await submitInvocation(net, {
        submitter: intruder,
        invocation: settleCall(payload, 100n, intruder.publicKey()),
        resourcesOf: settleCall(payload, 100n, service.authority.publicKey()),
      });
      expect(outcome.status).toBe("FAILED");
      expect(hostErrors(outcome.diagnosticEvents)).toContainEqual(
        expect.objectContaining({ type: "Auth", code: "InvalidAction" }),
      );
      expect(await balances()).toEqual(before);

      // Nothing was consumed: the payment still settles through Rail402.
      const settled = await post(service.url, "/settle", payload, withAmount(requirements(), 100n));
      expect(settled.body).toMatchObject({ success: true, amount: "100" });
    });

    it("fails in the contract (#3) for an amount over the cap, even signed by the authority", async () => {
      const payload = await pay();
      const before = await balances();
      const outcome = await submitInvocation(net, {
        submitter: await submitter(),
        invocation: settleCall(payload, CAP + 1n, service.authority.publicKey()),
        signers: [service.authority],
        resourcesOf: settleCall(payload, CAP, service.authority.publicKey()),
      });
      expect(outcome.status).toBe("FAILED");
      expect(hostErrors(outcome.diagnosticEvents)).toContainEqual(
        expect.objectContaining({ type: "Contract", code: 3, contract: contract.address }),
      );
      expect(await balances()).toEqual(before);
    });

    it("settles one authorization once when two transaction sources submit it together", async () => {
      const payload = await pay();
      const [first, second] = await Promise.all([submitter(), submitter()]);
      const before = await balances();
      const outcomes = await Promise.all(
        [first, second].map(async (source) =>
          submitInvocation(net, {
            submitter: source,
            invocation: settleCall(payload, 100n, service.authority.publicKey()),
            signers: [service.authority],
          }),
        ),
      );
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["FAILED", "SUCCESS"]);
      const failed = outcomes.find((outcome) => outcome.status === "FAILED");
      expect(hostErrors(failed?.diagnosticEvents ?? [])).toContainEqual(
        expect.objectContaining({ type: "Auth", code: "ExistingValue" }),
      );
      expect(await balances()).toEqual({ payer: before.payer - 100n, recipient: before.recipient + 100n });

      // Rail402 sees the authorization used.
      const verified = await post(service.url, "/verify", payload, requirements());
      expect(codeOf(verified)).toBe("invalid_upto_stellar_payload_nonce_already_used");
    });
  });
});
