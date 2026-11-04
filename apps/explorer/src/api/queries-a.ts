import { sql, type Kysely } from "kysely";
import { RULES_VERSION, type IndexNetwork, type SettlementRow } from "@rail402.dev/x402-index";
import type { ExplorerDatabase } from "../db.ts";
import { settlementFromRow } from "../store.ts";
import { explorerError } from "./paging.ts";

/**
 * The reads of the overview, search and account pages, beside `ExplorerReader`. Each one is bounded:
 * a day range of the daily totals, a time window on the close-time index, a key range on a primary key,
 * or a row limit, and each reads only rows of the current rules (`RULES_VERSION`). Totals the indexer
 * keeps (daily and account totals) count every stored row, so they are read only while every indexed
 * ledger of the epoch is under the current rules.
 */

type Db = Kysely<ExplorerDatabase>;

/** The tiers the headline counts: registered facilitators, Rail402 included. */
const HEADLINE = ["rail402", "facilitator"] as const;
/** The headline tiers and the concluded beta: every payment a registry facilitator settled. */
const REGISTERED = ["rail402", "facilitator", "rail402-beta"] as const;

/** The database behind the pages' reader, or undefined for a reader without one (tests). */
export function readerDatabase(reader: object): Db | undefined {
  const database = (reader as { readonly database?: unknown }).database;
  return "database" in reader && database !== undefined ? (database as Db) : undefined;
}

