import { sql, type Kysely, type Selectable, type SelectQueryBuilder } from "kysely";
import {
  RULES_VERSION,
  type FailedAttemptRow,
  type IndexNetwork,
  type SettlementRow,
} from "@rail402.dev/x402-index";
import type { ExplorerDatabase, SettlementsTable } from "../db.ts";
import { settlementFromRow } from "../store.ts";
import { explorerError, encodeCursor, type Keyset } from "./paging.ts";

/** Which side of a payment an account page lists. */
export type AccountRole = "any" | "payer" | "payTo";

export interface SettlementPage {
  readonly items: readonly SettlementRow[];
  readonly nextCursor: string | null;
}

export interface AssetTotal {
  readonly role: "payer" | "payTo";
  readonly assetContract: string;
  readonly assetCode: string | null;
  readonly assetIssuer: string | null;
  readonly assetVerified: boolean;
  readonly payments: number;
  /** Atomic units of this asset. */
  readonly volume: string;
  readonly firstAt: string;
  readonly lastAt: string;
}

/** An account's totals: at most `TOTALS_PER_SIDE` assets per side, and how many more each side has. */
export interface AccountTotals {
  readonly items: readonly AssetTotal[];
  readonly more: { readonly payer: number; readonly payTo: number };
}

/**
 * The filters of the payments list. Without `facilitator` or `shaped` it lists attributed payments (the
 * rail402 and facilitator tiers); `facilitator` lists one registry facilitator's, `shaped` the
 * unattributed x402-shaped ones, which are never mixed into the attributed list.
 */
export interface PaymentFilter {
  readonly facilitator?: string;
  readonly shaped?: boolean;
  readonly scheme?: "exact" | "upto";
  /** An asset contract (C…). */
  readonly asset?: string;
  /** Only payments in this ledger or later (the first ledger of a time window). */
  readonly fromLedger?: number;
  /**
   * The time window `fromLedger` was computed from (`24h`, `7d`, `30d`): a cursor is bound to the
   * window, not to the ledger, which moves as time passes.
   */
  readonly window?: string;
}

/** What a seller (payTo) received in an epoch, from the indexed rows. */
export interface SellerSummary {
  readonly exact: number;
  readonly upto: number;
  readonly payers: number;
}

/** Received payments and the last one, per payTo address. */
export interface SellerTotal {
  readonly payments: number;
  readonly lastAt: string;
}

/** Assets listed per side of an account's totals. */
export const TOTALS_PER_SIDE = 100;

/** How long the reader trusts its last answer to whether an epoch's ledgers are all under the current rules. */
const RULES_CHECK_MS = 10_000;

const POSTGRES_TIMEOUT = "57014";

/**
 * A database failure as the Explorer reports it: a statement that ran into the reader role's timeout,
 * or a connection that failed, is `explorer_unavailable` (retryable). Nothing about the database
 * reaches the caller.
 */
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

/**
 * The public pages' reads. Every list is keyset-paginated newest first on an indexed column, every
 * page has at most 100 rows, and the reader role bounds each statement's time.
 *
 * Only rows classified under the rules this build runs (`RULES_VERSION`) are read. A row of other rules
 * can name a payer those rules never proved; it stays hidden until the indexer reads its ledger again
 * (when it starts, for its current epoch), and a row of an epoch it no longer indexes stays hidden.
 * The account totals the indexer keeps cover every stored row, so they are read only while every indexed
 * ledger of the epoch is under the current rules.
 */
export class ExplorerReader {
  readonly #db: Kysely<ExplorerDatabase>;
  readonly #now: () => number;
  readonly #rulesChecked = new Map<string, { readonly at: number; readonly current: boolean }>();

  constructor(db: Kysely<ExplorerDatabase>, options: { readonly now?: () => number } = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
  }

