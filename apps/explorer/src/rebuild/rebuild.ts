import { createHash, type Hash } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  DATA_LAKE_BASE_URL,
  HashChain,
  LedgerSourceError,
  type Anchor,
  type AnchorSource,
  type LedgerSource,
  type SourcedLedger,
  type VerifiedLedger,
} from "@rail402.dev/ledger-source";
import {
  RULES_VERSION,
  type ClassifyContext,
  type ExclusionReason,
  type FailedAttemptRow,
  type IndexNetwork,
  type RegistrySnapshot,
  type SettlementRow,
} from "@rail402.dev/x402-index";
import type { Epoch } from "../epoch.ts";
import { PARTITION_SIZE, partitionsBetween } from "./partitions.ts";
import { indexRange, indexSingle } from "../pipeline.ts";
import { Aggregator, aggregate, canonicalJson, sha256, type Aggregates } from "./aggregates.ts";

/** Bumped when the files or the manifest change shape. */
export const MANIFEST_VERSION = 3;

/**
 * What a manifest covers: `full`, every ledger of the range (the public audit path, from the data lake
 * alone); `registry`, only the ledgers registry discovery selected in the range, listed by hash.
 */
export type ManifestScope = "full" | "registry";

/** The discovery sources a registry-scope manifest can name. */
export const DISCOVERY_SOURCES = ["lumeus"] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

export type RebuildErrorCode =
  "range_incomplete" | "range_invalid" | "anchor_out_of_range" | "anchor_mismatch";

export class RebuildError extends Error {
  readonly code: RebuildErrorCode;
  constructor(code: RebuildErrorCode, message: string) {
    super(message);
    this.name = "RebuildError";
    this.code = code;
  }
}

export interface RebuildOptions {
  readonly network: IndexNetwork;
  readonly epoch: Epoch;
  readonly registry: RegistrySnapshot;
  readonly source: LedgerSource;
  /** How the source is named in the manifest: a URL, never a local path. */
  readonly sourceDescription: { readonly kind: "data-lake" | "directory"; readonly uri: string | null };
  readonly from: number;
  readonly to: number;
  /**
   * Independently known ledger hashes the chain must pass through: ledgers `from - 1` (the previous
   * hash of the first ledger) to `to`. Anything outside that range is refused, never listed unchecked.
   */
  readonly anchors?: readonly Anchor[];
  readonly concurrency?: number;
  /**
   * Raw ledger bytes held at once (see `IndexRangeOptions.maxBytesInFlight`): with the data lake, one
   * decoded ledger is alive at a time, whatever the range.
   */
  readonly maxBytesInFlight?: number;
  /**
   * Whether the result keeps every row in memory (default true). With false, rows are only streamed to
   * the files and `onRow`, so memory does not grow with the range; `rows` and `failed` come back empty.
   */
  readonly retainRows?: boolean;
  /** Stops the rebuild with the signal's reason, before the next ledger. */
  readonly signal?: AbortSignal;
  readonly outDir: string;
  readonly onProgress?: (ledger: number) => void;
  /** Every ledger as it is verified, in order. */
  readonly onLedger?: (ledger: VerifiedLedger) => void;
  /** Every settlement row, in file order; throwing stops the rebuild. */
  readonly onRow?: (row: SettlementRow) => void;
}

export interface ManifestFile {
  readonly sha256: string;
  readonly bytes: number;
  readonly lines: number;
}

