import { describe, expect, it } from "vitest";
import { Keypair, StrKey, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  I128_MAX,
  UPTO_DEPLOYMENTS,
  UPTO_DEPLOYMENT_SALT_HEX,
  authorityEntry,
  decodeAuthorizationEntry,
  encodeAuthorizationEntry,
  expirationLedgerFor,
  inspectSignerAuthorizations,
  inspectUptoAuthorization,
  isUptoCode,
  parseAtomicAmount,
  reject,
  resolveLedgerSeconds,
  resolveUptoContract,
  termsFromScVal,
  termsToScVal,
  unsignedPayerEntry,
  uptoCodes,
  uptoReason,
  uptoStandardCodes,
  uptoStellarCodes,
} from "@rail402.dev/upto";
import { CONTRACT, PASSPHRASE, payer, signedAuthorization, terms } from "./helpers.ts";

describe("terms codec", () => {
  it("round-trips, including an i128 cap above 64 bits", () => {
    const value = terms({ maxAmount: I128_MAX, validAfterLedger: 7 });
    expect(termsFromScVal(termsToScVal(value))).toEqual(value);
    const negative = terms({ maxAmount: -5n });
    expect(termsFromScVal(termsToScVal(negative))).toEqual(negative);
  });

  it("accepts contract recipients and refuses anything that is not the exact encoding", () => {
    const contractRecipient = terms({ recipient: CONTRACT });
    expect(termsFromScVal(termsToScVal(contractRecipient))?.recipient).toBe(CONTRACT);

    const entries = termsToScVal(terms()).map() ?? [];
    const replace = (key: string, value: xdr.ScVal) =>
      xdr.ScVal.scvMap(
        entries.map((entry) =>
          entry.key().sym().toString() === key ? new xdr.ScMapEntry({ key: entry.key(), val: value }) : entry,
        ),
      );
    expect(termsFromScVal(xdr.ScVal.scvU32(1))).toBeUndefined();
    expect(termsFromScVal(xdr.ScVal.scvMap([...entries, entries[0] as xdr.ScMapEntry]))).toBeUndefined();
    expect(
      termsFromScVal(replace("expiration_ledger", xdr.ScVal.scvU64(xdr.Uint64.fromString("5")))),
    ).toBeUndefined();
    expect(termsFromScVal(replace("max_amount", nativeToScVal(5n, { type: "u128" })))).toBeUndefined();
    expect(termsFromScVal(replace("recipient", xdr.ScVal.scvSymbol("GABC")))).toBeUndefined();
    const renamed = xdr.ScVal.scvMap(
      entries.map((entry, index) =>
        index === 0
          ? new xdr.ScMapEntry({ key: xdr.ScVal.scvString("expiration_ledger"), val: entry.val() })
          : entry,
      ),
    );
    expect(termsFromScVal(renamed)).toBeUndefined();
    const muxed = StrKey.encodeMed25519PublicKey(Buffer.concat([payer.rawPublicKey(), Buffer.alloc(8, 1)]));
    expect(termsFromScVal(replace("recipient", nativeToScVal(muxed, { type: "address" })))).toBeUndefined();
  });

  it("builds the authority's SOURCE_ACCOUNT entry for settle(payer, terms, amount)", () => {
    const entry = authorityEntry(CONTRACT, payer.publicKey(), terms(), 5n);
    expect(entry.credentials().switch()).toBe(xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount());
    const call = entry.rootInvocation().function().contractFn();
    expect(call.functionName().toString()).toBe("settle");
    expect(call.args().map((arg) => arg.switch())).toEqual([
      xdr.ScValType.scvAddress(),
      xdr.ScValType.scvMap(),
      xdr.ScValType.scvI128(),
    ]);
  });

  it("decodes only canonical base64", async () => {
    const base64 = await signedAuthorization();
    expect(encodeAuthorizationEntry(decodeAuthorizationEntry(base64))).toBe(base64);
    expect(() => decodeAuthorizationEntry(`${base64}AAAA`)).toThrow();
    expect(() => decodeAuthorizationEntry("not base64")).toThrow();
  });
});

