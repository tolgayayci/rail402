import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { PUBNET, isStellarNetwork, type StellarNetwork } from "@rail402.dev/stellar";
import { ConfigError } from "./config-error.ts";

/**
 * Access keys: who may call `/verify` and `/settle` on which network, how often, and how much fee
 * sponsorship each key may use per hour. Keys come from a JSON file the operator reviews and replaces
 * atomically; the service re-reads it when it changes, so issuing, expiring and revoking a key needs
 * no restart. The file holds SHA-256 digests only, never a key.
 */
export interface AccessKeyRecord {
  /** Public identifier: in metrics, usage records and logs; never derived from the secret. */
  readonly id: string;
  /** SHA-256 of the full key string. */
  readonly sha256: Buffer;
  /** The networks the key may use. */
  readonly networks: readonly StellarNetwork[];
  /** Requests per minute per network (`/verify` and `/settle`); the network default when unset. */
  readonly requestsPerMinute?: number;
  /** Fees the key's settlements may commit per hour per network, in stroops. */
  readonly sponsorBudgetStroopsPerHour?: bigint;
  readonly expiresAt?: Date;
  readonly revoked: boolean;
  /** A digest from `API_KEY_SHA256`: matched by digest alone, valid on every configured network. */
  readonly legacy: boolean;
  /**
   * Scopes beyond payments. `discovery-internal` marks an internal caller of the discovery routes (a
   * hosted discovery front end): it draws on a bucket of its own instead of the per-address limit and
   * is refused on `/verify` and `/settle` everywhere.
   */
  readonly scopes: readonly AccessScope[];
  /**
   * Issued to a signed-in GitHub account (see `signup.ts`), not listed in the key file: counted under one
   * metric label, and refused while the key file switches issued keys off.
   */
  readonly issued?: true;
  /** For `discovery-internal`: requests per minute for the whole identity; the service default when unset. */
  readonly discoveryRequestsPerMinute?: number;
  /**
   * For `discovery-internal`: trust its `X-Rail402-Client` header and limit each forwarded client to this
   * many discovery requests per minute; unset = the header is ignored.
   */
  readonly forwardedClientRequestsPerMinute?: number;
}

export type AccessScope = "discovery-internal";

/**
 * What the key file allows for keys issued through GitHub sign-in (`issuedKeys`): `on` issues and
 * accepts them, `no-new` accepts the ones issued but issues no more, `off` also refuses every issued key.
 */
export type IssuedKeysMode = "on" | "no-new" | "off";

/** The id prefix of issued keys; key-file records cannot use it. */
export const ISSUED_KEY_ID_PREFIX = "gh-";

/** The `key_id` metric label of a key: its id, or `issued` for every issued key. */
export function metricKeyId(record: AccessKeyRecord): string {
  return record.issued === true ? "issued" : record.id;
}

export interface AccessKeyRules {
  /** The networks the service is configured for. */
  readonly networks: readonly string[];
  /** Accept keys that name a network the service does not serve yet. */
  readonly futureNetworks: boolean;
  /** Longest a key may live from `createdAt` to `expiresAt`, in days. */
  readonly maxLifetimeDays: number;
  /** Most keys a file may hold. */
  readonly max: number;
}

/** The largest key file read: 1,000 records fit easily. */
export const ACCESS_KEYS_FILE_MAX_BYTES = 1_048_576;

const KEY_ID = /^[a-z0-9][a-z0-9-]{2,31}$/;
/** `r402_<id>_<43 base64url characters>`: 32 random bytes after the public id. */
const KEY_STRING = /^r402_([a-z0-9][a-z0-9-]{2,31})_([A-Za-z0-9_-]{43})$/;
const STROOPS_PER_XLM = 10_000_000n;

