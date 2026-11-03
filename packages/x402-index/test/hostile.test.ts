/**
 * Hostile variants of real settlements: each test edits one thing in an evidence transaction's XDR and
 * checks that the rules refuse to count it (or count it without the claim it fakes).
 */
import { Address, Keypair, Networks, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  classifyTransaction,
  unstorableFields,
  verifySacAsset,
  type Classification,
  type SettlementRow,
} from "../src/index.ts";
import {
  ADDRESSES,
  TRANSACTIONS,
  accountSignature,
  addressCredentials,
  contextFor,
  payAs,
  sealResult,
  signEntry,
  testnet,
  type FixtureTransaction,
} from "./helpers.ts";

const ATTACKER_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 7));
const ATTACKER_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 9));

interface Parts {
  envelope: xdr.TransactionEnvelope;
  meta: xdr.TransactionMeta;
  /** The inner transaction (of the fee bump). */
  tx: xdr.Transaction;
  op: xdr.InvokeHostFunctionOp;
  events: xdr.ContractEvent[];
}

/**
 * Decodes a fixture, lets `edit` change it, and classifies the re-encoded result. With `seal` (the
 * default) the result is re-committed to the edited events, as for a contract that really emitted them;
 * without it the meta is tampered after the fact.
 */
function mutated(
  fixture: FixtureTransaction,
  edit: (parts: Parts) => void,
  { seal = true }: { seal?: boolean } = {},
): Classification {
  const envelope = xdr.TransactionEnvelope.fromXDR(fixture.envelopeXdr, "base64");
  const meta = xdr.TransactionMeta.fromXDR(fixture.metaXdr, "base64");
  const tx =
    envelope.switch() === xdr.EnvelopeType.envelopeTypeTxFeeBump()
      ? envelope.feeBump().tx().innerTx().v1().tx()
      : envelope.v1().tx();
  const [operation] = tx.operations();
  if (operation === undefined) throw new Error("no operation");
  const events = meta.v4().operations()[0]?.events() ?? [];
  edit({ envelope, meta, tx, op: operation.body().invokeHostFunctionOp(), events });
  return classifyTransaction(
    {
      ...fixture,
      envelopeXdr: envelope.toXDR("base64"),
      resultXdr: seal ? sealResult(fixture.resultXdr, meta) : fixture.resultXdr,
      metaXdr: meta.toXDR("base64"),
    },
    contextFor(fixture),
  );
}

const contractId = (address: string) =>
  xdr.ScAddress.scAddressTypeContract(Address.fromString(address).toScAddress().contractId());

function retarget(parts: Parts, contract: string) {
  const call = parts.op.hostFunction().invokeContract();
  call.contractAddress(contractId(contract));
  const root = parts.op.auth()[0]?.rootInvocation().function().contractFn();
  root?.contractAddress(contractId(contract));
}

const symbol = (event: xdr.ContractEvent) => {
  const [topic] = event.body().v0().topics();
  return topic?.switch() === xdr.ScValType.scvSymbol() ? topic.sym().toString() : undefined;
};

const contractOf = (address: string) => Address.fromString(address).toScAddress().contractId();

describe("hostile upto events", () => {
  it("ignores upto_settled from a contract outside the registry", () => {
    const outcome = mutated(TRANSACTIONS["rail402-upto"], (parts) => {
      retarget(parts, ATTACKER_CONTRACT);
      for (const event of parts.events) {
        if (symbol(event) === "upto_settled") event.contractId(contractOf(ATTACKER_CONTRACT));
      }
    });
    expect(outcome).toEqual({ kind: "excluded", reason: "upto_unregistered_contract" });
  });

  it("ignores upto_settled emitted by another contract during a registry settle", () => {
    const outcome = mutated(TRANSACTIONS["rail402-upto"], (parts) => {
      for (const event of parts.events) {
        if (symbol(event) === "upto_settled") event.contractId(contractOf(ATTACKER_CONTRACT));
      }
    });
    expect(outcome).toEqual({ kind: "excluded", reason: "transfer_event_mismatch" });
  });

  it("refuses an upto_settled amount the token transfer does not match", () => {
    const outcome = mutated(TRANSACTIONS["rail402-upto"], (parts) => {
      for (const event of parts.events) {
        if (symbol(event) !== "upto_settled") continue;
        const body = event.body().v0();
        const entries = body.data().map() ?? [];
        for (const entry of entries) {
          if (entry.key().sym().toString() === "amount") entry.val(nativeToScVal(99_000n, { type: "i128" }));
        }
      }
    });
    expect(outcome).toEqual({ kind: "excluded", reason: "transfer_event_mismatch" });
  });

  it("refuses a registry contract whose instance runs other WASM", () => {
    const outcome = mutated(TRANSACTIONS["rail402-upto"], (parts) => {
      const instance = new xdr.LedgerEntry({
        lastModifiedLedgerSeq: 1,
        data: xdr.LedgerEntryData.contractData(
          new xdr.ContractDataEntry({
            ext: new xdr.ExtensionPoint(0),
            contract: contractId(ADDRESSES.upto),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent(),
            val: xdr.ScVal.scvContractInstance(
              new xdr.ScContractInstance({
                executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 1)),
                storage: null,
              }),
            ),
          }),
        ),
        ext: new xdr.LedgerEntryExt(0),
      });
      parts.meta.v4().txChangesBefore().push(xdr.LedgerEntryChange.ledgerEntryState(instance));
    });
    expect(outcome).toEqual({ kind: "excluded", reason: "upto_wasm_mismatch" });
  });
});