describe("inspectUptoAuthorization", () => {
  it("reads payer, credential, nonce, expiration and terms", async () => {
    const t = terms();
    const result = inspectUptoAuthorization(
      await signedAuthorization({ terms: t, nonce: 99n, credential: "address_v2" }),
      CONTRACT,
    );
    if (!result.ok) throw new Error(result.rejection.code);
    expect(result.authorization).toMatchObject({
      payer: payer.publicKey(),
      credential: "address_v2",
      nonce: 99n,
      signatureExpirationLedger: t.expirationLedger,
      terms: t,
      treeValid: true,
    });
  });

  it("refuses non-strings, contract-creation roots and delegated credentials", async () => {
    expect(inspectUptoAuthorization(42, CONTRACT)).toMatchObject({
      ok: false,
      rejection: { code: "invalid_upto_stellar_payload_malformed" },
    });
    const entry = decodeAuthorizationEntry(await signedAuthorization());
    const creation = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
    creation.rootInvocation(
      new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
          new xdr.CreateContractArgs({
            contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(
              xdr.Asset.assetTypeNative(),
            ),
            executable: xdr.ContractExecutable.contractExecutableStellarAsset(),
          }),
        ),
        subInvocations: [],
      }),
    );
    expect(inspectUptoAuthorization(creation.toXDR("base64"), CONTRACT)).toMatchObject({
      ok: false,
      rejection: { code: "invalid_upto_stellar_payload_wrong_function" },
    });
    const delegated = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
    delegated.credentials(
      xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
        new xdr.SorobanAddressCredentialsWithDelegates({
          addressCredentials: entry.credentials().address(),
          delegates: [],
        }),
      ),
    );
    expect(inspectUptoAuthorization(delegated.toXDR("base64"), CONTRACT)).toMatchObject({
      ok: false,
      rejection: { code: "invalid_upto_stellar_payload_unsupported_credential_type" },
    });
  });
});

describe("inspectSignerAuthorizations", () => {
  const smartPayer = StrKey.encodeContract(hash(Buffer.from("smart payer")));
  const delegate = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 77));

  function checkAuthEntry(
    options: { signer?: Keypair; contract?: string; fn?: string; signed?: boolean; children?: number } = {},
  ) {
    const key = options.signer ?? delegate;
    const invocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: nativeToScVal(options.contract ?? smartPayer, { type: "address" }).address(),
          functionName: options.fn ?? "__check_auth",
          args: [xdr.ScVal.scvBytes(Buffer.alloc(32))],
        }),
      ),
      subInvocations: [],
    });
    if ((options.children ?? 0) > 0) {
      invocation.subInvocations([xdr.SorobanAuthorizedInvocation.fromXDR(invocation.toXDR())]);
    }
    return new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: nativeToScVal(key.publicKey(), { type: "address" }).address(),
          nonce: xdr.Int64.fromString("5"),
          signatureExpirationLedger: 100,
          signature: options.signed === false ? xdr.ScVal.scvVoid() : xdr.ScVal.scvBytes(Buffer.alloc(64, 1)),
        }),
      ),
      rootInvocation: invocation,
    }).toXDR("base64");
  }

  const facilitator = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 78));
  const check = (value: unknown, payerAddress = smartPayer) =>
    inspectSignerAuthorizations(value, payerAddress, new Set([facilitator.publicKey()]));

  it("accepts delegated __check_auth entries of a smart-account payer", () => {
    const result = check([checkAuthEntry()]);
    expect(result.ok && result.entries).toHaveLength(1);
    expect(check(undefined)).toMatchObject({ ok: true, entries: [] });
    expect(check([])).toMatchObject({ ok: true, entries: [] });
  });

  it.each([
    ["not an array", "x"],
    ["not a string", [1]],
    ["undecodable", ["AAAA"]],
    ["unsigned", "unsigned"],
    ["another contract", "contract"],
    ["another function", "fn"],
    ["children", "children"],
    ["signed by a facilitator account", "facilitator"],
    ["duplicated", "duplicate"],
    ["more than four", "many"],
  ])("refuses %s", (_name, variant) => {
    const value =
      variant === "unsigned"
        ? [checkAuthEntry({ signed: false })]
        : variant === "contract"
          ? [checkAuthEntry({ contract: CONTRACT })]
          : variant === "fn"
            ? [checkAuthEntry({ fn: "transfer" })]
            : variant === "children"
              ? [checkAuthEntry({ children: 1 })]
              : variant === "facilitator"
                ? [checkAuthEntry({ signer: facilitator })]
                : variant === "duplicate"
                  ? [checkAuthEntry(), checkAuthEntry()]
                  : variant === "many"
                    ? Array.from({ length: 5 }, (_, i) =>
                        checkAuthEntry({ signer: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 90 + i)) }),
                      )
                    : variant;
    const result = check(value);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.rejection.code).toBe("invalid_upto_stellar_payload_invalid_signer_authorization");
  });

  it("refuses an entry signed by the payer and oversized entries", () => {
    const self = checkAuthEntry();
    const result = inspectSignerAuthorizations([self], delegate.publicKey(), new Set());
    expect(result.ok).toBe(false);
    expect(check(["A".repeat(9000)])).toMatchObject({
      ok: false,
      rejection: { code: "invalid_upto_stellar_payload_too_large" },
    });
  });
});

