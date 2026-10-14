import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  hash,
  nativeToScVal,
  type rpc,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
import type { IssuedAsset, LocalNetwork } from "./network.ts";
import { mintTo } from "./smart-account.ts";

/** The SEP-41 test token (`contracts/testing/test-token`), as committed next to its provenance record. */
export const TEST_TOKEN_WASM = readFileSync(new URL("../fixtures/test_token.wasm", import.meta.url));

/** A test token deployed on a local network. */
export interface TestToken {
  /** Contract address (`C…`). */
  readonly contract: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  /**
   * A funded account that submits faucet and mint calls. It authorizes nothing: the token's faucet is
   * open, so it only pays the transaction fees.
   */
  readonly minter: Keypair;
}

export interface TokenOptions {
  readonly symbol: string;
  readonly decimals: number;
  /** Defaults to "Rail402 Test Token (<decimals> decimals)". */
  readonly name?: string;
}

/**
 * Deploys the test token with the given decimals (0 to 18) from the committed WASM: uploads the code,
 * creates an instance with a random salt and runs its constructor. A fresh Friendbot account deploys
 * it and stays on as the token's minter.
 */
export async function deployToken(net: LocalNetwork, options: TokenOptions): Promise<TestToken> {
  const minter = Keypair.random();
  await net.fund(minter);
  const name = options.name ?? `Rail402 Test Token (${String(options.decimals)} decimals)`;
  await submitOperation(net, minter, Operation.uploadContractWasm({ wasm: TEST_TOKEN_WASM }));
  const created = await submitOperation(
    net,
    minter,
    Operation.createCustomContract({
      address: Address.fromString(minter.publicKey()),
      wasmHash: hash(TEST_TOKEN_WASM),
      salt: randomBytes(32),
      constructorArgs: [
        nativeToScVal(name, { type: "string" }),
        nativeToScVal(options.symbol, { type: "string" }),
        nativeToScVal(options.decimals, { type: "u32" }),
      ],
    }),
  );
  if (created.returnValue === undefined) throw new Error("token creation returned no address");
  return {
    contract: Address.fromScVal(created.returnValue).toString(),
    name,
    symbol: options.symbol,
    decimals: options.decimals,
    minter,
  };
}

/** Mints 100 whole tokens to `to` (a G… or C… address; no trustline exists or is needed) and returns the base units minted. */
export async function faucet(net: LocalNetwork, token: TestToken, to: string): Promise<bigint> {
  const result = await submitOperation(
    net,
    token.minter,
    new Contract(token.contract).call("faucet", nativeToScVal(to, { type: "address" })),
  );
  return result.returnValue === undefined ? 0n : (scValToNative(result.returnValue) as bigint);
}

/** Mints exactly `amount` base units of a test token to `to` (at most 1,000,000 whole tokens per call). */
export async function mintToken(
  net: LocalNetwork,
  token: TestToken,
  to: string,
  amount: bigint,
): Promise<void> {
  await submitOperation(
    net,
    token.minter,
    new Contract(token.contract).call(
      "mint_test",
      nativeToScVal(to, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ),
  );
}

/**
 * An asset a test can pay in, whatever it is: a classic asset through its Stellar Asset Contract, or a
 * test token. It hides the one difference that matters to a test's setup: a classic asset needs a
 * trustline before a G… account can hold it, a SEP-41 token does not.
 */
export interface TestAsset {
  readonly contract: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly kind: "sac" | "sep41";
  /** Lets a G… account hold the asset: a trustline for a classic asset, nothing for a token. */
  prepare(account: Keypair): Promise<void>;
  /** Mints `amount` base units to a G… (prepared) or C… address. */
  mint(to: string, amount: bigint): Promise<void>;
}

/** A classic asset issued on the local network, paid through its Stellar Asset Contract (7 decimals). */
export function classicTestAsset(net: LocalNetwork, issued: IssuedAsset): TestAsset {
  return {
    contract: issued.sac,
    symbol: issued.asset.getCode(),
    decimals: 7,
    kind: "sac",
    prepare: (account) => net.trust(account, issued),
    mint: (to, amount) => mintTo(net, issued, to, amount),
  };
}

/** A deployed test token. Its mints are serialised, since they share the minter's sequence number. */
export function tokenTestAsset(net: LocalNetwork, token: TestToken): TestAsset {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    contract: token.contract,
    symbol: token.symbol,
    decimals: token.decimals,
    kind: "sep41",
    prepare: () => Promise.resolve(),
    mint: (to, amount) => {
      const minted = queue.then(() => mintToken(net, token, to, amount));
      queue = minted.catch(() => undefined);
      return minted;
    },
  };
}

async function submitOperation(
  net: LocalNetwork,
  source: Keypair,
  operation: xdr.Operation,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const account = await net.server.getAccount(source.publicKey());
  const transaction = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(operation)
    .setTimeout(60)
    .build();
  const prepared = await net.server.prepareTransaction(transaction);
  prepared.sign(source);
  return net.submit(prepared);
}