const recordSchema = z
  .object({
    id: z
      .string()
      .regex(KEY_ID, "must be 3 to 32 lower-case letters, digits or dashes, starting with a letter or digit"),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lower-case hex characters"),
    label: z.string().max(64).optional(),
    networks: z.array(z.string()),
    scopes: z.array(z.enum(["discovery-internal"])).optional(),
    requestsPerMinute: z.number().int().min(1).max(100_000).optional(),
    discoveryRequestsPerMinute: z.number().int().min(1).max(1_000_000).optional(),
    forwardedClientRequestsPerMinute: z.number().int().min(1).max(100_000).optional(),
    sponsorBudgetXlmPerHour: z.string().optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    revoked: z.boolean().optional(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

const fileSchema = z
  .object({
    schemaVersion: z.literal(1),
    issuedKeys: z.enum(["on", "no-new", "off"]).optional(),
    keys: z.array(z.unknown()),
  })
  .strict();

/** A parsed access-key file: its records and what it allows for issued keys. */
export interface AccessKeyFile {
  readonly records: AccessKeyRecord[];
  readonly issuedKeys: IssuedKeysMode;
}

/**
 * Parses and validates an access-key file's content. Every problem is a `ConfigError` with code
 * `config_access_keys_invalid` naming the record by position or id, never a digest.
 */
export function parseAccessKeys(
  text: string,
  rules: AccessKeyRules,
  source = "API_KEYS_FILE",
): AccessKeyRecord[] {
  return parseAccessKeyFile(text, rules, source).records;
}

/** `parseAccessKeys` with the file's `issuedKeys` switch (`on` when absent). */
export function parseAccessKeyFile(
  text: string,
  rules: AccessKeyRules,
  source = "API_KEYS_FILE",
): AccessKeyFile {
  const fail = (message: string): never => {
    throw new ConfigError(`${source}: ${message}`, "config_access_keys_invalid");
  };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail("is not valid JSON");
  }
  const file = fileSchema.safeParse(json);
  if (!file.success)
    return fail('must be {"schemaVersion": 1, "issuedKeys"?: "on" | "no-new" | "off", "keys": [...]}');
  if (file.data.keys.length > rules.max)
    fail(`holds ${String(file.data.keys.length)} keys, more than ${String(rules.max)}`);
  const ids = new Set<string>();
  const digests = new Set<string>();
  const records = file.data.keys.map((raw, index): AccessKeyRecord => {
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(
        `key ${String(index)}: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "is invalid"}`.replace(
          /\s+/g,
          " ",
        ),
      );
    }
    const record = parsed.data;
    const at = `key ${record.id}`;
    if (record.id.startsWith(ISSUED_KEY_ID_PREFIX))
      fail(`${at}: ids starting with "${ISSUED_KEY_ID_PREFIX}" are kept for keys issued through sign-in`);
    const scopes = [...new Set(record.scopes ?? [])];
    const internal = scopes.includes("discovery-internal");
    // A discovery identity never pays, so it names no network; a payment key names at least one.
    if (internal && record.networks.length > 0) fail(`${at}: a discovery-internal key names no networks`);
    if (!internal && record.networks.length === 0) fail(`${at}: networks must name at least one network`);
    if (
      !internal &&
      (record.discoveryRequestsPerMinute !== undefined ||
        record.forwardedClientRequestsPerMinute !== undefined)
    ) {
      fail(`${at}: discovery limits are for discovery-internal keys`);
    }
    if (ids.has(record.id)) fail(`${at}: the id is used twice`);
    if (digests.has(record.sha256)) fail(`${at}: the digest is used by another key`);
    ids.add(record.id);
    digests.add(record.sha256);
    const networks: StellarNetwork[] = [];
    for (const network of record.networks) {
      if (!isStellarNetwork(network)) fail(`${at}: unknown network "${network}"`);
      else if (!rules.networks.includes(network) && !rules.futureNetworks) {
        fail(
          `${at}: ${network} is not served (set ACCESS_KEYS_FUTURE_NETWORKS=true to issue keys for it in advance)`,
        );
      } else if (!networks.includes(network)) networks.push(network);
    }
    const pubnet = networks.includes(PUBNET);
    const budget =
      record.sponsorBudgetXlmPerHour === undefined
        ? undefined
        : xlmToStroops(
            record.sponsorBudgetXlmPerHour,
            `${source}: ${at}: sponsorBudgetXlmPerHour`,
            "config_access_keys_invalid",
          );
    if (pubnet && budget === undefined) fail(`${at}: a pubnet key needs sponsorBudgetXlmPerHour`);
    const createdAt = new Date(record.createdAt);
    const expiresAt = record.expiresAt === undefined ? undefined : new Date(record.expiresAt);
    if (pubnet && expiresAt === undefined) fail(`${at}: a pubnet key needs expiresAt`);
    if (expiresAt !== undefined) {
      if (expiresAt <= createdAt) fail(`${at}: expiresAt is not after createdAt`);
      if (expiresAt.getTime() - createdAt.getTime() > rules.maxLifetimeDays * 86_400_000) {
        fail(`${at}: lives longer than ACCESS_KEY_MAX_LIFETIME_DAYS (${String(rules.maxLifetimeDays)})`);
      }
    }
    return {
      id: record.id,
      sha256: Buffer.from(record.sha256, "hex"),
      networks,
      ...(record.requestsPerMinute === undefined ? {} : { requestsPerMinute: record.requestsPerMinute }),
      ...(budget === undefined ? {} : { sponsorBudgetStroopsPerHour: budget }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      revoked: record.revoked ?? false,
      legacy: false,
      scopes,
      ...(record.discoveryRequestsPerMinute === undefined
        ? {}
        : { discoveryRequestsPerMinute: record.discoveryRequestsPerMinute }),
      ...(record.forwardedClientRequestsPerMinute === undefined
        ? {}
        : { forwardedClientRequestsPerMinute: record.forwardedClientRequestsPerMinute }),
    };
  });
  return { records, issuedKeys: file.data.issuedKeys ?? "on" };
}

/** An amount of XLM as a decimal string (up to 7 fraction digits, above zero), in stroops. */
export function xlmToStroops(value: string, name: string, code = "config_invalid"): bigint {
  const match = /^(\d{1,12})(?:\.(\d{1,7}))?$/.exec(value);
  if (match === null) throw new ConfigError(`${name} must be an amount of XLM with at most 7 decimals`, code);
  const stroops = BigInt(match[1] ?? "0") * STROOPS_PER_XLM + BigInt((match[2] ?? "").padEnd(7, "0"));
  if (stroops <= 0n) throw new ConfigError(`${name} must be above zero`, code);
  return stroops;
}

/**
 * The facts of the file a failed read or validation was about, taken from the same open descriptor, so
 * a reload can remember exactly that file as seen and no other one renamed into place meanwhile.
 */
const refusedFacts = new WeakMap<object, FileFacts>();

function refusedWith<E extends object>(error: E, facts: FileFacts): E {
  refusedFacts.set(error, facts);
  return error;
}

/**
 * Reads an access-key file: a regular file of at most 1 MiB, not writable by its group or others.
 * Returns its content and the facts reloading compares.
 */
export function readAccessKeyFile(
  path: string,
  source = "API_KEYS_FILE",
): { text: string; mtimeMs: number; size: number; ino: number } {
  if (!isAbsolute(path))
    throw new ConfigError(`${source} must be an absolute path`, "config_access_keys_invalid");
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch {
    throw new ConfigError(`${source}: ${path} cannot be read`, "config_access_keys_invalid");
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > ACCESS_KEYS_FILE_MAX_BYTES) {
      throw refusedWith(
        new ConfigError(
          `${source}: ${path} is not a regular file of at most 1 MiB`,
          "config_access_keys_invalid",
        ),
        factsOf(stat),
      );
    }
    if ((stat.mode & 0o022) !== 0) {
      throw refusedWith(
        new ConfigError(
          `${source}: ${path} is writable by its group or by others; make it writable by its owner only`,
          "config_secret_file_insecure",
        ),
        factsOf(stat),
      );
    }
    const buffer = Buffer.alloc(stat.size);
    const length = readSync(descriptor, buffer, 0, stat.size, 0);
    return {
      text: buffer.subarray(0, length).toString("utf8"),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ino: stat.ino,
    };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Records for the digests of `API_KEY_SHA256`: valid on every configured network, without limits of
 * their own. Their id is the digest's first 16 hex characters, so their usage subject (`key:<id>`)
 * continues the records written before keys had ids.
 */
export function legacyKeys(hashes: Iterable<string>, networks: readonly StellarNetwork[]): AccessKeyRecord[] {
  return [...hashes].map((hash) => ({
    id: hash.slice(0, 16),
    sha256: Buffer.from(hash, "hex"),
    networks,
    revoked: false,
    legacy: true,
    scopes: [],
  }));
}

/** Generates a new key for `id`: the key string, shown once, and its digest for the key file. */
export function newAccessKey(id: string): { key: string; sha256: string } {
  if (!KEY_ID.test(id))
    throw new ConfigError(`--id: "${id}" must be 3 to 32 lower-case letters, digits or dashes`);
  const key = `r402_${id}_${randomBytes(32).toString("base64url")}`;
  return { key, sha256: createHash("sha256").update(key).digest("hex") };
}

/** How a request's key relates to one network. */
export type AccessDecision =
  /** No usable key on a network that does not require one: served as `public`. */
  | { readonly kind: "public"; readonly keyId: "public" | "invalid" }
  | { readonly kind: "served"; readonly record: AccessKeyRecord }
  | { readonly kind: "unauthorized"; readonly reason: string; readonly keyId: string }
  | { readonly kind: "forbidden"; readonly reason: string; readonly keyId: string };

export interface AccessKeyStatus {
  readonly keys: { readonly active: number; readonly expired: number; readonly revoked: number };
  readonly lastReloadAt: string | null;
  readonly reloadError: string | null;
  /** SHA-256 (hex) of the key file in force; null without a file or before one was read. */
  readonly fileSha256: string | null;
}

export interface AccessKeysOptions {
  /** The key file to watch; without it the keys never change. */
  readonly path?: string;
  /** The variable that named `path`, for error messages; `API_KEYS_FILE` by default. */
  readonly source?: string;
  readonly rules: AccessKeyRules;
  /** Keys that do not come from the file (`API_KEY_SHA256`). */
  readonly legacy?: readonly AccessKeyRecord[];
  readonly now?: () => number;
  /** Called after each reload attempt with its outcome. */
  readonly onReload?: (
    outcome: { readonly ok: true } | { readonly ok: false; readonly error: ConfigError },
  ) => void;
}

/** How often the key file's size and modification time are compared. */
export const ACCESS_KEYS_RELOAD_MS = 10_000;

/** The current access keys, reloaded from their file when it changes. */
export class AccessKeys {
  /** The key file's records (and the legacy digests): replaced by each reload. */
  private fileRecords: readonly AccessKeyRecord[];
  /** Keys issued through sign-in: replaced by `setIssued`. */
  private issued: readonly AccessKeyRecord[] = [];
  private issuedMode: IssuedKeysMode = "on";
  private records: readonly AccessKeyRecord[];
  private byId: ReadonlyMap<string, AccessKeyRecord>;
  private readonly options: AccessKeysOptions;
  private readonly now: () => number;
  private seen: FileFacts | undefined;
  private lastReloadAt: Date | undefined;
  private reloadError: string | undefined;
  private fileSha256: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly onSignal = () => {
    this.reload(true);
  };

  constructor(initial: readonly AccessKeyRecord[], options: AccessKeysOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.fileRecords = [...(options.legacy ?? []), ...initial];
    this.records = this.fileRecords;
    this.byId = indexById(this.records);
    if (options.path !== undefined) {
      // The file may have been replaced since the configuration read it, so the records, the facts
      // reloads compare and the digest all come from this one read. If it fails, the startup records
      // stay, nothing is marked as seen, and the first reload reads the file again and reports it.
      try {
        this.apply(options.path, options.source ?? "API_KEYS_FILE");
      } catch {
        // Reported by the first reload.
      }
    }
  }

  /** What the key file allows for issued keys. */
  get issuedKeys(): IssuedKeysMode {
    return this.issuedMode;
  }

  /** Puts in force the keys issued through sign-in, as last read from the database. */
  setIssued(records: readonly AccessKeyRecord[]): void {
    this.issued = records.filter((record) => record.issued === true);
    this.combine();
  }

  /** Adds or replaces one issued key at once, before the next read of the database. */
  addIssued(record: AccessKeyRecord): void {
    if (record.issued !== true) return;
    this.issued = [record, ...this.issued.filter((other) => other.id !== record.id)];
    this.combine();
  }

  private combine(): void {
    // File records win an id clash; the file refuses issued ids anyway.
    const fileIds = new Set(this.fileRecords.map((record) => record.id));
    this.records = [...this.fileRecords, ...this.issued.filter((record) => !fileIds.has(record.id))];
    this.byId = indexById(this.records);
  }

  /** Whether any key exists (on any network). */
  get size(): number {
    return this.records.length;
  }

  /** The key records for `network`, for limits and metrics. */
  forNetwork(network: string): readonly AccessKeyRecord[] {
    return this.records.filter((record) => record.networks.includes(network as StellarNetwork));
  }

  /**
   * Re-reads the key file when its inode, size or modification time changed (or always with `force`).
   * The path is looked up afresh each time, so a file replaced by rename inside a mounted directory is
   * seen. A file that fails validation leaves the current keys in place and is reported until a good
   * one arrives. Returns whether the keys changed.
   */
  reload(force = false): boolean {
    const path = this.options.path;
    if (path === undefined) return false;
    const source = this.options.source ?? "API_KEYS_FILE";
    try {
      const facts = factsOf(statSync(path));
      if (!force && this.seen !== undefined && sameFacts(facts, this.seen)) return false;
      this.apply(path, source);
      this.options.onReload?.({ ok: true });
      return true;
    } catch (error) {
      const failure =
        error instanceof ConfigError
          ? error
          : new ConfigError(`${source}: ${path} cannot be read`, "config_access_keys_invalid");
      this.reloadError = `${failure.code}: ${failure.message}`;
      // Do not re-read the same broken file every round; a new write is compared again. Only the facts
      // of the file that was actually refused count: a fresh look at the path could see a good file
      // renamed in since, which would then never be applied. Without them, the next round reads again.
      this.seen = error instanceof Object ? refusedFacts.get(error) : undefined;
      this.options.onReload?.({ ok: false, error: failure });
      return false;
    }
  }

  /**
   * Reads, validates and puts in force the key file at `path`. The records, the facts later reads are
   * compared with and the digest shown all describe the same bytes. Throws, changing nothing, when the
   * file cannot be read or fails validation.
   */
  private apply(path: string, source: string): void {
    const file = readAccessKeyFile(path, source);
    let parsed: AccessKeyFile;
    try {
      parsed = parseAccessKeyFile(file.text, this.options.rules, source);
    } catch (error) {
      throw error instanceof Object
        ? refusedWith(error, { mtimeMs: file.mtimeMs, size: file.size, ino: file.ino })
        : error;
    }
    this.fileRecords = [...(this.options.legacy ?? []), ...parsed.records];
    this.issuedMode = parsed.issuedKeys;
    this.combine();
    this.seen = { mtimeMs: file.mtimeMs, size: file.size, ino: file.ino };
    this.fileSha256 = createHash("sha256").update(file.text).digest("hex");
    this.lastReloadAt = new Date(this.now());
    this.reloadError = undefined;
  }

  /** Starts watching the key file: every 10 s and on SIGHUP. */
  start(): void {
    if (this.options.path === undefined || this.timer !== undefined) return;
    this.timer = setInterval(() => this.reload(), ACCESS_KEYS_RELOAD_MS);
    this.timer.unref();
    process.on("SIGHUP", this.onSignal);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    process.off("SIGHUP", this.onSignal);
  }

  status(): AccessKeyStatus {
    const now = this.now();
    let active = 0;
    let expired = 0;
    let revoked = 0;
    for (const record of this.records) {
      if (record.revoked) revoked++;
      else if (record.expiresAt !== undefined && record.expiresAt.getTime() <= now) expired++;
      else active++;
    }
    return {
      keys: { active, expired, revoked },
      lastReloadAt: this.lastReloadAt?.toISOString() ?? null,
      reloadError: this.reloadError ?? null,
      fileSha256: this.fileSha256 ?? null,
    };
  }

  /** The record a presented key string matches, compared in constant time; undefined when none. */
  match(presented: string): AccessKeyRecord | undefined {
    const digest = createHash("sha256").update(presented).digest();
    const shaped = KEY_STRING.exec(presented);
    if (shaped !== null) {
      const record = this.byId.get(shaped[1] ?? "");
      return record !== undefined && !record.legacy && timingSafeEqual(digest, record.sha256)
        ? record
        : undefined;
    }
    // Keys from API_KEY_SHA256 carry no id: compare every legacy digest, without stopping early.
    let matched: AccessKeyRecord | undefined;
    for (const record of this.records) {
      if (record.legacy && timingSafeEqual(digest, record.sha256)) matched = record;
    }
    return matched;
  }

  /**
   * Decides a request on `network`. Where keys are required, a missing, unknown, expired or revoked
   * key is `unauthorized` and a key for other networks `forbidden`; where they are not, anything but
   * a valid key for the network is served as `public`.
   */
  decide(presented: PresentedKey, network: string, required: boolean): AccessDecision {
    if (presented.kind === "conflict") {
      return {
        kind: "unauthorized",
        reason: "Authorization and X-API-Key carry different keys; send one.",
        keyId: "invalid",
      };
    }
    if (presented.kind === "none") {
      return required
        ? { kind: "unauthorized", reason: "A valid API key is required on this network.", keyId: "public" }
        : { kind: "public", keyId: "public" };
    }
    const record = this.match(presented.key);
    const refuse = (kind: "unauthorized" | "forbidden", reason: string, keyId: string): AccessDecision =>
      required
        ? { kind, reason, keyId }
        : { kind: "public", keyId: record === undefined ? "invalid" : "public" };
    if (record === undefined) return refuse("unauthorized", "The API key is not valid.", "invalid");
    if (record.issued === true && this.issuedMode === "off") {
      return refuse(
        "unauthorized",
        "Keys issued through sign-in are switched off for now; retry later.",
        metricKeyId(record),
      );
    }
    // An internal discovery identity never pays, whatever the network requires.
    if (record.scopes.includes("discovery-internal")) {
      return { kind: "forbidden", reason: "This key may call the discovery routes only.", keyId: record.id };
    }
    if (record.revoked) return refuse("unauthorized", "The API key was revoked.", metricKeyId(record));
    if (record.expiresAt !== undefined && record.expiresAt.getTime() <= this.now()) {
      return refuse("unauthorized", "The API key has expired.", metricKeyId(record));
    }
    if (!record.networks.includes(network as StellarNetwork)) {
      return refuse("forbidden", `The API key is not allowed on ${network}.`, metricKeyId(record));
    }
    return { kind: "served", record };
  }

  /** The `discovery-internal` record a usable key matches, if any: not revoked, not expired. */
  discoveryCaller(presented: PresentedKey): AccessKeyRecord | undefined {
    const record = this.holder(presented);
    return record?.scopes.includes("discovery-internal") === true ? record : undefined;
  }

  /** The record a usable key matches on any network (for `/usage`): not revoked, not expired. */
  holder(presented: PresentedKey): AccessKeyRecord | undefined {
    if (presented.kind !== "key") return undefined;
    const record = this.match(presented.key);
    if (record === undefined || record.revoked) return undefined;
    if (record.issued === true && this.issuedMode === "off") return undefined;
    if (record.expiresAt !== undefined && record.expiresAt.getTime() <= this.now()) return undefined;
    return record;
  }
}

/** The key a request carries: `Authorization: Bearer <key>` or `X-API-Key: <key>`. */
export type PresentedKey =
  | { readonly kind: "none" }
  | { readonly kind: "key"; readonly key: string }
  /** Both headers, with different keys. */
  | { readonly kind: "conflict" };

export function presentedKey(
  authorization: string | undefined,
  apiKeyHeader: string | undefined,
): PresentedKey {
  const bearer =
    authorization?.toLowerCase().startsWith("bearer ") === true ? authorization.slice(7).trim() : undefined;
  const header = apiKeyHeader?.trim();
  const keys = [bearer, header].filter((value): value is string => value !== undefined && value !== "");
  if (keys.length === 0) return { kind: "none" };
  if (keys.length === 2 && keys[0] !== keys[1]) return { kind: "conflict" };
  return { kind: "key", key: keys[0] ?? "" };
}

/** What reloading compares to tell that the key file changed. */
interface FileFacts {
  readonly mtimeMs: number;
  readonly size: number;
  readonly ino: number;
}

function factsOf(stat: { mtimeMs: number; size: number; ino: number }): FileFacts {
  return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
}

function sameFacts(a: FileFacts, b: FileFacts): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

function indexById(records: readonly AccessKeyRecord[]): ReadonlyMap<string, AccessKeyRecord> {
  return new Map(records.filter((record) => !record.legacy).map((record) => [record.id, record]));
}
