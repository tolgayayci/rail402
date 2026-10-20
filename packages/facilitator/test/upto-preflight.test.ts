import { describe, expect, it } from "vitest";
import { Keypair, StrKey, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { uptoPreflight, type UptoPreflightContext } from "@rail402.dev/facilitator";
import { encodeAuthorizationEntry } from "@rail402.dev/upto";
import {
  CAP,
  CONTRACT,
  LEDGER,
  LEDGER_SECONDS,
  authority,
  channel,
  entry,
  payer,
  payment,
  policy,
  requirements,
  sponsor,
  terms,
  uptoPolicy,
} from "./upto-helpers.ts";

const context = (overrides: Partial<UptoPreflightContext> = {}): UptoPreflightContext => ({
  phase: "verify",
  policy,
  upto: uptoPolicy,
  authority: authority.publicKey(),
  facilitatorAddresses: new Set([sponsor.publicKey(), channel.publicKey(), authority.publicKey()]),
  currentLedger: LEDGER,
  ledgerSeconds: LEDGER_SECONDS,
  ...overrides,
});

const otherContract = StrKey.encodeContract(hash(Buffer.from("another contract")));

/** The payload with `mutate` applied to a copy of its payer entry. */
function withEntry(mutate: (built: xdr.SorobanAuthorizationEntry) => void): PaymentPayload {
  const built = entry();
  mutate(built);
  return payment({ authorization: built });
}

function rootCall(built: xdr.SorobanAuthorizationEntry): xdr.InvokeContractArgs {
  return built.rootInvocation().function().contractFn();
}

function check(
  payload: PaymentPayload,
  required: PaymentRequirements = requirements(),
  overrides: Partial<UptoPreflightContext> = {},
) {
  return uptoPreflight(payload, required, context(overrides));
}

describe("upto preflight", () => {
  it("accepts a well-formed payment for its cap at verify and any amount up to it at settle", () => {
    const verified = check(payment());
    expect(verified).toMatchObject({
      ok: true,
      payment: { payer: payer.publicKey(), amount: CAP, maxAmount: CAP },
    });

    for (const amount of [0n, 250_000n, CAP]) {
      const settled = check(payment(), requirements({ amount: amount.toString() }), { phase: "settle" });
      expect(settled, amount.toString()).toMatchObject({ ok: true, payment: { amount, maxAmount: CAP } });
    }
  });

  it("accepts both credential arms", () => {
    expect(check(payment({ authorization: entry({ credential: "address_v2" }) })).ok).toBe(true);
  });

  it("names one maxTimeoutSeconds range, raised to a ledger more than the expiration margin", () => {
    const refusal = (maxTimeoutSeconds: number, overrides: Partial<UptoPreflightContext> = {}) =>
      check(
        payment({ accepted: requirements({ maxTimeoutSeconds }) }),
        requirements({ maxTimeoutSeconds }),
        overrides,
      );
    // The policy accepts 10 s and up; its margin of 2 ledgers needs 15 s.
    for (const maxTimeoutSeconds of [5, 14, 301]) {
      expect(refusal(maxTimeoutSeconds)).toEqual({
        ok: false,
        code: "invalid_upto_stellar_requirements_timeout_out_of_range",
        reason: "maxTimeoutSeconds must be an integer from 15 to 300.",
      });
    }
    const oneLedger = { policy: { ...policy, expirationMarginLedgers: 1 } };
    expect(refusal(9, oneLedger)).toMatchObject({
      reason: "maxTimeoutSeconds must be an integer from 10 to 300.",
    });
    const atMinimum = refusal(10, oneLedger);
    expect(atMinimum.ok ? "accepted" : atMinimum.code).not.toBe(
      "invalid_upto_stellar_requirements_timeout_out_of_range",
    );
  });

  describe("maps every static rule to its code", () => {
    const cases: [string, () => ReturnType<typeof check>, string][] = [
      // Rule 1: protocol envelope.
      ["an x402 version other than 2", () => check({ ...payment(), x402Version: 1 }), "invalid_x402_version"],
      [
        "another scheme",
        () =>
          check(payment({ accepted: requirements({ scheme: "exact" }) }), requirements({ scheme: "exact" })),
        "unsupported_scheme",
      ],
      [
        "a network this scheme instance does not serve",
        () =>
          check(
            payment({ accepted: requirements({ network: "stellar:pubnet" }) }),
            requirements({ network: "stellar:pubnet" }),
          ),
        "invalid_network",
      ],
      [
        "an accepted network that differs from the requirements",
        () => check(payment({ accepted: requirements({ network: "stellar:pubnet" }) })),
        "network_mismatch",
      ],
      // Rule 2: requirements and what the payer accepted.
      [
        "an asset outside the operator's list",
        () => {
          const asset = StrKey.encodeContract(hash(Buffer.from("unlisted token")));
          return check(payment({ accepted: requirements({ asset }) }), requirements({ asset }));
        },
        "invalid_upto_stellar_requirements_asset_not_accepted",
      ],
      [
        "a classic-asset code instead of a contract",
        () => check(payment({ accepted: requirements({ asset: "USDC" }) }), requirements({ asset: "USDC" })),
        "invalid_upto_stellar_requirements_asset_not_accepted",
      ],
      [
        "a malformed payTo",
        () => check(payment({ accepted: requirements({ payTo: "GBAD" }) }), requirements({ payTo: "GBAD" })),
        "invalid_upto_stellar_requirements_invalid_pay_to",
      ],
      [
        "a channel account as payTo",
        () => {
          const payTo = channel.publicKey();
          return check(payment({ accepted: requirements({ payTo }) }), requirements({ payTo }));
        },
        "invalid_upto_stellar_requirements_invalid_pay_to",
      ],
      [
        "the settlement contract as payTo",
        () =>
          check(payment({ accepted: requirements({ payTo: CONTRACT }) }), requirements({ payTo: CONTRACT })),
        "invalid_upto_stellar_requirements_invalid_pay_to",
      ],
      [
        "a muxed payTo",
        () => {
          const payTo = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ";
          return check(payment({ accepted: requirements({ payTo }) }), requirements({ payTo }));
        },
        "invalid_upto_stellar_payload_unsupported_recipient",
      ],
      [
        "a maxTimeoutSeconds above the operator's maximum",
        () =>
          check(
            payment({ accepted: requirements({ maxTimeoutSeconds: 301 }) }),
            requirements({ maxTimeoutSeconds: 301 }),
          ),
        "invalid_upto_stellar_requirements_timeout_out_of_range",
      ],
      [
        "a maxTimeoutSeconds below the operator's minimum",
        () =>
          check(
            payment({ accepted: requirements({ maxTimeoutSeconds: 5 }) }),
            requirements({ maxTimeoutSeconds: 5 }),
          ),
        "invalid_upto_stellar_requirements_timeout_out_of_range",
      ],
      [
        "unsponsored fees",
        () => {
          const extra = { areFeesSponsored: false, facilitatorAddress: authority.publicKey() };
          return check(payment({ accepted: requirements({ extra }) }), requirements({ extra }));
        },
        "invalid_upto_stellar_requirements_fees_not_sponsored",
      ],
      [
        "another facilitator's authority in extra",
        () => {
          const extra = { areFeesSponsored: true, facilitatorAddress: Keypair.random().publicKey() };
          return check(payment({ accepted: requirements({ extra }) }), requirements({ extra }));
        },
        "invalid_upto_stellar_requirements_facilitator_mismatch",
      ],
      [
        "accepted requirements for another payTo",
        () => check(payment({ accepted: requirements({ payTo: Keypair.random().publicKey() }) })),
        "invalid_upto_stellar_payload_accepted_mismatch",
      ],
      [
        "a verify amount other than the cap",
        () => check(payment(), requirements({ amount: "999999" })),
        "invalid_upto_stellar_payload_accepted_mismatch",
      ],
      [
        "a zero cap",
        () => check(payment({ accepted: requirements({ amount: "0" }) }), requirements({ amount: "0" })),
        "invalid_upto_stellar_requirements_invalid_amount",
      ],
      [
        "a settle amount that is not an integer",
        () => check(payment(), requirements({ amount: "1.5" }), { phase: "settle" }),
        "invalid_upto_stellar_requirements_invalid_amount",
      ],
      [
        "a settle amount above the cap",
        () => check(payment(), requirements({ amount: (CAP + 1n).toString() }), { phase: "settle" }),
        "invalid_upto_stellar_payload_settlement_exceeds_amount",
      ],
      [
        "a cap above the asset's maximum",
        () => {
          const amount = "100000001";
          const built = entry({ terms: terms({ maxAmount: 100_000_001n }) });
          return check(
            payment({ accepted: requirements({ amount }), authorization: built }),
            requirements({ amount }),
          );
        },
        "invalid_upto_stellar_requirements_amount_out_of_range",
      ],
      // Rule 3: the entry.
      [
        "a missing authorization",
        () => check({ ...payment(), payload: {} }),
        "invalid_upto_stellar_payload_malformed",
      ],
      [
        "an authorization that is not XDR",
        () => check(payment({ authorization: "bm90IHhkcg==" })),
        "invalid_upto_stellar_payload_malformed",
      ],
      [
        "an authorization above the size limit",
        () => check(payment({ authorization: "A".repeat(8 * 1024 + 4) })),
        "invalid_upto_stellar_payload_too_large",
      ],
      [
        "source-account credentials",
        () =>
          check(
            withEntry((built) => {
              built.credentials(xdr.SorobanCredentials.sorobanCredentialsSourceAccount());
            }),
          ),
        "invalid_upto_stellar_payload_unsupported_credential_type",
      ],
      [
        "an unsigned entry",
        () => check(payment({ authorization: entry({ signed: false }) })),
        "invalid_upto_stellar_payload_missing_payer_signature",
      ],
      // Rule 4: the root call and its terms.
      [
        "an authorization for another contract",
        () => check(payment({ authorization: entry({ contract: otherContract }) })),
        "invalid_upto_stellar_payload_wrong_contract",
      ],
      [
        "an authorization for another function",
        () =>
          check(
            withEntry((built) => {
              rootCall(built).functionName("transfer");
            }),
          ),
        "invalid_upto_stellar_payload_wrong_function",
      ],
      [
        "terms that are not an UptoTerms map",
        () =>
          check(
            withEntry((built) => {
              rootCall(built).args([nativeToScVal(1, { type: "u32" })]);
            }),
          ),
        "invalid_upto_stellar_payload_invalid_terms",
      ],
      // Rule 5: the terms bind the requirements.
      [
        "terms for another recipient",
        () =>
          check(
            payment({ authorization: entry({ terms: terms({ recipient: Keypair.random().publicKey() }) }) }),
          ),
        "invalid_upto_stellar_payload_wrong_recipient",
      ],
      [
        "terms for another token",
        () => check(payment({ authorization: entry({ terms: terms({ token: otherContract }) }) })),
        "invalid_upto_stellar_payload_wrong_asset",
      ],
      [
        "terms with another cap",
        () => check(payment({ authorization: entry({ terms: terms({ maxAmount: CAP - 1n }) }) })),
        "invalid_upto_stellar_payload_wrong_amount",
      ],
      [
        "terms naming another settlement authority",
        () =>
          check(
            payment({
              authorization: entry({ terms: terms({ facilitator: Keypair.random().publicKey() }) }),
            }),
          ),
        "invalid_upto_stellar_payload_facilitator_mismatch",
      ],
      [
        "terms whose expiration differs from the signature's",
        () =>
          check(
            withEntry((built) => {
              built
                .credentials()
                .address()
                .signatureExpirationLedger(LEDGER + 11);
            }),
          ),
        "invalid_upto_stellar_payload_expiration_mismatch",
      ],
      [
        "terms that are not valid yet",
        () => check(payment({ authorization: entry({ terms: terms({ validAfterLedger: LEDGER + 5 }) }) })),
        "invalid_upto_stellar_payload_not_yet_valid",
      ],
      // Rule 6: the authorization tree.
      [
        "a tree without the approve child",
        () =>
          check(
            withEntry((built) => {
              built.rootInvocation().subInvocations([]);
            }),
          ),
        "invalid_upto_stellar_payload_invalid_authorization_tree",
      ],
      [
        "a tree with a second child",
        () =>
          check(
            withEntry((built) => {
              const [child] = built.rootInvocation().subInvocations();
              if (child !== undefined) built.rootInvocation().subInvocations([child, child]);
            }),
          ),
        "invalid_upto_stellar_payload_invalid_authorization_tree",
      ],
      // Rule 7: the expiration window.
      [
        "an expired authorization",
        () => check(payment({ authorization: entry({ terms: terms({ expirationLedger: LEDGER - 1 }) }) })),
        "invalid_upto_stellar_signature_expired",
      ],
      [
        "an authorization expiring within the margin",
        () => check(payment({ authorization: entry({ terms: terms({ expirationLedger: LEDGER + 1 }) }) })),
        "invalid_upto_stellar_signature_expiration_too_soon",
      ],
      [
        "an authorization expiring later than maxTimeoutSeconds allows",
        () => check(payment({ authorization: entry({ terms: terms({ expirationLedger: LEDGER + 15 }) }) })),
        "invalid_upto_stellar_signature_expiration_too_far",
      ],
      // Rule 8: the payer.
      [
        "the settlement authority as payer",
        () => check(payment({ authorization: entry({ payer: authority.publicKey() }) })),
        "invalid_upto_stellar_payload_facilitator_is_payer",
      ],
      [
        "a channel account as payer",
        () => check(payment({ authorization: entry({ payer: channel.publicKey() }) })),
        "invalid_upto_stellar_payload_facilitator_is_payer",
      ],
      [
        "a payer paying itself",
        () => {
          const payTo = payer.publicKey();
          const accepted = requirements({ payTo });
          return check(
            payment({ accepted, authorization: entry({ terms: terms({ recipient: payTo }) }) }),
            accepted,
          );
        },
        "invalid_upto_stellar_payload_self_payment",
      ],
      // Rule 9: delegated signer entries.
      [
        "signer entries for an account payer",
        () => check(payment({ signerAuthorizations: [encodeAuthorizationEntry(entry())] })),
        "invalid_upto_stellar_payload_invalid_signer_authorization",
      ],
    ];

    it.each(cases)("refuses %s", (_name, run, code) => {
      const result = run();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(code);
      expect(result.reason.trim()).not.toBe("");
    });
  });

  it("names the payer on refusals decided after the entry decoded", () => {
    const result = check(payment({ authorization: entry({ terms: terms({ token: otherContract }) }) }));
    expect(result).toMatchObject({ ok: false, payer: payer.publicKey() });
  });

  it("uses the operator's expiration margin", () => {
    const soon = payment({ authorization: entry({ terms: terms({ expirationLedger: LEDGER + 3 }) }) });
    expect(check(soon).ok).toBe(true);
    const wider = { ...policy, expirationMarginLedgers: 5 };
    expect(check(soon, requirements(), { policy: wider })).toMatchObject({
      ok: false,
      code: "invalid_upto_stellar_signature_expiration_too_soon",
    });
  });
});
