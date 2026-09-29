import { createHash } from "node:crypto";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import {
  baseAccount,
  groupByResource,
  identityKey,
  narrowOptions,
  optionMatches,
  type CatalogStore,
  type CatalogTransaction,
  type ListFilter,
  type Listing,
  type ListingFacts,
  type ListingIdentity,
  type ListingVersion,
  type OriginCheck,
  type QueuedSettlement,
  type ResourceListings,
  type SettledPayment,
  type VersionCause,
} from "@rail402.dev/bazaar";
import type { CatalogOutboxTable, Database, ListingsTable, OriginChecksTable } from "./database.ts";

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

  async list(filter: ListFilter): Promise<{ items: ResourceListings[]; total: number }> {
    // Rows and total from one snapshot, so a page and its total always agree.
    return this.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((trx) => this.listIn(trx, filter));
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

  async versions(id: string): Promise<ListingVersion[]> {
    const rows = await this.db
      .selectFrom("listing_versions")
      .selectAll()
      .where("listing_id", "=", id)
      .orderBy("version")
      .execute();
    return rows.map((row) => ({
      listingId: row.listing_id,
      version: row.version,
      createdAt: new Date(row.created_at),
      cause: row.cause as VersionCause,
      ...(row.transaction === null ? {} : { transaction: row.transaction }),
      owner: row.owner,
      trust: row.trust as Listing["trust"],
      state: row.state as Listing["state"],
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

  async staleFacts(limit: number, before: Date): Promise<Listing[]> {
    const rows = await this.db
      .selectFrom("listings")
      .selectAll()
      .where("state", "=", "published")
      .where((eb) => eb.or([eb("facts_checked_at", "is", null), eb("facts_checked_at", "<", before)]))
      .orderBy(sql`facts_checked_at NULLS FIRST`)
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

  async dueOriginChecks(limit: number): Promise<OriginCheck[]> {
    const rows = await this.db
      .selectFrom("origin_checks")
      .selectAll()
      .where("due_at", "<=", sql<Date>`now()`)
      .where((eb) => eb.or([eb("claimed_until", "is", null), eb("claimed_until", "<=", sql<Date>`now()`)]))
      .orderBy("due_at")
      .limit(limit)
      .execute();
    return rows.map(toOriginCheck);
  }

  async claimOriginChecks(limit: number, leaseMs: number): Promise<OriginCheck[]> {
    const result = await sql<Selectable<OriginChecksTable>>`
      UPDATE origin_checks SET claimed_until = now() + make_interval(secs => ${leaseMs / 1000})
      WHERE listing_id IN (
        SELECT listing_id FROM origin_checks
        WHERE due_at <= now() AND (claimed_until IS NULL OR claimed_until <= now())
        ORDER BY due_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`.execute(this.db);
    return result.rows
      .sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime())
      .map(toOriginCheck);
  }

  async deferOriginCheck(check: OriginCheck, delayMs: number): Promise<void> {
    await this.db
      .updateTable("origin_checks")
      .set((eb) => ({
        attempts: eb("attempts", "+", 1),
        due_at: sql<Date>`now() + make_interval(secs => ${delayMs / 1000})`,
        claimed_until: null,
      }))
      .where("listing_id", "=", check.listingId)
      .where("request_id", "=", check.requestId)
      .execute();
  }

  async completeOriginCheck(check: OriginCheck): Promise<void> {
    await this.db
      .deleteFrom("origin_checks")
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
      observe: async (listingId, observation) => {
        const inserted = await db
          .insertInto("listing_observations")
          .values({
            listing_id: listingId,
            transaction: observation.transaction,
            payer: observation.payer,
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
      countCreatedBy: async (owner, since) => {
        const row = await db
          .selectFrom("listings")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("owner", "=", owner)
          .where("first_cataloged_at", ">=", since)
          .where("state", "<>", "quarantined")
          .executeTakeFirstOrThrow();
        return Number(row.count);
      },
      countCreatedByPayer: async (payer, since) => {
        // A listing's first version names the settlement that created it; its observation, the payer.
        const row = await db
          .selectFrom("listing_versions as v")
          .innerJoin("listing_observations as o", "o.transaction", "v.transaction")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("v.version", "=", 1)
          .where("v.created_at", ">=", since)
          .where("o.payer", "=", payer)
          .executeTakeFirstOrThrow();
        return Number(row.count);
      },
      countCreatedSince: async (since) => {
        const row = await db
          .selectFrom("listings")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("first_cataloged_at", ">=", since)
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
            last_updated: listing.lastUpdated,
            last_settled_at: listing.lastSettledAt,
            settlements: listing.settlements,
          })
          .execute();
        await writeOptions(listing);
        await writeVersion(version);
        await bump();
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
      requestOriginCheck: async (listingId, reason, url, proposedOwner) => {
        await db
          .insertInto("origin_checks")
          .values({ listing_id: listingId, reason, url, proposed_owner: proposedOwner ?? null })
          .onConflict((conflict) =>
            conflict.column("listing_id").doUpdateSet((eb) => ({
              // An ownership claim is never downgraded by a later, plainer request.
              reason: sql<OriginCheck["reason"]>`CASE WHEN origin_checks.reason = 'owner_conflict'
                AND ${eb.ref("excluded.reason")} <> 'owner_conflict' THEN origin_checks.reason
                ELSE ${eb.ref("excluded.reason")} END`,
              proposed_owner: sql<string | null>`CASE WHEN origin_checks.reason = 'owner_conflict'
                AND ${eb.ref("excluded.reason")} <> 'owner_conflict' THEN origin_checks.proposed_owner
                ELSE ${eb.ref("excluded.proposed_owner")} END`,
              url: eb.ref("excluded.url"),
              attempts: 0,
              due_at: sql<Date>`now()`,
              claimed_until: null,
              request_id: sql<string>`gen_random_uuid()`,
            })),
          )
          .execute();
      },
    };
  }
}

function toOriginCheck(row: Selectable<OriginChecksTable>): OriginCheck {
  return {
    listingId: row.listing_id,
    reason: row.reason,
    url: row.url,
    attempts: row.attempts,
    requestId: row.request_id,
    ...(row.proposed_owner === null ? {} : { proposedOwner: row.proposed_owner }),
  };
}

function factsOf(stored: unknown): ListingFacts {
  const facts = stored as Omit<ListingFacts, "checkedAt"> & { checkedAt: string };
  return { ...facts, checkedAt: new Date(facts.checkedAt) };
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
    ...(row.facts === null ? {} : { facts: factsOf(row.facts) }),
    lastUpdated: new Date(row.last_updated),
    lastSettledAt: new Date(row.last_settled_at),
    settlements: Number(row.settlements),
  };
}