describe("hostile assets", () => {
  it("does not verify a token whose SAC topic names another asset", () => {
    // A transfer its payer really signed, so that the row exists and only its asset is in question.
    const buyer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x31));
    const outcome = mutated(TRANSACTIONS["rail402-exact"], (parts) => {
      retarget(parts, ATTACKER_TOKEN);
      for (const event of parts.events) event.contractId(contractOf(ATTACKER_TOKEN));
      payAs(parts.op, parts.events, buyer.publicKey());
      const [entry] = parts.op.auth();
      if (entry !== undefined) signEntry(entry, [buyer]);
    });
    expect(outcome).toMatchObject({
      kind: "settlement",
      row: { asset: { contract: ATTACKER_TOKEN, code: null, issuer: null, verified: false } },
    });
  });

  it("verifies only names whose contract id matches, including native", () => {
    const usdc = "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    const passphrase = "Test SDF Network ; September 2015";
    expect(verifySacAsset(ADDRESSES.usdcTestnet, usdc, passphrase).verified).toBe(true);
    expect(
      verifySacAsset(ADDRESSES.usdcTestnet, usdc, "Public Global Stellar Network ; September 2015").verified,
    ).toBe(false);
    expect(verifySacAsset(ATTACKER_TOKEN, usdc, passphrase)).toEqual({
      contract: ATTACKER_TOKEN,
      code: null,
      issuer: null,
      verified: false,
    });
    for (const topic of ["", "USDC", "USDC:not-an-issuer", "a:b:c", "‮USDC:GBBD", "x".repeat(500)]) {
      expect(verifySacAsset(ADDRESSES.usdcTestnet, topic, passphrase).verified).toBe(false);
    }
  });
});

