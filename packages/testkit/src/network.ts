import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  contract,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";

/**
 * Helpers for the private Stellar network from docker-compose.yml (`--profile stellar`). It runs with
 * the testnet passphrase, so everything here addresses it as `stellar:testnet`.
 */
export const LOCAL_RPC_URL = process.env["RAIL402_TEST_RPC_URL"] ?? "http://localhost:8000/rpc";
export const LOCAL_FRIENDBOT_URL =
  process.env["RAIL402_TEST_FRIENDBOT_URL"] ?? "http://localhost:8000/friendbot";

export interface PaymentRequirementsLike {
  readonly scheme: "exact";
  readonly network: "stellar:testnet";
  readonly asset: string;
  readonly payTo: string;
  readonly amount: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: { readonly areFeesSponsored: true };
}

export interface IssuedAsset {
  readonly asset: Asset;
  readonly issuer: Keypair;
  /** Stellar Asset Contract address. */
  readonly sac: string;
}

export class LocalNetwork {
  readonly passphrase: string = Networks.TESTNET;
  readonly server: rpc.Server;
  readonly rpcUrl: string;
  readonly friendbotUrl: string;

  constructor(rpcUrl = LOCAL_RPC_URL, friendbotUrl = LOCAL_FRIENDBOT_URL) {
    this.rpcUrl = rpcUrl;
    this.friendbotUrl = friendbotUrl;
    this.server = new rpc.Server(rpcUrl, { allowHttp: true });
  }

  async available(): Promise<boolean> {
    try {
      const network = await this.server.getNetwork();
      return network.passphrase === this.passphrase;
    } catch {
      return false;
    }
  }

  async fund(...accounts: Keypair[]): Promise<void> {
    await Promise.all(
      accounts.map(async (account) => {
        const response = await fetch(`${this.friendbotUrl}?addr=${account.publicKey()}`);
        if (!response.ok) throw new Error(`friendbot ${response.status}: ${await response.text()}`);
      }),
    );
  }

  async latestLedger(): Promise<number> {
    return (await this.server.getHealth()).latestLedger;
  }

