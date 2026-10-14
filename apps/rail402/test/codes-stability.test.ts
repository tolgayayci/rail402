/**
 * Codes are part of the wire contract: clients branch on them. `codes.snapshot.json` pins each code's
 * HTTP status and retryability. Adding a code means adding it to the snapshot; removing one or changing
 * its status or retryability means recording it under `removed` or `changed` together with a
 * CHANGELOG.md entry that names the code. Reason text may change freely.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allCodes } from "@rail402.dev/service";

interface Pinned {
  readonly status: number;
  readonly retryable: boolean;
}

interface Snapshot {
  readonly codes: Record<string, Pinned>;
  readonly removed: Record<string, Pinned & { readonly version: string }>;
  readonly changed: readonly {
    readonly code: string;
    readonly from: Pinned;
    readonly to: Pinned;
    readonly version: string;
  }[];
}

const snapshot = JSON.parse(
  readFileSync(new URL("codes.snapshot.json", import.meta.url), "utf8"),
) as Snapshot;
const changelog = readFileSync(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");
const current = new Map(Object.entries(allCodes).map(([code, spec]) => [code, spec]));

describe("code stability", () => {
  it("pins every registered code", () => {
    const unpinned = [...current.keys()].filter((code) => !Object.hasOwn(snapshot.codes, code));
    expect(unpinned, "add the new codes to apps/rail402/test/codes.snapshot.json").toEqual([]);
  });

  it("never drops a code silently", () => {
    const dropped = Object.keys(snapshot.codes).filter((code) => !current.has(code));
    expect(
      dropped,
      "a removed code moves from `codes` to `removed` in codes.snapshot.json, with a CHANGELOG.md entry",
    ).toEqual([]);
    for (const [code, entry] of Object.entries(snapshot.removed)) {
      expect(current.has(code), `${code} is listed as removed but still registered`).toBe(false);
      expect(entry.version.trim(), code).not.toBe("");
      expect(changelog, `CHANGELOG.md must name the removed code ${code}`).toContain(`\`${code}\``);
    }
  });

  it("never changes a status or retryability silently", () => {
    for (const [code, spec] of current) {
      const pinned = snapshot.codes[code];
      if (pinned === undefined) continue;
      expect(
        { status: spec.status, retryable: spec.retryable },
        `${code} changed: update codes.snapshot.json, record it under \`changed\` and in CHANGELOG.md`,
      ).toEqual(pinned);
    }
    for (const change of snapshot.changed) {
      expect(snapshot.codes[change.code], `${change.code}: \`to\` must match the pinned value`).toEqual(
        change.to,
      );
      expect(change.from, change.code).not.toEqual(change.to);
      expect(changelog, `CHANGELOG.md must name the changed code ${change.code}`).toContain(
        `\`${change.code}\``,
      );
    }
  });
});
