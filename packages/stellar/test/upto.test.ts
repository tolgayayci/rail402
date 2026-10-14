import { describe, expect, it } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import {
  classifyUptoFailure,
  exactStellarCodes,
  inspectUptoPayload,
  isUptoStellarCode,
  recordedUptoSettlement,
  uptoStellarCodes,
} from "@rail402.dev/stellar";
import {
  authorityEntry,
  encodeAuthorizationEntry,
  settleInvokeArgs,
  unsignedPayerEntry,
  uptoStandardCodes,
  uptoStellarCodes as mechanismCodes,
  type UptoTerms,
} from "@rail402.dev/upto";
import { hostErrors, type SettlementParties } from "@rail402.dev/upto/facilitator";

const contract = StrKey.encodeContract(hash(Buffer.from("upto inspection tests")));
const token = StrKey.encodeContract(hash(Buffer.from("upto inspection token")));
const payer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const authority = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const recipient = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
const channel = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4));

const terms: UptoTerms = {
  expirationLedger: 5_000,
  facilitator: authority.publicKey(),
  maxAmount: 1_000_000n,
  recipient: recipient.publicKey(),
  token,
  validAfterLedger: 0,
};

function signedEntry(nonce = 42n): xdr.SorobanAuthorizationEntry {
  const built = unsignedPayerEntry({ contract, payer: payer.publicKey(), terms, nonce });
  built
    .credentials()
    .address()
    .signature(xdr.ScVal.scvVec([xdr.ScVal.scvMap([])]));
  return built;
}

const parties: SettlementParties = {
  contract,
  token,
  payer: payer.publicKey(),
  recipient: recipient.publicKey(),
  authority: authority.publicKey(),
  facilitatorAddresses: new Set([authority.publicKey()]),
};

function hostError(error: xdr.ScError, message: string): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: null,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(error)],
          data: xdr.ScVal.scvVec([xdr.ScVal.scvString(message)]),
        }),
      ),
    }),
  });
}

describe("upto codes", () => {
  it("register every upto-specific code of the mechanism unchanged, plus the engine's", () => {
    for (const [code, spec] of Object.entries(mechanismCodes)) {
      expect(uptoStellarCodes[code as keyof typeof uptoStellarCodes], code).toEqual(spec);
    }
    expect(Object.keys(uptoStellarCodes).filter((code) => !Object.hasOwn(mechanismCodes, code))).toEqual([
      "settle_upto_stellar_settled_elsewhere",
    ]);
    expect(isUptoStellarCode("settle_upto_stellar_settled_elsewhere")).toBe(true);
    expect(isUptoStellarCode("insufficient_funds")).toBe(false);
  });

  it("share the x402 standard codes with exact, with the same status, retryability and a scheme-neutral reason", () => {
    for (const [code, spec] of Object.entries(uptoStandardCodes)) {
      const registered = exactStellarCodes[code as keyof typeof exactStellarCodes];
      expect(registered, code).toBeDefined();
      expect({ status: registered.status, retryable: registered.retryable }, code).toEqual({
        status: spec.status,
        retryable: spec.retryable,
      });
      expect(registered.reason, code).not.toMatch(/\bexact\b/);
    }
  });
});

describe("inspectUptoPayload", () => {
  it("decodes the payer, nonce and terms of a payload", () => {
    const inspected = inspectUptoPayload(
      { authorization: encodeAuthorizationEntry(signedEntry(7n)) },
      contract,
    );
    expect(inspected).toMatchObject({
      ok: true,
      authorization: { payer: payer.publicKey(), nonce: 7n, terms, treeValid: true, credential: "address" },
    });
  });

  it("refuses what the codec refuses, with its code", () => {
    expect(inspectUptoPayload(undefined, contract)).toMatchObject({
      ok: false,
      code: "invalid_upto_stellar_payload_malformed",
    });
    expect(inspectUptoPayload({ authorization: "not base64 xdr" }, contract)).toMatchObject({
      ok: false,
      code: "invalid_upto_stellar_payload_malformed",
    });
    const other = StrKey.encodeContract(hash(Buffer.from("another contract")));
    expect(
      inspectUptoPayload({ authorization: encodeAuthorizationEntry(signedEntry()) }, other),
    ).toMatchObject({
      ok: false,
      code: "invalid_upto_stellar_payload_wrong_contract",
      payer: payer.publicKey(),
    });
  });
});

describe("recordedUptoSettlement", () => {
  function envelope(operation: xdr.Operation, feeBump = true): string {
    const inner = new TransactionBuilder(new Account(channel.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(operation)
      .setTimeout(60)
      .build();
    inner.sign(channel);
    if (!feeBump) return inner.toXDR();
    const bump = TransactionBuilder.buildFeeBumpTransaction(authority, "200", inner, Networks.TESTNET);
    return bump.toXDR();
  }

  const settle = (amount: bigint) =>
    Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        settleInvokeArgs(contract, payer.publicKey(), terms, amount),
      ),
      auth: [signedEntry(9n), authorityEntry(contract, payer.publicKey(), terms, amount)],
      source: authority.publicKey(),
    });

  it("decodes settle(payer, terms, amount) and the payer's entry from a fee bump or a plain envelope", () => {
    for (const feeBump of [true, false]) {
      const recorded = recordedUptoSettlement(envelope(settle(250_000n), feeBump), Networks.TESTNET);
      expect(recorded).toMatchObject({ contract, payer: payer.publicKey(), terms, amount: 250_000n });
      expect(recorded?.payerEntry?.toXDR("base64")).toBe(signedEntry(9n).toXDR("base64"));
    }
  });

  it("returns undefined for anything else", () => {
    const payment = Operation.payment({
      destination: recipient.publicKey(),
      asset: Asset.native(),
      amount: "1",
    });
    expect(recordedUptoSettlement(envelope(payment), Networks.TESTNET)).toBeUndefined();
    const transfer = Operation.invokeContractFunction({ contract: token, function: "transfer", args: [] });
    expect(recordedUptoSettlement(envelope(transfer), Networks.TESTNET)).toBeUndefined();
  });
});

describe("classifyUptoFailure", () => {
  const authFailed = hostError(
    xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction()),
    "failed account authentication",
  );
  const missingAccount = hostError(
    xdr.ScError.sceStorage(xdr.ScErrorCode.scecMissingValue()),
    "trying to get non-existing value for account",
  );

  it("names a G… payer whose account does not exist", () => {
    expect(classifyUptoFailure(hostErrors([missingAccount, authFailed]), parties)).toMatchObject({
      code: "invalid_upto_stellar_payload_account_missing",
    });
  });

  it("leaves everything else to the mechanism's classifier", () => {
    expect(classifyUptoFailure(hostErrors([authFailed]), parties).code).toBe(
      "invalid_upto_stellar_payload_invalid_signature",
    );
    const existing = hostError(xdr.ScError.sceAuth(xdr.ScErrorCode.scecExistingValue()), "nonce");
    expect(classifyUptoFailure(hostErrors([existing]), parties).code).toBe(
      "invalid_upto_stellar_payload_nonce_already_used",
    );
    const smart = { ...parties, payer: contract };
    expect(classifyUptoFailure(hostErrors([missingAccount, authFailed]), smart).code).toBe(
      "invalid_upto_stellar_payload_smart_account_rejected",
    );
  });
});
