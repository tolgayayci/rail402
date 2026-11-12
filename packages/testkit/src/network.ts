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
import { getEstimatedLedgerCloseTimeSeconds } from "@x402/stellar";

/**
 * Helpers for the private Stellar network from docker-compose.yml (`--profile stellar`). It runs with
 * the testnet passphrase, so everything here addresses it as `stellar:testnet`.
 */
export const LOCAL_RPC_URL = process.env["RAIL402_TEST_RPC_URL"] ?? "http://localhost:8000/rpc";
export const LOCAL_FRIENDBOT_URL =
  process.env["RAIL402_TEST_FRIENDBOT_URL"] ?? "http://localhost:8000/friendbot";

/** How often `submit` sends a transaction the network answered with TRY_AGAIN_LATER. */
const SUBMIT_ATTEMPTS = 5;
/** How often `classic` rebuilds a transaction the network refused with txBadSeq. */
const BAD_SEQUENCE_ATTEMPTS = 3;
/** How long a read waits for an RPC node behind a ledger this client has already seen. */
const CATCH_UP_MS = 60_000;
const CATCH_UP_PAUSE_MS = 500;

/**
 * An RPC client whose reads never go back in time. A public RPC endpoint can be served by several
 * nodes a ledger or two apart: right after one confirms a transaction, the next request may reach
 * another that still answers with the account's previous sequence number (txBadSeq), an old balance,
 * or NOT_FOUND. Ledger-entry reads, simulations and transaction lookups are therefore sent again,
 * for a bounded time, until the answering node has reached the latest ledger this client has seen
 * (in any answer, or as the ledger of a transaction it looked up). Against one node nothing waits.
 */
export class MonotonicRpcServer extends rpc.Server {
  #seen = 0;

  /** The latest ledger any answer has shown this client. */
  get seenLedger(): number {
    return this.#seen;
  }

  /** Records a ledger known to have closed, e.g. that of a transaction confirmed elsewhere. */
  observe(ledger: number): void {
    if (ledger > this.#seen) this.#seen = ledger;
  }

  override _getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<rpc.Api.RawGetLedgerEntriesResponse> {
    return this.#caughtUp(() => super._getLedgerEntries(...keys));
  }

  override _simulateTransaction(
    ...args: Parameters<rpc.Server["_simulateTransaction"]>
  ): Promise<rpc.Api.RawSimulateTransactionResponse> {
    return this.#caughtUp(() => super._simulateTransaction(...args));
  }

  override async _getTransaction(hash: string): Promise<rpc.Api.RawGetTransactionResponse> {
    const response = await this.#caughtUp(() => super._getTransaction(hash));
    if (response.status !== rpc.Api.GetTransactionStatus.NOT_FOUND && response.ledger !== undefined) {
      this.observe(response.ledger);
    }
    return response;
  }

  async #caughtUp<T extends { readonly latestLedger: number }>(read: () => Promise<T>): Promise<T> {
    const target = this.#seen;
    const deadline = Date.now() + CATCH_UP_MS;
    for (;;) {
      const response = await read();
      if (response.latestLedger >= target) {
        this.observe(response.latestLedger);
        return response;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `the RPC stayed at ledger ${String(response.latestLedger)}, behind ledger ${String(target)}, for ${String(CATCH_UP_MS / 1_000)} s`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, CATCH_UP_PAUSE_MS));
    }
  }
}
/** Friendbot answers tried per account before `fund` gives up (5xx and network errors only). */
const FRIENDBOT_ATTEMPTS = 5;

