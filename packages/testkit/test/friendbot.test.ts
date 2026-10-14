import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { LocalNetwork } from "@rail402.dev/testkit";

/** The ledger entry of an existing account, as `getLedgerEntries` returns it. */
function accountEntry(account: Keypair) {
  return {
    key: xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: account.xdrAccountId() })).toXDR(
      "base64",
    ),
    xdr: xdr.LedgerEntryData.account(
      new xdr.AccountEntry({
        accountId: account.xdrAccountId(),
        balance: xdr.Int64.fromString("100000000000"),
        seqNum: xdr.Int64.fromString("1"),
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

/**
 * A stand-in Friendbot answering from a script of statuses, then 200. Its RPC (`/rpc`) knows the
 * accounts in `existing`; without them the "does it exist" check always answers no.
 */
async function fakeFriendbot(statuses: number[], existing: Keypair[] = []) {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    if (request.url === "/rpc") {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        const { id } = JSON.parse(body) as { id: unknown };
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { entries: existing.map(accountEntry), latestLedger: 2 },
          }),
        );
      });
      return;
    }
    requests.push(request.url ?? "");
    const status = statuses.shift() ?? 200;
    response.writeHead(status, { "content-type": "application/json" }).end(`{"status":${String(status)}}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  servers.push(server);
  const origin = `http://127.0.0.1:${String(port)}`;
  return { net: new LocalNetwork(`${origin}/rpc`, `${origin}/`), requests };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("LocalNetwork.fund", () => {
  it("retries a Friendbot that answers 5xx under load", async () => {
    const { net, requests } = await fakeFriendbot([500, 502]);
    await net.fund(Keypair.random());
    expect(requests).toHaveLength(3);
  });

  it("does not retry a 4xx answer", async () => {
    const { net, requests } = await fakeFriendbot([400]);
    await expect(net.fund(Keypair.random())).rejects.toThrow(/^friendbot 400: /);
    expect(requests).toHaveLength(1);
  });

  it("counts an account Friendbot refuses as already funded as funded", async () => {
    const account = Keypair.random();
    const { net, requests } = await fakeFriendbot([400], [account]);
    await net.fund(account);
    expect(requests).toHaveLength(1);
  });

  it("gives up after five 5xx answers", async () => {
    const { net, requests } = await fakeFriendbot([500, 500, 500, 500, 500, 500]);
    await expect(net.fund(Keypair.random())).rejects.toThrow(/^friendbot 500: /);
    expect(requests).toHaveLength(5);
  }, 15_000);
});
