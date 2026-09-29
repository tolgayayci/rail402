import { describe, expect, it } from "vitest";
import { Account, Keypair, MuxedAccount, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  acceptedAsset,
  preflight,
  type NetworkPolicy,
  type PreflightContext,
} from "@rail402.dev/facilitator";
import { PASSPHRASE, buildTransfer, randomContractId } from "@rail402.dev/testkit";

const asset = randomContractId();
const payTo = Keypair.random().publicKey();
const sponsor = Keypair.random().publicKey();

const policy: NetworkPolicy = {
  network: "stellar:testnet",
  assets: new Map([
    [asset, acceptedAsset({ contract: asset, symbol: "USDC", decimals: 7 }, { maxAmount: 100_000_000n })],
  ]),
  timeoutSeconds: { min: 10, max: 300 },
  expirationMarginLedgers: 1,
  maxTransactionFeeStroops: 300_000,
  inclusionFeeStroops: 100,
};
const context = (overrides: Partial<PreflightContext> = {}): PreflightContext => ({
  policy,
  passphrase: PASSPHRASE,
  facilitatorAddresses: new Set([sponsor]),
  currentLedger: 1_000,
  ...overrides,
});

const requirements = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "stellar:testnet",
  asset,
  payTo,
  amount: "1234567",
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
  ...overrides,
});

async function payment(options: Parameters<typeof buildTransfer>[0] = {}, required = requirements()) {
  const built = await buildTransfer({
    asset,
    to: payTo,
    amount: 1_234_567n,
    expirationLedger: 1_010,
    ...options,
  });
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: { url: "https://seller.example/resource" },
    accepted: required,
    payload: { transaction: built.xdr },
  };
  return { payload, built };
}

