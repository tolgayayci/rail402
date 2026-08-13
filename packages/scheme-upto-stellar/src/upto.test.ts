import { describe, it, expect } from "vitest";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { UptoStellarFacilitatorScheme } from "./facilitator.js";
import { UptoStellarServerScheme } from "./server.js";
import { ARG, SETTLE_FN, uptoContractFor } from "./constants.js";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

const NETWORK = "stellar:testnet";
const PASS = Networks.TESTNET;
const CONTRACT = uptoContractFor(NETWORK)!;
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const payer = Keypair.random();
const seller = Keypair.random();
const facilitator = Keypair.random();
const source = Keypair.random();

const signer = {
  address: facilitator.publicKey(),
  signAuthEntry: async () => ({ signedAuthEntry: "" }) as never,
  signTransaction: async () => ({ signedTxXdr: "" }) as never,
};

/**
 * A structurally-valid Soroban authorization entry for `from`. Unsigned (void signature): enough to
 * pass the pre-RPC structural check (`structuralAuthCheck`) so a test can reach the ledger-dependent
 * logic, but not the signature-presence check, which needs a real simulation.
 */
function dummyAuthEntry(from: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(from).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 100,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(CONTRACT).toScAddress(),
          functionName: SETTLE_FN,
          args: [],
        }),
      ),
      subInvocations: [],
    }),
  });
}

