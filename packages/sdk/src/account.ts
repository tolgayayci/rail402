/**
 * Account onboarding over the Stellar RPC: fund a testnet account with Friendbot, add the trustline a
 * classic asset needs, and buy the asset with XLM on the network's exchange. These are classic
 * transactions the account holder submits for itself; they never pay a seller, and nothing here
 * needs Node, so the same steps run in a browser.
 *
 * Signing goes through a `SetupSigner`, which these functions call only with envelopes they built
 * themselves: a `changeTrust` for the requested asset, or a `pathPaymentStrictReceive` from XLM to the
 * account itself. `keySetupSigner` is bound to one asset and refuses anything else, so a key handed to
 * onboarding can sign nothing but these two transactions for that asset.
 */
import {
  Asset,
  Keypair,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { paymentError, type PaymentError } from "./codes.ts";
import type { KeyHolder } from "./keys.ts";
import { toDecimal } from "./money.ts";

/** Where onboarding reads and submits. */
export interface AccountChain {
  readonly server: rpc.Server;
  /** The network passphrase every envelope is signed for. */
  readonly passphrase: string;
}

/**
 * Signs a classic transaction for `address`, SEP-43 style: base64 envelope in, signed envelope out.
 * Wallets that implement SEP-43 `signTransaction` fit.
 */
export interface SetupSigner {
  readonly address: string;
  signTransaction(
    transactionXdr: string,
    opts: { readonly networkPassphrase: string; readonly address?: string },
  ): Promise<{ readonly signedTxXdr: string }>;
}

export interface AccountState {
  readonly address: string;
  readonly exists: boolean;
  /** XLM balance in stroops; null when the account does not exist. */
  readonly xlm: bigint | null;
}

/** Most XLM decimals; amounts in stroops. */
export const XLM_DECIMALS = 7;
/** XLM kept back by default when buying an asset, for reserves and fees. */
export const DEFAULT_XLM_KEPT = 10n * 10_000_000n;
const FRIENDBOT_TIMEOUT_MS = 30_000;
const FALLBACK_FEE = 1_000;
const MAX_FEE = 100_000;
/** Setup transactions expire this soon after they are built. */
const SETUP_TIMEOUT_SECONDS = 60;
const POLL_ATTEMPTS = 30;

type SetupFailure = "account_trustline_failed" | "account_funding_failed";

/** Whether the account exists and its XLM balance, read from the RPC (`rpc_unavailable` on failure). */
export async function accountState(chain: AccountChain, address: string): Promise<AccountState> {
  const xlm = await nativeBalance(chain, address);
  return { address, exists: xlm !== undefined, xlm: xlm ?? null };
}

/**
 * Asks a Friendbot to fund `address` (testnet and local networks only). Redirects are refused. The
 * answer is read only for the funding transaction's hash, which Friendbots name as `hash`: undefined
 * when the answer names none, is not small JSON, or cannot be read (the account is funded either way).
 * `account_friendbot_failed` when it cannot be reached or refuses.
 */
export async function fundWithFriendbot(
  options: {
    readonly friendbotUrl: string;
    readonly fetch?: typeof fetch;
    readonly signal?: AbortSignal;
  },
  address: string,
): Promise<string | undefined> {
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw paymentError("account_friendbot_failed", { reason: "Friendbot funds G… accounts only." });
  }
  const url = `${options.friendbotUrl}?addr=${encodeURIComponent(address)}`;
  const timeout = AbortSignal.timeout(FRIENDBOT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
      redirect: "error",
    });
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    throw paymentError("account_friendbot_failed", { reason: "Friendbot could not be reached." });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw paymentError("account_friendbot_failed", { details: { status: response.status } });
  }
  return friendbotTransaction(response);
}

/** Largest Friendbot answer read for its transaction hash. */
const FRIENDBOT_ANSWER_BYTES = 64 * 1024;
const TRANSACTION_HASH = /^[0-9a-f]{64}$/;

/** The `hash` a Friendbot's JSON answer names, read up to FRIENDBOT_ANSWER_BYTES. */
async function friendbotTransaction(response: Response): Promise<string | undefined> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > FRIENDBOT_ANSWER_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(concatBytes(chunks, size));
    const hash = (JSON.parse(text) as { hash?: unknown } | null)?.hash;
    return typeof hash === "string" && TRANSACTION_HASH.test(hash) ? hash : undefined;
  } catch {
    await reader.cancel().catch(() => undefined);
    return undefined;
  }
}