  /** The settlements table, limited to rows of the current rules. */
  #settlements() {
    return this.#db.selectFrom("settlements").where("rules_version", "=", RULES_VERSION);
  }

  /**
   * Whether every indexed ledger of `epoch` was classified under the current rules, so that the totals
   * kept for it count no row of other rules. Asked at most once per `RULES_CHECK_MS` per epoch.
   */
  async #rulesCurrent(network: IndexNetwork, epoch: string): Promise<boolean> {
    const key = `${network}:${epoch}`;
    const now = this.#now();
    const known = this.#rulesChecked.get(key);
    if (known !== undefined && now - known.at < RULES_CHECK_MS) return known.current;
    const stale = await guarded(() =>
      this.#db
        .selectFrom("indexed_ledgers")
        .select("ledger")
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .where("status", "=", "indexed")
        .where((eb) => eb.or([eb("rules_version", "is", null), eb("rules_version", "<>", RULES_VERSION)]))
        .limit(1)
        .executeTakeFirst(),
    );
    const current = stale === undefined;
    this.#rulesChecked.set(key, { at: now, current });
    return current;
  }

  /** The settlement whose outer or inner hash is `hash`, in any of `epochs` (newest epoch first). */
  async settlement(
    network: IndexNetwork,
    epochs: readonly string[],
    hash: string,
  ): Promise<SettlementRow | undefined> {
    const row = await guarded(() =>
      this.#settlements()
        .selectAll()
        .where("network", "=", network)
        .where("epoch", "in", [...epochs])
        .where((eb) => eb.or([eb("tx_hash", "=", hash), eb("inner_hash", "=", hash)]))
        .orderBy("epoch", "desc")
        .limit(1)
        .executeTakeFirst(),
    );
    return row === undefined ? undefined : settlementFromRow(row);
  }

  /** A failed transaction with the shape of a settlement, by its hash. */
  async failedAttempt(
    network: IndexNetwork,
    epochs: readonly string[],
    hash: string,
  ): Promise<FailedAttemptRow | undefined> {
    const row = await guarded(() =>
      this.#db
        .selectFrom("failed_attempts")
        .selectAll()
        .where("network", "=", network)
        .where("epoch", "in", [...epochs])
        .where("tx_hash", "=", hash)
        .orderBy("epoch", "desc")
        .limit(1)
        .executeTakeFirst(),
    );
    if (row === undefined) return undefined;
    return {
      network: row.network as IndexNetwork,
      epoch: row.epoch,
      ledger: Number(row.ledger),
      txIndex: row.tx_index,
      txHash: row.tx_hash,
      scheme: row.scheme,
      resultCode: row.result_code,
      feePayer: row.fee_payer,
      feeChargedStroops: row.fee_charged,
    };
  }

  /** An account's settlements in `epoch`, as payer, as seller or both, newest first. */
  async accountSettlements(
    network: IndexNetwork,
    epoch: string,
    address: string,
    role: AccountRole,
    page: Keyset,
    muxedId?: string,
  ): Promise<SettlementPage> {
    const list = accountList(network, epoch, address, role, muxedId);
    const side = (column: "payer" | "pay_to") =>
      this.#page(
        this.#settlements()
          .selectAll()
          .where("network", "=", network)
          .where(column, "=", address)
          .where("epoch", "=", epoch)
          .$if(column === "pay_to" && muxedId !== undefined, (query) =>
            query.where("pay_to_muxed_id", "=", muxedId ?? ""),
          ),
        page,
      );
    const sides =
      role === "payer"
        ? [await side("payer")]
        : role === "payTo"
          ? [await side("pay_to")]
          : await Promise.all([side("payer"), side("pay_to")]);
    const merged = new Map<string, SettlementRow>();
    for (const row of sides.flat()) merged.set(row.txHash, row);
    return pageOf(list, [...merged.values()].sort(newestFirst), page.limit);
  }

  /**
   * Totals per asset of an account in `epoch`, as payer and as seller: indexed reads of the totals the
   * indexer maintains, never an aggregate over the account's history. Each side lists at most
   * `TOTALS_PER_SIDE` assets, verified Stellar assets first, then by payments, so payments in throwaway
   * tokens can neither push the other side off the page nor hide a verified asset behind custom ones;
   * `more` counts the assets left out per side. Empty while the epoch holds ledgers of other rules.
   */
  async accountTotals(network: IndexNetwork, epoch: string, address: string): Promise<AccountTotals> {
    if (!(await this.#rulesCurrent(network, epoch))) return { items: [], more: { payer: 0, payTo: 0 } };
    const side = (role: "payer" | "payTo") =>
      guarded(async () => {
        const [rows, counted] = await Promise.all([
          this.#db
            .selectFrom("account_totals")
            .selectAll()
            .where("network", "=", network)
            .where("epoch", "=", epoch)
            .where("address", "=", address)
            .where("role", "=", role)
            .orderBy("asset_verified", "desc")
            .orderBy("payments", "desc")
            .orderBy("asset_contract")
            .limit(TOTALS_PER_SIDE)
            .execute(),
          this.#db
            .selectFrom("account_totals")
            .select(sql<string>`count(*)`.as("count"))
            .where("network", "=", network)
            .where("epoch", "=", epoch)
            .where("address", "=", address)
            .where("role", "=", role)
            .executeTakeFirst(),
        ]);
        return { rows, more: Math.max(0, Number(counted?.count ?? 0) - rows.length) };
      });
    const [paid, received] = await Promise.all([side("payer"), side("payTo")]);
    return {
      items: [...paid.rows, ...received.rows].map((row): AssetTotal => ({
        role: row.role,
        assetContract: row.asset_contract,
        assetCode: row.asset_code,
        assetIssuer: row.asset_issuer,
        assetVerified: row.asset_verified,
        payments: Number(row.payments),
        volume: row.volume,
        firstAt: new Date(row.first_at).toISOString(),
        lastAt: new Date(row.last_at).toISOString(),
      })),
      more: { payer: paid.more, payTo: received.more },
    };
  }

  /** A facilitator's settlements in `epoch`, newest first. */
  async facilitatorSettlements(
    network: IndexNetwork,
    epoch: string,
    id: string,
    page: Keyset,
  ): Promise<SettlementPage> {
    const rows = await this.#page(
      this.#settlements()
        .selectAll()
        .where("network", "=", network)
        .where("facilitator_id", "=", id)
        .where("epoch", "=", epoch),
      page,
    );
    return pageOf(facilitatorList(network, epoch, id), rows, page.limit);
  }

  /** Payments newest first under `filter` (see `PaymentFilter`), every page at most 100 rows. */
  async payments(
    network: IndexNetwork,
    epoch: string,
    filter: PaymentFilter,
    page: Keyset,
  ): Promise<SettlementPage> {
    const rows = await this.#page(
      this.#settlements()
        .selectAll()
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .$if(filter.facilitator !== undefined, (q) =>
          q.where("facilitator_id", "=", filter.facilitator ?? ""),
        )
        .$if(filter.facilitator === undefined && filter.shaped === true, (q) =>
          q.where("tier", "=", "shaped"),
        )
        .$if(filter.facilitator === undefined && filter.shaped !== true, (q) =>
          q.where("tier", "in", ["rail402", "facilitator"]),
        )
        .$if(filter.scheme !== undefined, (q) => q.where("scheme", "=", filter.scheme ?? "exact"))
        .$if(filter.asset !== undefined, (q) => q.where("asset_contract", "=", filter.asset ?? ""))
        .$if(filter.fromLedger !== undefined, (q) => q.where("ledger", ">=", String(filter.fromLedger ?? 0))),
      page,
    );
    return pageOf(paymentsList(network, epoch, filter), rows, page.limit);
  }

  /**
   * The first ledger of `epoch` that holds a row closed at or after `since`, through the close-time
   * index; null when no row is that recent. Ledger order and close time agree, so a time window becomes
   * a ledger bound the position index can use.
   */
  async firstLedgerSince(network: IndexNetwork, epoch: string, since: string): Promise<number | null> {
    const row = await guarded(() =>
      this.#settlements()
        .select("ledger")
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .where("closed_at", ">=", new Date(since))
        .orderBy("closed_at", "asc")
        .limit(1)
        .executeTakeFirst(),
    );
    return row === undefined ? null : Number(row.ledger);
  }

  /** The settlements whose outer or inner hash is one of `hashes` (at most 100), newest first. */
  async settlementsByHash(
    network: IndexNetwork,
    epochs: readonly string[],
    hashes: readonly string[],
  ): Promise<SettlementRow[]> {
    const wanted = [...new Set(hashes)].slice(0, 100);
    if (wanted.length === 0) return [];
    const rows = await guarded(() =>
      this.#settlements()
        .selectAll()
        .where("network", "=", network)
        .where("epoch", "in", [...epochs])
        .where((eb) => eb.or([eb("tx_hash", "in", wanted), eb("inner_hash", "in", wanted)]))
        .orderBy("ledger", "desc")
        .orderBy("tx_index", "desc")
        .limit(100)
        .execute(),
    );
    return rows.map((row) => settlementFromRow(row));
  }

  /** Payments a payTo address received in `epoch` by scheme, and its distinct payers. */
  async sellerSummary(network: IndexNetwork, epoch: string, payTo: string): Promise<SellerSummary> {
    // The indexer keeps these counts with the account totals: a view reads one row, never the
    // seller's settlements. Like the totals, they count every stored row, so they are read only while
    // every indexed ledger of the epoch is under the current rules.
    if (!(await this.#rulesCurrent(network, epoch))) return { exact: 0, upto: 0, payers: 0 };
    const row = await guarded(() =>
      this.#db
        .selectFrom("seller_summaries")
        .select(["exact", "upto", "payers"])
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .where("pay_to", "=", payTo)
        .executeTakeFirst(),
    );
    return { exact: Number(row?.exact ?? 0), upto: Number(row?.upto ?? 0), payers: Number(row?.payers ?? 0) };
  }

  /** The newest upto payments a payTo address received in `epoch`. */
  async uptoReceived(
    network: IndexNetwork,
    epoch: string,
    payTo: string,
    limit: number,
  ): Promise<SettlementRow[]> {
    const rows = await guarded(() =>
      this.#settlements()
        .selectAll()
        .where("network", "=", network)
        .where("pay_to", "=", payTo)
        .where("epoch", "=", epoch)
        .where("scheme", "=", "upto")
        .orderBy("ledger", "desc")
        .orderBy("tx_index", "desc")
        .limit(Math.min(100, limit))
        .execute(),
    );
    return rows.map((row) => settlementFromRow(row));
  }

  /**
   * Payments received and the last one per payTo address in `epoch`, from the totals the indexer keeps
   * (every asset, every tier). At most 500 addresses. Empty while the epoch holds ledgers of other rules.
   */
  async sellerTotals(
    network: IndexNetwork,
    epoch: string,
    addresses: readonly string[],
  ): Promise<ReadonlyMap<string, SellerTotal>> {
    const wanted = [...new Set(addresses)].slice(0, 500);
    if (wanted.length === 0 || !(await this.#rulesCurrent(network, epoch))) return new Map();
    const rows = await guarded(() =>
      this.#db
        .selectFrom("account_totals")
        .select(["address", sql<string>`sum(payments)`.as("payments"), sql<Date>`max(last_at)`.as("last_at")])
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .where("role", "=", "payTo")
        .where("address", "in", wanted)
        .groupBy("address")
        .execute(),
    );
    return new Map(
      rows.map((row) => [
        row.address,
        { payments: Number(row.payments), lastAt: new Date(row.last_at).toISOString() },
      ]),
    );
  }

  async ping(): Promise<void> {
    await guarded(() => sql`SELECT 1`.execute(this.#db));
  }

  /** Up to `limit + 1` rows after the keyset position, newest first. */
  async #page(query: SettlementQuery, page: Keyset): Promise<SettlementRow[]> {
    const after = page.after;
    const rows = await guarded(() =>
      query
        .$if(after !== undefined, (q) =>
          q.where(
            sql<boolean>`(ledger, tx_index) < (${after?.ledger ?? 0}::bigint, ${after?.txIndex ?? 0}::integer)`,
          ),
        )
        .orderBy("ledger", "desc")
        .orderBy("tx_index", "desc")
        .limit(page.limit + 1)
        .execute(),
    );
    return rows.map((row) => settlementFromRow(row));
  }
}

const newestFirst = (a: SettlementRow, b: SettlementRow) => b.ledger - a.ledger || b.txIndex - a.txIndex;

function pageOf(list: string, rows: readonly SettlementRow[], limit: number): SettlementPage {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor(list, { ledger: last.ledger, txIndex: last.txIndex })
        : null,
  };
}

/** The name a cursor of an account list is bound to. */
export const accountList = (
  network: string,
  epoch: string,
  address: string,
  role: AccountRole,
  muxedId?: string,
) => `account:${network}:${epoch}:${address}:${role}:${muxedId ?? ""}`;

/** The name a cursor of the payments list is bound to: its filters. */
export const paymentsList = (network: string, epoch: string, filter: PaymentFilter) =>
  `payments:${network}:${epoch}:${filter.facilitator ?? ""}:${filter.shaped === true ? "shaped" : ""}:${filter.scheme ?? ""}:${filter.asset ?? ""}:${filter.window ?? String(filter.fromLedger ?? "")}`;

/** The name a cursor of a facilitator list is bound to. */
export const facilitatorList = (network: string, epoch: string, id: string) =>
  `facilitator:${network}:${epoch}:${id}`;
