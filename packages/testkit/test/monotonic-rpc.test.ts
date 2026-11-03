import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { BadSequenceError, LocalNetwork } from "@rail402.dev/testkit";

/** One RPC node's view: the ledger it has reached and the account's sequence number there. */
interface NodeView {
  readonly latestLedger: number;
  readonly sequence: string;
}

/** The ledger entry of `account` at `sequence`, as `getLedgerEntries` returns it. */
function accountEntry(account: Keypair, sequence: string) {
  return {
    key: xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: account.xdrAccountId() })).toXDR(
      "base64",
    ),
    xdr: xdr.LedgerEntryData.account(
      new xdr.AccountEntry({
        accountId: account.xdrAccountId(),
        balance: xdr.Int64.fromString("100000000000"),
        seqNum: xdr.Int64.fromString(sequence),
        numSubEntries: 0,
        inflationDest: null,
        flags: 0,
        homeDomain: "",
        thresholds: Buffer.from([1, 0, 0, 0]),
        signers: [],
        ext: new xdr.AccountEntryExt(0),
      }),
    ).toXDR("base64"),
    lastModifiedLedgerSeq: 1,
  };
}

/** A transaction result with `code`, as an ERROR answer of `sendTransaction` carries it. */
function errorResult(code: "txBadSeq" | "txBadAuth"): string {
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("0"),
    result: xdr.TransactionResultResult[code](),
    ext: new xdr.TransactionResultExt(0),
  }).toXDR("base64");
}

/**
 * A stand-in RPC endpoint served by several nodes: each read is answered by the next view in `views`
 * (the last one repeats); `sendTransaction` answers ERROR with the next code in `sends`.
 */
async function fakeRpc(account: Keypair, views: NodeView[], sends: ("txBadSeq" | "txBadAuth")[] = []) {
  const reads: number[] = [];
  const sent: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      const { id, method, params } = JSON.parse(body) as {
        id: unknown;
        method: string;
        params: { transaction?: string };
      };
      const view = views.length > 1 ? (views.shift() as NodeView) : (views[0] as NodeView);
      let result: unknown;
      if (method === "sendTransaction") {
        const envelope = TransactionBuilder.fromXDR(
          params.transaction ?? "",
          "Test SDF Network ; September 2015",
        );
        sent.push("sequence" in envelope ? envelope.sequence : "");
        result = {
          status: "ERROR",
          hash: "00".repeat(32),
          latestLedger: view.latestLedger,
          errorResultXdr: errorResult(sends.shift() ?? "txBadAuth"),
        };
      } else if (method === "getTransaction") {
        reads.push(view.latestLedger);
        result = {
          status: "NOT_FOUND",
          latestLedger: view.latestLedger,
          latestLedgerCloseTime: "0",
          oldestLedger: 1,
          oldestLedgerCloseTime: "0",
        };
      } else {
        reads.push(view.latestLedger);
        result = { entries: [accountEntry(account, view.sequence)], latestLedger: view.latestLedger };
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  servers.push(server);
  const origin = `http://127.0.0.1:${String(port)}`;
  return { net: new LocalNetwork(`${origin}/rpc`, `${origin}/friendbot`), reads, sent };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("MonotonicRpcServer", () => {
  it("asks again while the answering node is behind a ledger already seen", async () => {
    const account = Keypair.random();
    const { net, reads } = await fakeRpc(account, [
      { latestLedger: 10, sequence: "5" },
      { latestLedger: 8, sequence: "4" },
      { latestLedger: 9, sequence: "4" },
      { latestLedger: 10, sequence: "5" },
    ]);
    expect((await net.server.getAccount(account.publicKey())).sequenceNumber()).toBe("5");
    expect((await net.server.getAccount(account.publicKey())).sequenceNumber()).toBe("5");
    expect(reads).toEqual([10, 8, 9, 10]);
    expect(net.server.seenLedger).toBe(10);
  });

  it("takes NOT_FOUND as an answer only from a node that has reached the ledgers seen", async () => {
    const account = Keypair.random();
    const { net, reads } = await fakeRpc(account, [
      { latestLedger: 7, sequence: "1" },
      { latestLedger: 6, sequence: "1" },
      { latestLedger: 7, sequence: "1" },
    ]);
    net.server.observe(7);
    const response = await net.server.getTransaction("00".repeat(32));
    expect(response.status).toBe("NOT_FOUND");
    expect(reads).toEqual([7]);
    await net.server.getTransaction("00".repeat(32));
    expect(reads).toEqual([7, 6, 7]);
  });
});

describe("LocalNetwork.classic", () => {
  const payment = (to: Keypair) =>
    Operation.createAccount({ destination: to.publicKey(), startingBalance: "1" });

  it("builds a transaction refused with txBadSeq again from a fresh sequence number", async () => {
    const source = Keypair.random();
    const { net, sent } = await fakeRpc(
      source,
      [
        { latestLedger: 20, sequence: "40" },
        { latestLedger: 20, sequence: "40" },
        { latestLedger: 21, sequence: "41" },
      ],
      ["txBadSeq", "txBadAuth"],
    );
    await expect(net.classic(source, [payment(Keypair.random())])).rejects.toThrow(
      "sendTransaction ERROR: txBadAuth",
    );
    expect(sent).toEqual(["41", "42"]);
  });

  it("gives up after a few txBadSeq refusals", async () => {
    const source = Keypair.random();
    const { net, sent } = await fakeRpc(
      source,
      [{ latestLedger: 30, sequence: "7" }],
      ["txBadSeq", "txBadSeq", "txBadSeq", "txBadSeq"],
    );
    await expect(net.classic(source, [payment(Keypair.random())])).rejects.toBeInstanceOf(BadSequenceError);
    expect(sent).toHaveLength(3);
  }, 15_000);
});
