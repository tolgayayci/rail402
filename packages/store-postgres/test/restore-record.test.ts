import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIRECTORY } from "../src/migrate.ts";

const RESTORE_SCRIPT = join(import.meta.dirname, "../../../deploy/postgres/restore-dump.sh");

/** The column list of `CREATE TABLE IF NOT EXISTS [public.]settlement_rewinds (…);`, spacing ignored. */
function rewindsTable(text: string): string | undefined {
  const match = /CREATE TABLE IF NOT EXISTS (?:public\.)?settlement_rewinds \(([^;]*)\);/.exec(text);
  return match?.[1]?.replace(/\s+/g, " ").trim();
}

describe("the record of restores", () => {
  it("is created by the restore script exactly as by its migration, for a dump older than the table", () => {
    const migration = readFileSync(join(MIGRATIONS_DIRECTORY, "0032_settlement_rewinds.sql"), "utf8");
    const script = readFileSync(RESTORE_SCRIPT, "utf8");
    expect(rewindsTable(migration)).toBeDefined();
    expect(rewindsTable(script)).toBe(rewindsTable(migration));
    // Every restore adds its row in the restore's own transaction.
    expect(script).toContain("INSERT INTO public.settlement_rewinds (reason) VALUES ('restore');");
  });
});
