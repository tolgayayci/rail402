import { createHash } from "node:crypto";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import {
  baseAccount,
  checkCandidates,
  mergeCandidates,
  MAX_PROPOSED_OWNERS,
  OWNER_CLAIM_DELAY_MS,
  PRIVATE_USAGE_EXTENSION,
  RESOURCE_ORIGIN_PATTERN,
  groupByResource,
  identityKey,
  narrowOptions,
  optionMatches,
  type CatalogStats,
  type CatalogStore,
  type CatalogTransaction,
  type DomainClaim,
  type ListFilter,
  type Listing,
  type ListingFacts,
  type ListingIdentity,
  type ListingUsage,
  type ListingVersion,
  type Observation,
  type OriginCheck,
  type QuarantineReason,
  type QueuedSettlement,
  type QuotaCount,
  type ResourceListings,
  type SellerUsage,
  type SettledPayment,
  type SettlementLink,
  type VersionCause,
  type VersionPage,
  type CheckCandidate,
} from "@rail402.dev/bazaar";
import type {
  CatalogOutboxTable,
  Database,
  ListingObservationsTable,
  ListingsTable,
  OriginChecksTable,
} from "./database.ts";

/**
 * Bazaar catalog in Postgres. Each catalog transaction holds a transaction-scoped advisory lock on the
 * listing identity, so settlements and origin checks for one listing serialise across every replica,
 * including the race to create a listing that does not exist yet.
 */