describe("preflight", () => {
  it("accepts a well-formed payment and returns the payer's authorization", async () => {
    const { payload, built } = await payment({ nonce: 99n });
    const result = preflight(payload, requirements(), context());
    expect(result).toMatchObject({
      ok: true,
      authorization: { nonce: 99n, address: built.payer.publicKey() },
    });
  });

  it.each<[string, Partial<PaymentRequirements>, string]>([
    [
      "an unaccepted asset",
      { asset: randomContractId() },
      "invalid_exact_stellar_requirements_asset_not_accepted",
    ],
    ["a malformed payTo", { payTo: "GNOTANADDRESS" }, "invalid_exact_stellar_requirements_invalid_pay_to"],
    ["a decimal amount", { amount: "1.5" }, "invalid_exact_stellar_requirements_invalid_amount"],
    ["a zero amount", { amount: "0" }, "invalid_exact_stellar_requirements_invalid_amount"],
    [
      "an amount above the ceiling",
      { amount: "100000001" },
      "invalid_exact_stellar_requirements_amount_out_of_range",
    ],
    [
      "a timeout below the floor",
      { maxTimeoutSeconds: 1 },
      "invalid_exact_stellar_requirements_timeout_out_of_range",
    ],
    [
      "unsponsored fees",
      { extra: { areFeesSponsored: false } },
      "invalid_exact_stellar_requirements_fees_not_sponsored",
    ],
    ["a missing extra", { extra: {} }, "invalid_exact_stellar_requirements_fees_not_sponsored"],
  ])("rejects requirements with %s", async (_label, override, code) => {
    const required = requirements(override);
    const { payload } = await payment({}, required);
    expect(preflight(payload, required, context())).toMatchObject({ ok: false, code });
  });

  it("rejects protocol mismatches before decoding anything", async () => {
    const { payload } = await payment();
    expect(preflight({ ...payload, x402Version: 1 }, requirements(), context())).toMatchObject({
      code: "invalid_x402_version",
    });
    expect(preflight(payload, requirements({ scheme: "upto" }), context())).toMatchObject({
      code: "unsupported_scheme",
    });
    expect(preflight(payload, requirements({ network: "stellar:pubnet" }), context())).toMatchObject({
      code: "invalid_network",
    });
    expect(
      preflight(
        { ...payload, accepted: { ...payload.accepted, network: "stellar:pubnet" } },
        requirements(),
        context(),
      ),
    ).toMatchObject({ code: "network_mismatch" });
  });

  it("rejects an accepted block that differs from the requirements", async () => {
    const { payload } = await payment();
    const accepted = { ...payload.accepted, amount: "1" };
    expect(preflight({ ...payload, accepted }, requirements(), context())).toMatchObject({
      code: "invalid_exact_stellar_payload_accepted_mismatch",
    });
  });

  it("rejects a transfer that does not match the requirements", async () => {
    const other = Keypair.random().publicKey();
    for (const [options, code] of [
      [{ to: other }, "invalid_exact_stellar_payload_wrong_recipient"],
      [{ amount: 7n }, "invalid_exact_stellar_payload_wrong_amount"],
      [{ asset: randomContractId() }, "invalid_exact_stellar_payload_wrong_asset"],
    ] as const) {
      const { payload } = await payment(options);
      expect(preflight(payload, requirements(), context()), code).toMatchObject({ ok: false, code });
    }
  });

  it("refuses a payment to the payer's own account, muxed or not", async () => {
    const payer = Keypair.random();
    const muxed = new MuxedAccount(new Account(payer.publicKey(), "0"), "7").accountId();
    for (const to of [payer.publicKey(), muxed]) {
      const required = requirements({ payTo: to });
      const { payload } = await payment({ payer, to }, required);
      expect(preflight(payload, required, context()), to).toMatchObject({
        ok: false,
        code: "invalid_exact_stellar_payload_self_payment",
        payer: payer.publicKey(),
      });
    }
  });

  it("protects facilitator accounts", async () => {
    const facilitatorPayer = Keypair.random();
    const { payload } = await payment({ payer: facilitatorPayer });
    expect(
      preflight(
        payload,
        requirements(),
        context({ facilitatorAddresses: new Set([facilitatorPayer.publicKey()]) }),
      ),
    ).toMatchObject({ code: "invalid_exact_stellar_payload_unsafe_tx_or_op_source" });

    // The facilitator as transaction source, with a different payer.
    const { payload: sourced, built } = await payment();
    const transaction = TransactionBuilder.fromXDR(
      (sourced.payload as { transaction: string }).transaction,
      PASSPHRASE,
    ) as Transaction;
    expect(
      preflight(sourced, requirements(), context({ facilitatorAddresses: new Set([transaction.source]) })),
    ).toMatchObject({
      code: "invalid_exact_stellar_payload_unsafe_tx_or_op_source",
      payer: built.payer.publicKey(),
    });
  });

  it("rejects a facilitator account as payer or co-signer", async () => {
    const facilitatorKey = Keypair.random();
    const facilitator = context({ facilitatorAddresses: new Set([facilitatorKey.publicKey()]) });

    const { payload: paying } = await payment({
      payer: facilitatorKey,
      source: Keypair.random().publicKey(),
    });
    expect(preflight(paying, requirements(), facilitator)).toMatchObject({
      code: "invalid_exact_stellar_payload_facilitator_is_payer",
    });

    const { payload: cosigned } = await payment({
      extraAuthorization: { signer: facilitatorKey, sign: true },
    });
    expect(preflight(cosigned, requirements(), facilitator)).toMatchObject({
      code: "invalid_exact_stellar_payload_facilitator_in_auth",
    });
  });

  it.each<[string, Parameters<typeof buildTransfer>[0], string]>([
    ["no authorization entries", { noAuthorization: true }, "invalid_exact_stellar_payload_no_auth_entries"],
    [
      "another account's unsigned authorization",
      { extraAuthorization: { signer: Keypair.random(), sign: false } },
      "invalid_exact_stellar_payload_unexpected_pending_signatures",
    ],
    [
      "source-account credentials",
      { credential: "source_account" },
      "invalid_exact_stellar_payload_unsupported_credential_type",
    ],
    ["an unsigned authorization", { sign: false }, "invalid_exact_stellar_payload_missing_payer_signature"],
    ["sub-invocations", { subInvocation: true }, "invalid_exact_stellar_payload_has_subinvocations"],
    [
      "ledger bounds",
      { ledgerBounds: { minLedger: 5, maxLedger: 0 } },
      "invalid_exact_stellar_payload_unsupported_preconditions",
    ],
    ["an extra operation", { extraOperation: true }, "invalid_exact_stellar_payload_wrong_operation"],
  ])("rejects %s", async (_label, options, code) => {
    const { payload } = await payment(options);
    expect(preflight(payload, requirements(), context())).toMatchObject({ ok: false, code });
  });

  it("rejects an authorization signed for a different call than the operation", async () => {
    const { payload } = await payment({
      editAuthorizedCall: (call) => {
        call.functionName("burn");
        return call;
      },
    });
    expect(preflight(payload, requirements(), context())).toMatchObject({
      code: "invalid_exact_stellar_payload_auth_invocation_mismatch",
    });
  });

  it("enforces the expiration margin, inclusive of the expiration ledger", async () => {
    const at = (expirationLedger: number) => payment({ expirationLedger });
    expect(preflight((await at(999)).payload, requirements(), context())).toMatchObject({
      code: "invalid_exact_stellar_signature_expired",
    });
    expect(preflight((await at(1_000)).payload, requirements(), context())).toMatchObject({
      code: "invalid_exact_stellar_signature_expiration_too_soon",
    });
    expect(preflight((await at(1_001)).payload, requirements(), context())).toMatchObject({ ok: true });
  });

  it("names the payer on every rejection after the payer is known", async () => {
    const { payload, built } = await payment({ amount: 1n });
    expect(preflight(payload, requirements(), context())).toMatchObject({ payer: built.payer.publicKey() });
  });
});