/** A submission the network refused with txBadSeq: nothing was applied and no fee was charged. */
export class BadSequenceError extends Error {
  override readonly name = "BadSequenceError";
}

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
  /**
   * The inclusion fee bid, in stroops, of the Soroban transactions this kit builds (contract uploads,
   * deploys and calls). The base fee is enough on a local network and testnet; pubnet needs more.
   */
  readonly sorobanInclusionFee: string = BASE_FEE;
  readonly server: MonotonicRpcServer;
  readonly rpcUrl: string;
  readonly friendbotUrl: string;

  constructor(rpcUrl = LOCAL_RPC_URL, friendbotUrl = LOCAL_FRIENDBOT_URL) {
    this.rpcUrl = rpcUrl;
    this.friendbotUrl = friendbotUrl;
    this.server = new MonotonicRpcServer(rpcUrl, { allowHttp: true });
  }

  async available(): Promise<boolean> {
    try {
      const network = await this.server.getNetwork();
      return network.passphrase === this.passphrase;
    } catch {
      return false;
    }
  }

  /**
   * Funds new accounts from Friendbot. A Friendbot shared by many test runs answers 5xx under load
   * (its own funding transaction failed or timed out), so those answers are retried a few times with
   * a growing pause; an account that already exists after a failed answer (Friendbot refuses one it
   * funded before with a 400) counts as funded.
   */
  async fund(...accounts: Keypair[]): Promise<void> {
    await Promise.all(accounts.map((account) => this.fundOne(account)));
  }

  private async fundOne(account: Keypair): Promise<void> {
    const url = `${this.friendbotUrl}?addr=${account.publicKey()}`;
    for (let attempt = 1; ; attempt++) {
      const failure = await fetch(url).then(
        async (response) =>
          response.ok
            ? undefined
            : {
                retry: response.status >= 500,
                message: `friendbot ${String(response.status)}: ${await response.text()}`,
              },
        (error: unknown) => ({
          retry: true,
          message: `friendbot unreachable: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
      if (failure === undefined) return;
      // Friendbot refuses an account it already funded with a 4xx: an existing account is funded.
      if (await this.exists(account.publicKey())) return;
      if (!failure.retry) throw new Error(failure.message);
      if (attempt >= FRIENDBOT_ATTEMPTS) throw new Error(failure.message);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }

  private async exists(address: string): Promise<boolean> {
    try {
      await this.server.getAccount(address);
      return true;
    } catch {
      return false;
    }
  }

  async latestLedger(): Promise<number> {
    return (await this.server.getHealth()).latestLedger;
  }

  /**
   * The signature expiration ledger the stock client picks for `maxTimeoutSeconds`: the latest
   * ledger plus `ceil(maxTimeoutSeconds / est)`, `est` being upstream's Horizon-based estimate.
   */
  async expirationFor(maxTimeoutSeconds: number): Promise<number> {
    const latest = (await this.server.getLatestLedger()).sequence;
    const seconds = await getEstimatedLedgerCloseTimeSeconds("stellar:testnet");
    return latest + Math.ceil(maxTimeoutSeconds / seconds);
  }

  async submit(
    transaction: Transaction | FeeBumpTransaction,
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    let sent = await this.server.sendTransaction(transaction);
    // A busy shared network answers TRY_AGAIN_LATER without accepting the transaction; the same bytes
    // can be sent again.
    for (let attempt = 1; sent.status === "TRY_AGAIN_LATER" && attempt < SUBMIT_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
      sent = await this.server.sendTransaction(transaction);
    }
    if (sent.status !== "PENDING") {
      const code = sent.errorResult?.result().switch().name ?? "";
      const message = `sendTransaction ${sent.status}: ${code}`;
      throw code === "txBadSeq" ? new BadSequenceError(message) : new Error(message);
    }
    const result = await this.server.pollTransaction(sent.hash, { attempts: 60 });
    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS)
      throw new Error(`transaction ${result.status}`);
    return result;
  }

  /**
   * Builds and submits a transaction from a sequence number read when `build` runs. A refusal with
   * txBadSeq means the transaction was not applied (the read came from a node behind the ledger that
   * used the number), so it is built again from a fresh read, a few times at most. For transactions
   * of accounts the caller owns: anything that uses the same account elsewhere races it.
   */
  async submitBuilt(
    build: () => Promise<Transaction | FeeBumpTransaction>,
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.submit(await build());
      } catch (error) {
        if (!(error instanceof BadSequenceError) || attempt >= BAD_SEQUENCE_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
      }
    }
  }

  /** Builds, signs and submits a classic transaction. */
  async classic(source: Keypair, operations: xdr.Operation[], cosigners: Keypair[] = []) {
    return this.submitBuilt(async () => {
      const account = await this.server.getAccount(source.publicKey());
      const builder = new TransactionBuilder(account, {
        fee: String(Number(BASE_FEE) * Math.max(operations.length, 1)),
        networkPassphrase: this.passphrase,
      }).setTimeout(60);
      for (const operation of operations) builder.addOperation(operation);
      const transaction = builder.build();
      transaction.sign(source, ...cosigners);
      return transaction;
    });
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
    let simulation = await this.server.simulateTransaction(transaction);
    // The local RPC can answer from a snapshot that lacks the network settings for a moment after a ledger.
    for (let retry = 0; retry < 5; retry++) {
      if (!rpc.Api.isSimulationError(simulation) || !simulation.error.includes("not present in the snapshot"))
        break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      simulation = await this.server.simulateTransaction(transaction);
    }
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
   * the unmodified client is exercised against the public testnet instead. Like the stock client,
   * the authorization expires `ceil(maxTimeoutSeconds / est)` ledgers after the latest one, where
   * `est` is upstream's ledger-time estimate from public Horizon (see horizon-pin.ts).
   */
  async payment(
    payer: Keypair,
    requirements: PaymentRequirementsLike,
    options: { expirationLedger?: number } = {},
  ) {
    const expiration = options.expirationLedger ?? (await this.expirationFor(requirements.maxTimeoutSeconds));
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
