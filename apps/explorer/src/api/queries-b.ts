import { sql, type Kysely, type SelectQueryBuilder, type Selectable } from "kysely";
import { RULES_VERSION, type IndexNetwork, type SettlementRow } from "@rail402.dev/x402-index";
import type { ExplorerDatabase, SettlementsTable } from "../db.ts";
import { settlementFromRow } from "../store.ts";
import { explorerError, type Position } from "./paging.ts";
import type { PaymentFilter } from "./queries.ts";

/**
 * The reads of the payments list, the payment page and the report page that the reader class does not
 * make: numbered pages, bounded counts, the same buyer and seller around a payment, and payments per day
 * and facilitator. Every read keeps to the reader's rules: rows of the current rules only, indexed
 * columns, and a bound on what one statement may read.
 */

/** The payments list's filters plus an account (a payer or a seller; with `muxedId`, that muxed seller). */
export interface PaymentFilterB extends PaymentFilter {
  readonly account?: string;
  readonly muxedId?: string;
}

/** Rows a numbered page may skip at most: page 1,000 of 10 rows. Older rows need a narrower filter. */
export const MAX_OFFSET = 9_990;
/** Counts stop here; a page says "10,000+". */
export const COUNT_CAP = 10_000;

/** Registered payments of one UTC day and facilitator, self-payments left out. */
export interface DailyFacilitator {
  readonly day: string;
  readonly facilitatorId: string;
  readonly payments: number;
}

export interface ReadsB {
  /** `limit` payments newest first under `filter`, after skipping `offset` (at most `MAX_OFFSET`). */
  paymentsAt(
    network: IndexNetwork,
    epoch: string,
    filter: PaymentFilterB,
    offset: number,
    limit: number,
  ): Promise<SettlementRow[]>;
  /** How many payments `filter` lists, counted up to `COUNT_CAP` + 1. */
  paymentsCount(network: IndexNetwork, epoch: string, filter: PaymentFilterB): Promise<number>;
  /**
   * Payments from `payer` to `payTo` next to `around`: at most `each` newer and `each` older ones,
   * newest first, the payment at `around` left out.
   */
  sameParties(
    network: IndexNetwork,
    epoch: string,
    payer: string,
    payTo: string,
    around: Position,
    each: number,
  ): Promise<SettlementRow[]>;
  /**
   * Registered payments per UTC day and facilitator from `fromDay` (all days when undefined), from the
   * daily totals the indexer keeps. Undefined while the epoch holds ledgers of other rules: the totals
   * count every stored row.
   */
  dailyByFacilitator(
    network: IndexNetwork,
    epoch: string,
    fromDay: string | undefined,
  ): Promise<readonly DailyFacilitator[] | undefined>;
}

const POSTGRES_TIMEOUT = "57014";

