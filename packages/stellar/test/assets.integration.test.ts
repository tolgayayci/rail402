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
import { LocalNetwork, randomContractId, type IssuedAsset } from "@rail402.dev/testkit";

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
