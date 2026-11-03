import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { RULES_VERSION, type IndexNetwork, type RegistrySnapshot } from "@rail402.dev/x402-index";
import type { ExplorerDatabase } from "../db.ts";
import type { Epoch } from "../epoch.ts";
import { computeReport, underCurrentRules, withNetworkWindow, type ComputedReport } from "../api/report.ts";
import { ALL_VIEWS } from "../web/components.ts";
import { NETWORK_VIEWS } from "../web/format.ts";
import { ecosystemPage } from "../web/pages/ecosystem.ts";

export interface SnapshotOptions {
  readonly network: IndexNetwork;
  readonly epoch: Epoch;
  readonly registry: RegistrySnapshot;
  readonly outDir: string;
  /** The Explorer's public origin, for the links in the standalone page. */
  readonly publicUrl: string;
  readonly statusUrl?: string | undefined;
  readonly now?: () => Date;
}

/**
 * Exports a network's report as files: report.html (standalone, no script), report.json, and the
 * rebuild's own files for the same range (settlements.ndjson, failed_attempts.ndjson, aggregates.json,
 * manifest.json). The manifest is byte-identical to the one `pnpm explorer:rebuild` writes for that
 * range, so anyone can check a published snapshot against public ledgers. With a network window
 * published, its manifest is written as network-window-manifest.json.
 */
export async function exportSnapshot(
  db: Kysely<ExplorerDatabase>,
  options: SnapshotOptions,
): Promise<ComputedReport | undefined> {
  mkdirSync(options.outDir, { recursive: true });
  const settlements = openSync(join(options.outDir, "settlements.ndjson"), "w");
  const failed = openSync(join(options.outDir, "failed_attempts.ndjson"), "w");
  let report: ComputedReport | undefined;
  try {
    report = await computeReport(db, {
      network: options.network,
      epoch: options.epoch,
      registry: options.registry,
      ...(options.now === undefined ? {} : { now: options.now }),
      sinks: {
        settlement: (line) => {
          writeSync(settlements, line);
        },
        failedAttempt: (line) => {
          writeSync(failed, line);
        },
      },
    });
  } finally {
    closeSync(settlements);
    closeSync(failed);
  }
  if (report === undefined) return undefined;
  if (!underCurrentRules(report)) {
    throw new Error(
      `the index holds rows of rules versions ${report.manifest.rowVersions.rules.join(", ")}; start the indexer so it reads their ledgers again under rules v${RULES_VERSION}, then export`,
    );
  }
  report = await withNetworkWindow(db, report);
  if (report.networkWindowManifest !== undefined) {
    writeFileSync(join(options.outDir, "network-window-manifest.json"), report.networkWindowManifest);
  }
  const view = NETWORK_VIEWS[options.network];
  writeFileSync(join(options.outDir, "aggregates.json"), report.aggregatesText);
  writeFileSync(join(options.outDir, "manifest.json"), report.manifestText);
  writeFileSync(join(options.outDir, "report.json"), `${JSON.stringify(report.document, null, 2)}\n`);
  writeFileSync(
    join(options.outDir, "report.html"),
    ecosystemPage(
      {
        layout: {
          view,
          networks: ALL_VIEWS,
          versions: { rules: report.document.rulesVersion, registry: report.document.registryVersion },
          standalone: { origin: options.publicUrl },
        },
        registry: options.registry,
        statusUrl: options.statusUrl,
        apiOrigin: options.publicUrl,
      },
      report.document,
    ),
  );
  return report;
}
