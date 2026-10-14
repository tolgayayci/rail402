/**
 * Onboarding builds only its own transactions, has them signed for the account's own key, and
 * reports each failure with its account code; the setup signer refuses every other transaction.
 */
import { describe, expect, it } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  KeyHolder,
  accountState,
  addTrustline,
  buyAsset,
  classicAssetFor,
  feePerOperation,
  fundWithFriendbot,
  keySetupSigner,
  resultCode,
  submitClassic,
  type AccountChain,
  type SetupSigner,
} from "@rail402.dev/sdk";

const passphrase = Networks.TESTNET;
const issuer = Keypair.random().publicKey();
const usdc = new Asset("USDC", issuer);
const HASH = "c".repeat(64);

interface FakeServerOptions {
  readonly balance?: bigint | undefined;
  readonly p90?: string;
  readonly send?: Partial<rpc.Api.SendTransactionResponse>;
  readonly final?: Partial<rpc.Api.GetTransactionResponse>;
}

/** An RPC that holds one account and records what is submitted. */
function fakeChain(address: string, options: FakeServerOptions = {}) {
  const sent: Transaction[] = [];
  const balance = "balance" in options ? options.balance : 10_000n * 10_000_000n;
  const server = {
    getLedgerEntries: () =>
      Promise.resolve({
        entries:
          balance === undefined
            ? []
            : [{ val: { account: () => ({ balance: () => ({ toBigInt: () => balance }) }) } }],
      }),
    getAccount: (id: string) => Promise.resolve(new Account(id, "41")),
    getFeeStats: () => Promise.resolve({ inclusionFee: { p90: options.p90 ?? "250" } }),
    sendTransaction: (transaction: Transaction) => {
      sent.push(transaction);
      return Promise.resolve({ status: "PENDING", hash: HASH, ...options.send });
    },
    pollTransaction: () =>
      Promise.resolve({ status: rpc.Api.GetTransactionStatus.SUCCESS, ...options.final }),
  } as unknown as rpc.Server;
  const chain: AccountChain = { server, passphrase };
  return { chain, sent };
}

function failedResult(code: "changeTrustLowReserve" | "pathPaymentStrictReceiveTooFewOffers") {
  const tr =
    code === "changeTrustLowReserve"
      ? xdr.OperationResultTr.changeTrust(xdr.ChangeTrustResult.changeTrustLowReserve())
      : xdr.OperationResultTr.pathPaymentStrictReceive(
          xdr.PathPaymentStrictReceiveResult.pathPaymentStrictReceiveTooFewOffers(),
        );
  return new xdr.TransactionResult({
    feeCharged: xdr.Int64.fromString("100"),
    result: xdr.TransactionResultResult.txFailed([xdr.OperationResult.opInner(tr)]),
    ext: new xdr.TransactionResultExt(0),
  });
}

function signedBy(transaction: Transaction, key: Keypair): boolean {
  return transaction.signatures.some((signature) => key.verify(transaction.hash(), signature.signature()));
}

