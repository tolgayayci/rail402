import { Buffer } from "buffer";
import { StrKey, hash } from "@stellar/stellar-sdk";
import { z } from "zod";

const HEX64 = /^[0-9a-f]{64}$/;
const ledger = z.number().int().min(1).max(0xffffffff);

const evidenceSchema = z
  .strictObject({
    url: z.url({ protocol: /^https$/ }),
    /** SHA-256 of the archived file. */
    sha256: z.string().regex(HEX64),
    /**
     * `copy` (the default): the archive is exactly what the URL returned. `extract`: the archive is an
     * {@link EvidenceExtract} quoting the relevant statement of a third-party page, and
     * `sourceSha256` is the SHA-256 of the full response it was taken from.
     */
    kind: z.enum(["copy", "extract"]).optional(),
    sourceSha256: z.string().regex(HEX64).optional(),
    archivedAt: z.iso.datetime(),
    /** The archived file, relative to the package root: `registry/evidence/<sha256>.<ext>`. */
    archive: z.string().regex(/^registry\/evidence\/[0-9a-f]{64}\.(json|html|txt)$/),
  })
  .refine((evidence) => (evidence.kind === "extract") === (evidence.sourceSha256 !== undefined), {
    message: "sourceSha256 is required for an extract and allowed only there",
  })
  .refine((evidence) => evidence.kind !== "extract" || evidence.archive.endsWith(".json"), {
    message: "an extract is archived as JSON",
  });

/**
 * The archived form of `extract` evidence: the statement that supports the entry, quoted from a
 * third-party page (an issue or a comment), without the rest of the page or other people's data.
 */
const evidenceExtractSchema = z.strictObject({
  kind: z.literal("extract"),
  url: z.url({ protocol: /^https$/ }),
  html_url: z.url({ protocol: /^https$/ }),
  created_at: z.iso.datetime(),
  author: z.string().min(1).max(64),
  statement: z.string().min(1).max(2_000),
  sourceSha256: z.string().regex(HEX64),
});

export type EvidenceExtract = z.infer<typeof evidenceExtractSchema>;

const rangeFields = {
  epoch: z.string().min(1).max(32),
  validFromLedger: ledger,
  validToLedger: ledger.nullable(),
};

const accountSchema = z.strictObject({
  address: z
    .string()
    .refine((value) => StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value), {
      message: "not a G… account or C… contract",
    }),
  role: z.enum(["sponsor", "channel", "upto-authority", "fee-bump", "relayer"]),
  ...rangeFields,
  evidence: z.array(evidenceSchema).min(1),
  note: z.string().max(500).optional(),
});

const facilitatorSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: z.string().min(1).max(100),
  tier: z.enum(["rail402", "rail402-beta", "facilitator"]),
  sharedRelayer: z.boolean(),
  /** Facilitator base URLs (https), for matching a configured facilitator to its entry. */
  urls: z
    .array(z.url({ protocol: /^https$/ }))
    .max(10)
    .optional(),
  note: z.string().max(500).optional(),
  accounts: z.array(accountSchema).min(1),
});

const uptoContractSchema = z.strictObject({
  contract: z.string().refine((value) => StrKey.isValidContract(value), { message: "not a C… contract" }),
  wasmSha256: z.string().regex(HEX64),
  ...rangeFields,
  rule: z.enum(["R-UPTO", "R-UPTO-BETA"]),
  /** The facilitator whose settlement authority the contract serves, when one is known. */
  facilitatorId: z.string().optional(),
  deploymentRecord: z.string().optional(),
  evidence: z.array(evidenceSchema).min(1),
  note: z.string().max(500).optional(),
});

/** The registry file format (`registry/<network>.json`). Changes only by reviewed commit. */
export const registrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  network: z.enum(["stellar:testnet", "stellar:pubnet"]),
  registryVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d{1,3}$/),
  epochs: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(32),
        passphrase: z.string().min(1),
        fromLedger: ledger,
        dataLakeFolder: z.string().regex(/^(pubnet|testnet\/\d{4}-\d{2}-\d{2})$/),
      }),
    )
    .min(1),
  facilitators: z.array(facilitatorSchema),
  uptoContracts: z.array(uptoContractSchema),
});

