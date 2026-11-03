/**
 * Exports a network's Ecosystem Report snapshot from the Explorer database (reader role):
 *
 *   EXPLORER_DATABASE_URL=postgres://reader:…@localhost:5432/rail402_explorer \
 *     pnpm --filter @rail402.dev/explorer snapshot --network testnet --out ./snapshot
 *
 * Writes report.html, report.json, settlements.ndjson, failed_attempts.ndjson, aggregates.json and
 * manifest.json (and network-window-manifest.json when a network window is published), and prints the
 * manifest's SHA-256: the same hash `pnpm explorer:rebuild` prints for the report's range.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { IndexNetwork } from "@rail402.dev/x402-index";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";
import { secret } from "../config.ts";
import { createExplorerDatabase } from "../db.ts";
import { exportSnapshot } from "./snapshot.ts";

function usage(message: string): never {
  process.stderr.write(`explorer snapshot: ${message}\n`);
  process.exit(2);
}

const { values } = parseArgs({
  options: { network: { type: "string" }, out: { type: "string" }, "public-url": { type: "string" } },
  strict: true,
});
const network: IndexNetwork =
  values.network === "pubnet"
    ? "stellar:pubnet"
    : values.network === "testnet"
      ? "stellar:testnet"
      : usage("--network must be testnet or pubnet");
const databaseUrl =
  secret(process.env, "EXPLORER_DATABASE_URL") ?? usage("EXPLORER_DATABASE_URL (or _FILE) is required");
const registry = REGISTRIES[network];
const epoch = registry.document.epochs.at(-1) ?? usage("the registry lists no epoch");
const outDir = resolve(values.out ?? `.work/explorer-snapshot/${network.replace("stellar:", "")}`);
const db = createExplorerDatabase({ connectionString: databaseUrl, maxConnections: 1 });

exportSnapshot(db, {
  network,
  epoch,
  registry,
  outDir,
  publicUrl: (
    values["public-url"] ??
    process.env["EXPLORER_PUBLIC_URL"] ??
    "https://explorer.rail402.dev"
  ).replace(/\/+$/, ""),
  statusUrl: process.env["EXPLORER_STATUS_URL"],
})
  .then((report) => {
    if (report === undefined) {
      process.stderr.write(`explorer snapshot: no ${network} ledgers are indexed\n`);
      process.exitCode = 1;
      return;
    }
    const { document } = report;
    process.stdout.write(
      [
        `network      ${document.network} (epoch ${document.epoch})`,
        `ledgers      ${String(document.discovery.ledgersRead)} of ${String(document.range.from)}-${String(document.range.to)} (scope ${document.scope})`,
        `rules        v${document.rulesVersion}, registry ${document.registryVersion}`,
        `output       ${outDir}`,
        `manifest     sha256 ${document.manifestSha256}`,
        `rebuild      ${document.rebuildCommand}`,
        `audit        ${document.auditCommand}`,
        "",
      ].join("\n"),
    );
  })
  .catch((error: unknown) => {
    process.stderr.write(`explorer snapshot: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void db.destroy());