export class PostgresCatalogStore implements CatalogStore {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  async transaction<T>(
    key: ListingIdentity | string,
    work: (tx: CatalogTransaction) => Promise<T>,
  ): Promise<T> {
    let identity: ListingIdentity | undefined;
    if (typeof key === "string") {
      identity = (await this.get(key))?.identity;
      if (identity === undefined) return work(this.tx(this.db));
    } else {
      identity = key;
    }
    // Postgres text cannot hold the NUL separators of identityKey; lock on its digest.
    const lock = createHash("sha256").update(identityKey(identity)).digest("hex");
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 402))`.execute(trx);
      return work(this.tx(trx));
    });
  }

  async get(id: string): Promise<Listing | undefined> {
    const row = await this.db.selectFrom("listings").selectAll().where("id", "=", id).executeTakeFirst();
    return row === undefined ? undefined : toListing(row);
  }

  async getMany(ids: readonly string[]): Promise<Listing[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom("listings")
      .selectAll()
      .where("id", "in", [...new Set(ids)])
      .execute();
    return rows.map(toListing);
  }

  async list(filter: ListFilter): Promise<{ items: ResourceListings[]; total: number }> {
    // Rows and total from one snapshot, so a page and its total always agree.
    return this.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (trx) => {
        // A page is a public, unauthenticated read: it may never hold the database for long.
        await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
        return this.listIn(trx, filter);
      });
  }

  private async listIn(
    db: Transaction<Database>,
    filter: ListFilter,
  ): Promise<{ items: ResourceListings[]; total: number }> {
    let query = db.selectFrom("listings").where("state", "=", "published");
    if (filter.asOf !== undefined) query = query.where("listed_at", "<=", filter.asOf);
    if (filter.type !== undefined) query = query.where("kind", "=", filter.type as "http" | "mcp");
    const declared = filter.extensions?.filter((key) => key !== "bazaar") ?? [];
    if (declared.length > 0) {
      query = query.where(
        sql<boolean>`coalesce(content -> 'extensions', '[]'::jsonb) ?& ${declared}::text[]`,
      );
    }
    const { payTo, network, scheme } = filter;
    if (payTo !== undefined || network !== undefined || scheme !== undefined) {
      // A G… or C… filter matches the account and every muxed M… address of it; an M… filter
      // matches only that muxed address.
      const muxed = payTo?.startsWith("M") === true;
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom("listing_options as o")
            .select(sql`1`.as("one"))
            .whereRef("o.listing_id", "=", "listings.id")
            .$if(payTo !== undefined, (q) =>
              q.where(muxed ? "o.pay_to" : "o.pay_to_account", "=", payTo ?? ""),
            )
            .$if(network !== undefined, (q) => q.where("o.network", "=", network ?? ""))
            .$if(scheme !== undefined, (q) => q.where("o.scheme", "=", scheme ?? "")),
        ),
      );
    }
    // A resource is its matching listings on every network, placed where the first of them was published.
    const resource = ["kind", "resource", "method", "tool_name", "scope"] as const;
    const resources = query
      .select(resource)
      .select((eb) => [eb.fn.min("listed_at").as("first_listed"), eb.fn.min("sequence").as("first_sequence")])
      .groupBy(resource);
    const [page, count] = await Promise.all([
      resources
        .orderBy("first_listed")
        .orderBy("first_sequence")
        .limit(filter.limit)
        .offset(filter.offset)
        .execute(),
      db
        .selectFrom(resources.as("r"))
        .select((eb) => eb.fn.countAll<string>().as("total"))
        .executeTakeFirstOrThrow(),
    ]);
    const rows =
      page.length === 0
        ? []
        : await query
            .selectAll()
            .where((eb) =>
              eb.or(
                page.map((key) =>
                  eb.and([
                    eb("kind", "=", key.kind),
                    eb("resource", "=", key.resource),
                    eb("method", "=", key.method),
                    eb("tool_name", "=", key.tool_name),
                    eb("scope", "=", key.scope),
                  ]),
                ),
              ),
            )
            .orderBy("listed_at")
            .orderBy("sequence")
            .execute();
    const listings = rows.map((row) =>
      narrowOptions(toListing(row), (option) => optionMatches(option, filter)),
    );
    return { items: groupByResource(listings), total: Number(count.total) };
  }

  async versions(id: string, page?: VersionPage): Promise<ListingVersion[]> {
    const query = (db: Kysely<Database> | Transaction<Database>) =>
      db.selectFrom("listing_versions").selectAll().where("listing_id", "=", id).orderBy("version");
    const rows =
      page === undefined
        ? await query(this.db).execute()
        : await this.db.transaction().execute(async (trx) => {
            // A page of history is a public, unauthenticated read: it may never hold the database for long.
            await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
            return query(trx)
              .where("version", ">", page.after ?? 0)
              .limit(page.limit)
              .execute();
          });
    return rows.map((row) => ({
      listingId: row.listing_id,
      version: row.version,
      createdAt: new Date(row.created_at),
      cause: row.cause as VersionCause,
      ...(row.transaction === null ? {} : { transaction: row.transaction }),
      owner: row.owner,
      trust: row.trust as Listing["trust"],
      state: row.state as Listing["state"],
      ...(row.reason === null ? {} : { reason: row.reason as QuarantineReason }),
      content: row.content,
    }));
  }

  async published(): Promise<{ revision: number; listings: Listing[] }> {
    // One snapshot for both, so the listings are exactly those of the revision.
    return this.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (trx) => {
        const revision = await this.revisionIn(trx);
        const rows = await trx
          .selectFrom("listings")
          .selectAll()
          .where("state", "=", "published")
          .orderBy("listed_at")
          .orderBy("sequence")
          .execute();
        return { revision, listings: rows.map(toListing) };
      });
  }

  async scanPublished(visit: (batch: readonly Listing[]) => void, batchSize = 500): Promise<number> {
    const size = Math.max(1, Math.floor(batchSize));
    // One snapshot for the revision and every batch, read through a cursor so only one batch of rows
    // is in memory at a time. Each fetch is bounded in time, like every other unauthenticated read.
    return this.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (trx) => {
        await sql`SET LOCAL statement_timeout = '15s'`.execute(trx);
        const revision = await this.revisionIn(trx);
        await sql`DECLARE published_scan NO SCROLL CURSOR FOR
          SELECT * FROM listings WHERE state = 'published' ORDER BY listed_at, sequence`.execute(trx);
        for (;;) {
          const { rows } = await sql<
            Selectable<ListingsTable>
          >`FETCH ${sql.raw(String(size))} FROM published_scan`.execute(trx);
          if (rows.length > 0) visit(rows.map(toListing));
          if (rows.length < size) break;
        }
        await sql`CLOSE published_scan`.execute(trx);
        return revision;
      });
  }

  async staleFacts(limit: number, before: Date, network?: string): Promise<Listing[]> {
    const rows = await this.db
      .selectFrom("listings")
      .selectAll()
      .where("state", "=", "published")
      .$if(network !== undefined, (query) => query.where("network", "=", network ?? ""))
      .where((eb) => eb.or([eb("facts_checked_at", "is", null), eb("facts_checked_at", "<", before)]))
      .orderBy(sql`facts_checked_at NULLS FIRST`)
      .limit(limit)
      .execute();
    return rows.map(toListing);
  }

  async staleFactsNetworks(before: Date): Promise<string[]> {
    const rows = await this.db
      .selectFrom("listings")
      .select("network")
      .distinct()
      .where("state", "=", "published")
      .where((eb) => eb.or([eb("facts_checked_at", "is", null), eb("facts_checked_at", "<", before)]))
      .orderBy("network")
      .execute();
    return rows.map((row) => row.network);
  }

  async publishedNetworks(): Promise<string[]> {
    const rows = await this.db
      .selectFrom("listings")
      .select("network")
      .distinct()
      .where("state", "=", "published")
      .orderBy("network")
      .execute();
    return rows.map((row) => row.network);
  }

  async abandonedListings(before: Date, limit: number): Promise<Listing[]> {
    const rows = await this.db
      .selectFrom("listings")
      .selectAll()
      .where("state", "=", "quarantined")
      .where("listed_at", "is", null)
      .where("last_updated", "<", before)
      .orderBy("last_updated")
      .limit(limit)
      .execute();
    return rows.map(toListing);
  }

  async expiredListings(
    network: string,
    unverifiedBefore: Date,
    idleBefore: Date | undefined,
    limit: number,
  ): Promise<Listing[]> {
    const rows = await this.db
      .selectFrom("listings")
      .selectAll()
      .where("state", "=", "published")
      .where("network", "=", network)
      .where((eb) =>
        eb.or([
          eb.and([eb("trust", "=", "settled"), eb("last_settled_at", "<", unverifiedBefore)]),
          ...(idleBefore === undefined ? [] : [eb("last_settled_at", "<", idleBefore)]),
        ]),
      )
      .orderBy("last_settled_at")
      .limit(limit)
      .execute();
    return rows.map(toListing);
  }

  revision(): Promise<number> {
    return this.revisionIn(this.db);
  }

  private async revisionIn(db: Kysely<Database> | Transaction<Database>): Promise<number> {
    const row = await db.selectFrom("catalog_state").select("revision").executeTakeFirst();
    return Number(row?.revision ?? 0);
  }

  async dueOriginChecks(limit: number, network?: string): Promise<OriginCheck[]> {
    let query = this.db
      .selectFrom("origin_checks")
      .selectAll()
      .select(sql<boolean>`coalesce(retry_at > now(), false)`.as("early"))
      .where("due_at", "<=", sql<Date>`now()`)
      .where((eb) => eb.or([eb("claimed_until", "is", null), eb("claimed_until", "<=", sql<Date>`now()`)]));
    if (network !== undefined) query = query.where("network", "=", network);
    const rows = await query.orderBy("due_at").limit(limit).execute();
    return rows.map(toOriginCheck);
  }

  async claimOriginChecks(limit: number, leaseMs: number, network?: string): Promise<OriginCheck[]> {
    const result = await sql<Selectable<OriginChecksTable> & { early: boolean }>`
      UPDATE origin_checks SET claimed_until = now() + make_interval(secs => ${leaseMs / 1000})
      WHERE listing_id IN (
        SELECT listing_id FROM origin_checks
        WHERE due_at <= now() AND (claimed_until IS NULL OR claimed_until <= now())
          AND (${network ?? null}::text IS NULL OR network = ${network ?? null})
        ORDER BY due_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *, coalesce(retry_at > now(), false) AS early`.execute(this.db);
    return result.rows
      .sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime())
      .map(toOriginCheck);
  }

  async originCheckNetworks(): Promise<string[]> {
    const rows = await this.db
      .selectFrom("origin_checks")
      .select("network")
      .distinct()
      .where("due_at", "<=", sql<Date>`now()`)
      .where((eb) => eb.or([eb("claimed_until", "is", null), eb("claimed_until", "<=", sql<Date>`now()`)]))
      .orderBy("network")
      .execute();
    return rows.map((row) => row.network);
  }

  async deferOriginCheck(
    check: OriginCheck,
    delayMs: number,
    spend = true,
    asked: readonly CheckCandidate[] = [],
  ): Promise<void> {
    // How this run found its candidates is recorded on the row's own, so a candidate a request added
    // meanwhile is kept.
    await this.db
      .updateTable("origin_checks")
      .set(() => ({
        // A run a request made due before its scheduled retry waits for that retry and spends none.
        attempts: sql<number>`attempts + CASE WHEN ${spend}::boolean AND NOT coalesce(retry_at > now(), false)
          THEN 1 ELSE 0 END`,
        due_at: sql<Date>`CASE WHEN ${spend}::boolean AND coalesce(retry_at > now(), false) THEN retry_at
          ELSE now() + make_interval(secs => ${delayMs / 1000}) END`,
        retry_at: sql<Date | null>`CASE WHEN ${spend}::boolean THEN NULL ELSE retry_at END`,
        claimed_until: null,
        candidates: sql<string>`(
          SELECT coalesce(jsonb_agg(
            CASE WHEN found.asked IS NULL THEN kept.candidate
              ELSE (kept.candidate - 'asked') || jsonb_build_object('asked', found.asked) END
            ORDER BY kept.position), '[]'::jsonb)
          FROM jsonb_array_elements(origin_checks.candidates) WITH ORDINALITY AS kept(candidate, position)
          LEFT JOIN LATERAL (
            SELECT mark->'asked' AS asked
            FROM jsonb_array_elements(${JSON.stringify(asked)}::jsonb) AS mark
            WHERE (mark - 'asked') = (kept.candidate - 'asked')
            LIMIT 1
          ) AS found ON true)`,
      }))
      .where("listing_id", "=", check.listingId)
      .where("request_id", "=", check.requestId)
      .execute();
  }

  async completeOriginCheck(check: OriginCheck): Promise<void> {
    const candidates = JSON.stringify(check.candidates ?? []);
    const removed = await this.db
      .deleteFrom("origin_checks")
      .where("listing_id", "=", check.listingId)
      .where("request_id", "=", check.requestId)
      .where(sql<boolean>`candidates = ${candidates}::jsonb`)
      .executeTakeFirst();
    if (removed.numDeletedRows > 0n) return;
    // A request added a candidate while it ran: the check runs again, as a new one.
    await this.db
      .updateTable("origin_checks")
      .set({
        attempts: 0,
        due_at: sql<Date>`now()`,
        claimed_until: null,
        retry_at: null,
        request_id: sql<string>`gen_random_uuid()`,
        candidates: sql<string>`(
          SELECT coalesce(jsonb_agg(candidate - 'asked' ORDER BY position), '[]'::jsonb)
          FROM jsonb_array_elements(origin_checks.candidates) WITH ORDINALITY AS kept(candidate, position))`,
      })
      .where("listing_id", "=", check.listingId)
      .where("request_id", "=", check.requestId)
      .execute();
  }

  async enqueueSettlement(payment: SettledPayment, graceMs: number): Promise<void> {
    await this.db
      .insertInto("catalog_outbox")
      .values({
        transaction: payment.transaction,
        payment: JSON.stringify(payment),
        due_at: sql<Date>`now() + make_interval(secs => ${graceMs / 1000})`,
      })
      .onConflict((conflict) => conflict.column("transaction").doNothing())
      .execute();
  }

  async claimSettlements(limit: number, leaseMs: number): Promise<QueuedSettlement[]> {
    const result = await sql<Selectable<CatalogOutboxTable>>`
      UPDATE catalog_outbox SET claimed_until = now() + make_interval(secs => ${leaseMs / 1000})
      WHERE transaction IN (
        SELECT transaction FROM catalog_outbox
        WHERE due_at <= now() AND (claimed_until IS NULL OR claimed_until <= now())
        ORDER BY due_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`.execute(this.db);
    return result.rows
      .sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime())
      .map((row) => ({ payment: row.payment as SettledPayment, attempts: row.attempts }));
  }

  async deferSettlement(transaction: string, delayMs: number): Promise<void> {
    await this.db
      .updateTable("catalog_outbox")
      .set((eb) => ({
        attempts: eb("attempts", "+", 1),
        due_at: sql<Date>`now() + make_interval(secs => ${delayMs / 1000})`,
        claimed_until: null,
      }))
      .where("transaction", "=", transaction)
      .execute();
  }

  async completeSettlement(transaction: string): Promise<void> {
    await this.db.deleteFrom("catalog_outbox").where("transaction", "=", transaction).execute();
  }

  async stats(): Promise<CatalogStats> {
    const [states, queued] = await Promise.all([
      this.db
        .selectFrom("listings")
        .select(["state", (eb) => eb.fn.countAll<string>().as("count")])
        .groupBy("state")
        .execute(),
      this.db
        .selectFrom("catalog_outbox")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow(),
    ]);
    const listings = { pending: 0, published: 0, quarantined: 0 };
    for (const row of states) {
      if (row.state in listings) listings[row.state] = Number(row.count);
    }
    return { listings, queuedSettlements: Number(queued.count) };
  }

  async settlementLinks(network: string, transactions: readonly string[]): Promise<SettlementLink[]> {
    const wanted = [...new Set(transactions)];
    if (wanted.length === 0) return [];
    const rows = await this.publicRead((trx) =>
      trx
        .selectFrom("listing_observations as o")
        .innerJoin("listings as l", "l.id", "o.listing_id")
        .selectAll("l")
        .select([
          "o.transaction as observed_transaction",
          "o.payer as observed_payer",
          "o.pay_to as observed_pay_to",
          "o.asset as observed_asset",
          "o.amount as observed_amount",
          "o.observed_at as observed_at",
        ])
        .where("o.transaction", "in", wanted)
        .where((eb) =>
          eb.and([
            eb("l.state", "=", "published"),
            eb("l.network", "=", network),
            eb.not(PRIVATE_USAGE),
            eb("o.pay_to", "=", eb.ref("l.owner")),
          ]),
        )
        .execute(),
    );
    return rows.map((row) => ({
      listing: toListing(row),
      observation: {
        transaction: row.observed_transaction,
        payer: row.observed_payer,
        payTo: row.observed_pay_to ?? "",
        asset: row.observed_asset,
        amount: row.observed_amount,
        observedAt: new Date(row.observed_at),
      },
    }));
  }

  async listingUsage(listing: Listing, recent: number): Promise<ListingUsage> {
    const paid = (db: Transaction<Database>) =>
      db
        .selectFrom("listing_observations")
        .where("listing_id", "=", listing.id)
        .where("pay_to", "=", listing.owner);
    const [totals, rows] = await this.publicRead((trx) =>
      Promise.all([
        paid(trx)
          .select((eb) => [
            eb.fn.countAll<string>().as("payments"),
            sql<string>`count(DISTINCT payer)`.as("payers"),
            // Null when the listing has no such settlement.
            eb.fn.min<Date | null>("observed_at").as("first"),
            eb.fn.max<Date | null>("observed_at").as("last"),
          ])
          .executeTakeFirstOrThrow(),
        paid(trx)
          .selectAll()
          .orderBy("observed_at", "desc")
          .orderBy("transaction", "desc")
          .limit(Math.max(0, recent))
          .execute(),
      ]),
    );
    return {
      payments: Number(totals.payments),
      payers: Number(totals.payers),
      ...(totals.first === null ? {} : { firstObservedAt: new Date(totals.first) }),
      ...(totals.last === null ? {} : { lastObservedAt: new Date(totals.last) }),
      recent: rows.map(toObservation),
    };
  }

  async sellerUsage(owner: string, network: string, limit: number): Promise<SellerUsage> {
    const owned = (db: Transaction<Database>) =>
      db
        .selectFrom("listings as l")
        .where("l.owner", "=", owner)
        .where((eb) =>
          eb.and([eb("l.state", "=", "published"), eb("l.network", "=", network), eb.not(PRIVATE_USAGE)]),
        );
    const [totals, rows] = await this.publicRead((trx) =>
      Promise.all([
        owned(trx)
          .innerJoin("listing_observations as o", (join) =>
            join.onRef("o.listing_id", "=", "l.id").onRef("o.pay_to", "=", "l.owner"),
          )
          .select((eb) => [
            eb.fn.countAll<string>().as("payments"),
            sql<string>`count(DISTINCT o.payer)`.as("payers"),
          ])
          .executeTakeFirstOrThrow(),
        owned(trx)
          .leftJoin("listing_observations as o", (join) =>
            join.onRef("o.listing_id", "=", "l.id").onRef("o.pay_to", "=", "l.owner"),
          )
          .selectAll("l")
          .select((eb) => [
            eb.fn.count<string>("o.transaction").as("payments"),
            sql<string>`count(DISTINCT o.payer)`.as("payers"),
            eb.fn.max("o.observed_at").as("last_observed_at"),
          ])
          .groupBy("l.id")
          // Most recently paid first, then listings never paid; ties in catalog order.
          .orderBy(sql`max(o.observed_at) DESC NULLS LAST`)
          .orderBy("l.listed_at")
          .orderBy("l.sequence")
          .limit(Math.max(0, limit) + 1)
          .execute(),
      ]),
    );
    return {
      payments: Number(totals.payments),
      payers: Number(totals.payers),
      listings: rows.slice(0, Math.max(0, limit)).map((row) => ({
        listing: toListing(row),
        payments: Number(row.payments),
        payers: Number(row.payers),
        ...(row.last_observed_at === null ? {} : { lastObservedAt: new Date(row.last_observed_at) }),
      })),
      truncated: rows.length > Math.max(0, limit),
    };
  }

  /**
   * Runs a public, unauthenticated usage read in one snapshot, so totals and rows always agree, and
   * never holds the database for long.
   */
  private publicRead<T>(work: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
    return this.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (trx) => {
        await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
        return work(trx);
      });
  }

  private tx(db: Kysely<Database> | Transaction<Database>): CatalogTransaction {
    // The row lock this takes is held until commit: catalog changes commit one revision at a time.
    const bump = () =>
      db
        .updateTable("catalog_state")
        .set({ revision: sql<string>`revision + 1` })
        .execute();
    const writeOptions = async (listing: Listing) => {
      await db.deleteFrom("listing_options").where("listing_id", "=", listing.id).execute();
      if (listing.content.accepts.length === 0) return;
      await db
        .insertInto("listing_options")
        .values(
          listing.content.accepts.map((option, position) => ({
            listing_id: listing.id,
            position,
            scheme: option.scheme,
            network: option.network,
            asset: option.asset,
            pay_to: option.payTo,
            pay_to_account: baseAccount(option.payTo) ?? option.payTo,
            amount: option.amount,
          })),
        )
        .execute();
    };
    const writeVersion = async (version: ListingVersion) => {
      await db
        .insertInto("listing_versions")
        .values({
          listing_id: version.listingId,
          version: version.version,
          created_at: version.createdAt,
          cause: version.cause,
          transaction: version.transaction ?? null,
          owner: version.owner,
          trust: version.trust,
          state: version.state,
          reason: version.reason ?? null,
          content: JSON.stringify(version.content),
        })
        .execute();
    };

    return {
      find: async (identity) => {
        const row = await db
          .selectFrom("listings")
          .selectAll()
          .where("network", "=", identity.network)
          .where("kind", "=", identity.kind)
          .where("resource", "=", identity.resource)
          .where("method", "=", identity.method)
          .where("tool_name", "=", identity.toolName)
          .where("scope", "=", identity.scope)
          .executeTakeFirst();
        return row === undefined ? undefined : toListing(row);
      },
      get: async (id) => {
        const row = await db.selectFrom("listings").selectAll().where("id", "=", id).executeTakeFirst();
        return row === undefined ? undefined : toListing(row);
      },
      latestReason: async (listingId) => {
        const row = await db
          .selectFrom("listing_versions")
          .select("reason")
          .where("listing_id", "=", listingId)
          .orderBy("version", "desc")
          .limit(1)
          .executeTakeFirst();
        return (row?.reason ?? undefined) as QuarantineReason | undefined;
      },
      observe: async (listingId, observation) => {
        const inserted = await db
          .insertInto("listing_observations")
          .values({
            listing_id: listingId,
            transaction: observation.transaction,
            payer: observation.payer,
            pay_to: observation.payTo,
            asset: observation.asset,
            amount: observation.amount,
            observed_at: observation.observedAt,
          })
          .onConflict((conflict) => conflict.column("transaction").doNothing())
          .executeTakeFirst();
        if (inserted.numInsertedOrUpdatedRows === 1n) return "new";
        const earlier = await db
          .selectFrom("listing_observations")
          .select("listing_id")
          .where("transaction", "=", observation.transaction)
          .executeTakeFirst();
        return earlier?.listing_id === listingId ? "seen" : "elsewhere";
      },
      observedListing: async (transaction) => {
        const row = await db
          .selectFrom("listing_observations")
          .select("listing_id")
          .where("transaction", "=", transaction)
          .executeTakeFirst();
        return row?.listing_id;
      },
      countCreatedBy: async (owner, network, origin, since) => {
        // Held until the transaction ends, so two checks never both take an owner's last place.
        const quota = createHash("sha256")
          .update(["quota", owner, network, origin].join("\u0000"))
          .digest("hex");
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${quota}, 402))`.execute(db);
        const row = await db
          .selectFrom("listings")
          .select((eb) => [
            eb.fn.countAll<string>().as("count"),
            eb.fn.min("quota_charged_at").as("earliest"),
          ])
          .where("owner", "=", owner)
          .where("network", "=", network)
          .where("quota_charged_at", ">=", since)
          .where("state", "=", "published")
          .where("trust", "<>", "settled")
          // resourceOrigin, in SQL: the owner's few recent listings are narrowed to the one origin.
          .where(
            sql<string>`coalesce(substring(resource from ${RESOURCE_ORIGIN_PATTERN}::text), resource)`,
            "=",
            origin,
          )
          .executeTakeFirstOrThrow();
        return quotaCount(row);
      },
      countCreatedByPayer: async (payer, network, since) => {
        // A listing's first version names the settlement that created it; its observation, the payer.
        const row = await db
          .selectFrom("listing_versions as v")
          .innerJoin("listing_observations as o", "o.transaction", "v.transaction")
          .innerJoin("listings as l", "l.id", "v.listing_id")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("v.version", "=", 1)
          .where("v.created_at", ">=", since)
          .where("o.payer", "=", payer)
          .where("l.network", "=", network)
          .executeTakeFirstOrThrow();
        return Number(row.count);
      },
      countListedSince: async (network, since, unverified) => {
        // Held until the transaction ends, so two publications never both take a network's last place.
        const quota = createHash("sha256")
          .update(["listed", network, String(unverified)].join("\u0000"))
          .digest("hex");
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${quota}, 402))`.execute(db);
        const row = await db
          .selectFrom("listings")
          .select((eb) => [eb.fn.countAll<string>().as("count"), eb.fn.min("listed_at").as("earliest")])
          .where("network", "=", network)
          .where("listed_at", ">=", since)
          .where("trust", unverified ? "=" : "<>", "settled")
          .executeTakeFirstOrThrow();
        return quotaCount(row);
      },
      countPublishedBy: async (network, owner) => {
        const row = await db
          .selectFrom("listings")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("owner", "=", owner)
          .where("network", "=", network)
          .where("state", "=", "published")
          .where("trust", "<>", "settled")
          .executeTakeFirstOrThrow();
        return Number(row.count);
      },
      countPublished: async (network, unverified) => {
        const row = await db
          .selectFrom("listings")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("network", "=", network)
          .where("state", "=", "published")
          .where("trust", unverified ? "=" : "<>", "settled")
          .executeTakeFirstOrThrow();
        return Number(row.count);
      },
      insert: async (listing, version) => {
        await db
          .insertInto("listings")
          .values({
            id: listing.id,
            network: listing.identity.network,
            kind: listing.identity.kind,
            resource: listing.identity.resource,
            method: listing.identity.method,
            tool_name: listing.identity.toolName,
            scope: listing.identity.scope,
            owner: listing.owner,
            trust: listing.trust,
            state: listing.state,
            version: listing.version,
            content: JSON.stringify(listing.content),
            content_hash: listing.contentHash,
            first_cataloged_at: listing.firstCatalogedAt,
            listed_at: listing.listedAt ?? null,
            quota_charged_at: listing.quotaChargedAt ?? null,
            confirmed_example: listing.confirmedExample ?? null,
            last_updated: listing.lastUpdated,
            last_settled_at: listing.lastSettledAt,
            settlements: listing.settlements,
          })
          .execute();
        await writeOptions(listing);
        await writeVersion(version);
        await bump();
      },
      remove: async (listingId) => {
        // Versions, options, observations and the origin check go with it (ON DELETE CASCADE).
        await db.deleteFrom("listings").where("id", "=", listingId).execute();
      },
      update: async (listing, version) => {
        await db
          .updateTable("listings")
          .set({
            owner: listing.owner,
            trust: listing.trust,
            state: listing.state,
            version: listing.version,
            content: JSON.stringify(listing.content),
            content_hash: listing.contentHash,
            last_updated: listing.lastUpdated,
            last_settled_at: listing.lastSettledAt,
            settlements: listing.settlements,
            listed_at: listing.listedAt ?? null,
            quota_charged_at: listing.quotaChargedAt ?? null,
            confirmed_example: listing.confirmedExample ?? null,
            facts: listing.facts === undefined ? null : JSON.stringify(listing.facts),
            facts_checked_at: listing.facts?.checkedAt ?? null,
          })
          .where("id", "=", listing.id)
          .execute();
        if (version !== undefined) {
          await writeOptions(listing);
          await writeVersion(version);
          await bump();
        }
      },
      requestOriginCheck: async (listingId, reason, url, proposedOwner, settled, probe) => {
        if (reason === "owner_conflict") {
          const claim = proposedOwner ?? null;
          // A claim joins a check already requested: it adds its claimant (up to the cap) and changes
          // nothing else, so no claimant can replace another's claim or reset the check's retries.
          const joined = await sql<{ listing_id: string }>`
            UPDATE origin_checks SET
              reason = 'owner_conflict',
              proposed_owners = array_append(proposed_owners, ${claim}::text),
              due_at = LEAST(due_at, now() + make_interval(secs => ${OWNER_CLAIM_DELAY_MS / 1000})),
              retry_at = CASE WHEN attempts > 0
                AND due_at > now() + make_interval(secs => ${OWNER_CLAIM_DELAY_MS / 1000})
                THEN coalesce(retry_at, due_at) ELSE retry_at END,
              claimed_until = NULL,
              request_id = gen_random_uuid()
            WHERE listing_id = ${listingId}
              AND ${claim}::text IS NOT NULL
              AND NOT (${claim}::text = ANY(proposed_owners))
              AND cardinality(proposed_owners) < ${MAX_PROPOSED_OWNERS}
            RETURNING listing_id`.execute(db);
          if (joined.rows.length > 0) return;
          await db
            .insertInto("origin_checks")
            .values({
              listing_id: listingId,
              network: sql<string>`(SELECT network FROM listings WHERE id = ${listingId})`,
              reason,
              url,
              proposed_owners: claim === null ? [] : [claim],
            })
            .onConflict((conflict) => conflict.column("listing_id").doNothing())
            .execute();
          return;
        }
        // A settlement that paid the owner adds its candidate; the check keeps its retry count. The
        // listing's transaction serialises requests, so these reads stay current.
        const row = await db
          .selectFrom("origin_checks")
          .select(["reason", "url", "settled_option", "probe", "candidates", "attempts"])
          .select(sql<boolean>`coalesce(claimed_until > now(), false)`.as("running"))
          .where("listing_id", "=", listingId)
          .executeTakeFirst();
        const before =
          row === undefined
            ? []
            : checkCandidates({
                reason: row.reason,
                url: row.url,
                ...(row.settled_option === null ? {} : { settled: row.settled_option }),
                ...(row.probe === null ? {} : { probe: row.probe }),
                candidates: row.candidates,
              });
        const candidates = mergeCandidates(before, {
          url,
          ...(settled === undefined ? {} : { settled }),
          ...(probe === undefined ? {} : { probe }),
        });
        const listing = await db
          .selectFrom("listings")
          .select("state")
          .where("id", "=", listingId)
          .executeTakeFirst();
        // A check waiting for a retry, or running, is due sooner only for a listing not published;
        // otherwise it keeps its due time and claim, so a run in flight still defers it.
        const soon =
          row === undefined || (row.attempts === 0 && !row.running) || listing?.state !== "published";
        await db
          .insertInto("origin_checks")
          .values({
            listing_id: listingId,
            network: sql<string>`(SELECT network FROM listings WHERE id = ${listingId})`,
            reason,
            url,
            settled_option: settled === undefined ? null : JSON.stringify(settled),
            probe: probe === undefined ? null : JSON.stringify(probe),
            candidates: JSON.stringify(candidates),
          })
          .onConflict((conflict) =>
            conflict.column("listing_id").doUpdateSet((eb) => ({
              // An ownership claim is never downgraded by a later, plainer request, nor sent to its
              // path, and its claimants are kept.
              reason: sql<OriginCheck["reason"]>`CASE WHEN origin_checks.reason = 'owner_conflict'
                THEN origin_checks.reason ELSE ${eb.ref("excluded.reason")} END`,
              url: sql<string>`CASE WHEN origin_checks.reason = 'owner_conflict'
                THEN origin_checks.url ELSE ${eb.ref("excluded.url")} END`,
              settled_option: eb.ref("excluded.settled_option"),
              probe: eb.ref("excluded.probe"),
              candidates: eb.ref("excluded.candidates"),
              due_at: soon ? sql<Date>`now()` : sql<Date>`origin_checks.due_at`,
              // Made due before its scheduled retry, it keeps that retry's time: only scheduled runs
              // spend one.
              retry_at: soon
                ? sql<Date | null>`CASE WHEN origin_checks.attempts > 0
                    THEN coalesce(origin_checks.retry_at,
                      CASE WHEN origin_checks.due_at > now() THEN origin_checks.due_at END) END`
                : sql<Date | null>`origin_checks.retry_at`,
              claimed_until: soon ? null : sql<Date | null>`origin_checks.claimed_until`,
              request_id: soon ? sql<string>`gen_random_uuid()` : sql<string>`origin_checks.request_id`,
            })),
          )
          .execute();
      },
    };
  }
}

/**
 * Whether listing `l`'s usage stays private (see `usageVisible`): no origin confirmed its content
 * (trust `settled`, such as an `mcp://` tool), or it declares PRIVATE_USAGE_EXTENSION.
 */
