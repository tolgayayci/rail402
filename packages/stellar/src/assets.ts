import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  StrKey,
  TransactionBuilder,
  rpc,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { baseAccount } from "./networks.ts";
import { readContractTtl } from "./ttl.ts";

/**
 * How a token is implemented: a Stellar Asset Contract (`"sac"`, built into the protocol for a
 * classic asset or native XLM) or any other SEP-41 contract (`"sep41"`, running WASM).
 */
export type AssetKind = "sac" | "sep41";

/** What `AssetDirectory.inspect` found at a contract address. */
export type TokenContract =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly kind: AssetKind;
      /** The token's `decimals()`; undefined when the contract does not answer it with a u32. */
      readonly decimals: number | undefined;
    };

/** A SEP-41 token as it describes itself on chain. */
export interface AssetFacts {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

/** An account's holding of a token, as `AssetDirectory.funds` reads it. */
export interface AccountFunds {
  readonly trustline: boolean;
  readonly authorized: boolean;
  /** Base units (stroops for 7-decimal assets). */
  readonly balance: bigint;
  /**
   * What the account can send now, in base units: the balance less selling liabilities (open offers),
   * and for native XLM also less the account's minimum reserve.
   */
  readonly available: bigint;
}

/** Stroops per base reserve: 0.5 XLM, the reserve of the public and test networks. */
export const BASE_RESERVE_STROOPS = 5_000_000n;

/** A trustline's balance less its selling liabilities, never below zero. */
export function availableTrustlineBalance(trustline: xdr.TrustLineEntry): bigint {
  const ext = trustline.ext();
  const selling = ext.switch() === 1 ? ext.v1().liabilities().selling().toBigInt() : 0n;
  return nonNegative(trustline.balance().toBigInt() - selling);
}

/**
 * An account's native balance less its minimum reserve ((2 + subentries + sponsoring − sponsored) base
 * reserves) and its selling liabilities, never below zero.
 */
export function availableNativeBalance(
  account: xdr.AccountEntry,
  baseReserve: bigint = BASE_RESERVE_STROOPS,
): bigint {
  let selling = 0n;
  let sponsoring = 0;
  let sponsored = 0;
  const ext = account.ext();
  if (ext.switch() === 1) {
    const v1 = ext.v1();
    selling = v1.liabilities().selling().toBigInt();
    if (v1.ext().switch() === 2) {
      sponsoring = v1.ext().v2().numSponsoring();
      sponsored = v1.ext().v2().numSponsored();
    }
  }
  const reserve = BigInt(2 + account.numSubEntries() + sponsoring - sponsored) * baseReserve;
  return nonNegative(account.balance().toBigInt() - reserve - selling);
}

function nonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
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
   * What is deployed at `contract`, read now and not cached: whether its instance is live, whether it
   * is a Stellar Asset Contract, and its `decimals()`. `decimals` is undefined only when the answer is
   * definitive: the contract has no `decimals` function, or answers it with something other than a
   * u32. Anything that may pass (an RPC failure, a simulation that fails for another reason, archived
   * state) rejects, so a caller can tell a network it could not read from a contract that is missing
   * or is not a token.
   */
  async inspect(contract: string): Promise<TokenContract> {
    const reading = await readContractTtl(this.server, [contract]);
    const instance = reading.contracts.get(contract);
    if (instance === undefined) return { found: false };
    const answer = await this.probe(contract, "decimals");
    if (answer.kind === "no_instance") return { found: false };
    const decimals = answer.kind === "value" ? answer.value : undefined;
    return {
      found: true,
      kind: instance.kind === "stellar_asset" ? "sac" : "sep41",
      decimals:
        typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 ? decimals : undefined,
    };
  }

  /**
   * The token's `balance(holder)` in base units, read by simulation; undefined when the contract does
   * not answer it with an integer. RPC failures reject.
   */
  async balance(contract: string, holder: string): Promise<bigint | undefined> {
    const balance = await this.call(contract, "balance", nativeToScVal(holder, { type: "address" }));
    return typeof balance === "bigint" ? balance : undefined;
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
    const asset = this.classicAsset(contract, facts);
    if (asset === undefined) return undefined;
    if (account === asset.getIssuer()) return true;
    const trustline = await this.entry(trustlineKey(account, asset));
    if (trustline === undefined) return false;
    return (trustline.trustLine().flags() & AUTHORIZED) !== 0;
  }

