import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { baseAccount } from "./networks.ts";

/** A SEP-41 token as it describes itself on chain. */
export interface AssetFacts {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

/** Trustline flag: the issuer authorized the holder to hold and receive the asset. */
const AUTHORIZED = 1;
const CLASSIC_NAME = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/;

/**
 * Reads Stellar token facts from the network: a token's own symbol, name and decimals, and whether an
 * account can receive it now. Token facts do not change, so they are cached for the process's life.
 */
export class AssetDirectory {
  private readonly server: rpc.Server;
  private readonly passphrase: string;
  private readonly facts = new Map<string, Promise<AssetFacts | undefined>>();

  constructor(server: rpc.Server, passphrase: string) {
    this.server = server;
    this.passphrase = passphrase;
  }

  /** The token's `symbol()`, `name()` and `decimals()`, or undefined if it is not a readable token. */
  describe(contract: string): Promise<AssetFacts | undefined> {
    let known = this.facts.get(contract);
    if (known === undefined) {
      known = this.read(contract).catch(() => undefined);
      this.facts.set(contract, known);
      // A failed read is retried next time rather than cached.
      void known.then((facts) => {
        if (facts === undefined) this.facts.delete(contract);
      });
    }
    return known;
  }

  /**
   * Whether `payTo` can receive the token now. A contract account always can. For a Stellar Asset
   * Contract, a G… or M… account can if it is the issuer or holds an authorized trustline (or, for
   * native XLM, exists). Undefined when it cannot be decided: an unreadable or custom SEP-41 token.
   */
  async receivable(contract: string, payTo: string): Promise<boolean | undefined> {
    if (StrKey.isValidContract(payTo)) return true;
    const account = baseAccount(payTo);
    if (account === undefined) return false;
    const facts = await this.describe(contract);
    if (facts === undefined) return undefined;
    if (facts.name === "native") return (await this.entry(accountKey(account))) !== undefined;
    const classic = CLASSIC_NAME.exec(facts.name);
    if (classic === null) return undefined;
    const [, code = "", issuer = ""] = classic;
    const asset = new Asset(code, issuer);
    // A classic asset's contract address derives from the asset: a mismatch is not this SAC.
    if (asset.contractId(this.passphrase) !== contract) return undefined;
    if (account === issuer) return true;
    const trustline = await this.entry(
      xdr.LedgerKey.trustline(
        new xdr.LedgerKeyTrustLine({
          accountId: Keypair.fromPublicKey(account).xdrAccountId(),
          asset: asset.toTrustLineXDRObject(),
        }),
      ),
    );
    if (trustline === undefined) return false;
    return (trustline.trustLine().flags() & AUTHORIZED) !== 0;
  }

  private async read(contract: string): Promise<AssetFacts | undefined> {
    const [symbol, name, decimals] = await Promise.all([
      this.call(contract, "symbol"),
      this.call(contract, "name"),
      this.call(contract, "decimals"),
    ]);
    if (typeof symbol !== "string" || typeof name !== "string" || typeof decimals !== "number")
      return undefined;
    return { symbol, name, decimals };
  }

  /** Simulates a read-only call; nothing is signed or submitted. */
  private async call(contract: string, method: string): Promise<unknown> {
    const transaction = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
      fee: BASE_FEE,
      networkPassphrase: this.passphrase,
    })
      .addOperation(new Contract(contract).call(method))
      .setTimeout(30)
      .build();
    const simulation = await this.server.simulateTransaction(transaction);
    if (!rpc.Api.isSimulationSuccess(simulation) || simulation.result === undefined) return undefined;
    return scValToNative(simulation.result.retval);
  }

  private async entry(key: xdr.LedgerKey): Promise<xdr.LedgerEntryData | undefined> {
    const { entries } = await this.server.getLedgerEntries(key);
    return entries[0]?.val;
  }
}

function accountKey(account: string): xdr.LedgerKey {
  return xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(account).xdrAccountId() }),
  );
}
