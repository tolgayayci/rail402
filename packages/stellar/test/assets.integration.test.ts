/**
 * Token facts and receivability read from the private Stellar network (docker compose --profile
 * stellar up -d): a real Stellar Asset Contract, real trustlines and a real authorization flag.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  Asset,
  AuthRequiredFlag,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { AssetDirectory } from "@rail402.dev/stellar";
import { LocalNetwork, deployUpto, randomContractId, type IssuedAsset } from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("AssetDirectory", () => {
  let usdc: IssuedAsset;
  let directory: AssetDirectory;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    directory = new AssetDirectory(net.server, net.passphrase);
  });

  it("reads a token's symbol, name and decimals from the token itself", async () => {
    expect(await directory.describe(usdc.sac)).toEqual({
      symbol: "USDC",
      name: `USDC:${usdc.issuer.publicKey()}`,
      decimals: 7,
    });
    expect(await directory.describe(randomContractId())).toBeUndefined();
  });

  it("inspects what a contract is: a token with its decimals, a contract that is not one, or nothing", async () => {
    expect(await directory.inspect(usdc.sac)).toEqual({ found: true, kind: "sac", decimals: 7 });
    // The upto settlement contract has no decimals(): definitive, not an error to retry.
    const settlement = await deployUpto(net);
    expect(await directory.inspect(settlement.address)).toEqual({
      found: true,
      kind: "sep41",
      decimals: undefined,
    });
    expect(await directory.inspect(randomContractId())).toEqual({ found: false });
  });

  it("knows who can receive a Stellar Asset Contract token", async () => {
    const holder = await net.holder(usdc, "1");
    const stranger = Keypair.random();
    await net.fund(stranger);
    expect(await directory.receivable(usdc.sac, holder.publicKey())).toBe(true);
    expect(await directory.receivable(usdc.sac, stranger.publicKey())).toBe(false);
    expect(await directory.receivable(usdc.sac, usdc.issuer.publicKey())).toBe(true);
    // Contract accounts hold token balances without trustlines.
    expect(await directory.receivable(usdc.sac, randomContractId())).toBe(true);
  });

  it("requires the trustline to be authorized when the issuer demands it", async () => {
    const issuer = Keypair.random();
    await net.fund(issuer);
    await net.classic(issuer, [Operation.setOptions({ setFlags: AuthRequiredFlag })]);
    const asset = new Asset("EURT", issuer.publicKey());
    const issued: IssuedAsset = { asset, issuer, sac: asset.contractId(net.passphrase) };
    await deploySac(issued);
    const holder = Keypair.random();
    await net.fund(holder);
    await net.trust(holder, issued);
    expect(await directory.receivable(issued.sac, holder.publicKey())).toBe(false);
    await net.classic(issuer, [
      Operation.setTrustLineFlags({ trustor: holder.publicKey(), asset, flags: { authorized: true } }),
    ]);
    expect(await directory.receivable(issued.sac, holder.publicKey())).toBe(true);
  });

  it("knows who can receive native XLM", async () => {
    const native = Asset.native().contractId(net.passphrase);
    // Public networks have the native token contract; a fresh private network deploys it on demand.
    if ((await directory.describe(native)) === undefined) {
      const deployer = Keypair.random();
      await net.fund(deployer);
      await deploySac({ asset: Asset.native(), issuer: deployer, sac: native });
    }
    expect(await directory.describe(native)).toMatchObject({ name: "native", decimals: 7 });
    const account = Keypair.random();
    await net.fund(account);
    expect(await directory.receivable(native, account.publicKey())).toBe(true);
    expect(await directory.receivable(native, Keypair.random().publicKey())).toBe(false);
    const funds = await directory.funds(native, account.publicKey());
    expect(funds).toMatchObject({ trustline: true, authorized: true });
    expect(funds?.balance).toBe(await net.nativeBalance(account.publicKey()));
    // The two base reserves of a plain account are not available to send.
    expect(funds?.available).toBe((funds?.balance ?? 0n) - 10_000_000n);
    expect(await directory.funds(native, Keypair.random().publicKey())).toEqual({
      trustline: false,
      authorized: false,
      balance: 0n,
      available: 0n,
    });
  });

  it("reads what an account holds of a Stellar Asset Contract token", async () => {
    const holder = await net.holder(usdc, "2.5");
    const stranger = Keypair.random();
    await net.fund(stranger);
    expect(await directory.funds(usdc.sac, holder.publicKey())).toEqual({
      trustline: true,
      authorized: true,
      balance: 25_000_000n,
      available: 25_000_000n,
    });
    expect(await directory.funds(usdc.sac, stranger.publicKey())).toEqual({
      trustline: false,
      authorized: false,
      balance: 0n,
      available: 0n,
    });
    // Not decidable from one ledger entry: the issuer, contract accounts and non-tokens.
    expect(await directory.funds(usdc.sac, usdc.issuer.publicKey())).toBeUndefined();
    expect(await directory.funds(usdc.sac, randomContractId())).toBeUndefined();
    expect(await directory.funds(randomContractId(), holder.publicKey())).toBeUndefined();
  });

  it("reports an unauthorized trustline", async () => {
    const issuer = Keypair.random();
    await net.fund(issuer);
    await net.classic(issuer, [Operation.setOptions({ setFlags: AuthRequiredFlag })]);
    const asset = new Asset("GBPT", issuer.publicKey());
    const issued: IssuedAsset = { asset, issuer, sac: asset.contractId(net.passphrase) };
    await deploySac(issued);
    const holder = Keypair.random();
    await net.fund(holder);
    await net.trust(holder, issued);
    expect(await directory.funds(issued.sac, holder.publicKey())).toEqual({
      trustline: true,
      authorized: false,
      balance: 0n,
      available: 0n,
    });
  });

  it("holds back what open offers sell", async () => {
    const holder = await net.holder(usdc, "2.5");
    await net.classic(holder, [
      Operation.manageSellOffer({ selling: usdc.asset, buying: Asset.native(), amount: "1", price: "1000" }),
    ]);
    expect(await directory.funds(usdc.sac, holder.publicKey())).toMatchObject({
      balance: 25_000_000n,
      available: 15_000_000n,
    });
  });

  it("reads an account's home domain", async () => {
    const account = Keypair.random();
    await net.fund(account);
    expect(await directory.homeDomain(account.publicKey())).toBeUndefined();
    await net.classic(account, [Operation.setOptions({ homeDomain: "Pay.Example.com" })]);
    expect(await directory.homeDomain(account.publicKey())).toBe("pay.example.com");
    expect(await directory.homeDomain(randomContractId())).toBeUndefined();
    expect(await directory.homeDomain(Keypair.random().publicKey())).toBeUndefined();
  });

  it("cannot decide for a contract that is not a readable token", async () => {
    expect(await directory.receivable(randomContractId(), Keypair.random().publicKey())).toBeUndefined();
  });

  async function deploySac(issued: IssuedAsset) {
    const source = await net.server.getAccount(issued.issuer.publicKey());
    const deploy = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: net.passphrase })
      .addOperation(Operation.createStellarAssetContract({ asset: issued.asset }))
      .setTimeout(60)
      .build();
    const prepared = await net.server.prepareTransaction(deploy);
    prepared.sign(issued.issuer);
    await net.submit(prepared);
  }
});
