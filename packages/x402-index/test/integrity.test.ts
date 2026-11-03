/**
 * Events are bound to consensus through the result's success hash. These tests rewrite the meta of real
 * settlements after the fact (the result left as published) and check that the classifier stops
 * instead of counting the forged events; and that the upto event must equal the signed arguments.
 */
import { Address, Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  EventIntegrityError,
  assertEventsBound,
  classifyLedger,
  classifyTransaction,
  transferOf,
  type Classification,
} from "../src/index.ts";
import {
  ADDRESSES,
  TRANSACTIONS,
  contextFor,
  ledgerMeta,
  sealResult,
  testnet,
  type FixtureTransaction,
} from "./helpers.ts";

const symbol = (event: xdr.ContractEvent) => {
  const [topic] = event.body().v0().topics();
  return topic?.switch() === xdr.ScValType.scvSymbol() ? topic.sym().toString() : undefined;
};

const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });

/** Sets `field` of an event whose data is a symbol map. */
function setField(event: xdr.ContractEvent, field: string, value: xdr.ScVal): void {
  for (const entry of event.body().v0().data().map() ?? []) {
    if (entry.key().sym().toString() === field) entry.val(value);
  }
}

/** Edits a fixture's meta (its events) and classifies it, sealing the result again only with `seal`. */
function withEvents(
  fixture: FixtureTransaction,
  edit: (events: xdr.ContractEvent[]) => void,
  seal: boolean,
): Classification {
  const meta = xdr.TransactionMeta.fromXDR(fixture.metaXdr, "base64");
  edit(meta.v4().operations()[0]?.events() ?? []);
  return classifyTransaction(
    {
      ...fixture,
      resultXdr: seal ? sealResult(fixture.resultXdr, meta) : fixture.resultXdr,
      metaXdr: meta.toXDR("base64"),
    },
    contextFor(fixture),
  );
}