const PRIVATE_USAGE = sql<boolean>`(l.trust = 'settled' OR coalesce(l.content -> 'extensions', '[]'::jsonb) ? ${PRIVATE_USAGE_EXTENSION}::text)`;

/** A quota's count row as `QuotaCount`. */
function quotaCount(row: { count: string; earliest: Date | string | null }): QuotaCount {
  const count = Number(row.count);
  return count === 0 || row.earliest === null ? { count } : { count, earliest: new Date(row.earliest) };
}

function toObservation(row: Selectable<ListingObservationsTable>): Observation {
  return {
    transaction: row.transaction,
    payer: row.payer,
    payTo: row.pay_to ?? "",
    asset: row.asset,
    amount: row.amount,
    observedAt: new Date(row.observed_at),
  };
}

function toOriginCheck(row: Selectable<OriginChecksTable> & { early?: boolean }): OriginCheck {
  return {
    listingId: row.listing_id,
    reason: row.reason,
    url: row.url,
    attempts: row.attempts,
    ...(row.early === true ? { early: true } : {}),
    requestId: row.request_id,
    ...(row.proposed_owners.length === 0 ? {} : { proposedOwners: row.proposed_owners }),
    ...(row.settled_option === null ? {} : { settled: row.settled_option }),
    ...(row.probe === null ? {} : { probe: row.probe }),
    ...(row.candidates.length === 0 ? {} : { candidates: row.candidates }),
  };
}

