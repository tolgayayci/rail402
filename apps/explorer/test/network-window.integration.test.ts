/**
 * The network window over a real Postgres: published by its job into its own table, attached to the
 * report the web role reads, replaced by the next window.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RULES_VERSION } from "@rail402.dev/x402-index";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";
import { loadReport, publishReport, type ComputedReport } from "../src/api/report.ts";
import type { ExplorerDatabase } from "../src/db.ts";
import { detectEpoch } from "../src/epoch.ts";
import { MANIFEST_VERSION } from "../src/rebuild/rebuild.ts";
import { publishNetworkWindow, runNetworkWindow } from "../src/window/window.ts";
import { dropDatabase, freshDatabase, testName } from "./database.ts";
import { FixtureSource } from "./sources.ts";

const registry = REGISTRIES["stellar:testnet"];
const epoch = detectEpoch(registry, { passphrase: "Test SDF Network ; September 2015" });
const scratch = mkdtempSync(join(tmpdir(), "rail402-explorer-window-db-"));
let db: Kysely<ExplorerDatabase>;

beforeAll(async () => {
  db = await freshDatabase("window");
});
afterAll(async () => {
  await db.destroy();
  await dropDatabase(testName("window"));
  rmSync(scratch, { recursive: true, force: true });
});

/** A window over the fixture's contiguous run ending at `to`. */
function window(to: number) {
  return runNetworkWindow({
    network: "stellar:testnet",
    epoch,
    registry,
    source: new FixtureSource(Array.from({ length: to - 5_330_304 }, (_, index) => 5_330_305 + index)),
    hours: 1,
    ledgers: to - 5_330_304,
    headHint: 5_330_305,
    maxSeconds: 60,
    maxDownloadBytes: 64 * 1024 * 1024,
    maxRows: 1_000,
    maxBytesInFlight: 1024 * 1024,
    concurrency: 4,
    workDir: join(scratch, String(to)),
  });
}

describe("the published network window", () => {
  it("is attached to the report the web reads, and replaced by the next one", async () => {
    const report = {
      document: {
        network: "stellar:testnet",
        epoch: epoch.id,
        generatedAt: "2026-10-26T12:00:00.000Z",
        scope: "registry",
        headlineScope: "registered-facilitators",
        range: { from: 5_330_305, to: 5_330_320 },
        discovery: { source: "lumeus" },
        rulesVersion: RULES_VERSION,
      },
      manifest: {
        manifestVersion: MANIFEST_VERSION,
        scope: "registry",
        rowVersions: { rules: [RULES_VERSION], registry: [] },
      },
      manifestText: `${JSON.stringify({
        manifestVersion: MANIFEST_VERSION,
        scope: "registry",
        rowVersions: { rules: [RULES_VERSION], registry: [] },
      })}\n`,
      aggregatesText: "{}\n",
    } as unknown as ComputedReport;
    await publishReport(db, report);
    const before = await loadReport(db, "stellar:testnet", epoch.id);
    expect(before?.document.networkWide).toBeNull();
    expect(before?.networkWindowManifest).toBeUndefined();

    const first = await window(5_330_319);
    await publishNetworkWindow(db, first);
    const second = await window(5_330_320);
    await publishNetworkWindow(db, second);
    expect(second.document.manifestSha256).not.toBe(first.document.manifestSha256);

    const after = await loadReport(db, "stellar:testnet", epoch.id);
    expect(after?.document.networkWide).toEqual(second.document);
    expect(after?.networkWindowManifest).toBe(second.manifestText);
    // The registry-scope report itself is unchanged.
    expect(after?.manifestText).toBe(report.manifestText);
    expect(after?.document.headlineScope).toBe("registered-facilitators");
    // Another network's report never shows this network's window.
    expect(await loadReport(db, "stellar:pubnet", epoch.id)).toBeUndefined();
  });
});
