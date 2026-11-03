/**
 * The whole-run spend ledger of a pubnet evidence run: one file that every harness process of the run
 * debits before it submits anything, so the caps bound the run as a whole and not each process alone.
 *
 * A dry run plans the ledger: it draws a fresh nonce, derives the run id from the commit, the network,
 * the treasury, the caps and that nonce, and writes `<runs>/<runId>/ledger.json` in state `planned`.
 * The operator confirms that id (RAIL402_PUBNET_RUN_CONFIRM); the run claims the ledger (`planned` →
 * `open`), which happens once: a ledger that is open or closed refuses a second claim, so every run
 * needs a new dry run and a new confirmation. Harness processes of the run join the open ledger
 * (RAIL402_PUBNET_LEDGER). Every debit takes an exclusive lock, re-reads the file, checks the run's
 * totals against its caps, writes the new totals (temporary file + rename) and only then lets the
 * caller submit. The ledger is closed at the end of the run, also when it fails; a closed ledger
 * refuses every debit.
 *
 * The run caps are net: XLM sent out of the treasury (fees, account reserves) minus XLM merged back,
 * and USDC sent out minus USDC swept back. A fully returned run therefore costs only its fees.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "./evidence.ts";

/**
 * Where pubnet runs keep their ledgers and account registries (ignored by git, owner-only):
 * `.work/pubnet-runs`, or RAIL402_PUBNET_RUNS_DIR (a rehearsal against a fake network keeps its own).
 */
export const PUBNET_RUNS_DIR = runsDir(process.env["RAIL402_PUBNET_RUNS_DIR"]);

function runsDir(configured: string | undefined): string {
  const dir = configured?.trim() ?? "";
  return dir === "" ? join(REPO_ROOT, ".work/pubnet-runs") : dir;
}

/** A step the ledger is asked to allow; every field defaults to zero. */
export interface LedgerStep {
  readonly xlmStroops?: bigint;
  readonly usdcBaseUnits?: bigint;
  readonly settlements?: number;
  readonly newAccounts?: number;
}

export interface RunCaps {
  /** XLM out of the treasury minus XLM merged back, across the run. */
  readonly maxNetXlmStroops: bigint;
  /** USDC out of the treasury minus USDC swept back, across the run. */
  readonly maxNetUsdcBaseUnits: bigint;
}

/** What a run is bound to: a ledger refuses a harness whose material differs. */
export interface RunMaterial {
  readonly commit: string;
  readonly network: string;
  readonly treasury: string;
  readonly runCaps: RunCaps;
  /** The per-harness caps and fee ceilings, as stable strings. */
  readonly settings: Readonly<Record<string, string>>;
}

export type LedgerState = "planned" | "open" | "closed";

interface Totals {
  xlmStroops: string;
  usdcBaseUnits: string;
  settlements: number;
  newAccounts: number;
}

interface LedgerFile {
  version: 1;
  runId: string;
  nonce: string;
  commit: string;
  network: string;
  treasury: string;
  runCaps: { maxNetXlmStroops: string; maxNetUsdcBaseUnits: string };
  settings: Record<string, string>;
  state: LedgerState;
  createdAt: string;
  openedAt?: string;
  closedAt?: string;
  spent: Totals;
  returned: { xlmStroops: string; usdcBaseUnits: string };
  harnesses: { name: string; pid: number; joinedAt: string }[];
  stranded: { harness: string; usdcBaseUnits: string; xlmStroops: string; accounts: string[] }[];
}

/**
 * A run account in the run's registry, written before the account is created or funded, so an operator
 * can return its funds after a crash. It holds no secret: every key is derived from the treasury seed
 * by `path` (HKDF), and only the treasury's owner can derive it.
 */
export type RegistryEntry =
  | { readonly kind: "account"; readonly harness: string; readonly address: string; readonly path: string }
  | {
      readonly kind: "contract";
      readonly harness: string;
      readonly address: string;
      /** How the contract authorizes a transfer: the fixture simple account or an OpenZeppelin account. */
      readonly auth: "simple" | "oz";
      readonly ownerPath: string;
      readonly verifier?: string;
    };