describe("events bound to the result", () => {
  it("accepts the events of every real settlement", () => {
    for (const fixture of Object.values(TRANSACTIONS)) {
      const meta = xdr.TransactionMeta.fromXDR(fixture.metaXdr, "base64");
      const result = xdr.TransactionResult.fromXDR(fixture.resultXdr, "base64");
      expect(() => {
        assertEventsBound(result, meta, 0);
      }, fixture.hash).not.toThrow();
    }
  });

  it("stops on an exact settlement whose transfer amount was rewritten in the meta", () => {
    const rewrite = (events: xdr.ContractEvent[]) => {
      for (const event of events) if (symbol(event) === "transfer") event.body().v0().data(i128(1n));
    };
    expect(() => withEvents(TRANSACTIONS["rail402-exact"], rewrite, false)).toThrow(EventIntegrityError);
    expect(() => withEvents(TRANSACTIONS["x402org-exact-1"], rewrite, false)).toThrow(EventIntegrityError);
  });

  it("stops on an upto settlement whose event and transfer were rewritten together", () => {
    const fixture = TRANSACTIONS["rail402-upto"];
    const error = (() => {
      try {
        withEvents(
          fixture,
          (events) => {
            for (const event of events) {
              if (symbol(event) === "upto_settled") setField(event, "amount", i128(99_000n));
              const transfer = transferOf({
                contract: "",
                topics: event.body().v0().topics(),
                data: event.body().v0().data(),
              });
              if (transfer !== undefined) event.body().v0().data(i128(99_000n));
            }
          },
          false,
        );
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(EventIntegrityError);
    expect(error).toMatchObject({ code: "events_unbound" });
  });

  it("stops on a concluded beta settlement whose transfer was rewritten", () => {
    const fixture = TRANSACTIONS["beta-upto"];
    expect(withEvents(fixture, () => undefined, false).kind).toBe("settlement");
    expect(() =>
      withEvents(
        fixture,
        (events) => {
          for (const event of events) if (symbol(event) === "transfer") event.body().v0().data(i128(7n));
        },
        false,
      ),
    ).toThrow(EventIntegrityError);
  });

  it("stops on a dropped event and on a return value that was rewritten", () => {
    const fixture = TRANSACTIONS["rail402-upto"];
    expect(() => withEvents(fixture, (events) => events.pop(), false)).toThrow(EventIntegrityError);
    const meta = xdr.TransactionMeta.fromXDR(fixture.metaXdr, "base64");
    meta.v4().sorobanMeta()?.returnValue(i128(1n));
    expect(() =>
      classifyTransaction({ ...fixture, metaXdr: meta.toXDR("base64") }, contextFor(fixture)),
    ).toThrow(EventIntegrityError);
  });

  it("stops a ledger whose settlement events were rewritten, although its header, set and results agree", () => {
    const meta = ledgerMeta(5_330_316);
    const entry = meta
      .v2()
      .txProcessing()
      .find(
        (candidate) =>
          candidate.result().transactionHash().toString("hex") === TRANSACTIONS["rail402-upto"].hash,
      );
    if (entry === undefined) throw new Error("the upto settlement is not in ledger 5330316");
    for (const event of entry.txApplyProcessing().v4().operations()[0]?.events() ?? []) {
      if (symbol(event) === "upto_settled") setField(event, "amount", i128(1n));
    }
    expect(() => classifyLedger(meta, testnet())).toThrow(EventIntegrityError);
  });
});

describe("upto events against the signed arguments", () => {
  const fixture = TRANSACTIONS["rail402-upto"];
  const stranger = Keypair.random().publicKey();

  it("refuses an event that reports another amount than the settle call, even with a matching transfer", () => {
    const outcome = withEvents(
      fixture,
      (events) => {
        for (const event of events) {
          if (symbol(event) === "upto_settled") setField(event, "amount", i128(99_000n));
          if (symbol(event) === "transfer") event.body().v0().data(i128(99_000n));
        }
      },
      true,
    );
    expect(outcome).toEqual({ kind: "excluded", reason: "transfer_event_mismatch" });
  });

  it("refuses an event that names another recipient, cap or settlement authority than the terms", () => {
    const address = nativeToScVal(Address.fromString(stranger));
    const recipient = withEvents(
      fixture,
      (events) => {
        for (const event of events) {
          if (symbol(event) === "upto_settled" || symbol(event) === "transfer") {
            const topics = event.body().v0().topics();
            topics[2] = address;
          }
        }
      },
      true,
    );
    expect(recipient).toEqual({ kind: "excluded", reason: "transfer_event_mismatch" });
    const cap = withEvents(
      fixture,
      (events) => {
        for (const event of events)
          if (symbol(event) === "upto_settled") setField(event, "max_amount", i128(10n ** 12n));
      },
      true,
    );
    expect(cap).toEqual({ kind: "excluded", reason: "transfer_event_mismatch" });
    const authority = withEvents(
      fixture,
      (events) => {
        for (const event of events)
          if (symbol(event) === "upto_settled") setField(event, "facilitator", address);
      },
      true,
    );
    expect(authority).toEqual({ kind: "excluded", reason: "transfer_event_mismatch" });
  });

  it("is not a candidate when only another contract emitted upto_settled", () => {
    const attacker = StrKey.encodeContract(Buffer.alloc(32, 9));
    const envelope = xdr.TransactionEnvelope.fromXDR(fixture.envelopeXdr, "base64");
    const [operation] = envelope.feeBump().tx().innerTx().v1().tx().operations();
    const contract = xdr.ScAddress.scAddressTypeContract(
      Address.fromString(attacker).toScAddress().contractId(),
    );
    const op = operation?.body().invokeHostFunctionOp();
    op?.hostFunction().invokeContract().contractAddress(contract);
    op?.auth()[0]?.rootInvocation().function().contractFn().contractAddress(contract);
    // The registry contract's upto_settled is still in the call, but the called contract emitted none.
    expect(
      classifyTransaction({ ...fixture, envelopeXdr: envelope.toXDR("base64") }, contextFor(fixture)),
    ).toEqual({ kind: "none" });
    expect(ADDRESSES.upto).not.toBe(attacker);
  });
});

describe("muxed transfer data", () => {
  const from = Keypair.random().publicKey();
  const to = Keypair.random().publicKey();
  const event = (muxed: xdr.ScVal) => ({
    contract: ADDRESSES.usdcTestnet,
    topics: [
      xdr.ScVal.scvSymbol("transfer"),
      nativeToScVal(Address.fromString(from)),
      nativeToScVal(Address.fromString(to)),
    ],
    data: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: i128(5n) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("to_muxed_id"), val: muxed }),
    ]),
  });

  it("reads to_muxed_id as a u64, and keeps only the form of a text or hash memo", () => {
    expect(transferOf(event(nativeToScVal(42n, { type: "u64" })))).toMatchObject({
      toMuxedId: "42",
      toMemo: null,
    });
    expect(transferOf(event(xdr.ScVal.scvString("x\u0000y")))).toMatchObject({
      amount: 5n,
      toMuxedId: null,
      toMemo: "text",
    });
    expect(transferOf(event(xdr.ScVal.scvBytes(Buffer.from("0a0b", "hex"))))).toMatchObject({
      amount: 5n,
      toMuxedId: null,
      toMemo: "hash",
    });
    expect(transferOf(event(xdr.ScVal.scvBool(true)))).toBeUndefined();
  });
});

describe("unreadable envelopes", () => {
  it("are none on a single transaction, as in a ledger", () => {
    const fixture = TRANSACTIONS["rail402-exact"];
    const envelope = xdr.TransactionEnvelope.fromXDR(fixture.envelopeXdr, "base64");
    const [operation] = envelope.feeBump().tx().innerTx().v1().tx().operations();
    const credentials = operation?.body().invokeHostFunctionOp().auth()[0]?.credentials().address();
    credentials?.address(
      xdr.ScAddress.scAddressTypeClaimableBalance(
        xdr.ClaimableBalanceId.claimableBalanceIdTypeV0(Buffer.alloc(32)),
      ),
    );
    expect(
      classifyTransaction({ ...fixture, envelopeXdr: envelope.toXDR("base64") }, contextFor(fixture)),
    ).toEqual({ kind: "none" });
  });
});