describe("shared helpers", () => {
  it("parses canonical atomic amounts within i128", () => {
    expect(parseAtomicAmount("0")).toBe(0n);
    expect(parseAtomicAmount(I128_MAX.toString())).toBe(I128_MAX);
    for (const value of ["", "-1", "01", "1.5", "1e3", " 1", (I128_MAX + 1n).toString(), 5, undefined]) {
      expect(parseAtomicAmount(value)).toBeUndefined();
    }
  });

  it("resolves the settlement contract from overrides and canonical deployments", () => {
    expect(resolveUptoContract("stellar:testnet", CONTRACT)).toBe(CONTRACT);
    expect(resolveUptoContract("stellar:testnet", { "stellar:testnet": CONTRACT })).toBe(CONTRACT);
    expect(resolveUptoContract("stellar:pubnet", { "stellar:testnet": CONTRACT })).toBe(
      UPTO_DEPLOYMENTS["stellar:pubnet"]?.address,
    );
    expect(resolveUptoContract("eip155:1")).toBeUndefined();
    expect(UPTO_DEPLOYMENT_SALT_HEX).toBe(hash(Buffer.from("x402-upto-stellar/v1.1")).toString("hex"));
  });

  it("derives the expiration ledger from maxTimeoutSeconds", async () => {
    expect(expirationLedgerFor(1_000, 60, 5)).toBe(1_012);
    expect(expirationLedgerFor(1_000, 61, 5)).toBe(1_013);
    expect(await resolveLedgerSeconds("stellar:testnet", 6)).toBe(6);
    expect(await resolveLedgerSeconds("stellar:testnet", () => Promise.resolve(2))).toBe(2);
    await expect(resolveLedgerSeconds("stellar:testnet", 0)).rejects.toThrow();
  });

  it("builds unsigned entries with the terms' expiration", () => {
    const entry = unsignedPayerEntry({
      contract: CONTRACT,
      payer: payer.publicKey(),
      terms: terms(),
      nonce: -3n,
    });
    const credentials = entry.credentials().address();
    expect(credentials.nonce().toBigInt()).toBe(-3n);
    expect(credentials.signatureExpirationLedger()).toBe(terms().expirationLedger);
    expect(credentials.signature().switch()).toBe(xdr.ScValType.scvVoid());
    expect(PASSPHRASE).toContain("Test SDF");
  });
});

describe("codes", () => {
  it("form one set without duplicates, each with a non-empty reason", () => {
    const standard = Object.keys(uptoStandardCodes);
    const specific = Object.keys(uptoStellarCodes);
    expect(standard.filter((code) => specific.includes(code))).toEqual([]);
    expect(Object.keys(uptoCodes)).toEqual([...standard, ...specific]);
    for (const code of Object.keys(uptoCodes)) {
      expect(isUptoCode(code)).toBe(true);
      expect(uptoReason(code as keyof typeof uptoCodes).trim()).not.toBe("");
    }
    for (const code of Object.keys(uptoStellarCodes)) expect(code).toMatch(/^(invalid|settle)_upto_stellar_/);
    expect(isUptoCode("nope")).toBe(false);
  });

  it("keeps a specific reason and falls back to the default for a blank one", () => {
    expect(reject("insufficient_funds", "detail").reason).toBe("detail");
    expect(reject("insufficient_funds", "  ").reason).toBe(uptoReason("insufficient_funds"));
  });
});