/** A ledger refusal; `code` is stable. */
export class LedgerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "LedgerError";
    this.code = code;
  }
}

/** The run id: the material and the nonce, so one id names one planned ledger only. */
export function runIdFor(material: RunMaterial, nonce: string): string {
  const text = JSON.stringify([
    material.commit,
    material.network,
    material.treasury,
    String(material.runCaps.maxNetXlmStroops),
    String(material.runCaps.maxNetUsdcBaseUnits),
    Object.entries(material.settings).sort(([a], [b]) => a.localeCompare(b)),
    nonce,
  ]);
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const ZERO: Totals = { xlmStroops: "0", usdcBaseUnits: "0", settlements: 0, newAccounts: 0 };

/** Plans a run: a fresh nonce and a `planned` ledger under `dir`. Spends nothing. */
export function planRun(material: RunMaterial, dir = PUBNET_RUNS_DIR): { runId: string; path: string } {
  const nonce = randomBytes(16).toString("hex");
  const runId = runIdFor(material, nonce);
  const runDir = join(dir, runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const file: LedgerFile = {
    version: 1,
    runId,
    nonce,
    commit: material.commit,
    network: material.network,
    treasury: material.treasury,
    runCaps: {
      maxNetXlmStroops: String(material.runCaps.maxNetXlmStroops),
      maxNetUsdcBaseUnits: String(material.runCaps.maxNetUsdcBaseUnits),
    },
    settings: { ...material.settings },
    state: "planned",
    createdAt: new Date().toISOString(),
    spent: { ...ZERO },
    returned: { xlmStroops: "0", usdcBaseUnits: "0" },
    harnesses: [],
    stranded: [],
  };
  const path = join(runDir, "ledger.json");
  writeAtomic(path, file);
  return { runId, path };
}

/** The ledger file of a run id under `dir`. */
export function ledgerPath(runId: string, dir = PUBNET_RUNS_DIR): string {
  if (!/^[0-9a-f]{16}$/.test(runId))
    throw new LedgerError("pubnet_run_unknown", `"${runId}" is not a run id`);
  return join(dir, runId, "ledger.json");
}

export class RunLedger {
  readonly path: string;
  readonly runId: string;
  readonly harness: string;
  /** Addresses already written to the registry as seen, so each is recorded once. */
  readonly #seen = new Set<string>();

  private constructor(path: string, runId: string, harness: string) {
    this.path = path;
    this.runId = runId;
    this.harness = harness;
  }

  /** The run's directory: the ledger, its lock and the account registry. */
  get dir(): string {
    return dirname(this.path);
  }

  /**
   * Claims a planned ledger for the run that `runId` names: once only. Refuses an unknown id, a
   * ledger already claimed or closed, or one planned for other material.
   */
  static claim(runId: string, material: RunMaterial, harness: string, dir = PUBNET_RUNS_DIR): RunLedger {
    const path = ledgerPath(runId, dir);
    if (!existsSync(path)) {
      throw new LedgerError(
        "pubnet_run_unknown",
        `no planned run ${runId}; run once without RAIL402_PUBNET_RUN_CONFIRM to plan one`,
      );
    }
    const ledger = new RunLedger(path, runId, harness);
    ledger.#update(
      (file) => {
        checkMaterial(file, runId, material);
        if (file.state !== "planned") {
          throw new LedgerError(
            "pubnet_run_reused",
            `run ${runId} was already ${file.state === "open" ? "started" : "finished"}; plan a new run and confirm its id`,
          );
        }
        file.state = "open";
        file.openedAt = new Date().toISOString();
        file.harnesses.push({ name: harness, pid: process.pid, joinedAt: new Date().toISOString() });
      },
      { closedOk: true },
    );
    return ledger;
  }

  /** Opens a ledger of any state to read it or return its funds (no harness joins). */
  static inspect(path: string): RunLedger {
    if (!existsSync(path)) throw new LedgerError("pubnet_run_unknown", `${path} names no ledger`);
    const file = JSON.parse(readFileSync(path, "utf8")) as LedgerFile;
    return new RunLedger(path, file.runId, "recovery");
  }

  /** Joins the open ledger at `path` (a step of a run another process claimed). */
  static join(path: string, runId: string, material: RunMaterial, harness: string): RunLedger {
    if (!existsSync(path))
      throw new LedgerError("pubnet_run_unknown", "RAIL402_PUBNET_LEDGER names no ledger");
    const ledger = new RunLedger(path, runId, harness);
    ledger.#update((file) => {
      checkMaterial(file, runId, material);
      if (file.state !== "open") {
        throw new LedgerError(
          file.state === "closed" ? "pubnet_run_closed" : "pubnet_run_unconfirmed",
          `run ${runId} is ${file.state}; a harness joins an open run only`,
        );
      }
      file.harnesses.push({ name: harness, pid: process.pid, joinedAt: new Date().toISOString() });
    });
    return ledger;
  }

  /** Debits a step when the run's totals stay within its caps; throws `spend_cap_exceeded` otherwise. */
  debit(step: LedgerStep, what: string): void {
    this.#update((file) => {
      const next = add(file.spent, step);
      const over = overCaps(file, next);
      if (over.length > 0) {
        throw new LedgerError("spend_cap_exceeded", `${what} would pass the run's cap: ${over.join(", ")}`);
      }
      file.spent = next;
    });
  }

  /** Whether a step would fit, without debiting it. */
  ensure(step: LedgerStep, what: string): void {
    const file = this.read();
    if (file.state !== "open")
      throw new LedgerError("pubnet_run_closed", `run ${this.runId} is ${file.state}`);
    const over = overCaps(file, add(file.spent, step));
    if (over.length > 0) {
      throw new LedgerError("spend_cap_exceeded", `${what} would pass the run's cap: ${over.join(", ")}`);
    }
  }

  /** Lowers the spent XLM by what a debit reserved above the fee the network charged. */
  release(xlmStroops: bigint): void {
    if (xlmStroops <= 0n) return;
    this.#update(
      (file) => {
        file.spent.xlmStroops = String(BigInt(file.spent.xlmStroops) - xlmStroops);
      },
      { closedOk: true },
    );
  }

  /** Records what came back to the treasury (swept USDC, merged XLM). */
  credit(step: { xlmStroops?: bigint; usdcBaseUnits?: bigint }): void {
    this.#update(
      (file) => {
        file.returned = {
          xlmStroops: String(BigInt(file.returned.xlmStroops) + (step.xlmStroops ?? 0n)),
          usdcBaseUnits: String(BigInt(file.returned.usdcBaseUnits) + (step.usdcBaseUnits ?? 0n)),
        };
      },
      { closedOk: true },
    );
  }

  /** Records what a harness's sweep-back could not return. */
  strand(entry: { usdcBaseUnits: bigint; xlmStroops: bigint; accounts: readonly string[] }): void {
    this.#update(
      (file) => {
        file.stranded.push({
          harness: this.harness,
          usdcBaseUnits: String(entry.usdcBaseUnits),
          xlmStroops: String(entry.xlmStroops),
          accounts: [...entry.accounts],
        });
      },
      { closedOk: true },
    );
  }

  /** Adds a run account to the run's registry (owner-only file beside the ledger). */
  register(entry: RegistryEntry): void {
    this.#append(entry);
  }

  /**
   * Records that a run account was seen to exist on the network, so a later recovery sweep (a fresh
   * process, after a crash) can tell an account merged away by whoever held its key from one that was
   * never created. Written once per address.
   */
  markSeen(address: string): void {
    if (this.#seen.has(address)) return;
    this.#seen.add(address);
    this.#append({ kind: "seen", address });
  }

  #append(entry: RegistryEntry | { kind: "seen"; address: string }): void {
    appendFileSync(join(this.dir, "accounts.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  #entries(): (RegistryEntry | { kind: "seen"; address: string })[] {
    const file = join(this.dir, "accounts.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as RegistryEntry | { kind: "seen"; address: string });
  }

  /** Every run account registered so far, by any harness of the run. */
  registry(): RegistryEntry[] {
    return this.#entries().filter((entry): entry is RegistryEntry => entry.kind !== "seen");
  }

  /** Every run account seen to exist on the network, for a recovery sweep's merged-away check. */
  seenAddresses(): string[] {
    return this.#entries().flatMap((entry) => (entry.kind === "seen" ? [entry.address] : []));
  }

  /** Closes the run: every later debit is refused. */
  close(): void {
    this.#update(
      (file) => {
        if (file.state === "closed") return;
        file.state = "closed";
        file.closedAt = new Date().toISOString();
      },
      { closedOk: true },
    );
  }

  read(): LedgerFile {
    return JSON.parse(readFileSync(this.path, "utf8")) as LedgerFile;
  }

  /** The run's totals so far, for the evidence. */
  totals(): {
    id: string;
    spent: Totals;
    returned: { xlmStroops: string; usdcBaseUnits: string };
    caps: { maxNetXlmStroops: string; maxNetUsdcBaseUnits: string };
  } {
    const file = this.read();
    return { id: file.runId, spent: file.spent, returned: file.returned, caps: file.runCaps };
  }

  #update(change: (file: LedgerFile) => void, options: { closedOk?: boolean } = {}): void {
    withLock(join(this.dir, "ledger.lock"), () => {
      const file = this.read();
      if (file.runId !== this.runId)
        throw new LedgerError("pubnet_run_mismatch", "the ledger names another run");
      if (file.state === "closed" && options.closedOk !== true) {
        throw new LedgerError("pubnet_run_closed", `run ${this.runId} is closed; plan a new run`);
      }
      change(file);
      writeAtomic(this.path, file);
    });
  }
}