export interface Manifest {
  readonly manifestVersion: number;
  readonly scope: ManifestScope;
  readonly network: IndexNetwork;
  readonly epoch: string;
  readonly rulesVersion: string;
  readonly registryVersion: string;
  /**
   * The rules and registry versions the rows themselves carry, sorted. A rebuild always has exactly the
   * versions above; a report served while rows are re-attributed lists the older ones too.
   */
  readonly rowVersions: { readonly rules: readonly string[]; readonly registry: readonly string[] };
  /** SHA-256 of the registry document as canonical JSON. */
  readonly registrySha256: string;
  /**
   * Where the ledgers came from: `data-lake` or `directory` for a full scan; `registry` with the
   * `discovery` source that selected the ledgers. Ledger bytes are verified whatever their source, so a
   * registry-scope manifest is the same whether a ledger was read from the data lake or an RPC.
   */
  readonly source: {
    readonly kind: string;
    readonly uri: string | null;
    readonly dataLakeFolder: string;
    readonly discovery?: DiscoverySource;
  };
  readonly range: { readonly from: number; readonly to: number };
  /** Full scope: the first ledger's previous hash and the last ledger's hash, the ends of the chain. */
  readonly firstLedger?: { readonly ledger: number; readonly previousHash: string };
  readonly lastLedger?: { readonly ledger: number; readonly hash: string };
  /** Registry scope: every ledger read, ascending, with its verified hash. */
  readonly ledgers?: readonly Anchor[];
  readonly anchors: readonly Anchor[];
  readonly partitions: readonly {
    readonly start: number;
    readonly from: number;
    readonly to: number;
    readonly rows: number;
    readonly failed: number;
    /** SHA-256 of the partition's lines of settlements.ndjson. */
    readonly rowsSha256: string;
    readonly lastLedgerHash: string;
  }[];
  readonly files: Readonly<
    Record<"settlements.ndjson" | "failed_attempts.ndjson" | "aggregates.json", ManifestFile>
  >;
  /** SHA-256 of aggregates.json. */
  readonly totalsSha256: string;
}

export interface RebuildResult {
  readonly manifest: Manifest;
  readonly manifestSha256: string;
  readonly rows: readonly SettlementRow[];
  readonly failed: readonly FailedAttemptRow[];
  /** The totals written to aggregates.json. */
  readonly aggregates: Aggregates;
}

const describeFile = (text: string): ManifestFile => ({
  sha256: sha256(text),
  bytes: Buffer.byteLength(text),
  lines: text === "" ? 0 : text.split("\n").length - 1,
});

const ndjson = (values: readonly unknown[]) => values.map((value) => `${canonicalJson(value)}\n`).join("");

/**
 * Rebuilds every row of `from`..`to` from ledgers alone (scope `full`): every ledger is verified against its
 * own hashes and the chain, classified under the current rules and the given registry, and written as
 * canonical NDJSON sorted by (ledger, txIndex), with aggregates and a manifest of checksums. The same
 * ledgers, rules and registry give byte-identical files. A ledger missing from the source fails the
 * rebuild rather than shortening it.
 */
