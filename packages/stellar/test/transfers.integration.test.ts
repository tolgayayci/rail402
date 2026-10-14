/**
 * Transfer events of real Stellar Asset Contract transfers on the private Stellar network
 * (docker compose --profile stellar up -d): read from the transaction meta and found again through
 * the RPC's event store.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  Account,
  BASE_FEE,
  Contract,
  type Keypair,
  MuxedAccount,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { findTransfers, sacTransferEvents } from "@rail402.dev/stellar";
import { LocalNetwork, type IssuedAsset } from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("transfer events", () => {
  let usdc: IssuedAsset;
  let payer: Keypair;
  let payTo: Keypair;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    [payer, payTo] = (await net.holders(usdc, 2, "10")) as [Keypair, Keypair];
  });

  async function transfer(to: string, amount: bigint) {
    const source = await net.server.getAccount(payer.publicKey());
    const built = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: net.passphrase })
      .addOperation(
        new Contract(usdc.sac).call(
          "transfer",
          nativeToScVal(payer.publicKey(), { type: "address" }),
          nativeToScVal(to, { type: "address" }),
          nativeToScVal(amount, { type: "i128" }),
        ),
      )
      .setTimeout(60)
      .build();
    const prepared = await net.server.prepareTransaction(built);
    prepared.sign(payer);
    const sent = await net.server.sendTransaction(prepared);
    const result = await net.server.pollTransaction(sent.hash, { attempts: 30 });
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(result.status);
    return { hash: sent.hash, result };
  }

  it("reads the transfer from the transaction meta, including a muxed destination", async () => {
    const plain = await transfer(payTo.publicKey(), 1_234_567n);
    expect(sacTransferEvents(plain.result)).toEqual([
      { contract: usdc.sac, from: payer.publicKey(), to: payTo.publicKey(), amount: 1_234_567n },
    ]);

    const muxed = new MuxedAccount(new Account(payTo.publicKey(), "0"), "77").accountId();
    const toMuxed = await transfer(muxed, 5n);
    expect(sacTransferEvents(toMuxed.result)).toEqual([
      { contract: usdc.sac, from: payer.publicKey(), to: payTo.publicKey(), amount: 5n, toMuxedId: 77n },
    ]);
  });

  it("finds a sender's transfers in a ledger range, and proves their absence elsewhere", async () => {
    const { hash, result } = await transfer(payTo.publicKey(), 42n);
    await waitForLedger(result.ledger);
    const found = await findTransfers(net.server, {
      asset: usdc.sac,
      from: payer.publicKey(),
      startLedger: result.ledger,
      endLedger: result.ledger,
    });
    expect(found).toEqual([
      {
        contract: usdc.sac,
        from: payer.publicKey(),
        to: payTo.publicKey(),
        amount: 42n,
        transaction: hash,
        ledger: result.ledger,
      },
    ]);
    expect(
      await findTransfers(net.server, {
        asset: usdc.sac,
        from: payTo.publicKey(),
        startLedger: result.ledger,
        endLedger: result.ledger,
      }),
    ).toEqual([]);
    await expect(
      findTransfers(net.server, {
        asset: usdc.sac,
        from: payer.publicKey(),
        startLedger: result.ledger,
        endLedger: result.ledger + 10_000,
      }),
    ).rejects.toThrow(/not ingested/);
  });

  async function waitForLedger(ledger: number) {
    for (let attempt = 0; attempt < 30 && (await net.latestLedger()) < ledger; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
});
