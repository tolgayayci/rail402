/**
 * The `upto` rows of the rejection audit: every static and simulation refusal of an `upto` payment,
 * sent over HTTP to `/verify` and `/settle` of a running Rail402, each answer checked for a registered
 * code the case expects and a non-empty reason (see `probe` in rejection-audit-run.ts).
 *
 * Payments are signed by `@rail402.dev/upto`'s client as a buyer signs them, then changed:
 * - in the requirements or the entry alone, which the static rules refuse with the field's own code
 *   before anything is simulated;
 * - consistently, entry and requirements rebuilt for another recipient with the original signature,
 *   which only the payer's signature can catch (the simulation);
 * - or signed properly over terms the client would never choose (a start ledger, an expiration outside
 *   the window, another settlement authority).
 * Account and balance refusals use accounts the caller funded; the replay case settles one payment and
 * then tries it again.
 *
 * Codes no request can produce against an honest network and token (a token moving other balances or
 * emitting other events, archived state, a revoked trustline, the fee ceiling) are proven by the
 * integration suites instead; the error-code page lists them with that justification.
 */
import { randomBytes } from "node:crypto";
import { Account, Address, Asset, Keypair, MuxedAccount, xdr } from "@stellar/stellar-sdk";
import { createEd25519Signer } from "@x402/stellar";
import {
  decodeAuthorizationEntry,
  encodeAuthorizationEntry,
  expirationLedgerFor,
  termsFromScVal,
  unsignedPayerEntry,
  type UptoTerms,
} from "@rail402.dev/upto";
import { UptoStellarScheme as UptoStellarClient } from "@rail402.dev/upto/client";
import {
  accountSigner,
  addressCredentialsOf,
  deploySimpleAccount,
  simpleAccountSigner,
  type LocalNetwork,
} from "@rail402.dev/testkit";
import { baseUrl, type CaseContext, type CaseRecorder } from "./harness.ts";
import { probe, type AuditAccounts } from "./rejection-audit-run.ts";

export interface UptoAuditOptions {
  readonly facilitator: string;
  readonly net: LocalNetwork;
  /** The asset contract the facilitator accepts, held by the audit's payers. */
  readonly asset: string;
  /** A second asset the facilitator accepts, for the wrong-asset case; any other contract without it. */
  readonly otherAsset?: string;
  /** The facilitator's settlement authority, `extra.facilitatorAddress` of its upto kind. */
  readonly authority: string;
  /** The settlement contract when it is not the network's canonical deployment (a local network). */
  readonly contract?: string;
  /** Seconds per ledger the payers' client assumes (default: the client's own estimate). */
  readonly ledgerSeconds?: number;
  readonly isRegistered: (code: string) => boolean;
  readonly accounts: AuditAccounts;
  /** Deploy a smart account for the C… wrong-key case. */
  readonly smartAccount?: boolean;
}

type Requirements = {
  readonly scheme: "upto";
  readonly network: "stellar:testnet";
  readonly asset: string;
  readonly payTo: string;
  readonly amount: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: Record<string, unknown>;
};

interface Payment {
  readonly x402Version: 2;
  readonly resource: { readonly url: string };
  readonly accepted: Requirements;
  readonly payload: Record<string, unknown>;
}

/** The cap of every audit payment; the settle cases ask for `SETTLE_AMOUNT` of it. */
const CAP = 10_000n;
const SETTLE_AMOUNT = 100n;