export async function rebuild(options: RebuildOptions): Promise<RebuildResult> {
  if (options.to < options.from || options.from < options.epoch.fromLedger) {
    throw new RebuildError(
      "range_invalid",
      `the range ${String(options.from)}-${String(options.to)} is not inside epoch ${options.epoch.id}`,
    );
  }
  const ctx: ClassifyContext = {
    network: options.network,
    epoch: options.epoch.id,
    passphrase: options.epoch.passphrase,
    registry: options.registry,
  };
  const anchors = checkedAnchors(options.anchors ?? [], options.from, options.to);
  const start = anchors.find((anchor) => anchor.ledger === options.from - 1);
  const chain = new HashChain(
    undefined,
    anchors.filter((anchor) => anchor !== start),
  );
  const retain = options.retainRows ?? true;
  const rows: SettlementRow[] = [];
  const failed: FailedAttemptRow[] = [];
  const aggregator = new Aggregator();
  const rules = new Set<string>();
  const registries = new Set<string>();
  const partitions: Manifest["partitions"][number][] = [];
  let firstLedger: Manifest["firstLedger"] | undefined;
  let lastLedger: Manifest["lastLedger"] | undefined;
  let failedCount = 0;

  // Rows go to the files as they are read, under temporary names until the rebuild completes.
  mkdirSync(options.outDir, { recursive: true });
  const settlementsFile = new StreamedFile(join(options.outDir, "settlements.ndjson"));
  const failedFile = new StreamedFile(join(options.outDir, "failed_attempts.ndjson"));
  let complete = false;
  try {
    for (const range of partitionsBetween(options.from, options.to)) {
      const partitionHash = createHash("sha256");
      let partitionRows = 0;
      let partitionFailed = 0;
      let reached = range.from - 1;
      let lastHash = "";
      for await (const ledger of indexRange(options.source, chain, range.from, range.to, ctx, {
        concurrency: options.concurrency ?? 8,
        ...(options.maxBytesInFlight === undefined ? {} : { maxBytesInFlight: options.maxBytesInFlight }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })) {
        if (firstLedger === undefined) {
          firstLedger = { ledger: ledger.verified.ledger, previousHash: ledger.verified.previousHash };
          if (start !== undefined && start.hash !== firstLedger.previousHash) {
            throw new LedgerSourceError(
              "anchor_mismatch",
              `ledger ${String(firstLedger.ledger)}: its previous hash ${firstLedger.previousHash} differs from the anchor ${start.hash} for ledger ${String(start.ledger)}`,
            );
          }
        }
        reached = ledger.verified.ledger;
        lastHash = ledger.verified.hash;
        options.onLedger?.(ledger.verified);
        for (const row of ledger.classification.rows) {
          const line = `${canonicalJson(row)}\n`;
          settlementsFile.add(line);
          partitionHash.update(line);
          partitionRows++;
          aggregator.add(row);
          rules.add(row.rulesVersion);
          registries.add(row.registryVersion);
          options.onRow?.(row);
          if (retain) rows.push(row);
        }
        for (const attempt of ledger.classification.failed) {
          failedFile.add(`${canonicalJson(attempt)}\n`);
          if (retain) failed.push(attempt);
        }
        failedCount += ledger.classification.failed.length;
        partitionFailed += ledger.classification.failed.length;
        for (const [reason, count] of Object.entries(ledger.classification.excluded)) {
          aggregator.addExcluded(reason as ExclusionReason, count);
        }
        options.onProgress?.(reached);
      }
      if (reached !== range.to) {
        throw new RebuildError(
          "range_incomplete",
          `ledger ${String(reached + 1)} is not available from the source`,
        );
      }
      lastLedger = { ledger: reached, hash: lastHash };
      partitions.push({
        start: range.start,
        from: range.from,
        to: range.to,
        rows: partitionRows,
        failed: partitionFailed,
        rowsSha256: partitionHash.digest("hex"),
        lastLedgerHash: lastHash,
      });
    }
    if (firstLedger === undefined || lastLedger === undefined) {
      throw new RebuildError("range_incomplete", "no ledger was read");
    }
    complete = true;
  } finally {
    settlementsFile.close(complete);
    failedFile.close(complete);
  }

  aggregator.addFailedAttempts(failedCount);
  const aggregates = aggregator.result();
  const aggregatesText = `${canonicalJson(aggregates)}\n`;
  const manifest: Manifest = {
    manifestVersion: MANIFEST_VERSION,
    scope: "full",
    network: options.network,
    epoch: options.epoch.id,
    rulesVersion: RULES_VERSION,
    registryVersion: options.registry.registryVersion,
    rowVersions: { rules: [...rules].sort(), registry: [...registries].sort() },
    registrySha256: sha256(canonicalJson(options.registry.document)),
    source: { ...options.sourceDescription, dataLakeFolder: options.epoch.dataLakeFolder },
    range: { from: options.from, to: options.to },
    firstLedger,
    lastLedger,
    // Every anchor listed here was checked: from - 1 as the first ledger's previous hash, the rest on the chain.
    anchors,
    partitions,
    files: {
      "settlements.ndjson": settlementsFile.describe(),
      "failed_attempts.ndjson": failedFile.describe(),
      "aggregates.json": describeFile(aggregatesText),
    },
    totalsSha256: sha256(aggregatesText),
  };
  writeFileSync(join(options.outDir, "aggregates.json"), aggregatesText);
  const manifestSha256 = writeManifest(options.outDir, manifest);
  return { manifest, manifestSha256, rows, failed, aggregates };
}

/**
 * A rebuild file written line by line and hashed as it goes: kept under a temporary name until the
 * rebuild completes, then renamed into place, so a failed rebuild never leaves a short file behind.
 */
class StreamedFile {
  readonly #path: string;
  readonly #fd: number;
  readonly #hash: Hash = createHash("sha256");
  #bytes = 0;
  #lines = 0;
  #open = true;

  constructor(path: string) {
    this.#path = path;
    this.#fd = openSync(`${path}.partial`, "w");
  }

  add(line: string): void {
    writeSync(this.#fd, line);
    this.#hash.update(line);
    this.#bytes += Buffer.byteLength(line);
    this.#lines++;
  }

  close(keep: boolean): void {
    if (!this.#open) return;
    this.#open = false;
    closeSync(this.#fd);
    if (keep) renameSync(`${this.#path}.partial`, this.#path);
    else rmSync(`${this.#path}.partial`, { force: true });
  }

  describe(): ManifestFile {
    return { sha256: this.#hash.digest("hex"), bytes: this.#bytes, lines: this.#lines };
  }
}

export interface LedgersRebuildOptions {
  readonly network: IndexNetwork;
  readonly epoch: Epoch;
  readonly registry: RegistrySnapshot;
  readonly source: LedgerSource;
  /** The range discovery covered, inclusive; every listed ledger lies inside it. */
  readonly range: { readonly from: number; readonly to: number };
  /** The ledgers to read, with the hash each must have when it is known (a published manifest's list). */
  readonly ledgers: readonly { readonly ledger: number; readonly hash?: string }[];
  readonly discovery: DiscoverySource;
  /** Independently known hashes of listed ledgers, checked against each ledger read. */
  readonly anchors?: readonly Anchor[];
  readonly concurrency?: number;
  readonly outDir: string;
  readonly onProgress?: (ledger: number) => void;
}

/**
 * Rebuilds a registry-scope result from the listed ledgers alone: each ledger is read (the data lake by
 * default, no discovery source needed), verified against its own hashes and any hash the list or an
 * anchor gives, classified under the current rules and the given registry, and written exactly as a
 * full rebuild writes its files. The manifest lists every ledger with its hash, so the same list, rules
 * and registry give the same manifest hash as the Explorer's published report.
 */
export async function rebuildLedgers(options: LedgersRebuildOptions): Promise<RebuildResult> {
  const { range } = options;
  if (range.to < range.from || range.from < options.epoch.fromLedger) {
    throw new RebuildError(
      "range_invalid",
      `the range ${String(range.from)}-${String(range.to)} is not inside epoch ${options.epoch.id}`,
    );
  }
  const listed = [...options.ledgers].sort((a, b) => a.ledger - b.ledger);
  for (let index = 0; index < listed.length; index++) {
    const entry = listed[index];
    if (entry === undefined) continue;
    if (!Number.isSafeInteger(entry.ledger) || entry.ledger < range.from || entry.ledger > range.to) {
      throw new RebuildError(
        "range_invalid",
        `ledger ${String(entry.ledger)} is outside ${String(range.from)}-${String(range.to)}`,
      );
    }
    if (listed[index - 1]?.ledger === entry.ledger) {
      throw new RebuildError("range_invalid", `ledger ${String(entry.ledger)} is listed twice`);
    }
  }
  const expected = new Map(listed.map((entry) => [entry.ledger, entry.hash]));
  const anchors = new Map<number, string>();
  for (const anchor of options.anchors ?? []) {
    if (!expected.has(anchor.ledger)) {
      throw new RebuildError(
        "anchor_out_of_range",
        `the anchor for ledger ${String(anchor.ledger)} names a ledger the list does not hold, so it could not be checked`,
      );
    }
    const known = anchors.get(anchor.ledger);
    if (known !== undefined && known !== anchor.hash) {
      throw new RebuildError("range_invalid", `two different anchors for ledger ${String(anchor.ledger)}`);
    }
    anchors.set(anchor.ledger, anchor.hash);
  }
  const ctx: ClassifyContext = {
    network: options.network,
    epoch: options.epoch.id,
    passphrase: options.epoch.passphrase,
    registry: options.registry,
  };
  const rows: SettlementRow[] = [];
  const failed: FailedAttemptRow[] = [];
  const excluded: Partial<Record<ExclusionReason, number>> = {};
  const read: Anchor[] = [];
  const perLedger = new Map<number, { rows: readonly SettlementRow[]; failed: number }>();
  const pending = new Map<number, Promise<SourcedLedger | undefined>>();
  const concurrency = options.concurrency ?? 8;
  let ahead = 0;
  for (let index = 0; index < listed.length; index++) {
    while (ahead < listed.length && ahead < index + concurrency) {
      const sequence = listed[ahead]?.ledger ?? 0;
      const promise = options.source.getLedger(sequence);
      promise.catch(() => undefined);
      pending.set(sequence, promise);
      ahead++;
    }
    const sequence = listed[index]?.ledger ?? 0;
    const sourced = await pending.get(sequence);
    pending.delete(sequence);
    if (sourced === undefined) {
      throw new RebuildError(
        "range_incomplete",
        `ledger ${String(sequence)} is not available from the source`,
      );
    }
    const indexed = indexSingle(sequence, sourced, ctx);
    for (const [what, hash] of [
      ["the list", expected.get(sequence)],
      ["the anchor", anchors.get(sequence)],
    ] as const) {
      if (hash !== undefined && hash !== indexed.verified.hash) {
        throw new LedgerSourceError(
          "anchor_mismatch",
          `ledger ${String(sequence)}: hash ${indexed.verified.hash} differs from ${what}'s ${hash}`,
        );
      }
    }
    read.push({ ledger: sequence, hash: indexed.verified.hash });
    rows.push(...indexed.classification.rows);
    failed.push(...indexed.classification.failed);
    perLedger.set(sequence, {
      rows: indexed.classification.rows,
      failed: indexed.classification.failed.length,
    });
    for (const [reason, count] of Object.entries(indexed.classification.excluded)) {
      excluded[reason as ExclusionReason] = (excluded[reason as ExclusionReason] ?? 0) + count;
    }
    options.onProgress?.(sequence);
  }
  const partitionLines = new PartitionLines();
  for (const { ledger } of read) {
    for (const row of perLedger.get(ledger)?.rows ?? [])
      partitionLines.add(ledger, `${canonicalJson(row)}\n`);
  }
  const settlementsText = ndjson(rows);
  const failedText = ndjson(failed);
  const aggregates = aggregate(rows, failed, excluded);
  const aggregatesText = `${canonicalJson(aggregates)}\n`;
  const manifest: Manifest = {
    manifestVersion: MANIFEST_VERSION,
    scope: "registry",
    network: options.network,
    epoch: options.epoch.id,
    rulesVersion: RULES_VERSION,
    registryVersion: options.registry.registryVersion,
    rowVersions: rowVersionsOf(rows),
    registrySha256: sha256(canonicalJson(options.registry.document)),
    source: registrySource(options.epoch, options.discovery),
    range: { from: range.from, to: range.to },
    ledgers: read,
    anchors: [...anchors].sort(([a], [b]) => a - b).map(([ledger, hash]) => ({ ledger, hash })),
    partitions: registryPartitions(read, partitionLines, (ledger) => perLedger.get(ledger)?.failed ?? 0),
    files: {
      "settlements.ndjson": describeFile(settlementsText),
      "failed_attempts.ndjson": describeFile(failedText),
      "aggregates.json": describeFile(aggregatesText),
    },
    totalsSha256: sha256(aggregatesText),
  };
  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(join(options.outDir, "settlements.ndjson"), settlementsText);
  writeFileSync(join(options.outDir, "failed_attempts.ndjson"), failedText);
  writeFileSync(join(options.outDir, "aggregates.json"), aggregatesText);
  const manifestSha256 = writeManifest(options.outDir, manifest);
  return { manifest, manifestSha256, rows, failed, aggregates };
}

/**
 * How a full-scope manifest names the public data lake: the same for the rebuild command and the
 * Explorer's network window, so both write the same manifest for the same range.
 */
export function dataLakeDescription(epoch: Epoch): RebuildOptions["sourceDescription"] {
  return { kind: "data-lake", uri: `${DATA_LAKE_BASE_URL}${epoch.dataLakeFolder}/` };
}

/**
 * The anchors `--anchor-horizon` gives a full scan: the hashes of ledgers `from - 1` and `to` from an
 * independent source. The rebuild checks both on the chain it reads and lists them in its manifest.
 */
export async function rangeAnchors(source: AnchorSource, from: number, to: number): Promise<Anchor[]> {
  return [
    { ledger: from - 1, hash: await source.ledgerHash(from - 1) },
    { ledger: to, hash: await source.ledgerHash(to) },
  ];
}

/** The `source` of a registry-scope manifest. */
export function registrySource(epoch: Epoch, discovery: DiscoverySource): Manifest["source"] {
  return { kind: "registry", discovery, uri: null, dataLakeFolder: epoch.dataLakeFolder };
}

/**
 * Settlement lines hashed per data lake partition as they are read, in ledger order, so a report over
 * any number of rows keeps none of them.
 */
export class PartitionLines {
  readonly #partitions = new Map<number, { hash: Hash; rows: number }>();
  #last = 0;

  add(ledger: number, line: string): void {
    if (ledger < this.#last) throw new RangeError("settlement lines must come in ledger order");
    this.#last = ledger;
    const start = Math.floor(ledger / PARTITION_SIZE) * PARTITION_SIZE;
    let entry = this.#partitions.get(start);
    if (entry === undefined) {
      entry = { hash: createHash("sha256"), rows: 0 };
      this.#partitions.set(start, entry);
    }
    entry.hash.update(line);
    entry.rows++;
  }

  /** The count and SHA-256 of a partition's lines; once per partition. */
  digest(start: number): { readonly rows: number; readonly sha256: string } {
    const entry = this.#partitions.get(start);
    return { rows: entry?.rows ?? 0, sha256: (entry?.hash ?? createHash("sha256")).digest("hex") };
  }
}

/**
 * The partitions of a registry-scope manifest: every data lake partition holding a listed ledger, from
 * its first to its last listed ledger, with the count and SHA-256 of its settlement lines (of the listed
 * ledgers, added to `lines` in ledger order) and its last listed ledger's hash.
 */
export function registryPartitions(
  ledgers: readonly Anchor[],
  lines: PartitionLines,
  failed: (ledger: number) => number,
): Manifest["partitions"][number][] {
  const out: Manifest["partitions"][number][] = [];
  let current: { start: number; from: number; to: number; failed: number; last: string } | undefined;
  const close = () => {
    if (current === undefined) return;
    const digest = lines.digest(current.start);
    out.push({
      start: current.start,
      from: current.from,
      to: current.to,
      rows: digest.rows,
      failed: current.failed,
      rowsSha256: digest.sha256,
      lastLedgerHash: current.last,
    });
  };
  for (const ledger of ledgers) {
    const start = Math.floor(ledger.ledger / PARTITION_SIZE) * PARTITION_SIZE;
    if (current?.start !== start) {
      close();
      current = { start, from: ledger.ledger, to: ledger.ledger, failed: 0, last: "" };
    }
    current.failed += failed(ledger.ledger);
    current.to = ledger.ledger;
    current.last = ledger.hash;
  }
  close();
  return out;
}

/**
 * The ledger list and range a published registry-scope manifest names (`--ledgers-from`). Throws when the
 * text is not such a manifest.
 */
export function ledgersFromManifest(text: string): {
  readonly range: { readonly from: number; readonly to: number };
  readonly ledgers: readonly Anchor[];
  readonly discovery: DiscoverySource;
} {
  const manifest = JSON.parse(text) as Partial<Manifest> | null;
  if (manifest?.scope !== "registry" || !Array.isArray(manifest.ledgers)) {
    throw new Error("the file is not a registry-scope manifest with a ledgers list");
  }
  const discovery = manifest.source?.discovery;
  if (discovery === undefined || !(DISCOVERY_SOURCES as readonly string[]).includes(discovery)) {
    throw new Error("the manifest names no known discovery source");
  }
  const range = manifest.range;
  if (range === undefined || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)) {
    throw new Error("the manifest has no range");
  }
  const ledgers = manifest.ledgers.map((item: unknown) => {
    const { ledger, hash } = (item ?? {}) as { ledger?: unknown; hash?: unknown };
    if (!Number.isSafeInteger(ledger) || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
      throw new Error("every listed ledger must be { ledger, hash } with a 64 hex hash");
    return { ledger: ledger as number, hash };
  });
  return { range: { from: range.from, to: range.to }, ledgers, discovery };
}

/**
 * Checks every listed ledger's hash against an independent anchor source (a Horizon with full history),
 * so a rebuild of a published ledger list trusts neither the data lake nor the publisher's hashes alone.
 * Throws `anchor_mismatch` naming the first ledger whose hash differs; a ledger the source cannot answer
 * for fails too. Nothing about the manifest changes: the check only refuses.
 */
export async function checkListedLedgers(ledgers: readonly Anchor[], anchors: AnchorSource): Promise<number> {
  const known =
    (await anchors.ledgerHashes?.(ledgers.map((entry) => entry.ledger))) ?? new Map<number, string>();
  for (const entry of ledgers) {
    const expected = known.get(entry.ledger) ?? (await anchors.ledgerHash(entry.ledger));
    if (expected !== entry.hash) {
      throw new RebuildError(
        "anchor_mismatch",
        `ledger ${String(entry.ledger)} is listed with hash ${entry.hash}, but ${anchors.name} has ${expected}`,
      );
    }
  }
  return ledgers.length;
}

/** The registry SHA-256 a manifest names, or undefined. */
export function manifestRegistrySha256(text: string): string | undefined {
  const value = (JSON.parse(text) as { registrySha256?: unknown } | null)?.registrySha256;
  return typeof value === "string" ? value : undefined;
}

/** The distinct rules and registry versions of `rows`, sorted. */
export function rowVersionsOf(rows: readonly SettlementRow[]): Manifest["rowVersions"] {
  return {
    rules: [...new Set(rows.map((row) => row.rulesVersion))].sort(),
    registry: [...new Set(rows.map((row) => row.registryVersion))].sort(),
  };
}

/** The anchors sorted by ledger; refuses one outside `from - 1`..`to`, or two hashes for one ledger. */
function checkedAnchors(anchors: readonly Anchor[], from: number, to: number): Anchor[] {
  const byLedger = new Map<number, string>();
  for (const anchor of anchors) {
    if (anchor.ledger < from - 1 || anchor.ledger > to) {
      throw new RebuildError(
        "anchor_out_of_range",
        `the anchor for ledger ${String(anchor.ledger)} is outside ${String(from - 1)}-${String(to)}, so it could not be checked`,
      );
    }
    const known = byLedger.get(anchor.ledger);
    if (known !== undefined && known !== anchor.hash) {
      throw new RebuildError("range_invalid", `two different anchors for ledger ${String(anchor.ledger)}`);
    }
    byLedger.set(anchor.ledger, anchor.hash);
  }
  return [...byLedger].sort(([a], [b]) => a - b).map(([ledger, hash]) => ({ ledger, hash }));
}

/**
 * The anchors a published manifest lists (`--anchors-from`): a rebuild that checks the same anchors on
 * the chain it reads lists them in its own manifest, so it hashes the same. Throws when the text is
 * not a manifest with a well-formed anchors list.
 */
export function anchorsFromManifest(text: string): Anchor[] {
  const listed = (JSON.parse(text) as { anchors?: unknown } | null)?.anchors;
  if (!Array.isArray(listed)) throw new Error("the file has no anchors list");
  return listed.map((item: unknown) => {
    const { ledger, hash } = (item ?? {}) as { ledger?: unknown; hash?: unknown };
    if (!Number.isSafeInteger(ledger) || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
      throw new Error("every anchor must be { ledger, hash } with a 64 hex hash");
    return { ledger: ledger as number, hash };
  });
}

/** Writes manifest.json as canonical JSON and returns its SHA-256, the one hash that pins the rebuild. */
export function writeManifest(outDir: string, manifest: Manifest): string {
  const text = `${canonicalJson(manifest)}\n`;
  writeFileSync(join(outDir, "manifest.json"), text);
  return sha256(text);
}
