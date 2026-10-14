import { rpc } from "@stellar/stellar-sdk";
import {
  baseAccount,
  findTransfers,
  isExpired,
  type FoundTransfer,
  type StellarNetwork,
  type TransferQuery,
} from "@rail402.dev/stellar";
import { paymentError } from "../codes.ts";
import { emit, type PaymentEventListener, type ReleaseReason } from "../events.ts";
import type { Reservation, SpendLedger } from "./ledger.ts";
import { reservationSettlement } from "./proof.ts";

/** What reconciliation reads from the chain. */
export interface ChainReader {
  latestLedger(): Promise<number>;
  /** Transfers of `asset` sent by `from` in the range, or "out_of_range" beyond the RPC's retention. */
  findTransfers(query: TransferQuery): Promise<FoundTransfer[] | "out_of_range">;
  /**
   * A transaction by hash: the successful transaction, "failed" when it did not succeed, or "missing"
   * when the RPC does not hold it. Throws when the RPC cannot be read.
   */
  transaction(hash: string): Promise<rpc.Api.GetSuccessfulTransactionResponse | "failed" | "missing">;
}

export function rpcChainReader(
  server: Pick<rpc.Server, "getEvents" | "getHealth" | "getTransaction">,
): ChainReader {
  return {
    latestLedger: async () => (await server.getHealth()).latestLedger,
    findTransfers: (query) => findTransfers(server, query),
    transaction: async (hash) => {
      const found = await server.getTransaction(hash);
      if (found.status === rpc.Api.GetTransactionStatus.SUCCESS) return found;
      return found.status === rpc.Api.GetTransactionStatus.NOT_FOUND ? "missing" : "failed";
    },
  };
}

export interface ReconcileOptions {
  readonly network: StellarNetwork;
  readonly payer: string;
  /** A `reserved` row older than this with no signature is from a process that died; default 300 s. */
  readonly maxAuthorizationSeconds: number;
  /** At most this many rows are checked on chain; the rest wait for the next run. */
  readonly limit?: number | undefined;
  /** Reconcile only this reservation (a retry of its idempotency key checks its own payment first). */
  readonly only?: string | undefined;
  readonly now?: (() => number) | undefined;
  readonly onEvent?: PaymentEventListener | undefined;
}

export interface ReconcileReport {
  /** Rows checked on chain. */
  readonly checked: number;
  readonly settled: number;
  readonly released: number;
  /** Rows not expired yet whose ledgers the RPC no longer holds; they stay pending. */
  readonly awaitingProof: number;
  /**
   * Expired rows whose ledgers the RPC no longer holds: they are counted as spent at their whole
   * amount and no longer reconciled.
   */
  readonly unprovable: number;
  /** Rows still pending because their authorization has not expired yet. */
  readonly waiting: number;
  /** Rows left for a later run because of the limit or a failed RPC read. */
  readonly deferred: number;
}

/** Slack past `maxAuthorizationSeconds` before an unsigned reservation counts as abandoned. */
export const ABANDONED_RESERVATION_GRACE_MS = 60_000;

const HASH = /^[0-9a-f]{64}$/;

/**
 * Settles or releases reservations from on-chain proof. Budget is released only when no signature
 * exists or when the chain shows that an expired authorization was never used. Nothing a seller
 * reported is trusted, and a seller's report can neither settle nor hide another payment:
 * - `reserved` rows older than the longest authorization window plus a minute are from a process that
 *   died before signing (a signature is always recorded before it is used) and are released;
 * - `signed` and `transmitted` rows past their expiration become `unresolved`;
 * - `unresolved` rows, and unverified settlements, are proven from the chain: every transaction that
 *   sent the payer's asset to the recipient between the ledger the authorization was signed at and its
 *   expiration (and the hash a seller reported, if any) is checked for the payer's entry with this
 *   reservation's nonce, consumed by the host (`reservationSettlement`). A transaction that consumed
 *   it settles the row, whatever else it did and whichever other payments claim it: for the price, or
 *   for upto the amount the settlement contract recorded (the whole cap when that cannot be read), and
 *   an upto remainder returns. Once the authorization has expired and no transaction consumed it, the
 *   row is released (`expired_unused`, or `claim_false` for a reported settlement);
 * - an expired row whose ledgers the RPC no longer holds can never be proven either way: it is counted
 *   as spent at its whole amount and no longer reconciled (`unprovable`), so it neither blocks later
 *   windows nor returns budget that may have been paid.
 */