describe("hostile shapes", () => {
  it("excludes a transfer batched with another operation", () => {
    const outcome = mutated(TRANSACTIONS["rail402-exact"], (parts) => {
      const [operation] = parts.tx.operations();
      if (operation !== undefined) parts.tx.operations().push(operation);
    });
    expect(outcome).toEqual({ kind: "excluded", reason: "multi_operation" });
  });

  it("excludes a wallet transfer the payer submitted and authorized as the source", () => {
    const outcome = mutated(TRANSACTIONS["rail402-exact"], (parts) => {
      const [entry] = parts.op.auth();
      if (entry !== undefined) entry.credentials(xdr.SorobanCredentials.sorobanCredentialsSourceAccount());
    });
    expect(outcome).toEqual({ kind: "excluded", reason: "self_paid_fee" });
  });

  it("excludes a payer that is also the transaction source", () => {
    const outcome = mutated(TRANSACTIONS["rail402-exact"], (parts) => {
      const [from] = parts.op.hostFunction().invokeContract().args();
      if (from !== undefined)
        parts.tx.sourceAccount(xdr.MuxedAccount.keyTypeEd25519(from.address().accountId().ed25519()));
    });
    expect(outcome).toEqual({ kind: "excluded", reason: "self_paid_fee" });
  });

  it("excludes delegated credentials and accepts AddressV2", () => {
    const delegated = mutated(TRANSACTIONS["rail402-exact"], (parts) => {
      const [entry] = parts.op.auth();
      if (entry === undefined) return;
      entry.credentials(
        xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
          new xdr.SorobanAddressCredentialsWithDelegates({
            addressCredentials: entry.credentials().address(),
            delegates: [],
          }),
        ),
      );
    });
    expect(delegated).toEqual({ kind: "excluded", reason: "delegated_credentials" });
    const v2 = mutated(TRANSACTIONS["rail402-exact"], (parts) => {
      const [entry] = parts.op.auth();
      if (entry !== undefined) {
        entry.credentials(xdr.SorobanCredentials.sorobanCredentialsAddressV2(entry.credentials().address()));
      }
    });
    expect(v2.kind).toBe("settlement");
  });

  it("excludes a second authorization and sub-invocations", () => {
    expect(
      mutated(TRANSACTIONS["rail402-exact"], (parts) => {
        const [entry] = parts.op.auth();
        if (entry !== undefined) parts.op.auth().push(entry);
      }),
    ).toEqual({ kind: "excluded", reason: "multi_auth" });
    expect(
      mutated(TRANSACTIONS["rail402-exact"], (parts) => {
        const root = parts.op.auth()[0]?.rootInvocation();
        if (root !== undefined)
          root.subInvocations().push(xdr.SorobanAuthorizedInvocation.fromXDR(root.toXDR()));
      }),
    ).toEqual({ kind: "excluded", reason: "sub_invocations" });
  });

  it("excludes an authorization for someone other than the payer", () => {
    const outcome = mutated(TRANSACTIONS["rail402-exact"], (parts) => {
      const credentials = parts.op.auth()[0]?.credentials().address();
      credentials?.address(xdr.ScAddress.scAddressTypeAccount(Keypair.random().xdrAccountId()));
    });
    expect(outcome).toEqual({ kind: "excluded", reason: "malformed" });
  });

  it("excludes a transfer whose event amount differs from the argument, or has no event", () => {
    expect(
      mutated(TRANSACTIONS["rail402-exact"], (parts) => {
        for (const event of parts.events) {
          if (symbol(event) === "transfer")
            event
              .body()
              .v0()
              .data(nativeToScVal(1n, { type: "i128" }));
        }
      }),
    ).toEqual({ kind: "excluded", reason: "transfer_event_mismatch" });
    expect(
      mutated(TRANSACTIONS["rail402-exact"], (parts) => {
        parts.events.length = 0;
      }),
    ).toEqual({ kind: "excluded", reason: "transfer_event_mismatch" });
  });

  it("excludes a non-positive amount and arguments of the wrong type", () => {
    expect(
      mutated(TRANSACTIONS["rail402-exact"], (parts) => {
        const args = parts.op.hostFunction().invokeContract().args();
        args[2] = nativeToScVal(0n, { type: "i128" });
      }),
    ).toEqual({ kind: "excluded", reason: "malformed" });
    expect(
      mutated(TRANSACTIONS["rail402-exact"], (parts) => {
        const args = parts.op.hostFunction().invokeContract().args();
        args[2] = nativeToScVal(10_000, { type: "u64" });
      }),
    ).toEqual({ kind: "excluded", reason: "malformed" });
  });
});

