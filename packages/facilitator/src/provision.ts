import { BASE_FEE, Keypair, Operation, StrKey, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";

export interface ProvisionOptions {
  readonly server: rpc.Server;
  readonly passphrase: string;
  readonly sponsor: Keypair;
  readonly channels: readonly Keypair[];
  /**
   * Channels per transaction. Each one signs, and a transaction carries at most 20 signatures: the
   * sponsor's and up to 19 channels'.
   */
  readonly batchSize?: number;
}

const MAX_CHANNELS_PER_TRANSACTION = 19;

export interface ProvisionResult {
  readonly created: readonly string[];
  readonly existing: readonly string[];
}

/**
 * Creates any missing channel accounts. Each channel is created with a zero balance and its base
 * reserve sponsored by the sponsor (CAP-33), so channels never hold XLM: the sponsor pays every
 * settlement fee through a fee bump. Idempotent: existing channels are left untouched.
 */
export async function provisionChannels(options: ProvisionOptions): Promise<ProvisionResult> {
  const batchSize = checkedBatchSize(options.batchSize);
  const existing = await existingAccounts(
    options.server,
    options.channels.map((k) => k.publicKey()),
  );
  const missing = options.channels.filter((keypair) => !existing.has(keypair.publicKey()));

  for (let start = 0; start < missing.length; start += batchSize) {
    const batch = missing.slice(start, start + batchSize);
    await submit(options, batch, "channel provisioning", (builder, channel) =>
      builder
        .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: channel.publicKey() }))
        .addOperation(Operation.createAccount({ destination: channel.publicKey(), startingBalance: "0" }))
        .addOperation(Operation.endSponsoringFutureReserves({ source: channel.publicKey() })),
    );
  }

  return {
    created: missing.map((keypair) => keypair.publicKey()),
    existing: [...existing],
  };
}

export interface RetireResult {
  readonly retired: readonly string[];
  readonly absent: readonly string[];
}

/**
 * Merges channel accounts back into the sponsor, which releases the reserves it sponsored. Channels
 * hold no balance, so nothing else moves. Only safe while no settlement uses the channels: the
 * caller checks that. Idempotent: channels that do not exist are skipped.
 */
export async function retireChannels(options: ProvisionOptions): Promise<RetireResult> {
  const batchSize = checkedBatchSize(options.batchSize);
  const existing = await existingAccounts(
    options.server,
    options.channels.map((k) => k.publicKey()),
  );
  const present = options.channels.filter((keypair) => existing.has(keypair.publicKey()));

  for (let start = 0; start < present.length; start += batchSize) {
    const batch = present.slice(start, start + batchSize);
    await submit(options, batch, "channel retirement", (builder, channel) =>
      builder.addOperation(
        Operation.accountMerge({ destination: options.sponsor.publicKey(), source: channel.publicKey() }),
      ),
    );
  }

  return {
    retired: present.map((keypair) => keypair.publicKey()),
    absent: options.channels
      .filter((keypair) => !existing.has(keypair.publicKey()))
      .map((k) => k.publicKey()),
  };
}

function checkedBatchSize(batchSize = MAX_CHANNELS_PER_TRANSACTION): number {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_CHANNELS_PER_TRANSACTION) {
    throw new RangeError(`batchSize must be between 1 and ${String(MAX_CHANNELS_PER_TRANSACTION)}`);
  }
  return batchSize;
}

/** One sponsor-sourced transaction with operations per channel, signed by the sponsor and every channel. */
async function submit(
  options: ProvisionOptions,
  channels: readonly Keypair[],
  purpose: string,
  add: (builder: TransactionBuilder, channel: Keypair) => TransactionBuilder,
): Promise<void> {
  const account = await options.server.getAccount(options.sponsor.publicKey());
  let builder = new TransactionBuilder(account, {
    fee: String(Number(BASE_FEE) * channels.length * 3),
    networkPassphrase: options.passphrase,
  }).setTimeout(60);
  for (const channel of channels) builder = add(builder, channel);
  const transaction = builder.build();
  transaction.sign(options.sponsor, ...channels);

  const sent = await options.server.sendTransaction(transaction);
  if (sent.status !== "PENDING") throw new Error(`${purpose} was not accepted: ${sent.status}`);
  const result = await options.server.pollTransaction(sent.hash, { attempts: 60 });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${purpose} transaction ${sent.hash} ended ${result.status}`);
  }
}

/** Which of `addresses` exist on the network. */
export async function existingAccounts(
  server: rpc.Server,
  addresses: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  // getLedgerEntries accepts at most 200 keys per request.
  for (let start = 0; start < addresses.length; start += 200) {
    const keys = addresses
      .slice(start, start + 200)
      .map((address) =>
        xdr.LedgerKey.account(
          new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
        ),
      );
    const { entries } = await server.getLedgerEntries(...keys);
    for (const entry of entries) {
      found.add(StrKey.encodeEd25519PublicKey(entry.val.account().accountId().ed25519()));
    }
  }
  return found;
}
