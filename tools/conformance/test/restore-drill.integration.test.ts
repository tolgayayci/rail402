/**
 * deploy/postgres/restore-drill.sh end to end: an encrypted pgBackRest backup with WAL archiving, of a
 * database with the owner and runtime roles, restored to a point in time on throwaway containers.
 * Needs Docker.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/evidence.ts";

interface DrillResult {
  readonly tool: string;
  readonly encryption: string;
  readonly tables: number;
  readonly expected: Record<string, string>;
  readonly restored: Record<string, string>;
  readonly rowsWrittenAfterTargetRestored: number;
  readonly metrics: { walArchived: number; walArchiveFailures: number; ok: boolean };
  readonly plaintextMarker: { inDataDirectory: boolean; inRepository: boolean };
  readonly runtimeRole: { reads: boolean; writes: boolean; ddlRefused: boolean };
  readonly matches: boolean;
  readonly ok: boolean;
}

describe("the restore drill", () => {
  it("records a restore drill with row counts and checksums", () => {
    const output = execFileSync("bash", [join(REPO_ROOT, "deploy/postgres/restore-drill.sh")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 480_000,
    });
    const result = JSON.parse(output) as DrillResult;
    expect(result.tool).toMatch(/^pgBackRest \d+\.\d+/);
    expect(result.encryption).toBe("aes-256-cbc");
    expect(result.matches).toBe(true);
    expect(result.restored).toEqual(result.expected);
    // 1500 rows and the marker row.
    expect(result.expected["drill_rows"]).toMatch(/^1501:[0-9a-f]{32}$/);
    expect(result.expected["settlements"]).toBeDefined();
    expect(result.rowsWrittenAfterTargetRestored).toBe(0);
    // The backup is encrypted: a marker row is in the data files but nowhere in the repository.
    expect(result.plaintextMarker).toEqual({ inDataDirectory: true, inRepository: false });
    // The runtime role still works after the restore, and still has no DDL.
    expect(result.runtimeRole).toEqual({ reads: true, writes: true, ddlRefused: true });
    // backup-metrics.sh read the archiver and the backup the alerts watch.
    expect(result.metrics.ok).toBe(true);
    expect(result.metrics.walArchiveFailures).toBe(0);
    expect(result.ok).toBe(true);
  }, 600_000);
});