function checkMaterial(file: LedgerFile, runId: string, material: RunMaterial): void {
  if (file.runId !== runId || runIdFor(material, file.nonce) !== runId) {
    throw new LedgerError(
      "pubnet_run_mismatch",
      `run ${runId} was planned for another commit, network, treasury or caps; plan a new run`,
    );
  }
}

function add(spent: Totals, step: LedgerStep): Totals {
  return {
    xlmStroops: String(BigInt(spent.xlmStroops) + (step.xlmStroops ?? 0n)),
    usdcBaseUnits: String(BigInt(spent.usdcBaseUnits) + (step.usdcBaseUnits ?? 0n)),
    settlements: spent.settlements + (step.settlements ?? 0),
    newAccounts: spent.newAccounts + (step.newAccounts ?? 0),
  };
}

function overCaps(file: LedgerFile, next: Totals): string[] {
  const netXlm = BigInt(next.xlmStroops) - BigInt(file.returned.xlmStroops);
  const netUsdc = BigInt(next.usdcBaseUnits) - BigInt(file.returned.usdcBaseUnits);
  const maxXlm = BigInt(file.runCaps.maxNetXlmStroops);
  const maxUsdc = BigInt(file.runCaps.maxNetUsdcBaseUnits);
  return [
    netXlm > maxXlm ? `net XLM ${netXlm} > ${maxXlm} stroops` : undefined,
    netUsdc > maxUsdc ? `net USDC ${netUsdc} > ${maxUsdc} base units` : undefined,
  ].filter((entry) => entry !== undefined);
}

function writeAtomic(path: string, file: LedgerFile): void {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** How long a lock may be held before it counts as abandoned by a process that died. */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 20_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Runs `body` holding an exclusive lock file: created with O_EXCL, removed afterwards. */
export function withLock<T>(path: string, body: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, String(process.pid));
        return body();
      } finally {
        closeSync(fd);
        unlinkSync(path);
      }
    }
    if (abandoned(path)) {
      try {
        unlinkSync(path);
      } catch {
        // Another process removed it first.
      }
      continue;
    }
    if (Date.now() > deadline) throw new LedgerError("ledger_locked", `${path} stayed locked`);
    Atomics.wait(sleeper, 0, 0, 5 + Math.floor(Math.random() * 10));
  }
}

/** A lock whose holder no longer runs, or that is older than any debit takes. */
function abandoned(path: string): boolean {
  try {
    const holder = Number(readFileSync(path, "utf8"));
    if (Number.isInteger(holder) && holder > 0) {
      try {
        process.kill(holder, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      }
    }
    return Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}