export type RegistryDocument = z.infer<typeof registrySchema>;
export type RegistryFacilitator = RegistryDocument["facilitators"][number];
export type RegistryAccount = RegistryFacilitator["accounts"][number];
export type RegistryUptoContract = RegistryDocument["uptoContracts"][number];
export type RegistryEvidence = RegistryAccount["evidence"][number];

export class RegistryError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid registry: ${problems.slice(0, 5).join("; ")}`);
    this.name = "RegistryError";
    this.problems = problems;
  }
}

/** A facilitator account valid in a ledger, with its facilitator. */
export interface AccountMatch {
  readonly facilitator: RegistryFacilitator;
  readonly account: RegistryAccount;
}

/** A parsed, validated registry with lookups by ledger. */
export interface RegistrySnapshot {
  readonly document: RegistryDocument;
  readonly network: RegistryDocument["network"];
  readonly registryVersion: string;
  /** The facilitator account `address` belongs to in `ledger` of `epoch`, if any. */
  accountAt(address: string, epoch: string, ledger: number): AccountMatch | undefined;
  /** The upto contract entry for `contract` in `ledger` of `epoch`, if any. */
  uptoContractAt(contract: string, epoch: string, ledger: number): RegistryUptoContract | undefined;
  facilitator(id: string): RegistryFacilitator | undefined;
}

interface Ranged {
  readonly epoch: string;
  readonly validFromLedger: number;
  readonly validToLedger: number | null;
}

const within = (entry: Ranged, epoch: string, at: number) =>
  entry.epoch === epoch &&
  at >= entry.validFromLedger &&
  (entry.validToLedger === null || at <= entry.validToLedger);

const overlaps = (a: Ranged, b: Ranged) =>
  a.epoch === b.epoch &&
  a.validFromLedger <= (b.validToLedger ?? Infinity) &&
  b.validFromLedger <= (a.validToLedger ?? Infinity);

/**
 * Parses and validates a registry document. Beyond the schema: unique facilitator ids, every range
 * inside a declared epoch with `validToLedger ≥ validFromLedger`, no address in two overlapping
 * ranges (across facilitators too), and no upto contract in two overlapping ranges. Throws
 * `RegistryError` listing every problem.
 */
export function parseRegistry(json: unknown): RegistrySnapshot {
  const parsed = registrySchema.safeParse(json);
  if (!parsed.success) {
    throw new RegistryError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  const document = parsed.data;
  const problems: string[] = [];
  const epochs = new Set(document.epochs.map((epoch) => epoch.id));
  if (epochs.size !== document.epochs.length) problems.push("duplicate epoch id");
  const checkRange = (where: string, entry: Ranged) => {
    if (!epochs.has(entry.epoch)) problems.push(`${where}: unknown epoch ${entry.epoch}`);
    if (entry.validToLedger !== null && entry.validToLedger < entry.validFromLedger) {
      problems.push(`${where}: validToLedger precedes validFromLedger`);
    }
  };

  const facilitators = new Map<string, RegistryFacilitator>();
  const accounts = new Map<string, AccountMatch[]>();
  for (const facilitator of document.facilitators) {
    if (facilitators.has(facilitator.id)) problems.push(`duplicate facilitator id ${facilitator.id}`);
    facilitators.set(facilitator.id, facilitator);
    for (const account of facilitator.accounts) {
      const where = `${facilitator.id}/${account.address}`;
      checkRange(where, account);
      const list = accounts.get(account.address) ?? [];
      for (const other of list) {
        if (overlaps(other.account, account)) {
          problems.push(`${where}: ledger range overlaps ${other.facilitator.id}/${other.account.address}`);
        }
      }
      list.push({ facilitator, account });
      accounts.set(account.address, list);
    }
  }
  const upto = new Map<string, RegistryUptoContract[]>();
  for (const entry of document.uptoContracts) {
    checkRange(entry.contract, entry);
    const owner = entry.facilitatorId === undefined ? undefined : facilitators.get(entry.facilitatorId);
    if (entry.facilitatorId !== undefined && owner === undefined) {
      problems.push(`${entry.contract}: unknown facilitator ${entry.facilitatorId}`);
    }
    if (entry.rule === "R-UPTO-BETA" && owner !== undefined && owner.tier !== "rail402-beta") {
      problems.push(`${entry.contract}: a beta contract must belong to a rail402-beta facilitator`);
    }
    const list = upto.get(entry.contract) ?? [];
    if (list.some((other) => overlaps(other, entry)))
      problems.push(`${entry.contract}: ledger ranges overlap`);
    list.push(entry);
    upto.set(entry.contract, list);
  }
  if (problems.length > 0) throw new RegistryError(problems);

  return {
    document,
    network: document.network,
    registryVersion: document.registryVersion,
    accountAt: (address, epoch, at) =>
      accounts.get(address)?.find((match) => within(match.account, epoch, at)),
    uptoContractAt: (contract, epoch, at) => upto.get(contract)?.find((entry) => within(entry, epoch, at)),
    facilitator: (id) => facilitators.get(id),
  };
}

/** Every evidence item of a registry, for checks that the archived copies exist and match. */
export function registryEvidence(document: RegistryDocument): RegistryEvidence[] {
  return [
    ...document.facilitators.flatMap((facilitator) =>
      facilitator.accounts.flatMap((account) => account.evidence),
    ),
    ...document.uptoContracts.flatMap((entry) => entry.evidence),
  ];
}

/**
 * What is wrong with the archived file of `evidence`, given its bytes; empty when it checks out. Every
 * file must hash to `evidence.sha256`. An extract must also be a valid {@link EvidenceExtract} for the
 * same URL and source hash, and its statement must name `address` when one is given.
 */
export function evidenceProblems(
  evidence: RegistryEvidence,
  archived: Uint8Array,
  address?: string,
): string[] {
  const problems: string[] = [];
  const digest = hash(Buffer.from(archived)).toString("hex");
  if (digest !== evidence.sha256)
    problems.push(`${evidence.archive}: SHA-256 ${digest}, expected ${evidence.sha256}`);
  if (!evidence.archive.includes(evidence.sha256))
    problems.push(`${evidence.archive}: not named by its SHA-256`);
  if (evidence.kind !== "extract") return problems;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(archived).toString("utf8"));
  } catch {
    return [...problems, `${evidence.archive}: not JSON`];
  }
  const extract = evidenceExtractSchema.safeParse(parsed);
  if (!extract.success) return [...problems, `${evidence.archive}: not an evidence extract`];
  if (extract.data.url !== evidence.url) problems.push(`${evidence.archive}: quotes ${extract.data.url}`);
  if (extract.data.sourceSha256 !== evidence.sourceSha256)
    problems.push(`${evidence.archive}: source SHA-256 differs from the registry entry`);
  if (address !== undefined && !extract.data.statement.includes(address))
    problems.push(`${evidence.archive}: the statement does not name ${address}`);
  return problems;
}

/**
 * A fingerprint of the registry parts that decide which transactions are rows at all (the upto
 * contracts, their WASM, ranges and rules), as opposed to who settled them. When it changes between
 * registry versions, indexed ledgers must be classified again; otherwise re-attributing the stored
 * rows gives the same result as indexing again.
 */
export function classificationFingerprint(document: RegistryDocument): string {
  const entries = document.uptoContracts
    .map((entry) =>
      [
        entry.contract,
        entry.wasmSha256,
        entry.epoch,
        entry.validFromLedger,
        entry.validToLedger,
        entry.rule,
      ].join("|"),
    )
    .sort();
  return hash(Buffer.from(entries.join("\n"), "utf8")).toString("hex");
}