  async submit(
    transaction: Transaction | FeeBumpTransaction,
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const sent = await this.server.sendTransaction(transaction);
    if (sent.status !== "PENDING") {
      throw new Error(`sendTransaction ${sent.status}: ${sent.errorResult?.result().switch().name ?? ""}`);
    }
    const result = await this.server.pollTransaction(sent.hash, { attempts: 60 });
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS)
      throw new Error(`transaction ${result.status}`);
    return result;
  }

  /** Builds, signs and submits a classic transaction. */
  async classic(source: Keypair, operations: xdr.Operation[], cosigners: Keypair[] = []) {
    const account = await this.server.getAccount(source.publicKey());
    const builder = new TransactionBuilder(account, {
      fee: String(Number(BASE_FEE) * Math.max(operations.length, 1)),
      networkPassphrase: this.passphrase,
    }).setTimeout(60);
    for (const operation of operations) builder.addOperation(operation);
    const transaction = builder.build();
    transaction.sign(source, ...cosigners);
    return this.submit(transaction);
  }

  /** Issues a classic asset, deploys its Stellar Asset Contract and returns both. */
  async issueAsset(code = "USDC"): Promise<IssuedAsset> {
    const issuer = Keypair.random();
    await this.fund(issuer);
    const asset = new Asset(code, issuer.publicKey());
    const account = await this.server.getAccount(issuer.publicKey());
    const deploy = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.passphrase })
      .addOperation(Operation.createStellarAssetContract({ asset }))
      .setTimeout(60)
      .build();
    const prepared = await this.server.prepareTransaction(deploy);
    prepared.sign(issuer);
    await this.submit(prepared);
    return { asset, issuer, sac: asset.contractId(this.passphrase) };
  }

  async trust(account: Keypair, issued: IssuedAsset): Promise<void> {
    await this.classic(account, [Operation.changeTrust({ asset: issued.asset })]);
  }

  /** Mints `amount` (decimal string, e.g. "100") of the asset to `to`, which must already trust it. */
  async mint(issued: IssuedAsset, to: string, amount: string): Promise<void> {
    await this.classic(issued.issuer, [Operation.payment({ destination: to, asset: issued.asset, amount })]);
  }

  /** A funded account with a trustline and `amount` of the asset. */
  async holder(issued: IssuedAsset, amount = "100"): Promise<Keypair> {
    const account = Keypair.random();
    await this.fund(account);
    await this.trust(account, issued);
    if (amount !== "0") await this.mint(issued, account.publicKey(), amount);
    return account;
  }

  /**
   * `count` funded accounts, each with a trustline and `amount` of the asset. Built with batched
   * transactions (one Friendbot call in total) so large fixtures stay fast and deterministic.
   */
  async holders(issued: IssuedAsset, count: number, amount = "100"): Promise<Keypair[]> {
    const treasury = Keypair.random();
    await this.fund(treasury);
    const accounts = Array.from({ length: count }, () => Keypair.random());
    for (let start = 0; start < accounts.length; start += 90) {
      const batch = accounts.slice(start, start + 90);
      await this.classic(
        treasury,
        batch.map((account) =>
          Operation.createAccount({ destination: account.publicKey(), startingBalance: "5" }),
        ),
      );
      // A transaction carries at most 20 signatures: the treasury plus 19 trusting accounts.
      for (let offset = 0; offset < batch.length; offset += 19) {
        const signers = batch.slice(offset, offset + 19);
        await this.classic(
          treasury,
          signers.map((account) =>
            Operation.changeTrust({ asset: issued.asset, source: account.publicKey() }),
          ),
          signers,
        );
      }
      if (amount !== "0") {
        await this.classic(
          issued.issuer,
          batch.map((account) =>
            Operation.payment({ destination: account.publicKey(), asset: issued.asset, amount }),
          ),
        );
      }
    }
    return accounts;
  }

  /** Token balance read through the contract's `balance` function, in base units. */
  async tokenBalance(token: string, holder: string): Promise<bigint> {
    const call = new Contract(token).call("balance", nativeToScVal(holder, { type: "address" }));
    const transaction = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
      fee: BASE_FEE,
      networkPassphrase: this.passphrase,
    })
      .addOperation(call)
      .setTimeout(60)
      .build();
    const simulation = await this.server.simulateTransaction(transaction);
    // A G-account without a trustline holds none of a classic asset (SAC error #13).
    if (rpc.Api.isSimulationError(simulation) && simulation.error.includes("Error(Contract, #13)")) return 0n;
    if (!rpc.Api.isSimulationSuccess(simulation) || simulation.result === undefined) {
      throw new Error(`balance simulation failed: ${"error" in simulation ? simulation.error : "no result"}`);
    }
    return scValToNative(simulation.result.retval) as bigint;
  }

  /** Native XLM balance in stroops; 0 for an account that holds only its sponsored reserve. */
  async nativeBalance(address: string): Promise<bigint> {
    const key = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
    );
    const { entries } = await this.server.getLedgerEntries(key);
    const entry = entries[0];
    if (entry === undefined) throw new Error(`account ${address} does not exist`);
    return entry.val.account().balance().toBigInt();
  }

  /**
   * Creates a signed x402 exact payment, following the upstream client (exact/client/scheme.ts) step
   * for step. The stock client cannot reach a plain-HTTP RPC, so this reproduces it with `allowHttp`;
   * the unmodified client is exercised against the public testnet instead.
   */
  async payment(
    payer: Keypair,
    requirements: PaymentRequirementsLike,
    options: { expirationLedger?: number } = {},
  ) {
    const latest = await this.latestLedger();
    const expiration = options.expirationLedger ?? latest + Math.ceil(requirements.maxTimeoutSeconds / 5);
    const { signAuthEntry } = basicNodeSigner(payer, this.passphrase);
    const assembled = await contract.AssembledTransaction.build({
      contractId: requirements.asset,
      method: "transfer",
      args: [
        nativeToScVal(payer.publicKey(), { type: "address" }),
        nativeToScVal(requirements.payTo, { type: "address" }),
        nativeToScVal(requirements.amount, { type: "i128" }),
      ],
      networkPassphrase: this.passphrase,
      rpcUrl: this.rpcUrl,
      allowHttp: true,
      parseResultXdr: (result: xdr.ScVal) => result,
    });
    if (assembled.simulation !== undefined && rpc.Api.isSimulationError(assembled.simulation)) {
      throw new Error(`client simulation failed: ${assembled.simulation.error}`);
    }
    await assembled.signAuthEntries({ address: payer.publicKey(), signAuthEntry, expiration });
    await assembled.simulate();
    const built = assembled.built;
    if (built === undefined) throw new Error("client transaction was not built");
    return {
      x402Version: 2 as const,
      resource: {
        url: "https://seller.example/resource",
        description: "test resource",
        mimeType: "application/json",
      },
      accepted: requirements,
      payload: { transaction: built.toXDR() },
    };
  }
}

export function requirementsFor(
  asset: string,
  payTo: string,
  amount: bigint | string,
  maxTimeoutSeconds = 60,
): PaymentRequirementsLike {
  return {
    scheme: "exact",
    network: "stellar:testnet",
    asset,
    payTo,
    amount: String(amount),
    maxTimeoutSeconds,
    extra: { areFeesSponsored: true },
  };
}

export function strkeyOf(address: xdr.ScAddress): string {
  return Address.fromScAddress(address).toString();
}
