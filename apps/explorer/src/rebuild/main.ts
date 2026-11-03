/**
 * Rebuilds the Explorer's rows from public ledgers, with no database and no discovery source:
 *
 *   pnpm explorer:rebuild --network testnet --from 5330305 --to 5330320
 *   pnpm explorer:rebuild --network pubnet --from 61440000 --to 61503999 --out ./rebuild
 *   pnpm explorer:rebuild --network testnet --from 5330305 --to 5330320 --source ./ledgers
 *   pnpm explorer:rebuild --network testnet --ledgers-from manifest.json
 *
 * With --from and --to it reads every ledger of the range (scope full, the audit path). With
 * --ledgers-from it reads only the ledgers a published registry-scope manifest lists, over its range,
 * checking each one's hash and the manifest's anchors (scope registry): the Explorer's report manifest.
 * Options: --network testnet|pubnet, --from, --to (inclusive), --ledgers-from <manifest.json>, --out
 * (default .work/explorer-rebuild/<network>-<from>-<to>), --source lake|<directory of <sequence>.xdr.zst>,
 * --registry <registry JSON> (default: the published one), --anchor <ledger>:<hash> (repeatable; from - 1
 * to to), --anchors-from <manifest.json> (every anchor a published manifest lists, checked on the chain),
 * --anchor-horizon <Horizon URL> (a full scan: anchors from - 1 and to from that Horizon; with
 * --ledgers-from: every listed ledger's hash checked against that Horizon first), --concurrency <n>.
 * With --ledgers-from it warns when the registry used differs from the one the manifest names. Prints
 * the manifest's SHA-256; equal hashes mean identical results.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DataLakeSource, HorizonAnchors, type Anchor } from "@rail402.dev/ledger-source";
import { parseRegistry, type IndexNetwork } from "@rail402.dev/x402-index";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";
import { detectEpoch } from "../epoch.ts";
import { DirectorySource } from "./directory-source.ts";
import { canonicalJson, sha256 } from "./aggregates.ts";
import {
  anchorsFromManifest,
  checkListedLedgers,
  dataLakeDescription,
  ledgersFromManifest,
  manifestRegistrySha256,
  rangeAnchors,
  rebuild,
  rebuildLedgers,
} from "./rebuild.ts";

function usage(message: string): never {
  process.stderr.write(`explorer:rebuild: ${message}\n`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    network: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    out: { type: "string" },
    source: { type: "string", default: "lake" },
    registry: { type: "string" },
    anchor: { type: "string", multiple: true, default: [] },
    "anchors-from": { type: "string" },
    "anchor-horizon": { type: "string" },
    "ledgers-from": { type: "string" },
    concurrency: { type: "string", default: "8" },
  },
  strict: true,
});

const network: IndexNetwork =
  values.network === "pubnet"
    ? "stellar:pubnet"
    : values.network === "testnet"
      ? "stellar:testnet"
      : usage("--network must be testnet or pubnet");
const ledger = (name: string, raw: string | undefined): number => {
  if (raw === undefined || !/^\d+$/.test(raw)) usage(`--${name} must be a ledger sequence`);
  return Number(raw);
};
const anchorsFrom: Anchor[] = [];
let listed: ReturnType<typeof ledgersFromManifest> | undefined;
let listedRegistrySha256: string | undefined;
if (values["ledgers-from"] !== undefined) {
  if (values.from !== undefined || values.to !== undefined)
    usage("--ledgers-from takes the range from the manifest; leave out --from and --to");
  try {
    const text = readFileSync(values["ledgers-from"], "utf8");
    listed = ledgersFromManifest(text);
    listedRegistrySha256 = manifestRegistrySha256(text);
    // The manifest's anchors are checked against the ledgers read, so the rebuild lists the same ones.
    anchorsFrom.push(...anchorsFromManifest(text));
  } catch (error) {
    usage(`--ledgers-from: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const from = listed?.range.from ?? ledger("from", values.from);
const to = listed?.range.to ?? ledger("to", values.to);
const anchors: Anchor[] = values.anchor.map((raw) => {
  const match = /^(\d+):([0-9a-f]{64})$/.exec(raw);
  if (match === null) usage(`--anchor must be <ledger>:<64 hex hash>, got ${raw}`);
  return { ledger: Number(match[1]), hash: match[2] ?? "" };
});
anchors.push(...anchorsFrom);
if (values["anchors-from"] !== undefined) {
  // A published manifest's anchors: the rebuild checks each one on the chain it reads, so its
  // manifest lists the same anchors and hashes the same.
  try {
    anchors.push(...anchorsFromManifest(readFileSync(values["anchors-from"], "utf8")));
  } catch (error) {
    usage(`--anchors-from: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (values["anchor-horizon"] !== undefined && listed !== undefined) {
  // Every listed ledger against an independent Horizon: the rebuild then trusts neither the data lake nor
  // the manifest's hashes alone. The manifest itself is unchanged.
  try {
    const checked = await checkListedLedgers(
      listed.ledgers,
      new HorizonAnchors({ url: values["anchor-horizon"] }),
    );
    process.stderr.write(
      `checked ${String(checked)} listed ledger hashes against ${values["anchor-horizon"]}\n`,
    );
  } catch (error) {
    const code = (error as { code?: string }).code ?? "anchor_unavailable";
    process.stderr.write(
      `explorer:rebuild: ${code}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
} else if (values["anchor-horizon"] !== undefined) {
  try {
    anchors.push(...(await rangeAnchors(new HorizonAnchors({ url: values["anchor-horizon"] }), from, to)));
  } catch (error) {
    usage(`--anchor-horizon: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const registry =
  values.registry === undefined
    ? REGISTRIES[network]
    : parseRegistry(JSON.parse(readFileSync(values.registry, "utf8")) as unknown);
if (registry.network !== network) usage(`the registry is for ${registry.network}`);
if (listedRegistrySha256 !== undefined && listedRegistrySha256 !== sha256(canonicalJson(registry.document))) {
  process.stderr.write(
    "warning: this registry differs from the one the manifest names (registrySha256); the rebuild will not match the manifest. Pass the manifest's registry with --registry.\n",
  );
}
const newest = registry.document.epochs.at(-1);
if (newest === undefined) usage("the registry lists no epoch");
const epoch = detectEpoch(registry, { passphrase: newest.passphrase });
const lake = values.source === "lake";
const source = lake
  ? new DataLakeSource({ folder: epoch.dataLakeFolder, passphrase: epoch.passphrase })
  : new DirectorySource(resolve(values.source));
const outDir = resolve(
  values.out ?? `.work/explorer-rebuild/${network.replace("stellar:", "")}-${String(from)}-${String(to)}`,
);

let lastReport = 0;
const started = Date.now();
const onProgress = (at: number) => {
  if (Date.now() - lastReport > 5_000) {
    lastReport = Date.now();
    process.stderr.write(`ledger ${String(at)} (${String(at - from + 1)}/${String(to - from + 1)})\n`);
  }
};
const run =
  listed === undefined
    ? rebuild({
        network,
        epoch,
        registry,
        source,
        sourceDescription: lake ? dataLakeDescription(epoch) : { kind: "directory", uri: null },
        from,
        to,
        anchors,
        concurrency: Number(values.concurrency),
        // One decoded ledger at a time and rows streamed to the files: memory stays flat over any range.
        maxBytesInFlight: 64 * 1024 * 1024,
        retainRows: false,
        outDir,
        onProgress,
      })
    : rebuildLedgers({
        network,
        epoch,
        registry,
        source,
        range: listed.range,
        ledgers: listed.ledgers,
        discovery: listed.discovery,
        anchors,
        concurrency: Number(values.concurrency),
        outDir,
        onProgress,
      });
run.then(
  (result) => {
    const { manifest } = result;
    const read =
      manifest.scope === "registry"
        ? `${String(manifest.ledgers?.length ?? 0)} listed ledgers of ${String(manifest.range.from)}-${String(manifest.range.to)} (scope registry)`
        : `${String(manifest.range.from)}-${String(manifest.range.to)}, last hash ${manifest.lastLedger?.hash ?? ""} (scope full)`;
    process.stdout.write(
      [
        `network      ${manifest.network} (epoch ${manifest.epoch})`,
        `ledgers      ${read}`,
        `rules        v${manifest.rulesVersion}, registry ${manifest.registryVersion}`,
        `settlements  ${String(manifest.files["settlements.ndjson"].lines)}, failed attempts ${String(manifest.files["failed_attempts.ndjson"].lines)}`,
        `output       ${outDir}`,
        `manifest     sha256 ${result.manifestSha256}`,
        `took         ${String(Math.round((Date.now() - started) / 1000))} s`,
        "",
      ].join("\n"),
    );
  },
  (error: unknown) => {
    const code = (error as { code?: string }).code ?? "rebuild_failed";
    process.stderr.write(
      `explorer:rebuild: ${code}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
