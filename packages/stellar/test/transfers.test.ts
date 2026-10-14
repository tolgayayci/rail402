import { describe, expect, it } from "vitest";
import {
  Account,
  Address,
  Contract,
  Keypair,
  MuxedAccount,
  nativeToScVal,
  xdr,
  type rpc,
} from "@stellar/stellar-sdk";
import { UnsupportedMetaError, findTransfers, sacTransferEvents } from "@rail402.dev/stellar";
import { randomContractId } from "@rail402.dev/testkit";

const token = randomContractId();
const payer = Keypair.random().publicKey();
const payTo = Keypair.random().publicKey();
const symbol = (value: string) => nativeToScVal(value, { type: "symbol" });
const address = (value: string) => nativeToScVal(value, { type: "address" });
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });

function event(contract: string, topics: xdr.ScVal[], data: xdr.ScVal): xdr.ContractEvent {
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: Address.fromString(contract).toScAddress().contractId(),
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
  });
}

function successfulWith(events: xdr.ContractEvent[]): rpc.Api.GetSuccessfulTransactionResponse {
  const meta = new xdr.TransactionMeta(
    4,
    new xdr.TransactionMetaV4({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [new xdr.OperationMetaV2({ ext: new xdr.ExtensionPoint(0), changes: [], events })],
      txChangesAfter: [],
      sorobanMeta: null,
      events: [],
      diagnosticEvents: [],
    }),
  );
  return { resultMetaXdr: meta } as rpc.Api.GetSuccessfulTransactionResponse;
}

const sacTopics = (from: string, to: string) => [
  symbol("transfer"),
  address(from),
  address(to),
  nativeToScVal("USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"),
];

describe("sacTransferEvents", () => {
  it("throws for a meta version it cannot read instead of reporting no transfers", () => {
    const future = {
      resultMetaXdr: { switch: () => 5 } as unknown as xdr.TransactionMeta,
    } as rpc.Api.GetSuccessfulTransactionResponse;
    expect(() => sacTransferEvents(future)).toThrow(UnsupportedMetaError);
  });

  it("reads SAC and custom-token transfer events in order", () => {
    const other = randomContractId();
    const transfers = sacTransferEvents(
      successfulWith([
        event(token, sacTopics(payer, payTo), i128(10n)),
        event(other, [symbol("transfer"), address(payer), address(payTo)], i128(20n)),
      ]),
    );
    expect(transfers).toEqual([
      { contract: token, from: payer, to: payTo, amount: 10n },
      { contract: other, from: payer, to: payTo, amount: 20n },
    ]);
  });

  it("reads a CAP-67 muxed destination", () => {
    const data = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: symbol("amount"), val: i128(7n) }),
      new xdr.ScMapEntry({ key: symbol("to_muxed_id"), val: nativeToScVal(42n, { type: "u64" }) }),
    ]);
    expect(sacTransferEvents(successfulWith([event(token, sacTopics(payer, payTo), data)]))).toEqual([
      { contract: token, from: payer, to: payTo, amount: 7n, toMuxedId: 42n },
    ]);
  });

  it("ignores other events and malformed transfers", () => {
    const transfers = sacTransferEvents(
      successfulWith([
        event(token, [symbol("mint"), address(payer), address(payTo)], i128(1n)),
        event(token, [symbol("transfer"), address(payer)], i128(1n)),
        event(token, [symbol("transfer"), symbol("x"), address(payTo)], i128(1n)),
        event(token, sacTopics(payer, payTo), symbol("nope")),
      ]),
    );
    expect(transfers).toEqual([]);
  });
});

describe("findTransfers", () => {
  function eventResponse(ledger: number, id: string, from = payer, success = true): rpc.Api.EventResponse {
    return {
      id,
      type: "contract",
      ledger,
      ledgerClosedAt: "",
      transactionIndex: 1,
      operationIndex: 0,
      inSuccessfulContractCall: success,
      txHash: `hash-${id}`,
      contractId: new Contract(token),
      topic: sacTopics(from, payTo),
      value: i128(5n),
    };
  }

  function server(pages: rpc.Api.EventResponse[][], retention = { oldestLedger: 100, latestLedger: 200 }) {
    const requests: rpc.Api.GetEventsRequest[] = [];
    let page = 0;
    return {
      requests,
      server: {
        getHealth: () => Promise.resolve({ status: "healthy", ledgerRetentionWindow: 100, ...retention }),
        getEvents: (request: rpc.Api.GetEventsRequest) => {
          requests.push(request);
          const events = pages[page++] ?? [];
          return Promise.resolve({
            events,
            cursor: `c${String(page)}`,
            ...retention,
            latestLedgerCloseTime: "",
            oldestLedgerCloseTime: "",
          });
        },
      } as unknown as Pick<rpc.Server, "getEvents" | "getHealth">,
    };
  }

  it("filters by token, sender and ledger range and returns hashes", async () => {
    const { server: rpcServer, requests } = server([
      [eventResponse(120, "a"), eventResponse(121, "b", payer, false), eventResponse(150, "c", payTo)],
    ]);
    const found = await findTransfers(rpcServer, {
      asset: token,
      from: payer,
      startLedger: 110,
      endLedger: 160,
    });
    expect(found).toEqual([
      { contract: token, from: payer, to: payTo, amount: 5n, transaction: "hash-a", ledger: 120 },
    ]);
    expect(requests[0]).toMatchObject({
      startLedger: 110,
      endLedger: 161,
      filters: [{ contractIds: [token] }],
    });
  });

  it("pages with the cursor and stops past the end ledger", async () => {
    const full = Array.from({ length: 200 }, (_, index) => eventResponse(120, `p${String(index)}`));
    const { server: rpcServer, requests } = server([
      full,
      [eventResponse(130, "q"), eventResponse(170, "r")],
    ]);
    const found = await findTransfers(rpcServer, {
      asset: token,
      from: payer,
      startLedger: 110,
      endLedger: 160,
    });
    expect(found === "out_of_range" ? -1 : found.length).toBe(201);
    expect(requests[1]).toMatchObject({ cursor: "c1" });
    expect(requests).toHaveLength(2);
  });

  it("reports a range the RPC cannot prove", async () => {
    const { server: rpcServer, requests } = server([]);
    const query = { asset: token, from: payer };
    expect(await findTransfers(rpcServer, { ...query, startLedger: 99, endLedger: 150 })).toBe(
      "out_of_range",
    );
    // Ledgers the RPC has not ingested yet are asked about again later, never proven absent.
    await expect(findTransfers(rpcServer, { ...query, startLedger: 150, endLedger: 201 })).rejects.toThrow(
      /not ingested ledger 201/,
    );
    expect(requests).toEqual([]);
    await expect(findTransfers(rpcServer, { ...query, startLedger: 150, endLedger: 140 })).rejects.toThrow(
      RangeError,
    );
  });

  it("keeps a muxed payer distinct from its base account", async () => {
    const muxed = new MuxedAccount(new Account(payer, "0"), "3").accountId();
    const { server: rpcServer } = server([[eventResponse(120, "a")]]);
    expect(
      await findTransfers(rpcServer, { asset: token, from: muxed, startLedger: 110, endLedger: 160 }),
    ).toEqual([]);
  });
});