function concatBytes(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const CLASSIC_NAME = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/;

/**
 * The classic asset behind a token contract, from the token's `name()` (`CODE:ISSUER`), when that
 * asset's contract on this network is `contract`. Undefined for any other token.
 */
export function classicAssetFor(name: string, contract: string, passphrase: string): Asset | undefined {
  const match = CLASSIC_NAME.exec(name);
  if (match === null) return undefined;
  const asset = new Asset(match[1] ?? "", match[2] ?? "");
  return asset.contractId(passphrase) === contract ? asset : undefined;
}

/** Adds the account's trustline for `asset`; returns the transaction hash once it succeeded. */
export function addTrustline(chain: AccountChain, signer: SetupSigner, asset: Asset): Promise<string> {
  if (asset.isNative()) {
    return Promise.reject(paymentError("account_trustline_failed", { reason: "XLM needs no trustline." }));
  }
  return submitClassic(chain, signer, [Operation.changeTrust({ asset })], "account_trustline_failed");
}

/**
 * Buys `amount` (a decimal) of `asset` with XLM on the network's exchange, paid to the account
 * itself, spending at most what it holds above `keep` stroops. Returns the transaction hash.
 */
export async function buyAsset(
  chain: AccountChain,
  signer: SetupSigner,
  purchase: { readonly asset: Asset; readonly amount: string; readonly keep?: bigint },
): Promise<string> {
  const keep = purchase.keep ?? DEFAULT_XLM_KEPT;
  if (purchase.asset.isNative()) {
    throw paymentError("account_funding_failed", { reason: "XLM cannot be bought with XLM." });
  }
  const xlm = await nativeBalance(chain, signer.address);
  if (xlm === undefined) throw paymentError("account_not_found");
  if (xlm <= keep) {
    throw paymentError("account_funding_failed", {
      reason: `The account has too little XLM to buy ${purchase.asset.getCode()}.`,
    });
  }
  return submitClassic(
    chain,
    signer,
    [
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax: toDecimal(xlm - keep, XLM_DECIMALS),
        destination: signer.address,
        destAsset: purchase.asset,
        destAmount: purchase.amount,
        path: [],
      }),
    ],
    "account_funding_failed",
  );
}

/**
 * Builds a classic transaction from the signer's account, has it signed, submits it and waits for
 * its outcome. Returns the hash once it succeeded; `failure` carries the result code otherwise.
 */
export async function submitClassic(
  chain: AccountChain,
  signer: SetupSigner,
  operations: readonly xdr.Operation[],
  failure: SetupFailure,
): Promise<string> {
  let transaction: Transaction;
  try {
    const source = await chain.server.getAccount(signer.address);
    const fee = await feePerOperation(chain.server);
    // The builder's fee is per operation; the transaction bids it times the operation count.
    const builder = new TransactionBuilder(source, {
      fee: String(fee),
      networkPassphrase: chain.passphrase,
    }).setTimeout(SETUP_TIMEOUT_SECONDS);
    for (const operation of operations) builder.addOperation(operation);
    transaction = builder.build();
  } catch {
    throw paymentError("rpc_unavailable", {
      reason: "The account could not be read from the Stellar RPC to build the transaction.",
    });
  }
  const signed = await signBuilt(chain, signer, transaction, failure);
  let sent;
  try {
    sent = await chain.server.sendTransaction(signed);
  } catch {
    throw paymentError("rpc_unavailable", {
      reason: "The transaction could not be submitted to the Stellar RPC.",
    });
  }
  if (sent.status === "TRY_AGAIN_LATER") {
    throw paymentError("rpc_unavailable", { reason: "The RPC asked to retry the transaction later." });
  }
  if (sent.status !== "PENDING" && sent.status !== "DUPLICATE") {
    throw paymentError(failure, { details: { result: resultCode(sent.errorResult) } });
  }
  let final;
  try {
    final = await chain.server.pollTransaction(sent.hash, { attempts: POLL_ATTEMPTS });
  } catch {
    throw paymentError("rpc_unavailable", { reason: "The transaction's outcome could not be read." });
  }
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw paymentError(failure, {
      details: {
        transaction: sent.hash,
        status: final.status,
        ...(final.status === rpc.Api.GetTransactionStatus.FAILED
          ? { result: resultCode(final.resultXdr) }
          : {}),
      },
    });
  }
  return sent.hash;
}

/**
 * Has the signer sign exactly `transaction`: the envelope it returns must be the same transaction
 * (same hash) carrying a valid signature of the account's key.
 */
async function signBuilt(
  chain: AccountChain,
  signer: SetupSigner,
  transaction: Transaction,
  failure: SetupFailure,
): Promise<Transaction> {
  const refuse = (reason: string): PaymentError => paymentError(failure, { reason });
  let signedXdr: string;
  try {
    ({ signedTxXdr: signedXdr } = await signer.signTransaction(transaction.toXDR(), {
      networkPassphrase: chain.passphrase,
      address: signer.address,
    }));
  } catch {
    throw refuse("The key or wallet did not sign the transaction.");
  }
  let signed: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(signedXdr, chain.passphrase);
    if (!(parsed instanceof Transaction)) throw new TypeError("fee bump");
    signed = parsed;
  } catch {
    throw refuse("The signer returned something other than the transaction.");
  }
  if (!signed.hash().equals(transaction.hash())) {
    throw refuse("The signer returned a different transaction.");
  }
  const key = Keypair.fromPublicKey(signer.address);
  const valid = signed.signatures.some(
    (signature) =>
      signature.hint().equals(key.signatureHint()) && key.verify(signed.hash(), signature.signature()),
  );
  if (!valid) throw refuse("The transaction carries no valid signature of the account's key.");
  return signed;
}

