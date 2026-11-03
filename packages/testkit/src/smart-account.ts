import {
  Address,
  BASE_FEE,
  Contract,
  type Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { IssuedAsset, LocalNetwork, PaymentRequirementsLike } from "./network.ts";
import { deployContract, fixtureWasm, type EntrySigner } from "./upto.ts";

const SIMPLE_ACCOUNT_WASM = fixtureWasm("ed25519_account.wasm");
const SIMPLE_ACCOUNT_WASM_HASH = hash(SIMPLE_ACCOUNT_WASM).toString("hex");

/**
 * The fixture account contract (`fixtures/ed25519_account.wasm`, built from
 * `contracts/testing/ed25519-account`): one ed25519 owner key, which its `__check_auth` checks.
 */
export function simpleAccountWasm(): Buffer {
  return Buffer.from(SIMPLE_ACCOUNT_WASM);
}

/**
 * Deploys the fixture account contract owned by `owner` and returns its C… address. The constructor
 * binds the owner inside the transaction that creates the contract, and nothing can change it later.
 */
export function deploySimpleAccount(net: LocalNetwork, deployer: Keypair, owner: Keypair): Promise<string> {
  return deployContract(net, deployer, SIMPLE_ACCOUNT_WASM, [xdr.ScVal.scvBytes(owner.rawPublicKey())]);
}

/** What a contract runs, read from its instance on chain. */
export interface ContractCode {
  /** Hex SHA-256 of the instance's WASM. */
  readonly wasmHash: string;
  readonly storage: readonly xdr.ScMapEntry[];
}

/**
 * The WASM and instance storage of `contract`; undefined when the network has no instance of it or
 * it is a built-in contract (a Stellar Asset Contract). Throws when the ledger cannot be read.
 */
export async function contractCode(net: LocalNetwork, contract: string): Promise<ContractCode | undefined> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const { entries } = await net.server.getLedgerEntries(key);
  const instance = entries[0]?.val.contractData().val().instance();
  const executable = instance?.executable();
  if (
    instance === undefined ||
    executable?.switch() !== xdr.ContractExecutableType.contractExecutableWasm()
  ) {
    return undefined;
  }
  return { wasmHash: executable.wasmHash().toString("hex"), storage: instance.storage() ?? [] };
}

/**
 * The owner of a fixture account as a G… key, read from the chain; undefined when the contract does
 * not run the fixture account's code. Throws when the ledger cannot be read.
 */
export async function simpleAccountOwner(net: LocalNetwork, account: string): Promise<string | undefined> {
  const code = await contractCode(net, account);
  if (code?.wasmHash !== SIMPLE_ACCOUNT_WASM_HASH) return undefined;
  // The constructor stores the key under the symbol `owner`.
  const owner = code.storage.find(
    (entry) => entry.key().switch() === xdr.ScValType.scvSymbol() && entry.key().sym().toString() === "owner",
  );
  const key = owner?.val();
  if (key?.switch() !== xdr.ScValType.scvBytes() || key.bytes().length !== 32) return undefined;
  return StrKey.encodeEd25519PublicKey(key.bytes());
}

/** Mints `amount` base units of a classic asset's SAC to any address (G… or C…), as the issuer. */
export async function mintTo(
  net: LocalNetwork,
  issued: IssuedAsset,
  to: string,
  amount: bigint,
): Promise<void> {
  await invoke(
    net,
    issued.issuer,
    new Contract(issued.sac).call(
      "mint",
      nativeToScVal(to, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ),
  );
}

/**
 * An x402 exact payment from a smart account. The transaction is built and simulated as a wallet
 * would, then the account's authorization entry is signed the way its `__check_auth` expects: an
 * ed25519 signature by the owner over the SorobanAuthorization preimage hash, or `signEntry` for an
 * account that expects another signature (an OpenZeppelin smart account's `AuthPayload`).
 */
export async function smartAccountPayment(
  net: LocalNetwork,
  options: {
    readonly account: string;
    readonly owner: Keypair;
    /** Any funded G… account to source the unsigned client transaction; it signs nothing. */
    readonly source: Keypair;
    readonly requirements: PaymentRequirementsLike;
    readonly signWith?: Keypair;
    /** Signs the account's entry (its expiration already set) instead of the owner's raw signature. */
    readonly signEntry?: EntrySigner;
    /** The authorization's expiration ledger; by default the latest ledger plus maxTimeoutSeconds / 5. */
    readonly expirationLedger?: number;
  },
) {
  const { account, requirements } = options;
  const call = new Contract(requirements.asset).call(
    "transfer",
    nativeToScVal(account, { type: "address" }),
    nativeToScVal(requirements.payTo, { type: "address" }),
    nativeToScVal(requirements.amount, { type: "i128" }),
  );
  const source = await net.server.getAccount(options.source.publicKey());
  const unsigned = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(call)
    .setTimeout(60)
    .build();
  const simulation = await net.server.simulateTransaction(unsigned);
  if (!rpc.Api.isSimulationSuccess(simulation) || simulation.result === undefined) {
    throw new Error(
      `smart-account payment simulation failed: ${"error" in simulation ? simulation.error : "no result"}`,
    );
  }

  const expiration =
    options.expirationLedger ?? (await net.latestLedger()) + Math.ceil(requirements.maxTimeoutSeconds / 5);
  const signer = options.signWith ?? options.owner;
  const auth = await Promise.all(
    simulation.result.auth.map(async (entry) => {
      const credentials = entry.credentials();
      if (credentials.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return entry;
      const address = credentials.address();
      if (Address.fromScAddress(address.address()).toString() !== account) return entry;
      address.signatureExpirationLedger(expiration);
      if (options.signEntry !== undefined) return options.signEntry(entry, net.passphrase);
      const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId: hash(Buffer.from(net.passphrase)),
          nonce: address.nonce(),
          signatureExpirationLedger: expiration,
          invocation: entry.rootInvocation(),
        }),
      );
      address.signature(xdr.ScVal.scvBytes(signer.sign(hash(preimage.toXDR()))));
      return entry;
    }),
  );

  const operation = unsigned.operations[0];
  if (operation?.type !== "invokeHostFunction") throw new Error("unexpected operation");
  const signed = new TransactionBuilder(await net.server.getAccount(options.source.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: net.passphrase,
  })
    .addOperation(Operation.invokeHostFunction({ func: operation.func, auth }))
    .setSorobanData(simulation.transactionData.build())
    .setTimeout(60)
    .build();

  return {
    x402Version: 2 as const,
    resource: { url: "https://seller.example/resource" },
    accepted: requirements,
    payload: { transaction: signed.toXDR() },
  };
}

async function invoke(
  net: LocalNetwork,
  source: Keypair,
  operation: xdr.Operation,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const account = await net.server.getAccount(source.publicKey());
  const transaction: Transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: net.passphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();
  const prepared = await net.server.prepareTransaction(transaction);
  prepared.sign(source);
  return net.submit(prepared);
}