export async function reconcile(
  ledger: SpendLedger,
  chain: ChainReader,
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  const now = options.now ?? Date.now;
  const limit = options.limit ?? Infinity;
  const rows = ledger
    .unfinished(options.network, options.payer)
    .filter((row) => options.only === undefined || row.id === options.only);
  let checked = 0;
  let settled = 0;
  let released = 0;
  let awaitingProof = 0;
  let unprovable = 0;
  let waiting = 0;
  let deferred = 0;
  const report = () => ({ checked, settled, released, awaitingProof, unprovable, waiting, deferred });

  const lookups = new Map<string, ReturnType<ChainReader["transaction"]>>();
  const abandonedBefore = now() - options.maxAuthorizationSeconds * 1_000 - ABANDONED_RESERVATION_GRACE_MS;
  for (const row of rows) {
    if (
      row.state === "reserved" &&
      row.createdAt < abandonedBefore &&
      release(ledger, row, "not_signed", options)
    ) {
      released++;
    }
  }

  const candidates = rows.filter((row) => row.state !== "reserved");
  if (candidates.length === 0) return report();

  let latest: number;
  try {
    latest = await chain.latestLedger();
  } catch {
    throw paymentError("rpc_unavailable", {
      reason: "The latest ledger could not be read to reconcile the budget.",
    });
  }

  for (const row of candidates) {
    const expiration = row.expirationLedger;
    const expired = expiration !== undefined && isExpired(expiration, latest);
    if (!expired && row.state !== "unresolved") {
      waiting++;
      continue;
    }
    if (checked >= limit) {
      deferred++;
      continue;
    }
    if ((row.state === "signed" || row.state === "transmitted") && expired)
      ledger.markUnresolved(row.id, now());

    checked++;
    const outcome = await prove(chain, row, options, latest, lookups);
    switch (outcome.kind) {
      case "used":
        if (
          ledger.settle(
            row.id,
            { transaction: outcome.transaction, settledAmount: outcome.amount, verified: true },
            now(),
          )
        ) {
          settled++;
          emit(options.onEvent, {
            type: "settled",
            callId: row.callId,
            reservation: row.id,
            transaction: outcome.transaction,
            amount: outcome.amount.toString(),
          });
          if (row.scheme === "upto") releasedBelowCap(row, outcome.amount, options);
        }
        break;
      case "absent":
        if (!expired) {
          waiting++;
        } else if (row.state === "settled" && row.scheme === "upto" && row.settledAmount === 0n) {
          // A zero upto settlement moves nothing: an expired authorization nothing consumed proves it.
          if (
            ledger.settle(
              row.id,
              { transaction: row.transaction ?? null, settledAmount: 0n, verified: true },
              now(),
            )
          ) {
            settled++;
            releasedBelowCap(row, 0n, options);
          }
        } else if (
          release(ledger, row, row.state === "settled" ? "claim_false" : "expired_unused", options)
        ) {
          released++;
        }
        break;
      case "out_of_range":
        if (expired) {
          if (ledger.markUnprovable(row.id, now())) {
            unprovable++;
            emit(options.onEvent, {
              type: "unprovable",
              callId: row.callId,
              reservation: row.id,
              amount: row.amount.toString(),
            });
          }
        } else {
          awaitingProof++;
          ledger.setAwaitingProof(row.id, true, now());
        }
        break;
      case "unavailable":
        checked--;
        deferred++;
        break;
    }
  }
  return report();
}

type Proof =
  | { readonly kind: "used"; readonly transaction: string; readonly amount: bigint }
  | { readonly kind: "absent" }
  | { readonly kind: "out_of_range" }
  | { readonly kind: "unavailable" };

async function prove(
  chain: ChainReader,
  row: Reservation,
  options: ReconcileOptions,
  latest: number,
  lookups: Map<string, ReturnType<ChainReader["transaction"]>>,
): Promise<Proof> {
  const expiration = row.expirationLedger;
  const start = row.signedAtLedger;
  // A signed row always records these; without them nothing can be proven either way.
  if (expiration === undefined || start === undefined || row.nonce === undefined) {
    return { kind: "out_of_range" };
  }
  const end = Math.min(expiration, latest);
  if (end < start) return { kind: "absent" };
  let transfers: FoundTransfer[] | "out_of_range";
  try {
    transfers = await chain.findTransfers({
      asset: row.asset,
      from: options.payer,
      startLedger: start,
      endLedger: end,
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (transfers === "out_of_range") return { kind: "out_of_range" };
  const recipient = baseAccount(row.payTo);
  const found = transfers
    .filter(
      (transfer) =>
        transfer.to === recipient &&
        (row.scheme === "exact" ? transfer.amount === row.amount : transfer.amount <= row.amount),
    )
    .map((transfer) => transfer.transaction);
  // The hash a seller reported is checked too (an upto settlement of zero moves nothing), but only
  // the transactions behind transfers the RPC indexed can leave the outcome open.
  const reported = row.transaction !== undefined && HASH.test(row.transaction) ? [row.transaction] : [];
  const indexed = new Set(found);
  for (const hash of new Set([...reported, ...found])) {
    let lookup = lookups.get(hash);
    if (lookup === undefined) {
      lookup = chain.transaction(hash);
      lookups.set(hash, lookup);
    }
    let transaction: Awaited<typeof lookup>;
    try {
      transaction = await lookup;
    } catch {
      return { kind: "unavailable" };
    }
    // The RPC indexed a transfer but does not return its transaction: ask again later.
    if (transaction === "missing") {
      if (indexed.has(hash)) return { kind: "unavailable" };
      continue;
    }
    if (transaction === "failed") continue;
    let amount: bigint | undefined;
    try {
      amount = reservationSettlement(transaction, row, options.payer);
    } catch {
      // A transaction this version cannot read (a newer meta version) proves nothing either way.
      return { kind: "unavailable" };
    }
    if (amount !== undefined) return { kind: "used", transaction: hash, amount };
  }
  return { kind: "absent" };
}

function release(
  ledger: SpendLedger,
  row: Reservation,
  reason: ReleaseReason,
  options: ReconcileOptions,
): boolean {
  const done = ledger.release(row.id, reason, (options.now ?? Date.now)());
  if (done) {
    emit(options.onEvent, {
      type: "released",
      callId: row.callId,
      reservation: row.id,
      reason,
      amount: row.amount.toString(),
    });
  }
  return done;
}

/** Reports the part of an upto reservation's cap that a proven settlement did not use. */
function releasedBelowCap(row: Reservation, settled: bigint, options: ReconcileOptions): void {
  const remainder = row.amount - settled;
  if (remainder <= 0n) return;
  emit(options.onEvent, {
    type: "released",
    callId: row.callId,
    reservation: row.id,
    reason: "settled_below_cap",
    amount: remainder.toString(),
  });
}
