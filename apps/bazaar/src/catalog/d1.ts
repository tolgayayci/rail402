import { entryKey, type CatalogEntry } from "./types.js";
import type { CatalogPersistence, StoredEntry } from "./persistence.js";

/**
 * D1-backed catalog durability — the Cloudflare-native half of the `CatalogPersistence` seam.
 *
 * ## Why this exists rather than a disk
 *
 * The catalog has to survive a restart, and on Cloudflare nothing on local disk does. Workers
 * isolates are ephemeral by design, and Cloudflare's own container documentation is explicit that
 * *"all disk is ephemeral — when a Container instance goes to sleep, the next time it is started it
 * will have a fresh disk as defined by its container image."* So a SQLite file works beautifully on
 * a VPS and is worth nothing on Cloudflare: the very sleep behaviour that keeps the bill small is
 * what wipes it.
 *
 * D1 is the durable store Cloudflare actually offers, and swapping to it is a backend change rather
 * than a rewrite because `CatalogStore` already talks to an interface (`persistence.ts`) rather than
 * to SQLite.
 *
 * ## The one structural difference from the SQLite backend
 *
 * D1 is a network call, so it cannot hydrate inside a constructor. `load()` returns a promise and
 * `CatalogStore.ready()` awaits it once at boot — serving `/discovery/*` before hydration completes
 * would report an empty catalog as though nothing had ever settled, which is a worse failure than
 * being briefly unavailable. Writes stay fire-and-forget: memory first, durability second, and a
 * failure degrades durability without touching the settlement that produced it.
 *
 * ## Typed structurally, on purpose
 *
 * The D1 surface used here is four methods wide. Declaring it structurally rather than depending on
 * `@cloudflare/workers-types` keeps a Cloudflare-shaped type out of a package that also runs under
 * plain Node, and keeps the dependency tree the licence gate scans unchanged.
 */

/** The slice of D1's API this backend uses. */
export interface D1Like {
  prepare(query: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown>;
  exec(query: string): Promise<unknown>;
}
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

/** Bump when the row format changes in a way a previous build could not read. */
const SCHEMA_VERSION = 1;

interface Row {
  resource: string;
  tool_name: string;
  entry: string;
  payers: string;
}

export class D1CatalogPersistence implements CatalogPersistence {
  private ensured: Promise<void> | undefined;

  constructor(private readonly db: D1Like) {}

  /**
   * Create the table once, lazily, and share one promise across concurrent callers.
   *
   * A Worker isolate can serve several requests before the first settles, and issuing the DDL from
   * each of them races. `IF NOT EXISTS` makes that harmless rather than fatal, and single-flighting
   * makes it cheap.
   */
  private ensureSchema(): Promise<void> {
    // Mirrors the SQLite schema deliberately: (resource, tool_name) as a COMPOSITE key rather than
    // one joined string. The in-memory key joins on a NUL byte, and a NUL cannot survive a bind to
    // a text column in either engine — two MCP tools on one endpoint would collapse to one row and
    // a seller's second tool would vanish. The key is rebuilt with `entryKey` on load.
    this.ensured ??= this.db
      .exec(
        `CREATE TABLE IF NOT EXISTS catalog (` +
          `resource TEXT NOT NULL, tool_name TEXT NOT NULL DEFAULT '', ` +
          `entry TEXT NOT NULL, payers TEXT NOT NULL, updated_at TEXT NOT NULL, ` +
          `schema_version INTEGER NOT NULL DEFAULT ${SCHEMA_VERSION}, ` +
          `PRIMARY KEY (resource, tool_name))`,
      )
      .then(() => undefined);
    return this.ensured;
  }

  async load(): Promise<StoredEntry[]> {
    await this.ensureSchema();
    const { results } = await this.db
      .prepare("SELECT resource, tool_name, entry, payers FROM catalog WHERE schema_version <= ?")
      .bind(SCHEMA_VERSION)
      .all<Row>();

    const out: StoredEntry[] = [];
    for (const row of results) {
      try {
        out.push({
          entry: JSON.parse(row.entry) as CatalogEntry,
          payers: JSON.parse(row.payers) as string[],
        });
      } catch {
        // One unreadable row must not stop a facilitator booting with the other ten thousand.
        // Skipped rather than deleted: deleting evidence on a parse error is how a corruption bug
        // becomes unreproducible.
        console.error(
          `catalog d1: skipping unreadable row ${JSON.stringify(row.resource)} / ${JSON.stringify(row.tool_name)}`,
        );
      }
    }
    return out;
  }

  async save(row: StoredEntry): Promise<void> {
    await this.ensureSchema();
    await this.db
      .prepare(
        "INSERT INTO catalog (resource, tool_name, entry, payers, updated_at, schema_version) " +
          "VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(resource, tool_name) DO UPDATE SET " +
          "entry = excluded.entry, payers = excluded.payers, updated_at = excluded.updated_at",
      )
      .bind(
        row.entry.resource,
        row.entry.toolName ?? "",
        JSON.stringify(row.entry),
        JSON.stringify(row.payers),
        new Date().toISOString(),
        SCHEMA_VERSION,
      )
      .run();
  }

  async remove(resource: string, toolName?: string): Promise<void> {
    await this.ensureSchema();
    await this.db
      .prepare("DELETE FROM catalog WHERE resource = ? AND tool_name = ?")
      .bind(resource, toolName ?? "")
      .run();
  }

  /** D1 connections are managed by the runtime; there is nothing to close. */
  close(): void {}
}

/** Exported for the round-trip test: the key a row rebuilds to must match the in-memory one. */
export const rowKey = (row: StoredEntry): string =>
  entryKey(row.entry.resource, row.entry.toolName);