describe("hostile payer authorizations", () => {
  const payer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x31));
  const cosigner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x32));
  const victim = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33));
  const fixture = TRANSACTIONS["x402org-exact-1"];
  const entryOf = (parts: Parts) => {
    const [entry] = parts.op.auth();
    if (entry === undefined) throw new Error("no authorization entry");
    return entry;
  };
  const credentialsOf = (parts: Parts) => addressCredentials(entryOf(parts));
  /** A settlement moved to a token that is not a Stellar Asset Contract and to the account `from`. */
  const customToken = (parts: Parts, from: string) => {
    retarget(parts, ATTACKER_TOKEN);
    for (const event of parts.events) event.contractId(contractOf(ATTACKER_TOKEN));
    payAs(parts.op, parts.events, from);
  };
  /** The forger pays the fee itself instead of a registered facilitator. */
  const forgerPaysFee = (parts: Parts) => {
    const forger = xdr.MuxedAccount.keyTypeEd25519(cosigner.rawPublicKey());
    parts.envelope.feeBump().tx().feeSource(forger);
    parts.tx.sourceAccount(forger);
  };
  const unproven = { kind: "excluded", reason: "unproven_authorization" };
  const ascending = () =>
    [payer, cosigner].sort((a, b) => Buffer.compare(a.rawPublicKey(), b.rawPublicKey()));
  /** An edit that signs the entry again with `keys`, in that order. */
  const signedWith =
    (keys: readonly Keypair[], passphrase?: string) =>
    (parts: Parts): void => {
      signEntry(entryOf(parts), keys, passphrase);
    };

  it("never names an account as the payer of a custom-token transfer it did not sign", () => {
    const signatures = [
      xdr.ScVal.scvVoid(),
      xdr.ScVal.scvVec([]),
      xdr.ScVal.scvVec([accountSignature(victim.rawPublicKey(), Buffer.alloc(64, 0xab))]),
    ];
    for (const signature of signatures) {
      for (const forgerFee of [false, true]) {
        const outcome = mutated(fixture, (parts) => {
          customToken(parts, victim.publicKey());
          credentialsOf(parts).signature(signature);
          if (forgerFee) forgerPaysFee(parts);
        });
        expect(outcome).toEqual(unproven);
      }
    }
  });

  it("counts a custom-token transfer the payer's own key signed, with Address or AddressV2 credentials", () => {
    for (const v2 of [false, true]) {
      const outcome = mutated(fixture, (parts) => {
        customToken(parts, payer.publicKey());
        const entry = entryOf(parts);
        if (v2) entry.credentials(xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentialsOf(parts)));
        signEntry(entry, [payer]);
      });
      expect(outcome).toMatchObject({
        kind: "settlement",
        row: {
          payer: payer.publicKey(),
          asset: { contract: ATTACKER_TOKEN, verified: false },
          attribution: { tier: "facilitator", facilitatorId: "x402-org" },
          checks: ["E1", "E2", "E3", "E4", "E5", "E6", "E7"],
        },
      });
    }
  });

  it("refuses a signature by another key, for another network, transfer or credential, or past its expiration", () => {
    const variants: [string, (parts: Parts) => void][] = [
      ["another key", signedWith([cosigner])],
      ["another network", signedWith([payer], Networks.PUBLIC)],
      [
        "another amount",
        (parts) => {
          signEntry(entryOf(parts), [payer]);
          const amount = nativeToScVal(1n, { type: "i128" });
          parts.op.hostFunction().invokeContract().args()[2] = amount;
          entryOf(parts).rootInvocation().function().contractFn().args()[2] = amount;
          for (const event of parts.events) if (symbol(event) === "transfer") event.body().v0().data(amount);
        },
      ],
      [
        "an Address signature under AddressV2 credentials",
        (parts) => {
          signEntry(entryOf(parts), [payer]);
          entryOf(parts).credentials(
            xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentialsOf(parts)),
          );
        },
      ],
      [
        "expired before its ledger",
        (parts) => {
          credentialsOf(parts).signatureExpirationLedger(fixture.ledger - 1);
          signEntry(entryOf(parts), [payer]);
        },
      ],
    ];
    for (const [name, edit] of variants) {
      const outcome = mutated(fixture, (parts) => {
        customToken(parts, payer.publicKey());
        edit(parts);
      });
      expect(outcome, name).toEqual(unproven);
    }
    const lastLedger = mutated(fixture, (parts) => {
      customToken(parts, payer.publicKey());
      credentialsOf(parts).signatureExpirationLedger(fixture.ledger);
      signEntry(entryOf(parts), [payer]);
    });
    expect(lastLedger.kind).toBe("settlement");
  });

  it("reads co-signers in the form the network checks, and proves the payer by its own signature", () => {
    const signedBy = (edit: (parts: Parts) => void) =>
      mutated(fixture, (parts) => {
        customToken(parts, payer.publicKey());
        edit(parts);
      });
    /** Signs with both keys in ascending order, then replaces `key`'s signature with bytes no key made. */
    const forgedSignatureOf = (key: Keypair) => (parts: Parts) => {
      signEntry(entryOf(parts), ascending());
      const signatures = credentialsOf(parts).signature().vec() ?? [];
      signatures[ascending().indexOf(key)] = accountSignature(key.rawPublicKey(), Buffer.alloc(64, 0xab));
    };
    expect(signedBy(signedWith(ascending())).kind).toBe("settlement");
    expect(signedBy(signedWith(ascending().reverse()))).toEqual(unproven);
    expect(signedBy(signedWith([payer, payer]))).toEqual(unproven);
    expect(signedBy(forgedSignatureOf(payer))).toEqual(unproven);
    // A co-signature proves nothing about the payer, so it is not verified at all.
    expect(signedBy(forgedSignatureOf(cosigner)).kind).toBe("settlement");
    expect(
      signedBy((parts) => {
        signEntry(entryOf(parts), [payer]);
        const [element] = credentialsOf(parts).signature().vec() ?? [];
        element
          ?.map()
          ?.push(new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("weight"), val: xdr.ScVal.scvU32(1) }));
      }),
    ).toEqual(unproven);
  });

  it("checks one signature per transfer, whatever the entry carries", () => {
    const verify = vi.spyOn(Keypair.prototype, "verify");
    try {
      const keys = [
        payer,
        ...Array.from({ length: 19 }, (_, index) =>
          Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x40 + index)),
        ),
      ].sort((a, b) => Buffer.compare(a.rawPublicKey(), b.rawPublicKey()));
      verify.mockClear();
      const outcome = mutated(fixture, (parts) => {
        customToken(parts, payer.publicKey());
        signEntry(entryOf(parts), keys);
        verify.mockClear();
      });
      expect(outcome.kind).toBe("settlement");
      expect(verify).toHaveBeenCalledTimes(1);
    } finally {
      verify.mockRestore();
    }
  });

  it("refuses a contract payer in a custom token, whose own code decides its authorization", () => {
    expect(
      mutated(fixture, (parts) => {
        customToken(parts, ATTACKER_CONTRACT);
      }),
    ).toEqual(unproven);
  });

  it("proves a Stellar Asset Contract transfer by the contract, which requires the payer's authorization", () => {
    // The network authenticated the entry before the transfer could succeed, so the rules read no
    // signature: a contract payer or a co-signed account is proven the same way.
    for (const from of [ATTACKER_CONTRACT, victim.publicKey()]) {
      const outcome = mutated(fixture, (parts) => {
        payAs(parts.op, parts.events, from);
        signEntry(entryOf(parts), [cosigner]);
      });
      expect(outcome).toMatchObject({
        kind: "settlement",
        row: { payer: from, asset: { verified: true }, checks: ["E1", "E2", "E3", "E4", "E5", "E6", "E7"] },
      });
    }
  });
});

