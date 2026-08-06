import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CatalogEntry } from "./types.js";

/**
 * Durable catalog storage.
 *
 * ## The gap this closes
 *
 * `CatalogStore` has been in-memory since v1, on the reasoning that the catalog is derived state
 * rebuildable from settlement history. That reasoning is sound and the consequence was still real: a
 * restart loses every listing, and rebuilding "from settlement history" is a replay tool nobody
 * wrote. It is also what blocks a Workers deployment of discovery, where isolates are ephemeral and
 * `/discovery/*` currently answers a coded 501 rather than silently forgetting sellers.
 *
 * ## What it deliberately does NOT do
 *
 * **It does not touch ranking.** Retrieval stays the measured in-process hybrid — BM25 fused with
 * static-embedding vectors by RRF, the configuration that lifted recall@10 from ~45% to ~80% on the
 * 107-judgment held-out set (per-query sign test p < 0.0001). Entries are restored into memory at
 * boot and the existing retriever indexes them, unchanged.
 *
 * `node:sqlite` ships FTS5 with bm25, so using it as a candidate stage was the obvious move. It was
 * measured instead (`search/fts5-prefilter.test.ts`): against all 127 judgments over the 2,000-document
 * held-out corpus an FTS5 prefilter retains **64.4% of relevant documents at K=50, 70.8% at K=200 and
 * 79.5% at K=500** — and a candidate stage is a hard filter, so its recall is a ceiling on the whole
 * system's. At K=500, a quarter of the corpus, it would still discard one relevant document in five,
 * while the shipped hybrid reaches ~80% recall at K=10. The semantic half is doing work lexical
 * matching cannot reproduce.
 *
 * So this layer is storage, full stop: rows in, rows out, ranking somewhere else. If the catalog ever
 * outgrows memory the answer is a vector-aware candidate stage, measured before it ships.
 *
 * ## Synchronous, and why that is fine
 *
 * `node:sqlite` is synchronous. Cataloging runs in-process after a payment has already settled, and a
 * few-KB row write in WAL mode is microseconds — far below the ledger round trip that just happened.
 * An async driver would buy nothing here and would introduce a window where a settled payment's
 * listing is neither written nor guaranteed.
 *
 * ## Degraded mode
 *
 * A write failure must never take discovery down or fail a settlement. `CatalogStore` writes memory
 * first, then persists, and records a degraded flag if persistence throws — so a full disk costs
 * durability and nothing else, and `/health` says so (the stated degraded-mode story).
 *
 * ## The composite key never crosses this boundary
 *
 * An MCP resource is identified by (`resource.url`, `toolName`), and in memory that is one string
 * joined by a null byte. **A null byte cannot be stored in a SQLite TEXT column through this driver:**
 * `node:sqlite` binds JS strings as NUL-terminated C strings, so `"https://x/mcp\0tool_a"` and
 * `"https://x/mcp\0tool_b"` both arrive as `"https://x/mcp"` — same primary key, second row silently
 * overwrites the first, and a seller's second tool disappears on the next restart. Measured, not
 * assumed: `length(k)` comes back as 3 for a 5-character key.
 *
 * So the pair travels as two columns and the key is rebuilt with `entryKey` on load. The rule
 * generalises past SQLite: a composite key built from an invisible separator must not be handed to
 * any store that treats strings as C strings.
 *
 * NOTE: `node:sqlite` prints an `ExperimentalWarning` on startup. It is not suppressed here —
 * silencing process warnings to hide one expected line also hides the unexpected ones.
 */

/** One stored row. The catalog key is NOT part of it — see the null-byte note above. */
export interface StoredEntry {
  entry: CatalogEntry;
  payers: string[];
}

export interface CatalogPersistence {
  /** Every stored row. Called once, at construction. */
  load(): StoredEntry[];
  /** Insert or replace, keyed on (`entry.resource`, `entry.toolName`). */
  save(row: StoredEntry): void;
  remove(resource: string, toolName?: string): void;
  close(): void;
}

/** Bump when the row format changes in a way a previous build could not read. */
const SCHEMA_VERSION = 1;

export interface SqliteCatalogPersistenceOptions {
  /** File path, or `:memory:` for a database that lives and dies with the process. */
  readonly path: string;
}

export class SqliteCatalogPersistence implements CatalogPersistence {
  private readonly db: DatabaseSync;
  private readonly insert: ReturnType<DatabaseSync["prepare"]>;
  private readonly del: ReturnType<DatabaseSync["prepare"]>;
  private readonly selectAll: ReturnType<DatabaseSync["prepare"]>;

  constructor(options: SqliteCatalogPersistenceOptions) {
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true });
    this.db = new DatabaseSync(options.path);

    // WAL so a reader (a `/discovery/*` request in another process, an operator's sqlite3) never
    // blocks the writer that is finishing a settlement. NORMAL synchronous is the right trade for
    // derived state: it survives a process crash, and the ledger — not this file — is the record of
    // what was actually paid.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    // (resource, tool_name) rather than one joined key. `tool_name` is '' for an HTTP resource
    // rather than NULL, because SQLite permits duplicate NULLs in a PRIMARY KEY and every HTTP row
    // would then be distinct from itself.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS catalog (
        resource   TEXT NOT NULL,
        tool_name  TEXT NOT NULL DEFAULT '',
        entry      TEXT NOT NULL,
        payers     TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (resource, tool_name)
      ) STRICT
    `);

    const found = this.db.prepare("PRAGMA user_version").get() as { user_version?: number };
    const version = found?.user_version ?? 0;
    if (version === 0) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (version > SCHEMA_VERSION) {
      // Fail closed. Reading rows written by a newer format would publish a listing this build does
      // not understand, and silently dropping them would lose sellers who are already catalogued.
      this.db.close();
      throw new Error(
        `Catalog database at ${options.path} was written by schema version ${version}, but this build understands ${SCHEMA_VERSION}. Refusing to open it rather than misread catalogued listings.`,
      );
    }

    this.insert = this.db.prepare(
      "INSERT INTO catalog (resource, tool_name, entry, payers, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(resource, tool_name) DO UPDATE SET entry = excluded.entry, payers = excluded.payers, updated_at = excluded.updated_at",
    );
    this.del = this.db.prepare("DELETE FROM catalog WHERE resource = ? AND tool_name = ?");
    this.selectAll = this.db.prepare("SELECT resource, tool_name, entry, payers FROM catalog");
  }

  load(): StoredEntry[] {
    const rows = this.selectAll.all() as {
      resource: string;
      tool_name: string;
      entry: string;
      payers: string;
    }[];
    const out: StoredEntry[] = [];
    for (const row of rows) {
      try {
        out.push({
          entry: JSON.parse(row.entry) as CatalogEntry,
          payers: JSON.parse(row.payers) as string[],
        });
      } catch {
        // One unreadable row must not stop a facilitator booting with the other ten thousand.
        // Skipped rather than deleted: a human can inspect it, and deleting evidence on a parse
        // error is how a corruption bug becomes unreproducible.
        console.error(
          `catalog persistence: skipping unreadable row ${JSON.stringify(row.resource)} / ${JSON.stringify(row.tool_name)}`,
        );
      }
    }
    return out;
  }

  save(row: StoredEntry): void {
    this.insert.run(
      row.entry.resource,
      row.entry.toolName ?? "",
      JSON.stringify(row.entry),
      JSON.stringify(row.payers),
      new Date().toISOString(),
    );
  }

  remove(resource: string, toolName?: string): void {
    this.del.run(resource, toolName ?? "");
  }

  close(): void {
    this.db.close();
  }
}