/** Runs every `upto` audit case into `recorder`. */
export async function runUptoAudit(recorder: CaseRecorder, options: UptoAuditOptions): Promise<void> {
  const base = baseUrl(options.facilitator);
  const { net, accounts, isRegistered, authority } = options;
  const [payer, , replayPayer] = accounts.payers;
  if (payer === undefined || replayPayer === undefined) throw new Error("the audit needs funded payers");
  const other = Keypair.random().publicKey();

  const requirements = (overrides: Partial<Requirements> = {}): Requirements => ({
    scheme: "upto",
    network: "stellar:testnet",
    asset: options.asset,
    payTo: accounts.payTo,
    amount: CAP.toString(),
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true, facilitatorAddress: authority },
    ...overrides,
  });
  const wrap = (accepted: Requirements, payload: Record<string, unknown>): Payment => ({
    x402Version: 2,
    resource: { url: "https://seller.example/metered" },
    accepted,
    payload,
  });
  const clientOptions = {
    rpcConfig: { url: net.rpcUrl },
    ...(options.contract === undefined ? {} : { contracts: options.contract }),
    ...(options.ledgerSeconds === undefined ? {} : { ledgerSeconds: options.ledgerSeconds }),
  };
  /** A payment signed by the upto client for `accepted`, as a buyer makes one. */
  const pay = async (from: Keypair = payer, accepted = requirements()): Promise<Payment> => {
    const client = new UptoStellarClient(
      createEd25519Signer(from.secret(), "stellar:testnet"),
      clientOptions,
    );
    const created = await client.createPaymentPayload(2, accepted);
    return wrap(accepted, created.payload);
  };
  const entryOf = (payment: Payment) =>
    decodeAuthorizationEntry(String((payment.payload as { authorization?: unknown }).authorization));
  const contractOf = (payment: Payment) =>
    Address.fromScAddress(
      entryOf(payment).rootInvocation().function().contractFn().contractAddress(),
    ).toString();
  const termsOf = (payment: Payment): UptoTerms => {
    const [argument] = entryOf(payment).rootInvocation().function().contractFn().args();
    const terms = argument === undefined ? undefined : termsFromScVal(argument);
    if (terms === undefined) throw new Error("not an upto authorization");
    return terms;
  };
  /** The payment with its entry changed in place; the payer's signature stays as it was. */
  const edit = (payment: Payment, change: (entry: xdr.SorobanAuthorizationEntry) => void): Payment => {
    const entry = entryOf(payment);
    change(entry);
    return { ...payment, payload: { authorization: encodeAuthorizationEntry(entry) } };
  };
  /** A payment the payer signed over `terms` of the test's choosing. */
  const signTerms = async (
    from: Keypair,
    accepted: Requirements,
    overrides: Partial<UptoTerms>,
    payerAddress = from.publicKey(),
  ): Promise<Payment> => {
    const contract = contractOf(await pay());
    const latest = await net.latestLedger();
    const terms: UptoTerms = {
      expirationLedger: expirationLedgerFor(latest, accepted.maxTimeoutSeconds, options.ledgerSeconds ?? 5),
      facilitator: authority,
      maxAmount: BigInt(accepted.amount),
      recipient: accepted.payTo,
      token: accepted.asset,
      validAfterLedger: 0,
      ...overrides,
    };
    const entry = unsignedPayerEntry({ contract, payer: payerAddress, terms, nonce: randomNonce() });
    const signed = await accountSigner(from)(entry, net.passphrase);
    return wrap(accepted, { authorization: encodeAuthorizationEntry(signed) });
  };

  const call = (
    context: CaseContext,
    operation: "verify" | "settle",
    payment: unknown,
    paymentRequirements: unknown,
    expected: readonly string[],
  ) =>
    probe(context, isRegistered, {
      surface: "facilitator",
      operation: `POST /${operation}`,
      url: `${base}/${operation}`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x402Version: 2, paymentPayload: payment, paymentRequirements }),
      },
      expected,
      status: 200,
    });
  /** /verify at the cap and /settle for part of it must both refuse with one of `expected`. */
  const both = async (
    context: CaseContext,
    payment: Payment,
    expected: readonly string[],
    at: Requirements = payment.accepted,
  ) => {
    await call(context, "verify", payment, at, expected);
    await call(context, "settle", payment, { ...at, amount: settleAmountOf(at) }, expected);
  };
  const uptoCase = (id: string, title: string, run: (context: CaseContext) => Promise<void>) =>
    recorder.run({ id, title, checks: ["rejection-codes", "scheme-upto"], scheme: "upto" }, run);

  // --- requirements -------------------------------------------------------------------------------------
  await uptoCase(
    "upto-fees-not-sponsored",
    "upto requirements without areFeesSponsored are refused",
    async (context) => {
      const changed = requirements({ extra: { areFeesSponsored: false, facilitatorAddress: authority } });
      await both(context, { ...(await pay()), accepted: changed }, [
        "invalid_upto_stellar_requirements_fees_not_sponsored",
      ]);
    },
  );
  await uptoCase(
    "upto-authority-not-ours",
    "upto requirements naming another settlement authority are refused",
    async (context) => {
      const changed = requirements({ extra: { areFeesSponsored: true, facilitatorAddress: other } });
      await both(context, { ...(await pay()), accepted: changed }, [
        "invalid_upto_stellar_requirements_facilitator_mismatch",
      ]);
    },
  );
  await uptoCase(
    "upto-payto-invalid",
    "an upto payTo that is not a Stellar address, or is muxed, is refused",
    async (context) => {
      const payment = await pay();
      const invalid = requirements({ payTo: "GNOTANADDRESS" });
      await both(context, { ...payment, accepted: invalid }, [
        "invalid_upto_stellar_requirements_invalid_pay_to",
        "invalid_payload",
      ]);
      const muxed = requirements({ payTo: muxedOf(accounts.payTo) });
      await both(context, { ...payment, accepted: muxed }, [
        "invalid_upto_stellar_payload_unsupported_recipient",
        "invalid_upto_stellar_requirements_invalid_pay_to",
      ]);
    },
  );
  await uptoCase(
    "upto-amount-invalid",
    "an upto cap or settle amount that is not a non-negative integer is refused; a zero cap too",
    async (context) => {
      const payment = await pay();
      const codes = [
        "invalid_upto_stellar_requirements_invalid_amount",
        "invalid_upto_stellar_requirements_amount_out_of_range",
        "invalid_payload",
      ];
      // At /verify the amount is the cap the payment accepted; at /settle it is the charge.
      for (const amount of ["0", "-5", "1.5", "abc"]) {
        const changed = requirements({ amount });
        await call(context, "verify", { ...payment, accepted: changed }, changed, codes);
        if (amount !== "0") await call(context, "settle", payment, changed, codes);
      }
    },
  );
  await uptoCase(
    "upto-asset-not-accepted",
    "an upto payment in an asset the facilitator does not accept is refused",
    async (context) => {
      const unknown = new Asset("TEST", Keypair.random().publicKey()).contractId(net.passphrase);
      const changed = requirements({ asset: unknown });
      await both(context, { ...(await pay()), accepted: changed }, [
        "invalid_upto_stellar_requirements_asset_not_accepted",
      ]);
    },
  );
  await uptoCase(
    "upto-timeout-out-of-range",
    "upto maxTimeoutSeconds outside the accepted range is refused",
    async (context) => {
      const payment = await pay();
      for (const maxTimeoutSeconds of [86_400, 1]) {
        const changed = requirements({ maxTimeoutSeconds });
        await both(context, { ...payment, accepted: changed }, [
          "invalid_upto_stellar_requirements_timeout_out_of_range",
        ]);
      }
    },
  );

  // --- payload shape ------------------------------------------------------------------------------------
  await uptoCase(
    "upto-accepted-mismatch",
    "upto requirements that differ from the ones the payment accepted are refused",
    async (context) => {
      const payment = await pay();
      await both(context, payment, ["invalid_upto_stellar_payload_accepted_mismatch"], {
        ...payment.accepted,
        maxTimeoutSeconds: 90,
      });
    },
  );
  await uptoCase(
    "upto-payload-malformed",
    "an upto payload that is not one base64 authorization entry is refused",
    async (context) => {
      const accepted = requirements();
      for (const payload of [
        { authorization: "!!not-base64!!" },
        { authorization: Buffer.from("not an entry").toString("base64") },
        { transaction: "AAAA" },
      ]) {
        await both(context, wrap(accepted, payload), [
          "invalid_upto_stellar_payload_malformed",
          "invalid_payload",
        ]);
      }
    },
  );
  await uptoCase(
    "upto-payload-too-large",
    "an upto authorization over the size limit is refused",
    async (context) => {
      await both(context, wrap(requirements(), { authorization: "A".repeat(66_000) }), [
        "invalid_upto_stellar_payload_too_large",
        "payload_too_large",
      ]);
    },
  );
  await uptoCase(
    "upto-signer-authorizations",
    "more signer authorizations than a smart account may carry are refused",
    async (context) => {
      const payment = await pay();
      const authorization = String(payment.payload["authorization"]);
      await both(
        context,
        { ...payment, payload: { authorization, signerAuthorizations: Array(5).fill(authorization) } },
        [
          "invalid_upto_stellar_payload_invalid_signer_authorization",
          "invalid_upto_stellar_payload_malformed",
        ],
      );
    },
  );

  // --- the signed terms against the requirements ------------------------------------------------------------
  await uptoCase(
    "upto-wrong-recipient",
    "upto requirements for another payTo than the signed recipient are refused",
    async (context) => {
      const changed = requirements({ payTo: other });
      await both(context, { ...(await pay()), accepted: changed }, [
        "invalid_upto_stellar_payload_wrong_recipient",
      ]);
    },
  );
  await uptoCase(
    "upto-wrong-asset",
    "upto requirements for another asset than the signed token are refused",
    async (context) => {
      const asset =
        options.otherAsset ?? new Asset("TEST", Keypair.random().publicKey()).contractId(net.passphrase);
      const changed = requirements({ asset });
      await both(context, { ...(await pay()), accepted: changed }, [
        "invalid_upto_stellar_payload_wrong_asset",
        ...(options.otherAsset === undefined ? ["invalid_upto_stellar_requirements_asset_not_accepted"] : []),
      ]);
    },
  );
  await uptoCase(
    "upto-wrong-cap",
    "upto requirements for another cap than the signed one are refused",
    async (context) => {
      const changed = requirements({ amount: (2n * CAP).toString() });
      await both(context, { ...(await pay()), accepted: changed }, [
        "invalid_upto_stellar_payload_wrong_amount",
      ]);
    },
  );
  await uptoCase(
    "upto-expiration-mismatch",
    "an upto entry whose signature expiration differs from the signed terms is refused",
    async (context) => {
      const payment = edit(await pay(), (entry) => {
        const credentials = addressCredentialsOf(entry);
        credentials.signatureExpirationLedger(credentials.signatureExpirationLedger() + 1);
      });
      await both(context, payment, ["invalid_upto_stellar_payload_expiration_mismatch"]);
    },
  );
  await uptoCase(
    "upto-wrong-contract",
    "an upto entry for another contract than the settlement contract is refused",
    async (context) => {
      const payment = edit(await pay(), (entry) => {
        entry
          .rootInvocation()
          .function()
          .contractFn()
          .contractAddress(Address.fromString(options.asset).toScAddress());
      });
      await both(context, payment, ["invalid_upto_stellar_payload_wrong_contract"]);
    },
  );
  await uptoCase(
    "upto-wrong-function",
    "an upto entry for another function than settle is refused",
    async (context) => {
      const payment = edit(await pay(), (entry) => {
        entry.rootInvocation().function().contractFn().functionName("transfer");
      });
      await both(context, payment, ["invalid_upto_stellar_payload_wrong_function"]);
    },
  );
  await uptoCase(
    "upto-authorization-tree",
    "an upto entry whose approve child is missing, changed, doubled or nested is refused",
    async (context) => {
      const payment = await pay();
      const approveArgs = (entry: xdr.SorobanAuthorizationEntry) =>
        entry.rootInvocation().subInvocations()[0]?.function().contractFn();
      const changes: ((entry: xdr.SorobanAuthorizationEntry) => void)[] = [
        (entry) => entry.rootInvocation().subInvocations([]),
        (entry) => {
          const call = approveArgs(entry);
          const args = call?.args() ?? [];
          args[1] = xdr.ScVal.scvAddress(Address.fromString(other).toScAddress());
          call?.args(args);
        },
        (entry) => {
          const [approve] = entry.rootInvocation().subInvocations();
          if (approve !== undefined) entry.rootInvocation().subInvocations([approve, approve]);
        },
        (entry) => {
          const [approve] = entry.rootInvocation().subInvocations();
          if (approve === undefined) return;
          approve.subInvocations([xdr.SorobanAuthorizedInvocation.fromXDR(approve.toXDR())]);
        },
      ];
      for (const change of changes) {
        await both(context, edit(payment, change), [
          "invalid_upto_stellar_payload_invalid_authorization_tree",
        ]);
      }
    },
  );
  await uptoCase(
    "upto-credential-type",
    "an upto entry with source-account credentials is refused",
    async (context) => {
      const payment = edit(await pay(), (entry) =>
        entry.credentials(xdr.SorobanCredentials.sorobanCredentialsSourceAccount()),
      );
      await both(context, payment, ["invalid_upto_stellar_payload_unsupported_credential_type"]);
    },
  );
  await uptoCase(
    "upto-missing-signature",
    "an upto entry without the payer's signature is refused",
    async (context) => {
      const payment = edit(await pay(), (entry) =>
        addressCredentialsOf(entry).signature(xdr.ScVal.scvVoid()),
      );
      await both(context, payment, ["invalid_upto_stellar_payload_missing_payer_signature"]);
    },
  );
  await uptoCase(
    "upto-terms-authority",
    "upto terms signed for another settlement authority are refused",
    async (context) => {
      await both(context, await signTerms(payer, requirements(), { facilitator: other }), [
        "invalid_upto_stellar_payload_facilitator_mismatch",
      ]);
    },
  );
  await uptoCase(
    "upto-facilitator-is-payer",
    "an upto payment from the settlement authority is refused",
    async (context) => {
      // Signed by another key: the rule refuses the payer before any signature is checked.
      const payment = await signTerms(payer, requirements(), {}, authority);
      await both(context, payment, ["invalid_upto_stellar_payload_facilitator_is_payer"]);
    },
  );
  await uptoCase(
    "upto-self-payment",
    "an upto payment to the payer's own account is refused",
    async (context) => {
      // The client refuses to sign one, so the payer signs the terms directly.
      const accepted = requirements({ payTo: payer.publicKey() });
      await both(context, await signTerms(payer, accepted, {}), [
        "invalid_upto_stellar_payload_self_payment",
      ]);
    },
  );

  // --- time -------------------------------------------------------------------------------------------
  await uptoCase(
    "upto-not-yet-valid",
    "upto terms that start at a later ledger are refused until then",
    async (context) => {
      const latest = await net.latestLedger();
      const payment = await signTerms(payer, requirements(), { validAfterLedger: latest + 5 });
      await both(context, payment, ["invalid_upto_stellar_payload_not_yet_valid"]);
    },
  );
  await uptoCase("upto-expired", "an expired upto authorization is refused", async (context) => {
    const latest = await net.latestLedger();
    const payment = await signTerms(payer, requirements(), { expirationLedger: latest - 10 });
    await both(context, payment, ["invalid_upto_stellar_signature_expired"]);
  });
  await uptoCase(
    "upto-expires-too-far",
    "an upto authorization expiring beyond maxTimeoutSeconds is refused",
    async (context) => {
      const latest = await net.latestLedger();
      const payment = await signTerms(payer, requirements(), { expirationLedger: latest + 5_000 });
      await both(context, payment, ["invalid_upto_stellar_signature_expiration_too_far"]);
    },
  );
  await uptoCase(
    "upto-expires-too-soon",
    "an upto authorization expiring at the current ledger is refused, before simulating or at submission",
    async (context) => {
      const latest = await net.latestLedger();
      const payment = await signTerms(payer, requirements(), { expirationLedger: latest });
      // A ledger reading a few ledgers old only makes the lower bound more lenient: the settlement is
      // then refused by the network at submission (its ledger bounds end at the expiration), and no
      // fee is spent; the settlement is finished as expired once nothing can have landed.
      await call(context, "settle", payment, { ...payment.accepted, amount: SETTLE_AMOUNT.toString() }, [
        "invalid_upto_stellar_signature_expiration_too_soon",
        "invalid_upto_stellar_signature_expired",
        "settle_upto_stellar_transaction_expired",
      ]);
    },
  );

  // --- settle amount and signature ----------------------------------------------------------------------------
  await uptoCase(
    "upto-settle-over-cap",
    "an upto settlement above the signed cap is refused before simulating",
    async (context) => {
      const payment = await pay();
      await call(context, "settle", payment, { ...payment.accepted, amount: (CAP + 1n).toString() }, [
        "invalid_upto_stellar_payload_settlement_exceeds_amount",
      ]);
    },
  );
  await uptoCase(
    "upto-forged-terms",
    "upto terms rebuilt for another recipient with the original signature fail the signature",
    async (context) => {
      const payment = await pay();
      const original = entryOf(payment);
      const credentials = addressCredentialsOf(original);
      const changed = requirements({ payTo: other });
      const forged = unsignedPayerEntry({
        contract: contractOf(payment),
        payer: payer.publicKey(),
        terms: { ...termsOf(payment), recipient: other },
        nonce: credentials.nonce().toBigInt(),
      });
      addressCredentialsOf(forged).signature(credentials.signature());
      await both(context, wrap(changed, { authorization: encodeAuthorizationEntry(forged) }), [
        "invalid_upto_stellar_payload_invalid_signature",
      ]);
    },
  );

  // --- accounts and balances ------------------------------------------------------------------------------------
  await uptoCase(
    "upto-insufficient-balance",
    "an upto settlement the payer cannot cover is refused",
    async (context) => {
      const payment = await pay(accounts.poor);
      await call(context, "settle", payment, { ...payment.accepted, amount: SETTLE_AMOUNT.toString() }, [
        "insufficient_funds",
      ]);
    },
  );
  await uptoCase(
    "upto-payer-no-trustline",
    "an upto payer without a trustline to the asset is named",
    async (context) => {
      await both(context, await pay(accounts.untrusted), [
        "invalid_upto_stellar_payload_payer_trustline_missing",
      ]);
    },
  );
  await uptoCase(
    "upto-payto-no-trustline",
    "an upto payTo without a trustline to the asset is named",
    async (context) => {
      const accepted = requirements({ payTo: accounts.untrusted.publicKey() });
      await both(context, await pay(payer, accepted), [
        "invalid_upto_stellar_payload_recipient_trustline_missing",
      ]);
    },
  );
  await uptoCase(
    "upto-payer-account-missing",
    "an upto payer account that does not exist is named",
    async (context) => {
      await both(context, await pay(Keypair.random()), ["invalid_upto_stellar_payload_account_missing"]);
    },
  );
  if (options.smartAccount === false) {
    recorder.skip(
      {
        id: "upto-c-payer-wrong-key",
        title: "an upto payment from a C… account signed by the wrong key is refused",
        checks: ["rejection-codes", "scheme-upto"],
        scheme: "upto",
        payer: "C",
      },
      "smart-account cases were turned off for this run",
    );
  } else {
    await recorder.run(
      {
        id: "upto-c-payer-wrong-key",
        title: "an upto payment from a C… account signed by the wrong key is refused",
        checks: ["rejection-codes", "scheme-upto"],
        scheme: "upto",
        payer: "C",
      },
      async (context) => {
        const account = await deploySimpleAccount(net, accounts.deployer, Keypair.random());
        await accounts.fund(account, CAP);
        const client = new UptoStellarClient(
          {
            address: account,
            signAuthEntry: () => Promise.reject(new Error("the smart account signs through authorizeEntry")),
          },
          {
            ...clientOptions,
            authorizeEntry: (entry, context_) =>
              simpleAccountSigner(Keypair.random())(entry, context_.networkPassphrase),
          },
        );
        const accepted = requirements();
        const created = await client.createPaymentPayload(2, accepted);
        await both(context, wrap(accepted, created.payload), [
          "invalid_upto_stellar_payload_smart_account_rejected",
          "invalid_upto_stellar_payload_invalid_signature",
        ]);
      },
    );
  }

  // --- replay ------------------------------------------------------------------------------------------------
  await uptoCase(
    "upto-replay",
    "a settled upto authorization is refused by verify, and settling it for another amount is a conflict",
    async (context) => {
      const payment = await pay(replayPayer);
      const response = await fetch(`${base}/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload: payment,
          paymentRequirements: { ...payment.accepted, amount: SETTLE_AMOUNT.toString() },
        }),
      });
      const answer = (await response.json()) as { success?: boolean; transaction?: string };
      if (answer.success !== true)
        throw new Error(`the payment to replay did not settle: ${JSON.stringify(answer)}`);
      context.observe("settledTransaction", answer.transaction);
      await call(context, "verify", payment, payment.accepted, [
        "invalid_upto_stellar_payload_nonce_already_used",
      ]);
      await call(
        context,
        "settle",
        payment,
        { ...payment.accepted, amount: (SETTLE_AMOUNT + 1n).toString() },
        ["settle_upto_stellar_idempotency_conflict"],
      );
    },
  );
}

/** A settle amount within the cap, or the requirements' own (invalid) amount when it is not a cap. */
function settleAmountOf(requirements: Requirements): string {
  return /^\d+$/.test(requirements.amount) && BigInt(requirements.amount) > SETTLE_AMOUNT
    ? SETTLE_AMOUNT.toString()
    : requirements.amount;
}

function randomNonce(): bigint {
  return randomBytes(8).readBigInt64BE();
}

/** A muxed (M…) address of `account` with id 1. */
function muxedOf(account: string): string {
  return new MuxedAccount(new Account(account, "0"), "1").accountId();
}
