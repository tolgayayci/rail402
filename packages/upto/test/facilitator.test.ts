import { describe, expect, it } from "vitest";
import {
  Address,
  FeeBumpTransaction,
  Keypair,
  SorobanDataBuilder,
  Transaction,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { FacilitatorStellarSigner } from "@x402/stellar";
import { UptoStellarScheme, type UptoStellarFacilitatorOptions } from "@rail402.dev/upto/facilitator";
import {
  CAP,
  CONTRACT,
  FakeRpc,
  LEDGER,
  NETWORK,
  TOKEN,
  address,
  authority,
  authoritySigner,
  channel,
  channelSigner,
  contractEvent,
  errorEvent,
  errorSimulation,
  i128,
  payer,
  payment,
  recipient,
  requirements,
  settledEvent,
  settlementEvents,
  signedAuthorization,
  sponsor,
  sponsorSigner,
  successSimulation,
  terms,
} from "./helpers.ts";

function facilitator(fake: FakeRpc, options: UptoStellarFacilitatorOptions = {}) {
  return new UptoStellarScheme([channelSigner], {
    settlementAuthority: authoritySigner,
    feeBumpSigner: sponsorSigner,
    contract: CONTRACT,
    ledgerSeconds: 5,
    rpc: () => fake,
    confirmation: { attempts: 3, intervalMs: 1 },
    ...options,
  });
}

/** Answers every simulation with the events a correct settlement of the simulated amount emits. */
function honest(fake: FakeRpc, shape: "sac" | "sep41" = "sac") {
  fake.defaultSimulation = (transaction) =>
    successSimulation(settlementEvents(simulatedAmount(transaction), { shape }));
  return fake;
}

function simulatedAmount(transaction: Transaction): bigint {
  const operation = transaction.operations[0];
  if (operation?.type !== "invokeHostFunction") throw new Error("not a settlement");
  const amount = operation.func.invokeContract().args()[2];
  if (amount === undefined) throw new Error("no amount");
  const parts = amount.i128();
  return (parts.hi().toBigInt() << 64n) | parts.lo().toBigInt();
}

async function settleRequest(amount: bigint | string, authorization?: string) {
  const payload = await payment(authorization === undefined ? {} : { authorization });
  return { payload, settleRequirements: requirements({ amount: amount.toString() }) };
}

describe("upto facilitator: supported kind", () => {
  it("advertises sponsored fees and the settlement authority", () => {
    const scheme = facilitator(new FakeRpc());
    expect(scheme.scheme).toBe("upto");
    expect(scheme.caipFamily).toBe("stellar:*");
    expect(scheme.getExtra(NETWORK)).toEqual({
      areFeesSponsored: true,
      facilitatorAddress: authority.publicKey(),
    });
    expect(scheme.getSigners(NETWORK).sort()).toEqual(
      [channel.publicKey(), authority.publicKey(), sponsor.publicKey()].sort(),
    );
  });

  it("requires a signer and a G… authority", () => {
    expect(() => new UptoStellarScheme([])).toThrow();
    const contractAuthority: FacilitatorStellarSigner = { ...authoritySigner, address: CONTRACT };
    expect(() => new UptoStellarScheme([channelSigner], { settlementAuthority: contractAuthority })).toThrow(
      /G… account/,
    );
    expect(new UptoStellarScheme([channelSigner]).authority.address).toBe(channel.publicKey());
  });

  it("requires an expiration margin of at least one ledger", () => {
    expect(() => facilitator(new FakeRpc(), { expirationMarginLedgers: 0 })).toThrow(/at least 1/);
    expect(() => facilitator(new FakeRpc(), { expirationMarginLedgers: 1 })).not.toThrow();
  });
});

describe("upto facilitator: verify", () => {
  it("accepts a valid payment after simulating its cap (Stellar Asset Contract events)", async () => {
    const fake = honest(new FakeRpc());
    const result = await facilitator(fake).verify(await payment(), requirements());
    expect(result).toEqual({ isValid: true, payer: payer.publicKey() });
    expect(fake.simulated).toHaveLength(1);
    expect(simulatedAmount(fake.simulated[0] as Transaction)).toBe(CAP);
    expect(fake.sent).toHaveLength(0);
  });

  it("accepts SEP-41 token events (three topics, map data)", async () => {
    const fake = honest(new FakeRpc(), "sep41");
    expect((await facilitator(fake).verify(await payment(), requirements())).isValid).toBe(true);
  });

  it("refuses networks it does not serve", async () => {
    const fake = new FakeRpc();
    // Pubnet has no canonical deployment yet, so without a configured contract it is not served.
    const noContract = new UptoStellarScheme([channelSigner], { rpc: () => fake, ledgerSeconds: 5 });
    const pubnet = requirements({ network: "stellar:pubnet" });
    expect(await noContract.verify(await payment({ requirements: pubnet }), pubnet)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_network",
    });
    const evm = requirements({ network: "eip155:8453" });
    expect(await facilitator(fake).verify(await payment({ requirements: evm }), evm)).toMatchObject({
      invalidReason: "invalid_network",
    });
    expect(
      await facilitator(fake).verify({ ...(await payment()), x402Version: 1 }, requirements()),
    ).toMatchObject({
      invalidReason: "invalid_x402_version",
    });
  });

  it("returns static refusals with the payer and a reason, before any simulation", async () => {
    const fake = new FakeRpc();
    const authorization = await signedAuthorization({ terms: terms({ recipient: authority.publicKey() }) });
    const result = await facilitator(fake).verify(await payment({ authorization }), requirements());
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_wrong_recipient",
      payer: payer.publicKey(),
    });
    expect(result.invalidMessage).toContain(authority.publicKey());
    expect(fake.simulated).toHaveLength(0);
  });

  it("refuses an accepted block or accepted extra that is not an object, naming the mismatch", async () => {
    const fake = new FakeRpc();
    const scheme = facilitator(fake);
    for (const extra of [null, [], "extra", 7]) {
      const payload = await payment();
      const odd = { ...payload, accepted: { ...payload.accepted, extra } } as unknown as typeof payload;
      const result = await scheme.verify(odd, requirements());
      expect(result, JSON.stringify(extra)).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_payload_accepted_mismatch",
      });
    }
    const payload = await payment();
    const noAccepted = { ...payload, accepted: null } as unknown as typeof payload;
    expect(await scheme.verify(noAccepted, requirements())).toMatchObject({
      isValid: false,
      invalidReason: "invalid_upto_stellar_payload_accepted_mismatch",
    });
    expect(fake.simulated).toHaveLength(0);
  });

  it("accepts the expiration of a client that estimated 5 s ledgers when it estimates 6 s itself", async () => {
    const fake = honest(new FakeRpc());
    // Both round a network closing at about 5 s up to whole seconds; they may land on different sides.
    const slower = facilitator(fake, { ledgerSeconds: 6 });
    for (const maxTimeoutSeconds of [120, 300]) {
      const accepted = requirements({ maxTimeoutSeconds });
      const clientLedgers = Math.ceil(maxTimeoutSeconds / 5);
      const signed = async (expirationLedger: number) =>
        payment({
          requirements: accepted,
          authorization: await signedAuthorization({ terms: terms({ expirationLedger }) }),
        });
      expect(await slower.verify(await signed(LEDGER + clientLedgers), accepted)).toMatchObject({
        isValid: true,
      });
      expect(await slower.verify(await signed(LEDGER + clientLedgers + 3), accepted)).toMatchObject({
        isValid: false,
        invalidReason: "invalid_upto_stellar_signature_expiration_too_far",
      });
    }
  });

  it("applies the asset allow-list and the timeout policy", async () => {
    const fake = honest(new FakeRpc());
    const allowList = facilitator(fake, { isAssetAccepted: () => false });
    expect((await allowList.verify(await payment(), requirements())).invalidReason).toBe(
      "invalid_upto_stellar_requirements_asset_not_accepted",
    );
    const strict = facilitator(fake, { maxTimeoutSeconds: 30 });
    expect((await strict.verify(await payment(), requirements())).invalidReason).toBe(
      "invalid_upto_stellar_requirements_timeout_out_of_range",
    );
  });

  it("refuses a payee that is a facilitator address, including configured channel accounts", async () => {
    const extra = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 40)).publicKey();
    const fake = honest(new FakeRpc());
    const scheme = facilitator(fake, { facilitatorAddresses: [extra] });
    const req = requirements({ payTo: extra });
    const result = await scheme.verify(
      await payment({
        requirements: req,
        authorization: await signedAuthorization({ terms: terms({ recipient: extra }) }),
      }),
      req,
    );
    expect(result.invalidReason).toBe("invalid_upto_stellar_requirements_invalid_pay_to");
  });

  it("enforces the fee ceiling", async () => {
    const fake = new FakeRpc();
    fake.simulations.push(successSimulation(settlementEvents(CAP), { minResourceFee: 499_900 }));
    expect((await facilitator(fake).verify(await payment(), requirements())).isValid).toBe(true);
    fake.simulations.push(successSimulation(settlementEvents(CAP), { minResourceFee: 499_901 }));
    const result = await facilitator(fake).verify(await payment(), requirements());
    expect(result.invalidReason).toBe("invalid_upto_stellar_payload_fee_exceeds_maximum");
    expect(result.invalidMessage).toContain("500001");
  });

  describe("simulation failures", () => {
    const other = Address.contract(Buffer.alloc(32, 41)).toString();
    const auth = (code: xdr.ScErrorCode) => xdr.ScError.sceAuth(code);
    it.each<[string, xdr.DiagnosticEvent[], string]>([
      [
        "replay",
        [errorEvent(undefined, auth(xdr.ScErrorCode.scecExistingValue()))],
        "invalid_upto_stellar_payload_nonce_already_used",
      ],
      [
        "contract error #3",
        [errorEvent(CONTRACT, xdr.ScError.sceContract(3))],
        "invalid_upto_stellar_payload_settlement_exceeds_amount",
      ],
      [
        "contract error #1",
        [errorEvent(CONTRACT, xdr.ScError.sceContract(1))],
        "invalid_upto_stellar_payload_invalid_terms",
      ],
      [
        "contract error #2",
        [errorEvent(CONTRACT, xdr.ScError.sceContract(2))],
        "invalid_upto_stellar_requirements_invalid_amount",
      ],
      [
        "contract error #4",
        [errorEvent(CONTRACT, xdr.ScError.sceContract(4))],
        "invalid_upto_stellar_payload_not_yet_valid",
      ],
      [
        "contract error #5",
        [errorEvent(CONTRACT, xdr.ScError.sceContract(5))],
        "invalid_upto_stellar_signature_expired",
      ],
      [
        "contract error #6",
        [errorEvent(CONTRACT, xdr.ScError.sceContract(6))],
        "invalid_upto_stellar_requirements_invalid_pay_to",
      ],
      ["SAC balance error", [errorEvent(TOKEN, xdr.ScError.sceContract(10))], "insufficient_funds"],
      [
        "SEP-41 insufficient balance",
        [errorEvent(TOKEN, xdr.ScError.sceContract(100))],
        "insufficient_funds",
      ],
      [
        "trustline not authorized",
        [errorEvent(TOKEN, xdr.ScError.sceContract(11))],
        "invalid_upto_stellar_payload_trustline_not_authorized",
      ],
      [
        "missing account",
        [errorEvent(TOKEN, xdr.ScError.sceContract(6))],
        "invalid_upto_stellar_payload_account_missing",
      ],
      [
        "bad ed25519 signature",
        [errorEvent(undefined, xdr.ScError.sceCrypto(xdr.ScErrorCode.scecInvalidInput()))],
        "invalid_upto_stellar_payload_invalid_signature",
      ],
      [
        "account authentication",
        [
          errorEvent(
            undefined,
            auth(xdr.ScErrorCode.scecInvalidAction()),
            "failed account authentication with error",
          ),
        ],
        "invalid_upto_stellar_payload_invalid_signature",
      ],
      [
        "expired signature",
        [errorEvent(undefined, auth(xdr.ScErrorCode.scecInvalidInput()), "signature has expired")],
        "invalid_upto_stellar_signature_expired",
      ],
      [
        "unauthorized invocation",
        [errorEvent(undefined, auth(xdr.ScErrorCode.scecInvalidAction()), "Unauthorized function call")],
        "invalid_upto_stellar_payload_invalid_signature",
      ],
      [
        "unknown token error",
        [errorEvent(TOKEN, xdr.ScError.sceContract(55))],
        "invalid_upto_stellar_payload_simulation_failed",
      ],
      [
        "unknown contract error",
        [errorEvent(other, xdr.ScError.sceContract(77))],
        "invalid_upto_stellar_payload_simulation_failed",
      ],
      [
        "budget",
        [errorEvent(undefined, xdr.ScError.sceBudget(xdr.ScErrorCode.scecExceededLimit()))],
        "invalid_upto_stellar_payload_simulation_failed",
      ],
    ])("maps %s", async (_name, events, code) => {
      const fake = new FakeRpc();
      fake.simulations.push(errorSimulation(events));
      const result = await facilitator(fake).verify(await payment(), requirements());
      expect(result.invalidReason).toBe(code);
      expect(result.invalidMessage?.trim()).not.toBe("");
    });

    it("attributes a trustline error to the payer or the recipient", async () => {
      const failure = (subject: string) =>
        new xdr.DiagnosticEvent({
          inSuccessfulContractCall: false,
          event: new xdr.ContractEvent({
            ext: new xdr.ExtensionPoint(0),
            contractId: Address.fromString(TOKEN).toBuffer() as unknown as xdr.ContractId,
            type: xdr.ContractEventType.diagnostic(),
            body: new xdr.ContractEventBody(
              0,
              new xdr.ContractEventV0({
                topics: [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(xdr.ScError.sceContract(13))],
                data: xdr.ScVal.scvVec([
                  xdr.ScVal.scvString("trustline entry is missing for account"),
                  address(subject),
                ]),
              }),
            ),
          }),
        });
      const fake = new FakeRpc();
      fake.simulations.push(
        errorSimulation([failure(recipient.publicKey())]),
        errorSimulation([failure(payer.publicKey())]),
      );
      const scheme = facilitator(fake);
      expect((await scheme.verify(await payment(), requirements())).invalidReason).toBe(
        "invalid_upto_stellar_payload_recipient_trustline_missing",
      );
      expect((await scheme.verify(await payment(), requirements())).invalidReason).toBe(
        "invalid_upto_stellar_payload_payer_trustline_missing",
      );
    });

    it("reads host errors from the error string when no events are returned", async () => {
      const fake = new FakeRpc();
      fake.simulations.push(
        errorSimulation([], "HostError: Error(Auth, ExistingValue)\n\nEvent log (newest first): …"),
      );
      fake.simulations.push(errorSimulation([], "HostError: Error(WasmVm, InvalidAction)"));
      fake.simulations.push(errorSimulation([], ""));
      const scheme = facilitator(fake);
      expect((await scheme.verify(await payment(), requirements())).invalidReason).toBe(
        "invalid_upto_stellar_payload_nonce_already_used",
      );
      const wasm = await scheme.verify(await payment(), requirements());
      expect(wasm.invalidReason).toBe("invalid_upto_stellar_payload_simulation_failed");
      expect(wasm.invalidMessage).toContain("Error(WasmVm, InvalidAction)");
      expect((await scheme.verify(await payment(), requirements())).invalidMessage?.trim()).not.toBe("");
    });

    it("attributes refusals inside a smart account's __check_auth to the account", async () => {
      const smart = Address.contract(Buffer.alloc(32, 5)).toString();
      const policy = Address.contract(Buffer.alloc(32, 6)).toString();
      const { classifySimulationFailure, hostErrors } = await import("@rail402.dev/upto/facilitator");
      const parties = {
        contract: CONTRACT,
        token: TOKEN,
        payer: smart,
        recipient: recipient.publicKey(),
        authority: authority.publicKey(),
        facilitatorAddresses: new Set<string>(),
      };
      for (const events of [
        [errorEvent(policy, xdr.ScError.sceContract(8))],
        [errorEvent(smart, xdr.ScError.sceContract(3002))],
        [errorEvent(policy, xdr.ScError.sceCrypto(xdr.ScErrorCode.scecInvalidInput()))],
      ]) {
        expect(classifySimulationFailure(hostErrors(events), parties, "").code).toBe(
          "invalid_upto_stellar_payload_smart_account_rejected",
        );
      }
      const authFailure = [
        errorEvent(
          undefined,
          xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction()),
          "failed account authentication",
        ),
      ];
      expect(classifySimulationFailure(hostErrors(authFailure), parties, "").code).toBe(
        "invalid_upto_stellar_payload_smart_account_rejected",
      );
      const crypto = [errorEvent(undefined, xdr.ScError.sceCrypto(xdr.ScErrorCode.scecInvalidInput()))];
      expect(classifySimulationFailure(hostErrors(crypto), parties, "").code).toBe(
        "invalid_upto_stellar_payload_smart_account_rejected",
      );
    });
  });

  describe("simulated events", () => {
    const run = async (events: xdr.DiagnosticEvent[]) => {
      const fake = new FakeRpc();
      fake.simulations.push(successSimulation(events));
      return (await facilitator(fake).verify(await payment(), requirements())).invalidReason;
    };
    const transfer = (from: string, to: string, amount: bigint, token = TOKEN) =>
      contractEvent(token, [xdr.ScVal.scvSymbol("transfer"), address(from), address(to)], i128(amount));

    it("requires exactly one transfer of the cap from the payer to payTo", async () => {
      const unexpected = "invalid_upto_stellar_payload_unexpected_balance_change";
      expect(await run([settledEvent(CAP)])).toBe(unexpected);
      expect(
        await run([transfer(payer.publicKey(), recipient.publicKey(), CAP - 1n), settledEvent(CAP)]),
      ).toBe(unexpected);
      expect(await run([transfer(recipient.publicKey(), payer.publicKey(), CAP), settledEvent(CAP)])).toBe(
        unexpected,
      );
      expect(
        await run([transfer(payer.publicKey(), recipient.publicKey(), CAP, CONTRACT), settledEvent(CAP)]),
      ).toBe(unexpected);
      expect(
        await run([
          transfer(payer.publicKey(), recipient.publicKey(), CAP),
          transfer(payer.publicKey(), recipient.publicKey(), 1n),
          settledEvent(CAP),
        ]),
      ).toBe(unexpected);
      expect(
        await run([
          contractEvent(TOKEN, [xdr.ScVal.scvSymbol("mint"), address(recipient.publicKey())], i128(CAP)),
          settledEvent(CAP),
        ]),
      ).toBe(unexpected);
      expect(await run([transfer(payer.publicKey(), authority.publicKey(), CAP), settledEvent(CAP)])).toBe(
        unexpected,
      );
    });

    it("ignores events of calls that were rolled back", async () => {
      expect(
        await run([
          contractEvent(
            TOKEN,
            [xdr.ScVal.scvSymbol("mint"), address(recipient.publicKey())],
            i128(5n),
            false,
          ),
          ...settlementEvents(CAP),
        ]),
      ).toBeUndefined();
    });

    it("requires exactly one matching upto_settled event", async () => {
      const mismatch = "invalid_upto_stellar_payload_settlement_event_mismatch";
      const moved = transfer(payer.publicKey(), recipient.publicKey(), CAP);
      expect(await run([moved])).toBe(mismatch);
      expect(await run([moved, settledEvent(CAP), settledEvent(CAP)])).toBe(mismatch);
      expect(await run([moved, settledEvent(CAP - 1n)])).toBe(mismatch);
      expect(await run([moved, settledEvent(CAP, { cap: CAP + 1n })])).toBe(mismatch);
      expect(await run([moved, settledEvent(CAP, { facilitator: payer.publicKey() })])).toBe(mismatch);
      expect(await run([moved, settledEvent(CAP, { token: CONTRACT })])).toBe(mismatch);
      expect(
        await run([
          moved,
          contractEvent(CONTRACT, [xdr.ScVal.scvSymbol("upto_settled")], xdr.ScVal.scvVoid()),
        ]),
      ).toBe(mismatch);
    });
  });

  describe("archived state", () => {
    const instanceKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(CONTRACT).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const codeKey = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: Buffer.alloc(32, 0xab) }),
    );
    const otherKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(TOKEN).toScAddress(),
        key: xdr.ScVal.scvSymbol("balance"),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const data = (keys: xdr.LedgerKey[], archived: number[]) =>
      new xdr.SorobanTransactionData({
        ext: new xdr.SorobanTransactionDataExt(
          1,
          new xdr.SorobanResourcesExtV0({ archivedSorobanEntries: archived }),
        ),
        resources: new xdr.SorobanResources({
          footprint: new xdr.LedgerFootprint({ readOnly: [], readWrite: keys }),
          instructions: 1,
          diskReadBytes: 1,
          writeBytes: 1,
        }),
        resourceFee: xdr.Int64.fromString("150000"),
      });

    it("refuses when the settlement contract must be restored, and names other archived state", async () => {
      const fake = new FakeRpc();
      fake.simulations.push(
        successSimulation(settlementEvents(CAP), { data: data([otherKey, instanceKey], [1]) }),
        successSimulation(settlementEvents(CAP), { data: data([codeKey], [0]) }),
        successSimulation(settlementEvents(CAP), { data: data([otherKey], [0]) }),
        successSimulation(settlementEvents(CAP), { data: data([otherKey], []) }),
      );
      const scheme = facilitator(fake, { contractWasmHash: "ab".repeat(32) });
      expect((await scheme.verify(await payment(), requirements())).invalidReason).toBe(
        "invalid_upto_stellar_settlement_contract_archived",
      );
      expect((await scheme.verify(await payment(), requirements())).invalidReason).toBe(
        "invalid_upto_stellar_settlement_contract_archived",
      );
      expect((await scheme.verify(await payment(), requirements())).invalidReason).toBe(
        "invalid_upto_stellar_payload_archived_state",
      );
      expect((await scheme.verify(await payment(), requirements())).isValid).toBe(true);
    });

    it("refuses a simulation that asks for a restore preamble", async () => {
      const fake = new FakeRpc();
      const simulation = successSimulation(
        settlementEvents(CAP),
      ) as rpc.Api.SimulateTransactionRestoreResponse;
      simulation.restorePreamble = {
        minResourceFee: "1",
        transactionData: new SorobanDataBuilder(data([instanceKey], [0])),
      };
      fake.simulations.push(simulation);
      expect((await facilitator(fake).verify(await payment(), requirements())).invalidReason).toBe(
        "invalid_upto_stellar_settlement_contract_archived",
      );
    });
  });

  it("reports unexpected errors with a reason", async () => {
    const fake = new FakeRpc();
    fake.getLatestLedger = () => Promise.reject(new Error("rpc down"));
    const result = await facilitator(fake).verify(await payment(), requirements());
    expect(result).toMatchObject({
      isValid: false,
      invalidReason: "unexpected_verify_error",
      invalidMessage: "rpc down",
    });
  });
});

