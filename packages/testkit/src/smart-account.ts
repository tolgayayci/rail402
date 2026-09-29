import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Address,
  BASE_FEE,
  Contract,
  type Keypair,
  Operation,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { IssuedAsset, LocalNetwork, PaymentRequirementsLike } from "./network.ts";

const SIMPLE_ACCOUNT_WASM = readFileSync(new URL("../fixtures/simple_account.wasm", import.meta.url));

/** Uploads the fixture account contract, deploys an instance owned by `owner` and returns its C… address. */
export async function deploySimpleAccount(
  net: LocalNetwork,
  deployer: Keypair,
  owner: Keypair,
): Promise<string> {
  await invoke(net, deployer, Operation.uploadContractWasm({ wasm: SIMPLE_ACCOUNT_WASM }));
  const created = await invoke(
    net,
    deployer,
    Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()),
      wasmHash: hash(SIMPLE_ACCOUNT_WASM),
      salt: randomBytes(32),
    }),
  );
  if (created.returnValue === undefined) throw new Error("contract creation returned no address");
  const account = Address.fromScVal(created.returnValue).toString();
  await invoke(net, deployer, new Contract(account).call("init", xdr.ScVal.scvBytes(owner.rawPublicKey())));
  return account;
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
 * ed25519 signature by the owner over the SorobanAuthorization preimage hash.
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

  const expiration = (await net.latestLedger()) + Math.ceil(requirements.maxTimeoutSeconds / 5);
  const signer = options.signWith ?? options.owner;
  const auth = simulation.result.auth.map((entry) => {
    const credentials = entry.credentials();
    if (credentials.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return entry;
    const address = credentials.address();
    if (Address.fromScAddress(address.address()).toString() !== account) return entry;
    address.signatureExpirationLedger(expiration);
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
  });

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