/** A database failure as `explorer_unavailable`, like the reader's own reads. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw explorerError("explorer_unavailable", { cause: error });
  }
}

/** Answers kept for `ms`, per key: aggregates that change only as ledgers are indexed. */
class Memo<T> {
  readonly #ms: number;
  readonly #entries = new Map<string, { readonly at: number; readonly value: Promise<T> }>();
  constructor(ms: number) {
    this.#ms = ms;
  }
  get(key: string, now: number, run: () => Promise<T>): Promise<T> {
    const known = this.#entries.get(key);
    if (known !== undefined && now - known.at < this.#ms) return known.value;
    if (this.#entries.size > 64) this.#entries.clear();
    const value = run();
    this.#entries.set(key, { at: now, value });
    value.catch(() => this.#entries.delete(key));
    return value;
  }
}

const rulesMemo = new Memo<boolean>(10_000);

/** Whether every indexed ledger of `epoch` is under the current rules (asked at most every 10 s). */
export function rulesCurrent(
  db: Db,
  network: IndexNetwork,
  epoch: string,
  now = Date.now(),
): Promise<boolean> {
  return rulesMemo.get(`${network}:${epoch}`, now, async () => {
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
    return stale === undefined;
  });
}

// --- overview ----------------------------------------------------------------------------------------

/** The newest indexed ledger and whether candidate ledgers still wait to be read. */
export interface IndexState {
  readonly ledger: number | null;
  readonly closedAt: string | null;
  readonly pending: boolean;
}

export async function indexState(db: Db, network: IndexNetwork, epoch: string): Promise<IndexState> {
  const [latest, pending] = await guarded(() =>
    Promise.all([
      db
        .selectFrom("indexed_ledgers")
        .select(["ledger", "closed_at"])
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .where("status", "=", "indexed")
        .orderBy("ledger", "desc")
        .limit(1)
        .executeTakeFirst(),
      db
        .selectFrom("indexed_ledgers")
        .select("ledger")
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .where("status", "<>", "indexed")
        .limit(1)
        .executeTakeFirst(),
    ]),
  );
  return {
    ledger: latest === undefined ? null : Number(latest.ledger),
    closedAt:
      latest === undefined || latest.closed_at === null ? null : new Date(latest.closed_at).toISOString(),
    pending: pending !== undefined,
  };
}

/** Payments per UTC day, facilitator and scheme, and the volume of one asset. */
export interface DailyFacilitator {
  readonly day: string;
  readonly facilitator: string;
  readonly scheme: string;
  readonly payments: number;
  /** Atomic units of the asset asked for. */
  readonly volume: bigint;
}

/**
 * Registered facilitators' payments (the concluded beta included, self-payments left out) per day of
 * `from`…`to` (UTC days, inclusive), from the daily totals the indexer keeps. Empty while the epoch
 * holds ledgers of other rules.
 */
export async function dailyByFacilitator(
  db: Db,
  network: IndexNetwork,
  epoch: string,
  from: string,
  to: string,
  asset: string | undefined,
): Promise<DailyFacilitator[]> {
  if (!(await rulesCurrent(db, network, epoch))) return [];
  const rows = await guarded(() =>
    db
      .selectFrom("daily_aggregates")
      .select([
        sql<string>`to_char(day, 'YYYY-MM-DD')`.as("d"),
        "facilitator_id",
        "scheme",
        sql<string>`sum(payments)`.as("payments"),
        sql<string>`coalesce(sum(volume) filter (where asset_contract = ${asset ?? ""}), 0)`.as("volume"),
      ])
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .where("day", ">=", from)
      .where("day", "<=", to)
      .where("tier", "in", [...REGISTERED])
      .where("self_payment", "=", false)
      .groupBy(["day", "facilitator_id", "scheme"])
      .execute(),
  );
  return rows.map((row) => ({
    day: row.d,
    facilitator: row.facilitator_id,
    scheme: row.scheme,
    payments: Number(row.payments),
    volume: BigInt(row.volume),
  }));
}

/** The first UTC day with a registered payment in the epoch, from the daily totals. */
export async function firstPaymentDay(db: Db, network: IndexNetwork, epoch: string): Promise<string | null> {
  const row = await guarded(() =>
    db
      .selectFrom("daily_aggregates")
      .select(sql<string>`to_char(day, 'YYYY-MM-DD')`.as("d"))
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .orderBy("day", "asc")
      .limit(1)
      .executeTakeFirst(),
  );
  return row?.d ?? null;
}

/** Distinct buyers and sellers per UTC day, and the last 24 hours' totals before `end`. */
export interface Actors {
  readonly days: ReadonlyMap<string, { readonly buyers: number; readonly sellers: number }>;
  readonly last24h: {
    readonly payments: number;
    readonly volume: bigint;
    readonly buyers: number;
    readonly sellers: number;
  };
}

/**
 * Headline payments closed in `since`…`end`, through the close-time index: distinct buyers and sellers
 * per day, and the 24 hours before `end`.
 */
export async function actors(
  db: Db,
  network: IndexNetwork,
  epoch: string,
  since: string,
  end: string,
  asset: string | undefined,
): Promise<Actors> {
  const dayStart = new Date(Date.parse(end) - 86_400_000);
  const base = () =>
    db
      .selectFrom("settlements")
      .where("rules_version", "=", RULES_VERSION)
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .where("closed_at", ">=", new Date(since))
      .where("closed_at", "<=", new Date(end))
      .where("tier", "in", [...HEADLINE])
      .whereRef("payer", "<>", "pay_to");
  const [days, last] = await guarded(() =>
    Promise.all([
      base()
        .select([
          sql<string>`to_char(closed_at at time zone 'UTC', 'YYYY-MM-DD')`.as("d"),
          sql<string>`count(distinct payer)`.as("buyers"),
          sql<string>`count(distinct pay_to)`.as("sellers"),
        ])
        .groupBy("d")
        .execute(),
      base()
        .where("closed_at", ">", dayStart)
        .select([
          sql<string>`count(*)`.as("payments"),
          sql<string>`coalesce(sum(amount) filter (where asset_contract = ${asset ?? ""}), 0)`.as("volume"),
          sql<string>`count(distinct payer)`.as("buyers"),
          sql<string>`count(distinct pay_to)`.as("sellers"),
        ])
        .executeTakeFirst(),
    ]),
  );
  return {
    days: new Map(days.map((row) => [row.d, { buyers: Number(row.buyers), sellers: Number(row.sellers) }])),
    last24h: {
      payments: Number(last?.payments ?? 0),
      volume: BigInt(last?.volume ?? 0),
      buyers: Number(last?.buyers ?? 0),
      sellers: Number(last?.sellers ?? 0),
    },
  };
}

/** Who paid the network fees of the headline payments. */
export interface Fees {
  readonly payments: number;
  /** Payments whose fee a facilitator paid, and the stroops it paid. */
  readonly sponsored: number;
  readonly sponsoredStroops: bigint;
  /** Stroops buyers paid themselves. */
  readonly buyerStroops: bigint;
}

const feesMemo = new Memo<Fees>(300_000);

/**
 * Fees of the epoch's headline payments, kept five minutes per network: one pass over the epoch's
 * rows on the position index, which the reader's statement timeout bounds.
 */
export function fees(db: Db, network: IndexNetwork, epoch: string, now = Date.now()): Promise<Fees> {
  return feesMemo.get(`${network}:${epoch}`, now, async () => {
    const row = await guarded(() =>
      db
        .selectFrom("settlements")
        .select([
          sql<string>`count(*)`.as("payments"),
          sql<string>`count(*) filter (where sponsored)`.as("sponsored"),
          sql<string>`coalesce(sum(fee_charged) filter (where sponsored), 0)`.as("sponsored_fees"),
          sql<string>`coalesce(sum(fee_charged) filter (where not sponsored), 0)`.as("buyer_fees"),
        ])
        .where("rules_version", "=", RULES_VERSION)
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .where("tier", "in", [...HEADLINE])
        .whereRef("payer", "<>", "pay_to")
        .executeTakeFirst(),
    );
    return {
      payments: Number(row?.payments ?? 0),
      sponsored: Number(row?.sponsored ?? 0),
      sponsoredStroops: BigInt(row?.sponsored_fees ?? 0),
      buyerStroops: BigInt(row?.buyer_fees ?? 0),
    };
  });
}

/** An account of a top list: its payments on that side, the asset's volume, and its counterparties. */
export interface TopAccount {
  readonly address: string;
  readonly payments: number;
  readonly volume: bigint;
  /** Distinct buyers of a seller; undefined for buyers. */
  readonly buyers: number | undefined;
}

const topMemo = new Memo<TopAccount[]>(60_000);

/**
 * The accounts (at most ten) with the most payments on one side, from the account totals (every tier), kept a
 * minute. Empty while the epoch holds ledgers of other rules.
 */
export function topAccounts(
  db: Db,
  network: IndexNetwork,
  epoch: string,
  role: "payer" | "payTo",
  asset: string | undefined,
  now = Date.now(),
  limit = 5,
): Promise<TopAccount[]> {
  return topMemo.get(`${network}:${epoch}:${role}:${String(limit)}`, now, async () => {
    if (!(await rulesCurrent(db, network, epoch, now))) return [];
    const rows = await guarded(() =>
      db
        .selectFrom("account_totals")
        .select([
          "address",
          sql<string>`sum(payments)`.as("payments"),
          sql<string>`coalesce(sum(volume) filter (where asset_contract = ${asset ?? ""}), 0)`.as("volume"),
        ])
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .where("role", "=", role)
        .groupBy("address")
        .orderBy(sql`sum(payments)`, "desc")
        .orderBy("address")
        .limit(Math.min(10, limit))
        .execute(),
    );
    const payers =
      role === "payTo" && rows.length > 0
        ? await guarded(() =>
            db
              .selectFrom("seller_summaries")
              .select(["pay_to", "payers"])
              .where("network", "=", network)
              .where("epoch", "=", epoch)
              .where(
                "pay_to",
                "in",
                rows.map((row) => row.address),
              )
              .execute(),
          )
        : [];
    const byPayTo = new Map(payers.map((row) => [row.pay_to, Number(row.payers)]));
    return rows.map((row) => ({
      address: row.address,
      payments: Number(row.payments),
      volume: BigInt(row.volume),
      buyers: role === "payTo" ? (byPayTo.get(row.address) ?? 0) : undefined,
    }));
  });
}

// --- search ------------------------------------------------------------------------------------------

/** Results a search group reads at most. */
export const SEARCH_LIMIT = 50;

/**
 * The upper bound of a key range holding every string that starts with `prefix`, over the ordered
 * `alphabet` its characters come from; undefined when no bound is needed (the prefix is all maximal).
 */
export function prefixUpperBound(prefix: string, alphabet: string): string | undefined {
  for (let index = prefix.length - 1; index >= 0; index--) {
    const at = alphabet.indexOf(prefix[index] ?? "");
    if (at >= 0 && at < alphabet.length - 1) return `${prefix.slice(0, index)}${alphabet[at + 1] ?? ""}`;
  }
  return undefined;
}

const HEX = "0123456789abcdef";
/** Strkey characters in database order: digits sort before letters. */
const BASE32 = "234567ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Payments whose hash starts with `prefix` (lower-case hex), newest first, on the primary key. */
export async function paymentsByHashPrefix(
  db: Db,
  network: IndexNetwork,
  epoch: string,
  prefix: string,
): Promise<SettlementRow[]> {
  const upper = prefixUpperBound(prefix, HEX);
  const rows = await guarded(() =>
    db
      .selectFrom("settlements")
      .selectAll()
      .where("rules_version", "=", RULES_VERSION)
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .where("tx_hash", ">=", prefix)
      .$if(upper !== undefined, (q) => q.where("tx_hash", "<", upper ?? ""))
      .limit(SEARCH_LIMIT)
      .execute(),
  );
  return rows
    .map((row) => settlementFromRow(row))
    .filter((row) => row.txHash.startsWith(prefix))
    .sort((a, b) => b.ledger - a.ledger || b.txIndex - a.txIndex);
}

/** An account a search found: what it received and paid in the epoch. */
export interface FoundAccount {
  readonly address: string;
  readonly received: number;
  readonly paid: number;
}

/**
 * Accounts whose address starts with `part` (a key range of the account totals' primary key) or, for
 * four characters or more, ends with it (a scan of the epoch's totals the limit and the reader's
 * statement timeout bound). Upper-case strkey characters only.
 */
export async function accountsByPart(
  db: Db,
  network: IndexNetwork,
  epoch: string,
  part: string,
): Promise<FoundAccount[]> {
  if (!(await rulesCurrent(db, network, epoch))) return [];
  const upper = prefixUpperBound(part, BASE32);
  const select = () =>
    db
      .selectFrom("account_totals")
      .select([
        "address",
        sql<string>`coalesce(sum(payments) filter (where role = 'payTo'), 0)`.as("received"),
        sql<string>`coalesce(sum(payments) filter (where role = 'payer'), 0)`.as("paid"),
      ])
      .where("network", "=", network)
      .where("epoch", "=", epoch);
  const [starts, ends] = await guarded(() =>
    Promise.all([
      select()
        .where("address", ">=", part)
        .$if(upper !== undefined, (q) => q.where("address", "<", upper ?? ""))
        .groupBy("address")
        .orderBy("address")
        .limit(SEARCH_LIMIT)
        .execute(),
      part.length >= 4
        ? select()
            .where("address", "like", `%${part}`)
            .groupBy("address")
            .orderBy("address")
            .limit(SEARCH_LIMIT)
            .execute()
        : Promise.resolve([]),
    ]),
  );
  const found = new Map<string, FoundAccount>();
  for (const row of [...starts, ...ends]) {
    if (!row.address.startsWith(part) && !row.address.endsWith(part)) continue;
    found.set(row.address, { address: row.address, received: Number(row.received), paid: Number(row.paid) });
  }
  return [...found.values()]
    .sort((a, b) => b.received + b.paid - (a.received + a.paid) || a.address.localeCompare(b.address))
    .slice(0, SEARCH_LIMIT);
}

/** What one address received and paid in the epoch, from the account totals. */
export async function accountCounts(
  db: Db,
  network: IndexNetwork,
  epoch: string,
  address: string,
): Promise<FoundAccount | undefined> {
  if (!(await rulesCurrent(db, network, epoch))) return undefined;
  const row = await guarded(() =>
    db
      .selectFrom("account_totals")
      .select([
        sql<string>`coalesce(sum(payments) filter (where role = 'payTo'), 0)`.as("received"),
        sql<string>`coalesce(sum(payments) filter (where role = 'payer'), 0)`.as("paid"),
      ])
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .where("address", "=", address)
      .executeTakeFirst(),
  );
  const received = Number(row?.received ?? 0);
  const paid = Number(row?.paid ?? 0);
  return received + paid === 0 ? undefined : { address, received, paid };
}

// --- account -----------------------------------------------------------------------------------------

/** Newest rows an account page reads per side: its table pages, cards and bars come from them. */
export const ACCOUNT_SAMPLE = 1_000;

/** An account's newest payments, both sides merged, and whether a side had more. */
export interface AccountSample {
  readonly rows: readonly SettlementRow[];
  /** A side held more rows than `ACCOUNT_SAMPLE`: older payments are not in `rows`. */
  readonly capped: boolean;
  /** The account's first payment in the epoch (either side), on the payer and payTo indexes. */
  readonly first: { readonly ledger: number; readonly closedAt: string } | undefined;
}

/**
 * The newest payments of an account, on the payer and payTo indexes: as payer, as seller (a muxed id
 * filters the receiving side), and, for a registered fee-paying account, the payments of `feePaidFor`
 * (its facilitator) whose fee it paid, on the facilitator index.
 */
export async function accountSample(
  db: Db,
  network: IndexNetwork,
  epoch: string,
  address: string,
  options: {
    readonly sides: readonly ("payer" | "payTo")[];
    readonly muxedId?: string | undefined;
    readonly feePaidFor?: string | undefined;
  },
): Promise<AccountSample> {
  const base = () =>
    db
      .selectFrom("settlements")
      .selectAll()
      .where("rules_version", "=", RULES_VERSION)
      .where("network", "=", network)
      .where("epoch", "=", epoch);
  const newest = (column: "payer" | "pay_to") =>
    base()
      .where(column, "=", address)
      .$if(column === "pay_to" && options.muxedId !== undefined, (q) =>
        q.where("pay_to_muxed_id", "=", options.muxedId ?? ""),
      )
      .orderBy("ledger", "desc")
      .orderBy("tx_index", "desc")
      .limit(ACCOUNT_SAMPLE + 1)
      .execute();
  const oldest = (column: "payer" | "pay_to") =>
    db
      .selectFrom("settlements")
      .select(["ledger", "closed_at"])
      .where("rules_version", "=", RULES_VERSION)
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .where(column, "=", address)
      .orderBy("ledger", "asc")
      .limit(1)
      .executeTakeFirst();
  const lists = await guarded(() =>
    Promise.all([
      options.sides.includes("payer") ? newest("payer") : Promise.resolve([]),
      options.sides.includes("payTo") ? newest("pay_to") : Promise.resolve([]),
      options.feePaidFor === undefined
        ? Promise.resolve([])
        : base()
            .where("facilitator_id", "=", options.feePaidFor)
            .where("fee_payer", "=", address)
            .orderBy("ledger", "desc")
            .orderBy("tx_index", "desc")
            .limit(ACCOUNT_SAMPLE + 1)
            .execute(),
    ]),
  );
  const firsts = await guarded(() =>
    Promise.all([
      options.sides.includes("payer") ? oldest("payer") : Promise.resolve(undefined),
      options.sides.includes("payTo") ? oldest("pay_to") : Promise.resolve(undefined),
    ]),
  );
  const capped = lists.some((list) => list.length > ACCOUNT_SAMPLE);
  const merged = new Map<string, SettlementRow>();
  for (const list of lists)
    for (const row of list.slice(0, ACCOUNT_SAMPLE)) merged.set(row.tx_hash, settlementFromRow(row));
  const rows = [...merged.values()].sort((a, b) => b.ledger - a.ledger || b.txIndex - a.txIndex);
  const known = firsts
    .filter((entry) => entry !== undefined)
    .sort((a, b) => Number(a.ledger) - Number(b.ledger));
  const earliest = known[0];
  const sampleFirst = rows.at(-1);
  const first =
    earliest !== undefined
      ? { ledger: Number(earliest.ledger), closedAt: new Date(earliest.closed_at).toISOString() }
      : sampleFirst !== undefined && !capped
        ? { ledger: sampleFirst.ledger, closedAt: sampleFirst.closedAt }
        : undefined;
  return { rows, capped, first };
}
