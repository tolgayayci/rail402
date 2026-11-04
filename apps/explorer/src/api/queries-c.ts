import { sql, type Kysely } from "kysely";
import { RULES_VERSION, type IndexNetwork } from "@rail402.dev/x402-index";
import type { ExplorerDatabase } from "../db.ts";
import { explorerError } from "./paging.ts";
import { ExplorerReader } from "./queries.ts";

/**
 * The facilitator pages' reads: per facilitator totals the report does not keep (fees, schemes, the
 * last payment, the accounts in use, top sellers, tokens, payments per day). Only rows of the current
 * rules, self-payments left out as in the report. Each read walks one facilitator's rows through the
 * facilitator index, or a time-bounded slice through the close-time index, and its answer is kept for
 * a minute, so a page view never aggregates the history again.
 */

type Db = Kysely<ExplorerDatabase>;

/** The database behind a reader, when it is the real one (tests serve pages from in-memory readers). */
export const databaseOf = (reader: unknown): Db | undefined =>
  reader instanceof ExplorerReader ? reader.database : undefined;

/** `null` names the payments no registered facilitator explains (the unattributed shaped rows). */
export type FacilitatorKey = string | null;

export interface FacilitatorSummary {
  readonly id: FacilitatorKey;
  readonly payments: number;
  /** Network fees charged, in stroops. */
  readonly feeStroops: bigint;
  readonly sponsored: number;
  readonly lastAt: string | null;
  readonly exact: number;
  readonly upto: number;
}

export interface AccountCount {
  readonly address: string;
  readonly payments: number;
}

export interface SellerCount {
  readonly address: string;
  readonly payments: number;
  readonly payers: number;
  /** Atomic units of the network's USDC, when one is given. */
  readonly usdc: string;
}

export interface TokenCount {
  readonly contract: string;
  readonly code: string | null;
  readonly issuer: string | null;
  readonly verified: boolean;
  readonly payments: number;
}

export interface FacilitatorStats extends FacilitatorSummary {
  readonly firstAt: string | null;
  readonly payers: number;
  readonly contractPayers: number;
  readonly sellers: number;
  /** Sums over the upto payments: settled amount and the authorised maximum. */
  readonly uptoAmount: bigint;
  readonly uptoMax: bigint;
  readonly feePayers: readonly AccountCount[];
  readonly feePayerCount: number;
  readonly senders: readonly AccountCount[];
  readonly senderCount: number;
  readonly topSellers: readonly SellerCount[];
  readonly tokens: readonly TokenCount[];
}

export interface DayCount {
  /** UTC day, YYYY-MM-DD. */
  readonly day: string;
  readonly id: FacilitatorKey;
  readonly payments: number;
}

const CACHE_MS = 60_000;
const CACHE_ENTRIES = 200;
const cache = new Map<string, { readonly until: number; readonly value: Promise<unknown> }>();

/** One answer per key for a minute; a failed read is not kept. */
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit !== undefined && hit.until > now) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { until: now + CACHE_MS, value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  while (cache.size > CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw explorerError("explorer_unavailable", { cause: error });
  }
}

const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : new Date(value as string).toISOString();

/** The rows of one network and epoch under the current rules, self-payments left out. */
const rows = (db: Db, network: IndexNetwork, epoch: string) =>
  db
    .selectFrom("settlements")
    .where("rules_version", "=", RULES_VERSION)
    .where("network", "=", network)
    .where("epoch", "=", epoch)
    .where(sql<boolean>`payer <> pay_to`);

/** One facilitator's rows: a registry id, or the unattributed shaped rows for `null`. */
const rowsOf = (db: Db, network: IndexNetwork, epoch: string, id: FacilitatorKey) =>
  id === null
    ? rows(db, network, epoch).where("facilitator_id", "is", null).where("tier", "=", "shaped")
    : rows(db, network, epoch).where("facilitator_id", "=", id);

/** Payments, fees, schemes and the last payment of every facilitator, and of the unregistered rows. */
export function facilitatorSummaries(
  db: Db,
  network: IndexNetwork,
  epoch: string,
  ids: readonly string[],
): Promise<FacilitatorSummary[]> {
  const keys: FacilitatorKey[] = [...new Set(ids)].slice(0, 20);
  keys.push(null);
  return cached(`summaries:${network}:${epoch}:${keys.join(",")}`, () =>
    guarded(() => Promise.all(keys.map((id) => summaryOf(db, network, epoch, id)))),
  );
}

async function summaryOf(db: Db, network: IndexNetwork, epoch: string, id: FacilitatorKey) {
  const row = await rowsOf(db, network, epoch, id)
    .select([
      sql<string>`count(*)`.as("payments"),
      sql<string>`coalesce(sum(fee_charged), 0)`.as("fee"),
      sql<string>`count(*) FILTER (WHERE sponsored)`.as("sponsored"),
      sql<Date | null>`max(closed_at)`.as("last_at"),
      sql<string>`count(*) FILTER (WHERE scheme = 'exact')`.as("exact"),
      sql<string>`count(*) FILTER (WHERE scheme = 'upto')`.as("upto"),
    ])
    .executeTakeFirst();
  return {
    id,
    payments: Number(row?.payments ?? 0),
    feeStroops: BigInt(row?.fee ?? "0"),
    sponsored: Number(row?.sponsored ?? 0),
    lastAt: iso(row?.last_at),
    exact: Number(row?.exact ?? 0),
    upto: Number(row?.upto ?? 0),
  } satisfies FacilitatorSummary;
}

