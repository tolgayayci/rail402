import { describe, expect, it } from "vitest";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { classifyTransferFailure, hostErrors } from "@rail402.dev/stellar";
import {
  address,
  authError,
  contractError,
  cryptoError,
  errorEvent,
  randomContractId,
} from "@rail402.dev/testkit";

const asset = randomContractId();
const from = Keypair.random().publicKey();
const to = Keypair.random().publicKey();
const context = { asset, from, to };

/** Event sequences below mirror diagnostics captured from protocol 28 simulations. */
const classify = (...events: xdr.DiagnosticEvent[]) => classifyTransferFailure(hostErrors(events), context);

describe("hostErrors", () => {
  it("extracts type, code, message and arguments", () => {
    const [error] = hostErrors([
      errorEvent({
        contract: asset,
        error: contractError(13),
        message: "trustline entry is missing for account",
        args: [address(to)],
      }),
    ]);
    expect(error).toEqual({
      contract: asset,
      type: "Contract",
      code: 13,
      message: "trustline entry is missing for account",
      args: [to],
    });
  });

  it("ignores events that are not host errors", () => {
    const transfer = new xdr.DiagnosticEvent({
      inSuccessfulContractCall: true,
      event: new xdr.ContractEvent({
        ext: new xdr.ExtensionPoint(0),
        contractId: null,
        type: xdr.ContractEventType.diagnostic(),
        body: new xdr.ContractEventBody(
          0,
          new xdr.ContractEventV0({ topics: [xdr.ScVal.scvSymbol("fn_call")], data: xdr.ScVal.scvVoid() }),
        ),
      }),
    });
    expect(hostErrors([transfer])).toEqual([]);
  });
});

describe("classifyTransferFailure", () => {
  it("replayed authorization → nonce_already_used", () => {
    expect(
      classify(
        errorEvent({
          contract: asset,
          error: authError(xdr.ScErrorCode.scecExistingValue()),
          message: "nonce already exists for address",
          args: [address(from)],
        }),
      ).code,
    ).toBe("invalid_exact_stellar_payload_nonce_already_used");
  });

  it("tampered authorization → invalid_signature", () => {
    expect(
      classify(
        errorEvent({
          contract: asset,
          error: authError(xdr.ScErrorCode.scecInvalidAction()),
          message: "failed account authentication with error",
          args: [address(from), xdr.ScVal.scvError(cryptoError(xdr.ScErrorCode.scecInvalidInput()))],
        }),
        errorEvent({
          contract: asset,
          error: cryptoError(xdr.ScErrorCode.scecInvalidInput()),
          message: "failed ED25519 verification",
        }),
      ).code,
    ).toBe("invalid_exact_stellar_payload_invalid_signature");
  });

  it("operation differs from the signed invocation → unauthorized_invocation", () => {
    expect(
      classify(
        errorEvent({
          contract: asset,
          error: authError(xdr.ScErrorCode.scecInvalidAction()),
          message: "Unauthorized function call for address",
          args: [address(from)],
        }),
      ).code,
    ).toBe("invalid_exact_stellar_payload_unauthorized_invocation");
  });

  it("missing trustline blames the recipient or the payer from the event argument", () => {
    const missing = (account: string) =>
      errorEvent({
        contract: asset,
        error: contractError(13),
        message: "trustline entry is missing for account",
        args: [address(account)],
      });
    expect(classify(missing(to)).code).toBe("invalid_exact_stellar_payload_recipient_trustline_missing");
    expect(classify(missing(from)).code).toBe("invalid_exact_stellar_payload_payer_trustline_missing");
  });

  it("balance out of range → insufficient_funds", () => {
    expect(
      classify(
        errorEvent({
          contract: asset,
          error: contractError(10),
          message: "resulting balance is not within the allowed range",
          args: [nativeToScVal(0n, { type: "i128" })],
        }),
      ).code,
    ).toBe("insufficient_funds");
  });

  it("maps the remaining Stellar Asset Contract errors", () => {
    const sac = (code: number) =>
      classify(errorEvent({ contract: asset, error: contractError(code), message: "x", args: [address(to)] }))
        .code;
    expect(sac(6)).toBe("invalid_exact_stellar_payload_account_missing");
    expect(sac(11)).toBe("invalid_exact_stellar_payload_trustline_not_authorized");
  });

  it("a smart-account payer rejecting in __check_auth → smart_account_rejected", () => {
    const smartFrom = randomContractId();
    const errors = hostErrors([
      errorEvent({ contract: smartFrom, error: contractError(3), message: "denied" }),
    ]);
    expect(classifyTransferFailure(errors, { ...context, from: smartFrom }).code).toBe(
      "invalid_exact_stellar_payload_smart_account_rejected",
    );
  });

  it("an expired authorization → signature_expired", () => {
    expect(
      classify(
        errorEvent({
          contract: asset,
          error: authError(xdr.ScErrorCode.scecInvalidInput()),
          message: "signature has expired",
          args: [address(from)],
        }),
      ).code,
    ).toBe("invalid_exact_stellar_signature_expired");
  });

  it("falls back to simulation_failed with the host error in the reason", () => {
    const result = classify(
      errorEvent({ error: xdr.ScError.sceBudget(xdr.ScErrorCode.scecExceededLimit()), message: "budget" }),
    );
    expect(result.code).toBe("invalid_exact_stellar_payload_simulation_failed");
    expect(result.reason).toContain("Error(Budget, ExceededLimit)");
  });

  it("falls back cleanly when there are no host errors at all", () => {
    const result = classify();
    expect(result.code).toBe("invalid_exact_stellar_payload_simulation_failed");
    expect(result.reason.trim()).not.toBe("");
  });
});