  /**
   * What `account` holds of a Stellar Asset Contract token, from one ledger-entry read: whether it
   * has a trustline (for native XLM: whether the account exists), whether the issuer authorized it,
   * the raw balance in base units, and what is available to send (selling liabilities and, for native
   * XLM, the minimum reserve subtracted). Undefined when it
   * cannot be decided cheaply: C… accounts, the issuer itself, and custom SEP-41 tokens.
   */
  async funds(contract: string, account: string): Promise<AccountFunds | undefined> {
    const holder = baseAccount(account);
    if (holder === undefined || !StrKey.isValidEd25519PublicKey(holder)) return undefined;
    const facts = await this.describe(contract);
    if (facts === undefined) return undefined;
    if (facts.name === "native") {
      const entry = await this.entry(accountKey(holder));
      if (entry === undefined) return { trustline: false, authorized: false, balance: 0n, available: 0n };
      const account = entry.account();
      return {
        trustline: true,
        authorized: true,
        balance: account.balance().toBigInt(),
        available: availableNativeBalance(account),
      };
    }
    const asset = this.classicAsset(contract, facts);
    if (asset === undefined || holder === asset.getIssuer()) return undefined;
    const entry = await this.entry(trustlineKey(holder, asset));
    if (entry === undefined) return { trustline: false, authorized: false, balance: 0n, available: 0n };
    const trustline = entry.trustLine();
    return {
      trustline: true,
      authorized: (trustline.flags() & AUTHORIZED) !== 0,
      balance: trustline.balance().toBigInt(),
      available: availableTrustlineBalance(trustline),
    };
  }

  /**
   * The SEP-1 `home_domain` a G… (or M…) account sets on itself, lower-cased; undefined when the
   * account does not exist, sets none, or is a contract (which has no home domain). RPC failures reject.
   */
  async homeDomain(account: string): Promise<string | undefined> {
    const holder = baseAccount(account);
    if (holder === undefined || !StrKey.isValidEd25519PublicKey(holder)) return undefined;
    const entry = await this.entry(accountKey(holder));
    if (entry === undefined) return undefined;
    const value = entry.account().homeDomain();
    const domain = (typeof value === "string" ? value : value.toString("utf8")).trim().toLowerCase();
    return domain === "" ? undefined : domain;
  }

  /** The classic asset behind a Stellar Asset Contract, or undefined for any other token. */
  private classicAsset(contract: string, facts: AssetFacts): Asset | undefined {
    const classic = CLASSIC_NAME.exec(facts.name);
    if (classic === null) return undefined;
    const [, code = "", issuer = ""] = classic;
    const asset = new Asset(code, issuer);
    // A classic asset's contract address derives from the asset: a mismatch is not this SAC.
    return asset.contractId(this.passphrase) === contract ? asset : undefined;
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
  private async call(contract: string, method: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const transaction = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
      fee: BASE_FEE,
      networkPassphrase: this.passphrase,
    })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(30)
      .build();
    const simulation = await this.server.simulateTransaction(transaction);
    if (!rpc.Api.isSimulationSuccess(simulation) || simulation.result === undefined) return undefined;
    return scValToNative(simulation.result.retval);
  }

  /**
   * Simulates a read-only call and says why it failed when that is definitive: the contract has no
   * such function, or no instance. Any other failure rejects with the simulation's error.
   */
  private async probe(contract: string, method: string): Promise<ProbeAnswer> {
    const transaction = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
      fee: BASE_FEE,
      networkPassphrase: this.passphrase,
    })
      .addOperation(new Contract(contract).call(method))
      .setTimeout(30)
      .build();
    const simulation = await this.server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) {
      const failure = definitiveFailure(simulation.error);
      if (failure !== undefined) return { kind: failure };
      throw new Error(`simulating ${method}() failed: ${firstLine(simulation.error)}`);
    }
    // A simulation that would restore archived entries first still reports the call's result.
    if (simulation.result === undefined) throw new Error(`simulating ${method}() returned no result`);
    return { kind: "value", value: scValToNative(simulation.result.retval) };
  }

  private async entry(key: xdr.LedgerKey): Promise<xdr.LedgerEntryData | undefined> {
    const { entries } = await this.server.getLedgerEntries(key);
    return entries[0]?.val;
  }
}

type ProbeAnswer =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "missing_function" }
  | { readonly kind: "no_instance" };

/**
 * The host errors that settle what a contract is. A WASM contract without the function traps with
 * `Error(WasmVm, MissingValue)` "trying to invoke non-existent contract function"; a Stellar Asset
 * Contract rejects an unknown function with `Error(Value, InvalidInput)` "symbol not found in slice of
 * strs"; an address without an instance fails with `Error(Storage, MissingValue)` "trying to get
 * non-existing value for contract instance". Every other failure may pass on a later attempt.
 */
function definitiveFailure(error: string): "missing_function" | "no_instance" | undefined {
  if (error.includes("Error(WasmVm, MissingValue)") && error.includes("non-existent contract function")) {
    return "missing_function";
  }
  if (error.includes("Error(Value, InvalidInput)") && error.includes("symbol not found in slice of strs")) {
    return "missing_function";
  }
  if (
    error.includes("Error(Storage, MissingValue)") &&
    error.includes("non-existing value for contract instance")
  ) {
    return "no_instance";
  }
  return undefined;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? text;
  return line.length <= 200 ? line : `${line.slice(0, 199)}…`;
}

function trustlineKey(account: string, asset: Asset): xdr.LedgerKey {
  return xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: Keypair.fromPublicKey(account).xdrAccountId(),
      asset: asset.toTrustLineXDRObject(),
    }),
  );
}

function accountKey(account: string): xdr.LedgerKey {
  return xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(account).xdrAccountId() }),
  );
}