/** One facilitator's totals and breakdowns (see `FacilitatorStats`); `usdc` names the USDC contract. */
export function facilitatorStats(
  db: Db,
  network: IndexNetwork,
  epoch: string,
  id: FacilitatorKey,
  usdc: string | undefined,
): Promise<FacilitatorStats> {
  return cached(`stats:${network}:${epoch}:${id ?? ""}:${usdc ?? ""}`, () =>
    guarded(async () => {
      const base = () => rowsOf(db, network, epoch, id);
      const [summary, totals, feePayers, senders, sellers, tokens] = await Promise.all([
        summaryOf(db, network, epoch, id),
        base()
          .select([
            sql<Date | null>`min(closed_at)`.as("first_at"),
            sql<string>`count(DISTINCT payer)`.as("payers"),
            sql<string>`count(DISTINCT payer) FILTER (WHERE payer_kind = 'C')`.as("contract_payers"),
            sql<string>`count(DISTINCT pay_to)`.as("sellers"),
            sql<string>`coalesce(sum(amount) FILTER (WHERE scheme = 'upto'), 0)`.as("upto_amount"),
            sql<string>`coalesce(sum(max_amount) FILTER (WHERE scheme = 'upto'), 0)`.as("upto_max"),
            sql<string>`count(DISTINCT fee_payer)`.as("fee_payers"),
            sql<string>`count(DISTINCT inner_source)`.as("senders"),
          ])
          .executeTakeFirst(),
        base()
          .select(["fee_payer", sql<string>`count(*)`.as("payments")])
          .groupBy("fee_payer")
          .orderBy(sql`count(*)`, "desc")
          .orderBy("fee_payer")
          .limit(5)
          .execute(),
        base()
          .select(["inner_source", sql<string>`count(*)`.as("payments")])
          .groupBy("inner_source")
          .orderBy(sql`count(*)`, "desc")
          .orderBy("inner_source")
          .limit(5)
          .execute(),
        base()
          .select([
            "pay_to",
            sql<string>`count(*)`.as("payments"),
            sql<string>`count(DISTINCT payer)`.as("payers"),
            sql<string>`coalesce(sum(amount) FILTER (WHERE asset_contract = ${usdc ?? ""}), 0)`.as("usdc"),
          ])
          .groupBy("pay_to")
          .orderBy(sql`count(*)`, "desc")
          .orderBy("pay_to")
          .limit(5)
          .execute(),
        base()
          .select([
            "asset_contract",
            sql<string | null>`max(asset_code)`.as("code"),
            sql<string | null>`max(asset_issuer)`.as("issuer"),
            sql<boolean>`bool_and(asset_verified)`.as("verified"),
            sql<string>`count(*)`.as("payments"),
          ])
          .groupBy("asset_contract")
          .orderBy(sql`count(*)`, "desc")
          .orderBy("asset_contract")
          .limit(6)
          .execute(),
      ]);
      return {
        ...summary,
        firstAt: iso(totals?.first_at),
        payers: Number(totals?.payers ?? 0),
        contractPayers: Number(totals?.contract_payers ?? 0),
        sellers: Number(totals?.sellers ?? 0),
        uptoAmount: BigInt(totals?.upto_amount ?? "0"),
        uptoMax: BigInt(totals?.upto_max ?? "0"),
        feePayerCount: Number(totals?.fee_payers ?? 0),
        senderCount: Number(totals?.senders ?? 0),
        feePayers: feePayers.map((row) => ({ address: row.fee_payer, payments: Number(row.payments) })),
        senders: senders.map((row) => ({ address: row.inner_source, payments: Number(row.payments) })),
        topSellers: sellers.map((row) => ({
          address: row.pay_to,
          payments: Number(row.payments),
          payers: Number(row.payers),
          usdc: row.usdc,
        })),
        tokens: tokens.map((row) => ({
          contract: row.asset_contract,
          code: row.code,
          issuer: row.issuer,
          verified: row.verified,
          payments: Number(row.payments),
        })),
      } satisfies FacilitatorStats;
    }),
  );
}

/**
 * Payments per UTC day and facilitator (`null` for the unregistered rows) from `since` on, through the
 * close-time index, for at most 40 days.
 */
export function facilitatorDaily(
  db: Db,
  network: IndexNetwork,
  epoch: string,
  since: string,
): Promise<DayCount[]> {
  const key = new Date(since).toISOString().slice(0, 10);
  const from = new Date(`${key}T00:00:00Z`);
  return cached(`daily:${network}:${epoch}:${key}`, () =>
    guarded(async () => {
      const result = await rows(db, network, epoch)
        .where("closed_at", ">=", from)
        .where("closed_at", "<", new Date(from.getTime() + 40 * 86_400_000))
        .where("tier", "in", ["rail402", "facilitator", "shaped"])
        .select([
          sql<string>`to_char((closed_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')`.as("day"),
          "facilitator_id",
          sql<string>`count(*)`.as("payments"),
        ])
        .groupBy([sql`1`, "facilitator_id"])
        .limit(2_000)
        .execute();
      return result.map((row) => ({ day: row.day, id: row.facilitator_id, payments: Number(row.payments) }));
    }),
  );
}

/** The newest day any row of the epoch closed on (UTC, YYYY-MM-DD), through the close-time index. */
export function newestDay(db: Db, network: IndexNetwork, epoch: string): Promise<string | null> {
  return cached(`newest:${network}:${epoch}`, () =>
    guarded(async () => {
      const row = await db
        .selectFrom("settlements")
        .select("closed_at")
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .where("rules_version", "=", RULES_VERSION)
        .orderBy("closed_at", "desc")
        .limit(1)
        .executeTakeFirst();
      return row === undefined ? null : new Date(row.closed_at).toISOString().slice(0, 10);
    }),
  );
}