/** A transfer event's data rewritten to CAP-67's `{ amount, to_muxed_id }` with the given id. */
function muxTransfers(parts: Parts, muxedId: xdr.ScVal) {
  for (const event of parts.events) {
    if (symbol(event) !== "transfer") continue;
    const body = event.body().v0();
    const amount = body.data().switch() === xdr.ScValType.scvI128() ? body.data() : undefined;
    if (amount === undefined) continue;
    body.data(
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: amount }),
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("to_muxed_id"), val: muxedId }),
      ]),
    );
  }
}

describe("hostile bytes in rows", () => {
  it("never takes a text or hash memo form of to_muxed_id into a row, in any rule", () => {
    const nul = xdr.ScVal.scvString("a\u0000");
    const invalidUtf8 = xdr.ScVal.scvString(Buffer.from([0x61, 0xff, 0xfe]));
    for (const id of [nul, invalidUtf8, xdr.ScVal.scvBytes(Buffer.alloc(32, 1))]) {
      for (const fixture of ["beta-upto", "rail402-exact", "rail402-upto"] as const) {
        expect(
          mutated(TRANSACTIONS[fixture], (parts) => {
            muxTransfers(parts, id);
          }),
        ).toEqual({
          kind: "excluded",
          reason: "transfer_event_mismatch",
        });
      }
    }
  });

  it("still reads a u64 to_muxed_id in a concluded beta settlement", () => {
    const outcome = mutated(TRANSACTIONS["beta-upto"], (parts) => {
      muxTransfers(parts, nativeToScVal(77n, { type: "u64" }));
    });
    expect(outcome.kind === "settlement" ? outcome.row.payToMuxedId : outcome).toBe("77");
  });

  it("refuses any row field that could not be stored as it is", () => {
    const outcome = classifyTransaction(TRANSACTIONS["rail402-exact"], testnet());
    if (outcome.kind !== "settlement") throw new Error("expected a settlement");
    const row = outcome.row;
    expect(unstorableFields(row)).toEqual([]);
    const variants: [Partial<SettlementRow>, string][] = [
      [{ payToMuxedId: "a\u0000" }, "payToMuxedId"],
      [{ payToMuxedId: "12a" }, "payToMuxedId"],
      [{ payTo: "\ud800" + row.payTo.slice(1) }, "payTo"],
      [{ amount: "-5" }, "amount"],
      [{ maxAmount: "1".repeat(40) }, "maxAmount"],
      [{ txHash: row.txHash.toUpperCase() }, "txHash"],
      [{ asset: { ...row.asset, code: "US D" } }, "asset.code"],
      [{ checks: ["E1", "Z9" as never] }, "checks"],
      [{ attribution: { ...row.attribution, evidenceUrl: "x".repeat(4096) } }, "attribution.evidenceUrl"],
    ];
    for (const [change, field] of variants) {
      expect(unstorableFields({ ...row, ...change })).toContain(field);
    }
    expect(
      unstorableFields({
        network: row.network,
        epoch: row.epoch,
        ledger: row.ledger,
        txIndex: row.txIndex,
        txHash: row.txHash,
        scheme: "exact",
        resultCode: "txFailed:\u0000",
        feePayer: row.fee.payer,
        feeChargedStroops: "100",
      }),
    ).toEqual(["resultCode", "resultCode"]);
  });
});