function factsOf(stored: unknown): ListingFacts {
  const { checkedAt, options, domain } = stored as Omit<ListingFacts, "checkedAt" | "domain"> & {
    checkedAt: string;
    domain?: Omit<DomainClaim, "homeDomainMatches"> & { homeDomainMatches?: boolean };
  };
  return {
    checkedAt: new Date(checkedAt),
    options,
    // Facts read before homeDomainMatches was stored set claimsOwner only when both sides held.
    ...(domain === undefined
      ? {}
      : { domain: { ...domain, homeDomainMatches: domain.homeDomainMatches ?? domain.claimsOwner } }),
  };
}

function toListing(row: Selectable<ListingsTable>): Listing {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    identity: {
      network: row.network,
      kind: row.kind,
      resource: row.resource,
      method: row.method,
      toolName: row.tool_name,
      scope: row.scope,
    },
    owner: row.owner,
    trust: row.trust,
    state: row.state,
    version: row.version,
    content: row.content,
    contentHash: row.content_hash,
    firstCatalogedAt: new Date(row.first_cataloged_at),
    ...(row.listed_at === null ? {} : { listedAt: new Date(row.listed_at) }),
    ...(row.quota_charged_at === null ? {} : { quotaChargedAt: new Date(row.quota_charged_at) }),
    ...(row.confirmed_example === null ? {} : { confirmedExample: row.confirmed_example }),
    ...(row.facts === null ? {} : { facts: factsOf(row.facts) }),
    lastUpdated: new Date(row.last_updated),
    lastSettledAt: new Date(row.last_settled_at),
    settlements: Number(row.settlements),
  };
}