describe("account onboarding", () => {
  it("reads whether the account exists and its XLM", async () => {
    const address = Keypair.random().publicKey();
    await expect(accountState(fakeChain(address).chain, address)).resolves.toEqual({
      address,
      exists: true,
      xlm: 100_000_000_000n,
    });
    await expect(accountState(fakeChain(address, { balance: undefined }).chain, address)).resolves.toEqual({
      address,
      exists: false,
      xlm: null,
    });
    const broken = { server: { getLedgerEntries: () => Promise.reject(new Error("down")) }, passphrase };
    await expect(accountState(broken as unknown as AccountChain, address)).rejects.toMatchObject({
      code: "rpc_unavailable",
    });
  });

  it("asks Friendbot without following redirects and reports its refusals", async () => {
    const address = Keypair.random().publicKey();
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const ok: typeof fetch = (url, init) => {
      calls.push({ url: url instanceof Request ? url.url : url.toString(), init });
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    expect(
      await fundWithFriendbot({ friendbotUrl: "https://friendbot.example", fetch: ok }, address),
    ).toBeUndefined();
    expect(calls[0]?.url).toBe(`https://friendbot.example?addr=${address}`);
    expect(calls[0]?.init?.redirect).toBe("error");

    // The funding transaction, when the answer names it; anything else is not a hash.
    const hash = "ab".repeat(32);
    const answering =
      (body: string): typeof fetch =>
      () =>
        Promise.resolve(new Response(body, { status: 200 }));
    const fund = (body: string) =>
      fundWithFriendbot({ friendbotUrl: "https://friendbot.example", fetch: answering(body) }, address);
    expect(await fund(JSON.stringify({ successful: true, hash }))).toBe(hash);
    expect(await fund(JSON.stringify({ hash: "not a hash" }))).toBeUndefined();
    expect(await fund("not json")).toBeUndefined();
    expect(await fund("null")).toBeUndefined();
    expect(await fund(JSON.stringify({ hash, padding: "x".repeat(70_000) }))).toBeUndefined();

    const refusing: typeof fetch = () => Promise.resolve(new Response("no", { status: 400 }));
    await expect(
      fundWithFriendbot({ friendbotUrl: "https://friendbot.example", fetch: refusing }, address),
    ).rejects.toMatchObject({ code: "account_friendbot_failed", details: { status: 400 } });
    const down: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
    await expect(
      fundWithFriendbot({ friendbotUrl: "https://friendbot.example", fetch: down }, address),
    ).rejects.toMatchObject({ code: "account_friendbot_failed" });
    await expect(
      fundWithFriendbot({ friendbotUrl: "https://friendbot.example", fetch: ok }, "GNOTANACCOUNT"),
    ).rejects.toMatchObject({ code: "account_friendbot_failed" });

    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const aborting: typeof fetch = (_url, init) => Promise.reject(init?.signal?.reason as Error);
    await expect(
      fundWithFriendbot(
        { friendbotUrl: "https://friendbot.example", fetch: aborting, signal: controller.signal },
        address,
      ),
    ).rejects.toThrow("stopped");
  });

  const scope = { asset: usdc, maxBuy: "1" };

  it("finds the classic asset behind a token contract", () => {
    const name = `USDC:${issuer}`;
    expect(classicAssetFor(name, usdc.contractId(passphrase), passphrase)?.equals(usdc)).toBe(true);
    expect(classicAssetFor(name, usdc.contractId(Networks.PUBLIC), passphrase)).toBeUndefined();
    expect(classicAssetFor("native", usdc.contractId(passphrase), passphrase)).toBeUndefined();
  });

  it("adds a trustline with one changeTrust from the account, signed by its key", async () => {
    const key = KeyHolder.random();
    const { chain, sent } = fakeChain(key.address);
    await expect(addTrustline(chain, keySetupSigner(key, passphrase, scope), usdc)).resolves.toBe(HASH);
    const [transaction] = sent;
    expect(transaction?.source).toBe(key.address);
    expect(transaction?.operations).toMatchObject([{ type: "changeTrust" }]);
    expect(transaction?.fee).toBe("250");
    expect(signedBy(transaction as Transaction, Keypair.fromPublicKey(key.address))).toBe(true);
    await expect(
      addTrustline(chain, keySetupSigner(key, passphrase, scope), Asset.native()),
    ).rejects.toMatchObject({
      code: "account_trustline_failed",
    });
  });

  it("buys the asset with XLM paid to the account itself, keeping the reserve", async () => {
    const key = KeyHolder.random();
    const { chain, sent } = fakeChain(key.address, { balance: 10_000n * 10_000_000n });
    await expect(
      buyAsset(chain, keySetupSigner(key, passphrase, scope), { asset: usdc, amount: "1" }),
    ).resolves.toBe(HASH);
    expect(sent[0]?.operations).toMatchObject([
      {
        type: "pathPaymentStrictReceive",
        sendMax: "9990.0000000",
        destination: key.address,
        destAmount: "1.0000000",
        path: [],
      },
    ]);

    const poor = fakeChain(key.address, { balance: 10n * 10_000_000n });
    await expect(
      buyAsset(poor.chain, keySetupSigner(key, passphrase, scope), { asset: usdc, amount: "1" }),
    ).rejects.toMatchObject({ code: "account_funding_failed" });
    expect(poor.sent).toEqual([]);
    const missing = fakeChain(key.address, { balance: undefined });
    await expect(
      buyAsset(missing.chain, keySetupSigner(key, passphrase, scope), { asset: usdc, amount: "1" }),
    ).rejects.toMatchObject({ code: "account_not_found" });
  });

  it("reports a refused or failed transaction with its result code", async () => {
    const key = KeyHolder.random();
    const signer = keySetupSigner(key, passphrase, scope);
    const refused = fakeChain(key.address, {
      send: { status: "ERROR", errorResult: failedResult("changeTrustLowReserve") },
    });
    await expect(addTrustline(refused.chain, signer, usdc)).rejects.toMatchObject({
      code: "account_trustline_failed",
      details: { result: "changeTrustLowReserve" },
    });
    const failed = fakeChain(key.address, {
      final: {
        status: rpc.Api.GetTransactionStatus.FAILED,
        resultXdr: failedResult("pathPaymentStrictReceiveTooFewOffers"),
      } as Partial<rpc.Api.GetTransactionResponse>,
    });
    await expect(buyAsset(failed.chain, signer, { asset: usdc, amount: "1" })).rejects.toMatchObject({
      code: "account_funding_failed",
      details: { status: "FAILED", result: "pathPaymentStrictReceiveTooFewOffers" },
    });
    const busy = fakeChain(key.address, { send: { status: "TRY_AGAIN_LATER" } });
    await expect(addTrustline(busy.chain, signer, usdc)).rejects.toMatchObject({ code: "rpc_unavailable" });
  });

  it("refuses an envelope the signer changed or did not sign with the account's key", async () => {
    const key = KeyHolder.random();
    const { chain, sent } = fakeChain(key.address);
    const other = Keypair.random();
    const changed: SetupSigner = {
      address: key.address,
      signTransaction: (envelope) => {
        const original = TransactionBuilder.fromXDR(envelope, passphrase) as Transaction;
        const swapped = new TransactionBuilder(new Account(key.address, "41"), {
          fee: original.fee,
          networkPassphrase: passphrase,
        })
          .addOperation(
            Operation.payment({ destination: other.publicKey(), asset: Asset.native(), amount: "1" }),
          )
          .setTimeout(60)
          .build();
        swapped.sign(Keypair.fromSecret(key.exportSecret()));
        return Promise.resolve({ signedTxXdr: swapped.toXDR() });
      },
    };
    await expect(addTrustline(chain, changed, usdc)).rejects.toMatchObject({
      code: "account_trustline_failed",
      reason: "The signer returned a different transaction.",
    });
    const wrongKey: SetupSigner = {
      address: key.address,
      signTransaction: (envelope) => {
        const transaction = TransactionBuilder.fromXDR(envelope, passphrase) as Transaction;
        transaction.sign(other);
        return Promise.resolve({ signedTxXdr: transaction.toXDR() });
      },
    };
    await expect(addTrustline(chain, wrongKey, usdc)).rejects.toMatchObject({
      code: "account_trustline_failed",
      reason: "The transaction carries no valid signature of the account's key.",
    });
    const declining: SetupSigner = {
      address: key.address,
      signTransaction: () => Promise.reject(new Error("user declined")),
    };
    await expect(addTrustline(chain, declining, usdc)).rejects.toMatchObject({
      code: "account_trustline_failed",
    });
    expect(sent).toEqual([]);
  });

  it("has a key setup signer that signs nothing but onboarding transactions", async () => {
    const key = KeyHolder.random();
    const signer = keySetupSigner(key, passphrase, scope);
    const build = (
      operation: xdr.Operation,
      source = key.address,
      fee = "100",
      more: xdr.Operation[] = [],
    ) => {
      const builder = new TransactionBuilder(new Account(source, "1"), { fee, networkPassphrase: passphrase })
        .addOperation(operation)
        .setTimeout(60);
      for (const extra of more) builder.addOperation(extra);
      return builder.build().toXDR();
    };
    const buy = (overrides: Partial<Parameters<typeof Operation.pathPaymentStrictReceive>[0]> = {}) =>
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: "10",
        destination: key.address,
        destAsset: usdc,
        destAmount: "1",
        path: [],
        ...overrides,
      });
    const other = Keypair.random().publicKey();
    const refused = [
      build(Operation.payment({ destination: other, asset: Asset.native(), amount: "1" })),
      build(Operation.changeTrust({ asset: usdc }), other),
      build(Operation.changeTrust({ asset: usdc, source: other })),
      build(
        Operation.pathPaymentStrictReceive({
          sendAsset: Asset.native(),
          sendMax: "10",
          destination: other,
          destAsset: usdc,
          destAmount: "1",
          path: [],
        }),
      ),
      build(Operation.setOptions({ masterWeight: 0 })),
      // Another asset's trustline, a trustline removed or capped, more than one operation, a high fee.
      build(Operation.changeTrust({ asset: new Asset("EURC", issuer) })),
      build(Operation.changeTrust({ asset: usdc, limit: "0" })),
      build(Operation.changeTrust({ asset: usdc, limit: "5" })),
      build(Operation.changeTrust({ asset: usdc }), key.address, "100", [
        Operation.changeTrust({ asset: usdc }),
      ]),
      build(Operation.changeTrust({ asset: usdc }), key.address, "10000000"),
      // A purchase of another asset, of more than allowed, or through a path.
      build(buy({ destAsset: new Asset("EURC", issuer) })),
      build(buy({ destAmount: "1.0000001" })),
      build(buy({ path: [new Asset("EURC", issuer)] })),
      "not xdr",
    ];
    for (const envelope of refused) {
      await expect(signer.signTransaction(envelope, { networkPassphrase: passphrase })).rejects.toMatchObject(
        {
          code: "payment_signing_failed",
        },
      );
    }
    const trust = build(Operation.changeTrust({ asset: usdc }));
    await expect(signer.signTransaction(trust, { networkPassphrase: Networks.PUBLIC })).rejects.toMatchObject(
      { code: "payment_signing_failed" },
    );
    for (const envelope of [trust, build(buy()), build(buy({ destAmount: "0.5" }))]) {
      const { signedTxXdr } = await signer.signTransaction(envelope, { networkPassphrase: passphrase });
      const signed = TransactionBuilder.fromXDR(signedTxXdr, passphrase) as Transaction;
      expect(signedBy(signed, Keypair.fromPublicKey(key.address))).toBe(true);
    }
    // Without a purchase bound, no purchase is signed.
    await expect(
      keySetupSigner(key, passphrase, { asset: usdc }).signTransaction(build(buy()), {
        networkPassphrase: passphrase,
      }),
    ).rejects.toMatchObject({ code: "payment_signing_failed" });
  });

  it("bids the network's recent fee within bounds", async () => {
    const address = Keypair.random().publicKey();
    await expect(feePerOperation(fakeChain(address, { p90: "50" }).chain.server)).resolves.toBe(100);
    await expect(feePerOperation(fakeChain(address, { p90: "5000000" }).chain.server)).resolves.toBe(100_000);
    await expect(feePerOperation(fakeChain(address, { p90: "x" }).chain.server)).resolves.toBe(1_000);
    const key = KeyHolder.random();
    const { chain, sent } = fakeChain(key.address, { p90: "300" });
    const signsAnything: SetupSigner = {
      address: key.address,
      signTransaction: (envelope) => {
        const transaction = TransactionBuilder.fromXDR(envelope, passphrase) as Transaction;
        transaction.sign(Keypair.fromSecret(key.exportSecret()));
        return Promise.resolve({ signedTxXdr: transaction.toXDR() });
      },
    };
    await submitClassic(
      chain,
      signsAnything,
      [Operation.changeTrust({ asset: usdc }), Operation.changeTrust({ asset: new Asset("EURC", issuer) })],
      "account_trustline_failed",
    );
    expect(sent[0]?.fee).toBe("600");
    expect(resultCode(undefined)).toBeUndefined();
    expect(resultCode(failedResult("changeTrustLowReserve"))).toBe("changeTrustLowReserve");
  });
});