describe("upto facilitator: settle", () => {
  it("submits settle(payer, terms, amount) with the authority as operation source", async () => {
    const fake = honest(new FakeRpc());
    const { payload, settleRequirements } = await settleRequest(300_000n);
    const result = await facilitator(fake).settle(payload, settleRequirements);
    expect(result).toMatchObject({
      success: true,
      network: NETWORK,
      payer: payer.publicKey(),
      amount: "300000",
    });
    expect(fake.sent).toHaveLength(1);

    const bump = fake.sent[0] as FeeBumpTransaction;
    expect(bump).toBeInstanceOf(FeeBumpTransaction);
    expect(result.transaction).toBe(bump.hash().toString("hex"));
    expect(bump.feeSource).toBe(sponsor.publicKey());
    expect(bump.signatures).toHaveLength(1);
    const inner = bump.innerTransaction;
    expect(inner.source).toBe(channel.publicKey());
    expect(inner.signatures).toHaveLength(2);
    expect(inner.ledgerBounds).toEqual({ minLedger: 0, maxLedger: LEDGER + 13 });
    expect(Number(inner.fee)).toBe(150_100);

    const operation = inner.operations[0];
    if (operation?.type !== "invokeHostFunction") throw new Error("not a settlement");
    expect(operation.source).toBe(authority.publicKey());
    expect(simulatedAmount(inner)).toBe(300_000n);
    const [payerEntry, authorityEntry, extra] = operation.auth ?? [];
    expect(extra).toBeUndefined();
    expect(payerEntry?.toXDR("base64")).toBe(payload.payload["authorization"]);
    expect(authorityEntry?.credentials().switch()).toBe(
      xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount(),
    );
    expect(authorityEntry?.rootInvocation().function().contractFn().args()[2]?.toXDR("base64")).toBe(
      i128(300_000n).toXDR("base64"),
    );
  });

  it("signs once when the transaction source is the authority, and pays its own fee without a fee bump", async () => {
    const fake = honest(new FakeRpc());
    const scheme = new UptoStellarScheme([authoritySigner], {
      contract: CONTRACT,
      ledgerSeconds: 5,
      rpc: () => fake,
      confirmation: { attempts: 1, intervalMs: 1 },
    });
    const { payload, settleRequirements } = await settleRequest(CAP);
    expect((await scheme.settle(payload, settleRequirements)).success).toBe(true);
    const sent = fake.sent[0] as Transaction;
    expect(sent).toBeInstanceOf(Transaction);
    expect(sent.signatures).toHaveLength(1);
  });

  it("settles zero on-chain by default, moving no funds", async () => {
    const fake = honest(new FakeRpc());
    const { payload, settleRequirements } = await settleRequest(0n);
    const result = await facilitator(fake).settle(payload, settleRequirements);
    expect(result).toMatchObject({ success: true, amount: "0" });
    expect(result.transaction).not.toBe("");
    expect(simulatedAmount((fake.sent[0] as FeeBumpTransaction).innerTransaction)).toBe(0n);
  });

  it("records an off-chain zero without submitting, after checking the signature by simulation", async () => {
    const fake = honest(new FakeRpc());
    const scheme = facilitator(fake, { zeroSettlement: "offchain" });
    const { payload, settleRequirements } = await settleRequest(0n);
    const result = await scheme.settle(payload, settleRequirements);
    expect(result).toEqual({
      success: true,
      transaction: "",
      network: NETWORK,
      payer: payer.publicKey(),
      amount: "0",
    });
    expect(fake.sent).toHaveLength(0);
    expect(fake.simulated).toHaveLength(1);
    expect(await scheme.settle(payload, settleRequirements)).toEqual(result);
    expect((await scheme.settle(payload, requirements({ amount: "1" }))).errorReason).toBe(
      "settle_upto_stellar_idempotency_conflict",
    );

    fake.simulations.push(
      errorSimulation([errorEvent(undefined, xdr.ScError.sceAuth(xdr.ScErrorCode.scecExistingValue()))]),
    );
    const replay = await settleRequest(0n);
    expect((await scheme.settle(replay.payload, replay.settleRequirements)).errorReason).toBe(
      "invalid_upto_stellar_payload_nonce_already_used",
    );
  });

  it("refuses an amount above the cap before simulating", async () => {
    const fake = new FakeRpc();
    const { payload, settleRequirements } = await settleRequest(CAP + 1n);
    const result = await facilitator(fake).settle(payload, settleRequirements);
    expect(result).toMatchObject({
      success: false,
      errorReason: "invalid_upto_stellar_payload_settlement_exceeds_amount",
      transaction: "",
      amount: (CAP + 1n).toString(),
    });
    expect(fake.simulated).toHaveLength(0);
  });

  it("submits one transaction for 20 concurrent identical settlements", async () => {
    const fake = honest(new FakeRpc());
    const scheme = facilitator(fake);
    const { payload, settleRequirements } = await settleRequest(300_000n);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => scheme.settle(payload, settleRequirements)),
    );
    expect(fake.sent).toHaveLength(1);
    expect(new Set(results.map((result) => result.transaction)).size).toBe(1);
    expect(results.every((result) => result.success)).toBe(true);
  });

  it("refuses the same authorization for a different amount, naming the original transaction", async () => {
    const fake = honest(new FakeRpc());
    const scheme = facilitator(fake);
    const { payload, settleRequirements } = await settleRequest(300_000n);
    const [first, ...others] = await Promise.all([
      scheme.settle(payload, settleRequirements),
      ...[1n, 2n, 3n].map((amount) => scheme.settle(payload, requirements({ amount: amount.toString() }))),
    ]);
    expect(first.success).toBe(true);
    for (const other of others) {
      expect(other).toMatchObject({
        success: false,
        errorReason: "settle_upto_stellar_idempotency_conflict",
        transaction: first.transaction,
      });
      expect(other.errorMessage).toContain("300000");
    }
    expect(fake.sent).toHaveLength(1);
  });

  it("returns settlement_pending with the hash, and confirms it on a repeat", async () => {
    const fake = honest(new FakeRpc());
    fake.statuses = ["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"] as rpc.Api.GetTransactionStatus[];
    const scheme = facilitator(fake);
    const { payload, settleRequirements } = await settleRequest(300_000n);
    const pending = await scheme.settle(payload, settleRequirements);
    expect(pending).toMatchObject({ success: false, errorReason: "settlement_pending", amount: "300000" });
    expect(pending.transaction).toMatch(/^[0-9a-f]{64}$/);
    const confirmed = await scheme.settle(payload, settleRequirements);
    expect(confirmed).toMatchObject({ success: true, transaction: pending.transaction });
    expect(fake.sent).toHaveLength(1);
  });

  it("reports on-chain failures and expiry with the transaction hash", async () => {
    const fake = honest(new FakeRpc());
    fake.statuses = [rpc.Api.GetTransactionStatus.FAILED, rpc.Api.GetTransactionStatus.FAILED];
    const failedWith = (result: xdr.TransactionResultResult) =>
      new xdr.TransactionResult({
        feeCharged: xdr.Int64.fromString("100"),
        result,
        ext: new xdr.TransactionResultExt(0),
      });
    const scheme = facilitator(fake);
    fake.failedResult = failedWith(xdr.TransactionResultResult.txFailed([]));
    const first = await settleRequest(300_000n);
    const failed = await scheme.settle(first.payload, first.settleRequirements);
    expect(failed).toMatchObject({ success: false, errorReason: "settle_upto_stellar_transaction_failed" });
    expect(failed.transaction).not.toBe("");
    expect(failed.errorMessage).toContain("txFailed");

    fake.failedResult = failedWith(xdr.TransactionResultResult.txTooLate());
    const second = await settleRequest(300_000n);
    expect((await scheme.settle(second.payload, second.settleRequirements)).errorReason).toBe(
      "settle_upto_stellar_transaction_expired",
    );
  });

  it("lets a payment be retried when nothing reached the network", async () => {
    const fake = honest(new FakeRpc());
    fake.sendStatus = "ERROR";
    const scheme = facilitator(fake);
    const { payload, settleRequirements } = await settleRequest(300_000n);
    expect(await scheme.settle(payload, settleRequirements)).toMatchObject({
      success: false,
      errorReason: "settle_upto_stellar_transaction_submission_failed",
      transaction: "",
    });
    fake.sendStatus = "PENDING";
    expect((await scheme.settle(payload, settleRequirements)).success).toBe(true);
    expect(fake.sent).toHaveLength(2);
  });

  it("reports signing failures", async () => {
    const refusing = (signer: FacilitatorStellarSigner): FacilitatorStellarSigner => ({
      ...signer,
      signTransaction: () =>
        Promise.resolve({ signedTxXdr: "", error: { message: "hsm offline", code: -1 } }),
    });
    const fake = honest(new FakeRpc());
    const first = await settleRequest(300_000n);
    expect(
      (
        await facilitator(fake, { settlementAuthority: refusing(authoritySigner) }).settle(
          first.payload,
          first.settleRequirements,
        )
      ).errorReason,
    ).toBe("settle_upto_stellar_transaction_signing_failed");
    const second = await settleRequest(300_000n);
    expect(
      (
        await facilitator(fake, { feeBumpSigner: refusing(sponsorSigner) }).settle(
          second.payload,
          second.settleRequirements,
        )
      ).errorReason,
    ).toBe("settle_upto_stellar_fee_bump_signing_failed");
  });

  it("reports a failed signer selection and unexpected errors", async () => {
    const fake = honest(new FakeRpc());
    const first = await settleRequest(300_000n);
    expect(
      (
        await facilitator(fake, { selectSigner: () => "GNOPE" }).settle(
          first.payload,
          first.settleRequirements,
        )
      ).errorReason,
    ).toBe("settle_upto_stellar_signer_selection_failed");
    fake.getAccount = () => Promise.reject(new Error("account lookup failed"));
    const second = await settleRequest(300_000n);
    expect(await facilitator(fake).settle(second.payload, second.settleRequirements)).toMatchObject({
      success: false,
      errorReason: "unexpected_settle_error",
      errorMessage: "account lookup failed",
    });
  });

  it("answers a broadcast whose RPC answer was lost as pending with its hash, and confirms it on a repeat", async () => {
    const fake = honest(new FakeRpc());
    fake.sendTransaction = (transaction) => {
      fake.sent.push(transaction);
      return Promise.reject(new Error("socket hang up"));
    };
    const scheme = facilitator(fake);
    const { payload, settleRequirements } = await settleRequest(300_000n);
    const pending = await scheme.settle(payload, settleRequirements);
    const [sent] = fake.sent;
    expect(pending).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
      transaction: sent?.hash().toString("hex"),
    });
    // The transaction landed after all.
    expect(await scheme.settle(payload, settleRequirements)).toMatchObject({
      success: true,
      transaction: pending.transaction,
    });
    expect(fake.sent).toHaveLength(1);
  });

  it("lets a payment be retried when an RPC call failed before anything was signed", async () => {
    const fake = honest(new FakeRpc());
    const getAccount = fake.getAccount.bind(fake);
    fake.getAccount = () => Promise.reject(new Error("account lookup failed"));
    const scheme = facilitator(fake);
    const { payload, settleRequirements } = await settleRequest(300_000n);
    expect(await scheme.settle(payload, settleRequirements)).toMatchObject({
      success: false,
      errorReason: "unexpected_settle_error",
      transaction: "",
    });
    fake.getAccount = getAccount;
    expect((await scheme.settle(payload, settleRequirements)).success).toBe(true);
    expect(fake.sent).toHaveLength(1);
  });

  it("keeps polling a pending settlement after its authorization expired, and answers what landed", async () => {
    const fake = honest(new FakeRpc());
    fake.statuses = ["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"] as rpc.Api.GetTransactionStatus[];
    const scheme = facilitator(fake);
    const { payload, settleRequirements } = await settleRequest(300_000n);
    const pending = await scheme.settle(payload, settleRequirements);
    expect(pending.errorReason).toBe("settlement_pending");

    // Past the expiration ledger, a fresh request is refused by rule 7, but the repeat still polls.
    fake.ledger = LEDGER + 200;
    const fresh = await settleRequest(300_000n);
    await scheme.settle(fresh.payload, fresh.settleRequirements);
    expect(await scheme.settle(payload, settleRequirements)).toMatchObject({
      success: true,
      transaction: pending.transaction,
    });
    // Final now: every later repeat answers the same, until the record is pruned.
    fake.statuses = [rpc.Api.GetTransactionStatus.FAILED];
    expect(await scheme.settle(payload, settleRequirements)).toMatchObject({ success: true });
    expect(fake.sent).toHaveLength(1);
  });

  it("finishes a pending settlement as expired only once the RPC proves it absent", async () => {
    const fake = honest(new FakeRpc());
    fake.statuses = ["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"] as rpc.Api.GetTransactionStatus[];
    const scheme = facilitator(fake);
    const { payload, settleRequirements } = await settleRequest(300_000n);
    const pending = await scheme.settle(payload, settleRequirements);
    expect(pending.errorReason).toBe("settlement_pending");

    fake.ledger = LEDGER + 200;
    const notFound = () => {
      fake.statuses = ["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"] as rpc.Api.GetTransactionStatus[];
    };
    // The RPC no longer retains the ledger the settlement was requested in: it cannot tell.
    fake.oldestLedger = LEDGER + 1;
    notFound();
    expect(await scheme.settle(payload, settleRequirements)).toMatchObject({
      errorReason: "settlement_pending",
      transaction: pending.transaction,
    });
    // It does, and a ledger past the expiration closed without it.
    fake.oldestLedger = 1;
    notFound();
    const expired = {
      success: false,
      errorReason: "settle_upto_stellar_transaction_expired",
      transaction: pending.transaction,
    };
    expect(await scheme.settle(payload, settleRequirements)).toMatchObject(expired);
    expect(await scheme.settle(payload, settleRequirements)).toMatchObject(expired);
    expect(fake.sent).toHaveLength(1);
  });

  it("forgets settlements once their authorization has expired", async () => {
    const fake = honest(new FakeRpc());
    const scheme = facilitator(fake);
    const { payload, settleRequirements } = await settleRequest(300_000n);
    expect((await scheme.settle(payload, settleRequirements)).success).toBe(true);
    fake.ledger = LEDGER + 200;
    // The authorization has expired, so the static rules refuse it; nothing is re-submitted.
    expect((await scheme.settle(payload, settleRequirements)).errorReason).toBe(
      "invalid_upto_stellar_signature_expired",
    );
    expect(fake.sent).toHaveLength(1);
  });
});