/** What a key setup signer may sign for: one classic asset, and how much of it one purchase may buy. */
export interface SetupScope {
  /** The classic asset whose trustline may be added and which may be bought. */
  readonly asset: Asset;
  /** The most of the asset one purchase may receive, as a decimal; purchases are refused without it. */
  readonly maxBuy?: string;
}

/** The limit `changeTrust` sets when none is given: the largest amount, so the trustline is not capped. */
const DEFAULT_TRUST_LIMIT = "922337203685.4775807";

/**
 * A setup signer for a key held in memory. It signs only the onboarding transactions this module
 * builds, for `scope.asset`: from the key's own account, on `passphrase`, with one operation and a fee
 * of at most 100,000 stroops, which is either a `changeTrust` adding that asset's trustline at the
 * default limit (never removing or capping one), or a `pathPaymentStrictReceive` from XLM to the
 * account itself, direct (no path), of at most `scope.maxBuy` of the asset. No operation may name
 * another source account. Anything else is refused before the key is used.
 */
export function keySetupSigner(key: KeyHolder, passphrase: string, scope: SetupScope): SetupSigner {
  return {
    address: key.address,
    signTransaction: (transactionXdr, opts) => {
      try {
        if (opts.networkPassphrase !== passphrase) throw new TypeError("another network");
        const parsed = TransactionBuilder.fromXDR(transactionXdr, passphrase);
        if (!(parsed instanceof Transaction)) throw new TypeError("fee bump");
        if (!isOnboarding(parsed, key.address, scope)) throw new TypeError("not an onboarding transaction");
        parsed.sign(Keypair.fromSecret(key.exportSecret()));
        return Promise.resolve({ signedTxXdr: parsed.toXDR() });
      } catch {
        return Promise.reject(
          paymentError("payment_signing_failed", {
            reason: `Only the account's own ${scope.asset.getCode()} trustline and purchase transactions are signed here.`,
          }),
        );
      }
    },
  };
}

function isOnboarding(transaction: Transaction, address: string, scope: SetupScope): boolean {
  if (transaction.source !== address || transaction.operations.length !== 1) return false;
  if (BigInt(transaction.fee) > BigInt(MAX_FEE)) return false;
  const [operation] = transaction.operations;
  if (operation === undefined) return false;
  if (operation.source !== undefined && operation.source !== address) return false;
  if (operation.type === "changeTrust") {
    return (
      operation.line instanceof Asset &&
      operation.line.equals(scope.asset) &&
      operation.limit === DEFAULT_TRUST_LIMIT
    );
  }
  if (operation.type === "pathPaymentStrictReceive") {
    return (
      scope.maxBuy !== undefined &&
      operation.destination === address &&
      operation.sendAsset.isNative() &&
      operation.destAsset.equals(scope.asset) &&
      operation.path.length === 0 &&
      atMost(operation.destAmount, scope.maxBuy)
    );
  }
  return false;
}

/** Whether decimal `amount` is at most decimal `limit`, both with up to 7 decimals. */
function atMost(amount: string, limit: string): boolean {
  const units = (value: string): bigint | undefined => {
    const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(value);
    if (match === null) return undefined;
    return BigInt(match[1] ?? "0") * 10_000_000n + BigInt((match[2] ?? "").padEnd(7, "0"));
  };
  const a = units(amount);
  const b = units(limit);
  return a !== undefined && b !== undefined && a <= b;
}

/** A failed transaction's result code: the first operation's own (e.g. `changeTrustLowReserve`). */
export function resultCode(result: xdr.TransactionResult | undefined): string | undefined {
  if (result === undefined) return undefined;
  try {
    const outcome = result.result();
    const name = outcome.switch().name;
    if (name !== "txFailed") return name;
    const inner = outcome.results()[0]?.tr().value() as { switch(): { name: string } } | undefined;
    return inner?.switch().name ?? name;
  } catch {
    return undefined;
  }
}

/** The fee bid per operation: the network's recent 90th percentile, within 100 to 100,000 stroops. */
export async function feePerOperation(server: rpc.Server): Promise<number> {
  try {
    const stats = await server.getFeeStats();
    const p90 = Number(stats.inclusionFee.p90);
    return Number.isFinite(p90) ? Math.min(Math.max(p90, 100), MAX_FEE) : FALLBACK_FEE;
  } catch {
    return FALLBACK_FEE;
  }
}

/** The account's XLM balance in stroops, or undefined when the account does not exist. */
async function nativeBalance(chain: AccountChain, address: string): Promise<bigint | undefined> {
  let key: xdr.LedgerKey;
  try {
    key = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
    );
  } catch {
    throw paymentError("account_not_found", { reason: "The account is not a G… address." });
  }
  let response;
  try {
    response = await chain.server.getLedgerEntries(key);
  } catch {
    throw paymentError("rpc_unavailable", { reason: "The account could not be read from the Stellar RPC." });
  }
  const entry = response.entries[0];
  return entry === undefined ? undefined : entry.val.account().balance().toBigInt();
}