/** A database failure as the Explorer reports it, as the reader class does: retryable, nothing leaked. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw explorerError("explorer_unavailable", {
      ...(code === POSTGRES_TIMEOUT ? { reason: "The query took longer than the Explorer allows." } : {}),
      cause: error,
    });
  }
}

type SettlementQuery = SelectQueryBuilder<ExplorerDatabase, "settlements", Selectable<SettlementsTable>>;

/** The reads above on the Explorer database (the reader role's Kysely instance). */
export function databaseReadsB(db: Kysely<ExplorerDatabase>): ReadsB {
  const settlements = () => db.selectFrom("settlements").where("rules_version", "=", RULES_VERSION);

  /** The settlements `filter` names, as `ExplorerReader.payments` selects them, plus the account. */
  const filtered = (network: IndexNetwork, epoch: string, filter: PaymentFilterB) =>
    settlements()
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .$if(filter.facilitator !== undefined, (q) => q.where("facilitator_id", "=", filter.facilitator ?? ""))
      .$if(filter.facilitator === undefined && filter.shaped === true, (q) => q.where("tier", "=", "shaped"))
      .$if(filter.facilitator === undefined && filter.shaped !== true, (q) =>
        q.where("tier", "in", ["rail402", "facilitator"]),
      )
      .$if(filter.scheme !== undefined, (q) => q.where("scheme", "=", filter.scheme ?? "exact"))
      .$if(filter.asset !== undefined, (q) => q.where("asset_contract", "=", filter.asset ?? ""))
      .$if(filter.fromLedger !== undefined, (q) => q.where("ledger", ">=", String(filter.fromLedger ?? 0)))
      .$if(filter.account !== undefined && filter.muxedId !== undefined, (q) =>
        q.where("pay_to", "=", filter.account ?? "").where("pay_to_muxed_id", "=", filter.muxedId ?? ""),
      )
      .$if(filter.account !== undefined && filter.muxedId === undefined, (q) =>
        q.where((eb) =>
          eb.or([eb("payer", "=", filter.account ?? ""), eb("pay_to", "=", filter.account ?? "")]),
        ),
      );

  const newestFirst = (query: SettlementQuery) => query.orderBy("ledger", "desc").orderBy("tx_index", "desc");

  return {
    async paymentsAt(network, epoch, filter, offset, limit) {
      const rows = await guarded(() =>
        newestFirst(filtered(network, epoch, filter).selectAll())
          .offset(Math.max(0, Math.min(MAX_OFFSET, Math.floor(offset))))
          .limit(Math.max(1, Math.min(100, limit)))
          .execute(),
      );
      return rows.map((row) => settlementFromRow(row));
    },

    async paymentsCount(network, epoch, filter) {
      const row = await guarded(() =>
        db
          .selectFrom(
            filtered(network, epoch, filter)
              .select(sql<number>`1`.as("one"))
              .limit(COUNT_CAP + 1)
              .as("capped"),
          )
          .select(sql<string>`count(*)`.as("count"))
          .executeTakeFirst(),
      );
      return Number(row?.count ?? 0);
    },

    async sameParties(network, epoch, payer, payTo, around, each) {
      const limit = Math.max(1, Math.min(10, each));
      const pair = () =>
        settlements()
          .selectAll()
          .where("network", "=", network)
          .where("payer", "=", payer)
          .where("epoch", "=", epoch)
          .where("pay_to", "=", payTo);
      const [newer, older] = await guarded(() =>
        Promise.all([
          pair()
            .where(sql<boolean>`(ledger, tx_index) > (${around.ledger}::bigint, ${around.txIndex}::integer)`)
            .orderBy("ledger", "asc")
            .orderBy("tx_index", "asc")
            .limit(limit)
            .execute(),
          newestFirst(
            pair().where(
              sql<boolean>`(ledger, tx_index) < (${around.ledger}::bigint, ${around.txIndex}::integer)`,
            ),
          )
            .limit(limit)
            .execute(),
        ]),
      );
      return [...newer.reverse(), ...older].map((row) => settlementFromRow(row));
    },

    async dailyByFacilitator(network, epoch, fromDay) {
      const stale = await guarded(() =>
        db
          .selectFrom("indexed_ledgers")
          .select("ledger")
          .where("network", "=", network)
          .where("epoch", "=", epoch)
          .where("status", "=", "indexed")
          .where((eb) => eb.or([eb("rules_version", "is", null), eb("rules_version", "<>", RULES_VERSION)]))
          .limit(1)
          .executeTakeFirst(),
      );
      if (stale !== undefined) return undefined;
      const rows = await guarded(() =>
        db
          .selectFrom("daily_aggregates")
          .select([
            sql<string>`to_char(day, 'YYYY-MM-DD')`.as("day"),
            "facilitator_id",
            sql<string>`sum(payments)`.as("payments"),
          ])
          .where("network", "=", network)
          .where("epoch", "=", epoch)
          .$if(fromDay !== undefined, (q) => q.where("day", ">=", fromDay ?? "1970-01-01"))
          .where("tier", "in", ["rail402", "facilitator"])
          .where("self_payment", "=", false)
          .groupBy(["day", "facilitator_id"])
          .orderBy("day")
          // Every registered facilitator on every day of a long epoch stays far below this.
          .limit(20_000)
          .execute(),
      );
      return rows.map((row) => ({
        day: row.day,
        facilitatorId: row.facilitator_id,
        payments: Number(row.payments),
      }));
    },
  };
}

/**
 * The reads of `reader`: on its database when it has one (the reader class), or the reader itself when
 * it makes them (a test double); undefined otherwise, and the pages fall back to the reader's own lists.
 */
export function readsOf(reader: object): ReadsB | undefined {
  const candidate = reader as Partial<ReadsB> & { readonly database?: Kysely<ExplorerDatabase> };
  if (
    typeof candidate.paymentsAt === "function" &&
    typeof candidate.paymentsCount === "function" &&
    typeof candidate.sameParties === "function" &&
    typeof candidate.dailyByFacilitator === "function"
  )
    return candidate as ReadsB;
  if ("database" in reader && candidate.database !== undefined) return databaseReadsB(candidate.database);
  return undefined;
}