/** Build a `settle` invocation. Only structure matters here — no network access. */
function buildSettleTx(over: Partial<{
  contract: string;
  token: string;
  from: string;
  to: string;
  maxAmount: bigint;
  expirationLedger: number;
  actualAmount: bigint;
  txSource: string;
  argCount: number;
  fnName: string;
  withPayerAuth: boolean;
}> = {}) {
  const account = { accountId: () => over.txSource ?? source.publicKey(), sequenceNumber: () => "1", incrementSequenceNumber: () => {} };
  const c = new Contract(over.contract ?? CONTRACT);
  const args = [
    new Address(over.token ?? ASSET).toScVal(),
    new Address(over.from ?? payer.publicKey()).toScVal(),
    new Address(over.to ?? seller.publicKey()).toScVal(),
    nativeToScVal(over.maxAmount ?? 1_000_000n, { type: "i128" }),
    nativeToScVal(over.expirationLedger ?? 999_999_999, { type: "u32" }),
    nativeToScVal(Buffer.alloc(32, 7), { type: "bytes" }),
    nativeToScVal(over.actualAmount ?? 1_000_000n, { type: "i128" }),
    xdr.ScVal.scvVoid(), // hook: None
  ].slice(0, over.argCount ?? 8);

  const tx = new TransactionBuilder(account as never, { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(c.call(over.fnName ?? SETTLE_FN, ...args))
    .setTimeout(60)
    .build();
  if (!over.withPayerAuth) return tx;

  // Re-emit the operation with a (dummy) authorization entry for the payer so a test can get past
  // the structural auth check and exercise the ledger-dependent path.
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  return new TransactionBuilder(account as never, { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(Operation.invokeHostFunction({ func: op.func, auth: [dummyAuthEntry(over.from ?? payer.publicKey())] }))
    .setTimeout(60)
    .build();
}

const payload = (tx = buildSettleTx(), extra: Record<string, unknown> = {}): PaymentPayload =>
  ({
    x402Version: 2,
    accepted: { scheme: "upto", network: NETWORK },
    payload: { transaction: tx.toXDR(), maxAmount: "1000000", expirationLedger: 999_999_999, nonce: "07".repeat(32), ...extra },
  }) as unknown as PaymentPayload;

const requirements = (over: Partial<PaymentRequirements> = {}): PaymentRequirements =>
  ({
    scheme: "upto",
    network: NETWORK,
    amount: "1000000",
    asset: ASSET,
    payTo: seller.publicKey(),
    maxTimeoutSeconds: 60,
    ...over,
  }) as PaymentRequirements;

const scheme = new UptoStellarFacilitatorScheme([signer]);

/** Structural rejections happen before any RPC call, so these need no network. */
const verifyStructure = (p: PaymentPayload, r: PaymentRequirements) => scheme.verify(p, r);

describe("advertised capability", () => {
  it("advertises the canonical contract and fee sponsorship", () => {
    expect(scheme.getExtra(NETWORK)).toEqual({ uptoContract: CONTRACT, areFeesSponsored: true });
  });

  it("advertises nothing for a network with no deployed contract", () => {
    expect(scheme.getExtra("stellar:futurenet" as never)).toBeUndefined();
  });
});

describe("structural validation", () => {
  it("rejects a transaction invoking a contract other than the canonical one", async () => {
    // A hostile server naming its own contract would be naming its own settlement rules —
    // one that ignores the ceiling, or pays itself.
    // A real, valid contract address that simply is not ours (pubnet USDC SAC). Hand-editing a
    // Stellar address to fabricate one does not work — the checksum rejects it.
    const impostor = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
    const r = await verifyStructure(payload(buildSettleTx({ contract: impostor })), requirements());
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe("invalid_upto_stellar_payload_wrong_contract");
    expect(r.invalidMessage).toContain(CONTRACT);
  });

  it("rejects a wrong function name or argument count", async () => {
    expect((await verifyStructure(payload(buildSettleTx({ fnName: "transfer" })), requirements())).invalidReason)
      .toBe("invalid_upto_stellar_payload_malformed");
    expect((await verifyStructure(payload(buildSettleTx({ argCount: 5 })), requirements())).invalidReason)
      .toBe("invalid_upto_stellar_payload_malformed");
  });

  it("rejects a mismatched asset or recipient", async () => {
    const other = "CDQRFK7EOCYRTIZZ3D5GP663VTQ3QASQ2VDLOVH7L4C5PZETZNYV3OLH";
    expect((await verifyStructure(payload(buildSettleTx({ token: other })), requirements())).invalidReason)
      .toBe("invalid_exact_stellar_payload_wrong_asset");
    expect((await verifyStructure(payload(buildSettleTx()), requirements({ payTo: Keypair.random().publicKey() }))).invalidReason)
      .toBe("invalid_exact_stellar_payload_wrong_recipient");
  });

  it("refuses to be the payer or the transaction source", async () => {
    expect((await verifyStructure(payload(buildSettleTx({ from: facilitator.publicKey() })), requirements())).invalidReason)
      .toBe("invalid_exact_stellar_payload_facilitator_is_payer");
    expect((await verifyStructure(payload(buildSettleTx({ txSource: facilitator.publicKey() })), requirements())).invalidReason)
      .toBe("invalid_exact_stellar_payload_unsafe_tx_or_op_source");
  });

  it("treats the transaction as authoritative over the echoed convenience fields", async () => {
    // The echoed maxAmount exists so a facilitator can check cheaply before XDR decoding. It must
    // never be able to disagree with what was actually signed.
    const r = await verifyStructure(
      payload(buildSettleTx({ maxAmount: 1_000_000n }), { maxAmount: "999999999" }),
      requirements(),
    );
    expect(r.invalidReason).toBe("invalid_upto_stellar_payload_malformed");
    expect(r.invalidMessage).toMatch(/authoritative/i);
  });

  it("rejects the wrong scheme, version or network", async () => {
    const bad = { ...payload(), x402Version: 1 } as PaymentPayload;
    expect((await verifyStructure(bad, requirements())).invalidReason).toBe("invalid_x402_version");
    expect((await verifyStructure(payload(), requirements({ scheme: "exact" }))).invalidReason).toBe("unsupported_scheme");
  });

  it("rejects an authorization valid for far longer than the payment terms", async () => {
    // Validity was bounded on one side only: `upto` checked that an authorization had not already
    // expired and nothing else. An unbounded window is a standing claim on the payer's balance,
    // and past ~24h it outlives the contract's consumed-nonce record, at which point the
    // single-use guarantee stops holding. Validity is bounded by
    // `maxTimeoutSeconds`; this is that bound.
    const r = await verifyStructure(
      payload(buildSettleTx({ expirationLedger: 999_999_999, withPayerAuth: true })),
      requirements({ maxTimeoutSeconds: 60 }),
    );
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe("invalid_upto_stellar_payload_expiration_too_far");
    // The reason has to tell a client what window WOULD be accepted, or it cannot re-sign.
    expect(r.invalidMessage).toMatch(/at most \d+ are permitted/);
  });

  it("gives every rejection a non-null human reason", async () => {
    for (const r of [
      await verifyStructure(payload(buildSettleTx({ fnName: "nope" })), requirements()),
      await verifyStructure(payload(buildSettleTx({ from: facilitator.publicKey() })), requirements()),
    ]) {
      expect(r.invalidReason).toBeTruthy();
      expect(r.invalidMessage!.length).toBeGreaterThan(20);
    }
  });
});

describe("phase-dependent amount — the heart of upto", () => {
  it("requires the signed ceiling to equal requirements.amount at VERIFY", async () => {
    const r = await verifyStructure(
      payload(buildSettleTx({ maxAmount: 500_000n }), { maxAmount: "500000" }),
      requirements({ amount: "1000000" }),
    );
    expect(r.invalidReason).toBe("invalid_upto_stellar_payload_wrong_max_amount");
  });

  it("accepts a SETTLE amount below the ceiling — a partial settlement", async () => {
    // The conformance trap: a facilitator enforcing amount === maxAmount at settle rejects every
    // partial settlement and breaks the scheme entirely. This asserts we do not.
    const res = await scheme.settle(
      payload(buildSettleTx({ maxAmount: 1_000_000n })),
      requirements({ amount: "250000" }),
    );
    // No RPC in this environment, so it cannot succeed — but it must NOT be refused for exceeding
    // the ceiling, which is the failure mode under test.
    expect(res.errorReason).not.toBe("invalid_upto_stellar_payload_settlement_exceeds_amount");
  });

  it("refuses to settle above the signed ceiling", async () => {
    const res = await scheme.settle(
      payload(buildSettleTx({ maxAmount: 1_000_000n })),
      requirements({ amount: "1000001" }),
    );
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe("invalid_upto_stellar_payload_settlement_exceeds_amount");
    expect((res as { extra?: { reason?: string } }).extra?.reason).toContain("1000000");
  });

  /**
   * The reason must reach the field a STOCK consumer reads.
   *
   * `x402HTTPResourceServer` surfaces `settleResponse.errorMessage || settleResponse.errorReason`,
   * so a human reason parked anywhere else — `extra`, a log line — shows the buyer a bare code
   * string and nothing more. That is the "non-null reason" criterion degrading into the shape it
   * degrades into first: technically present, practically absent. A live canary caught it here and
   * on the `exact` path; this test is what stops it coming back.
   */
  it("puts the human reason in errorMessage, where stock clients look", async () => {
    const res = await scheme.settle(
      payload(buildSettleTx({ maxAmount: 1_000_000n })),
      requirements({ amount: "1000001" }),
    );
    const message = (res as { errorMessage?: string }).errorMessage ?? "";
    expect(message.trim().length).toBeGreaterThan(20);
    expect(message).not.toBe(res.errorReason);
    expect(message).toContain("1000000");
  });

  it("settles zero ON-LEDGER so the authorization is actually consumed", async () => {
    // This used to short-circuit to `success` with no transaction, on the reasoning that burning a
    // fee to record that nothing happened is waste. It saved a fee and bought a live authorization:
    // the client's payload stayed spendable up to the full ceiling while the resource server had
    // been told the cycle was complete. The contract's zero path returns
    // before any transfer, so this is cheap — and "single-use" now means used.
    const res = await scheme.settle(payload(), requirements({ amount: "0" }));

    // No RPC in this environment, so it cannot complete — the point is that it now takes the same
    // road as any other amount instead of returning a fabricated success. A zero settlement must
    // never report success without a transaction hash to show for it.
    expect(res.success && res.transaction === "").toBe(false);
    expect(res.errorReason).not.toBe("invalid_upto_stellar_payload_settlement_exceeds_amount");
  });

  it("refuses a negative settlement", async () => {
    const res = await scheme.settle(payload(), requirements({ amount: "-1" }));
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe("invalid_upto_stellar_payload_settlement_exceeds_amount");
  });
});

describe("actual_amount is outside the signed tuple", () => {
  it("sits at the documented argument position", () => {
    // The scheme only works because argument 6 is excluded from require_auth_for_args. If this
    // ordering ever drifts from the deployed contract, substitution silently corrupts payments.
    // Argument 7 (the hook) is likewise unsigned; both live past the signed tuple on purpose.
    const tx = buildSettleTx({ actualAmount: 4242n });
    const args = (tx.operations[0] as Operation.InvokeHostFunction).func.invokeContract().args();
    expect(args).toHaveLength(8);
    expect(scValToNative(args[ARG.ACTUAL_AMOUNT]!)).toBe(4242n);
    expect(scValToNative(args[ARG.MAX_AMOUNT]!)).toBe(1_000_000n);
    expect(scValToNative(args[ARG.TO]!)).toBe(seller.publicKey());
    // hook defaults to None (void) for a keypair payer.
    expect(args[ARG.HOOK]!.switch().name).toBe("scvVoid");
  });
});

describe("server scheme", () => {
  const server = new UptoStellarServerScheme();

  it("passes explicit asset amounts straight through", async () => {
    expect(await server.parsePrice({ amount: "250", asset: ASSET } as never, NETWORK)).toEqual({
      amount: "250",
      asset: ASSET,
    });
  });

  it("converts a dollar price at 7 decimals against default USDC", async () => {
    const parsed = await server.parsePrice("$0.10" as never, NETWORK);
    expect(parsed.amount).toBe("1000000");
    expect(server.getAssetDecimals()).toBe(7);
  });

  it("adds the settlement contract so the client can verify it before signing", async () => {
    const enhanced = await server.enhancePaymentRequirements(requirements(), {
      x402Version: 2,
      scheme: "upto",
      network: NETWORK,
    } as never);
    expect((enhanced.extra as { uptoContract?: string }).uptoContract).toBe(CONTRACT);
    expect((enhanced.extra as { areFeesSponsored?: boolean }).areFeesSponsored).toBe(true);
  });
});

describe("replay detection", () => {
  // Verbatim from a real testnet replay on 2026-07-31. Do not tidy: the exact shape is what the
  // classifier parses, and a hand-written approximation would let a real regression pass.
  const REAL_REPLAY_ERROR = `HostError: Error(Auth, ExistingValue)

Event log (newest first):
   0: [Diagnostic Event] contract:CB3TWFYYDS74WM2N4RKMKUBUREZ6SR5PV3PI3PGO2JEBPJ6A65PSL342, topics:[error, Error(Auth, ExistingValue)], data:"escalating error to VM trap from failed host function call: require_auth_for_args"
   1: [Diagnostic Event] contract:CB3TWFYYDS74WM2N4RKMKUBUREZ6SR5PV3PI3PGO2JEBPJ6A65PSL342, topics:[error, Error(Auth, ExistingValue)], data:["nonce already exists for address", GBIB5ZK6C77DN5F4UJ5PDT7BJNKGAJYPHBCO6OWGYEY6QSYPSFET6VJ3]
`;

  it("recognizes the auth-layer nonce rejection that a real replay actually produces", async () => {
    // Regression guard. An earlier version matched only the contract's own error #3 — but Soroban's
    // host-level auth nonce fires FIRST, so #3 is the case you almost never see, and every ordinary
    // replay was mis-reported as a generic simulation failure.
    const { isReplayForTest } = await import("./facilitator.js");
    expect(isReplayForTest(REAL_REPLAY_ERROR)).toBe(true);
  });

  it("also recognizes the contract's own defence-in-depth error", async () => {
    const { isReplayForTest } = await import("./facilitator.js");
    expect(isReplayForTest("HostError: Error(Contract, #3)")).toBe(true);
  });

  it("does not fire on unrelated failures", async () => {
    const { isReplayForTest } = await import("./facilitator.js");
    expect(isReplayForTest("HostError: Error(Contract, #10)")).toBe(false);
    expect(isReplayForTest("")).toBe(false);
  });
});

describe("authorization-entry validation", () => {
  // The critical defect this closes: `verify` established authorization from a successful simulation
  // alone, but a transaction with NO auth entries simulates in RECORDING mode and succeeds — so a
  // payload signed by nobody returned `isValid: true` in production. `buildSettleTx()` attaches no
  // auth, so these are exactly that payload; the structural check runs before any RPC.
  it("rejects a payload with no authorization entries at VERIFY, before any RPC", async () => {
    const r = await verifyStructure(payload(buildSettleTx({ maxAmount: 1_000_000n })), requirements());
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe("invalid_exact_stellar_payload_no_auth_entries");
    expect(r.invalidMessage!.length).toBeGreaterThan(0);
  });

  it("rejects a no-auth payload at SETTLE before submitting a fee-burning transaction", async () => {
    const res = await scheme.settle(payload(buildSettleTx({ maxAmount: 1_000_000n })), requirements({ amount: "250000" }));
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe("invalid_exact_stellar_payload_no_auth_entries");
  });

  it("passes the structural check once a payer authorization entry is present", async () => {
    // With a (dummy, unsigned) address-credential entry for the payer, the structural check no longer
    // rejects: the flow proceeds to the ledger-dependent checks, so the reason is no longer no-auth.
    const r = await verifyStructure(payload(buildSettleTx({ maxAmount: 1_000_000n, withPayerAuth: true })), requirements());
    expect(r.invalidReason).not.toBe("invalid_exact_stellar_payload_no_auth_entries");
  });
});

describe("amount parsing never throws a retryable 500", () => {
  it("rejects a non-integer echoed payload.maxAmount with a coded reason, not a thrown 500", async () => {
    for (const bad of ["NaN", "1e9", "10.5"]) {
      const r = await verifyStructure(payload(buildSettleTx({ maxAmount: 1_000_000n }), { maxAmount: bad }), requirements());
      expect(r.isValid).toBe(false);
      expect(r.invalidReason).toBe("invalid_upto_stellar_payload_malformed");
      expect(r.invalidMessage).toMatch(/not an integer/i);
    }
  });

  it("rejects a non-integer requirements.amount instead of throwing, at verify and settle", async () => {
    const v = await verifyStructure(payload(buildSettleTx()), requirements({ amount: "NaN" }));
    expect(v.invalidReason).toBe("invalid_payment_requirements");
    const s = await scheme.settle(payload(buildSettleTx()), requirements({ amount: "1e9" }));
    expect(s.success).toBe(false);
    expect(s.errorReason).toBe("invalid_payment_requirements");
  });
});
