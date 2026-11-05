/**
 * Network profiles for the conformance harnesses: what differs between a run on the Stellar testnet
 * and one on pubnet (CAIP-2 id, passphrase, RPC, USDC, the upto contract, how accounts are funded,
 * and the spend caps that bound a run with real funds).
 *
 * Testnet keeps its keyless fixtures: Friendbot and the testnet XLM/USDC pool (`testnet.ts`).
 * Pubnet never uses Friendbot or the DEX. It funds from an operator treasury whose seed is read from
 * a file only. Every account and contract-account owner of a run is derived from that seed, so only
 * the operator can sign for them and a crashed run can be recovered. Every transaction the harness
 * submits passes one choke point (`ProfileNetwork`): its fee is debited against the caps before it is
 * sent and the reservation is lowered to the fee the network charged once it lands. Funding,
 * account creation and every `/settle` request (`facilitator-guard.ts`) are debited the same way,
 * against the harness's own caps and against the whole run's ledger (`run-ledger.ts`). At the end, and
 * on an exception or a signal, the run returns its USDC (also from its contract accounts) and merges
 * its accounts back into the treasury, and reports truthfully what it could not return.
 */
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { USDC_PUBNET_ADDRESS, USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { UPTO_DEPLOYMENTS } from "@rail402.dev/upto";
import {
  BadSequenceError,
  LocalNetwork,
  OZ_DEFAULT_RULE,
  addressCredentialsOf,
  contractCode,
  deploySimpleAccount,
  fixtureWasm,
  ozSmartAccountSigner,
  requirementsFor,
  simpleAccountOwner,
  simpleAccountSigner,
  type EntrySigner,
} from "@rail402.dev/testkit";
import { REPO_ROOT } from "./evidence.ts";
import {
  checkFacilitatorAccess,
  installFacilitatorGuard,
  readApiKey,
  type FacilitatorGuard,
} from "./facilitator-guard.ts";
import {
  LedgerError,
  PUBNET_RUNS_DIR,
  RunLedger,
  planRun,
  type RegistryEntry,
  type RunCaps,
  type RunMaterial,
} from "./run-ledger.ts";
import { TESTNET_FRIENDBOT_URL, TESTNET_RPC_URL, Treasury, USDC, gitCommit, log } from "./testnet.ts";

export type NetworkId = "testnet" | "pubnet";
export type Caip2 = "stellar:testnet" | "stellar:pubnet";

export interface UsdcAsset {
  readonly contract: string;
  readonly code: "USDC";
  readonly issuer: string;
  readonly decimals: 7;
}

export interface SpendCaps {
  readonly maxXlmStroops: bigint;
  readonly maxUsdcBaseUnits: bigint;
  readonly maxSettlements: number;
  readonly maxNewAccounts: number;
}

/** The target facilitator's fee ceilings: the most one settlement may cost its sponsor. */
export interface FeeCeilings {
  readonly exact: bigint;
  readonly upto: bigint | undefined;
}

export type FundingStrategy =
  | { readonly kind: "friendbot"; readonly friendbotUrl: string; readonly usdcSource: "testnet-pool" }
  | {
      readonly kind: "treasury";
      /** RAIL402_TREASURY_SECRET_FILE: an operator account already holding XLM and USDC. */
      readonly secretFile: string;
      readonly accounts: "derived";
      readonly sweepBack: true;
    };

export interface NetworkProfile {
  readonly id: NetworkId;
  readonly caip2: Caip2;
  readonly passphrase: string;
  /** Ordered; the first is primary. */
  readonly rpcUrls: readonly string[];
  readonly usdc: UsdcAsset;
  /** Extra test assets; TEST6 is deployed on testnet only and is added by the harnesses that use it. */
  readonly extraAssets: readonly {
    readonly contract: string;
    readonly symbol: string;
    readonly decimals: number;
  }[];
  readonly upto: { readonly contract: string; readonly wasmHash: string } | undefined;
  readonly funding: FundingStrategy;
  /** Per harness process; unlimited on testnet. */
  readonly caps: SpendCaps | undefined;
  /** Across every harness of one evidence run; none on testnet. */
  readonly runCaps: RunCaps | undefined;
  /** The facilitator's fee ceilings a settlement is counted at; none on testnet. */
  readonly feeCeilings: FeeCeilings | undefined;
  readonly facilitator: { readonly apiKeyFile?: string };
  readonly explorer: { readonly tx: (hash: string) => string };
}

/** A pubnet run that cannot start, or a step that would pass a cap; `code` is stable. */
export class ProfileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProfileError";
    this.code = code;
  }
}

const USDC_PUBNET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

export const TESTNET_PROFILE: NetworkProfile = Object.freeze<NetworkProfile>({
  id: "testnet",
  caip2: "stellar:testnet",
  passphrase: Networks.TESTNET,
  rpcUrls: [TESTNET_RPC_URL],
  usdc: { contract: USDC_TESTNET_ADDRESS, code: "USDC", issuer: USDC.getIssuer() ?? "", decimals: 7 },
  extraAssets: [],
  upto: (() => {
    const deployment = UPTO_DEPLOYMENTS["stellar:testnet"];
    return deployment === undefined
      ? undefined
      : { contract: deployment.address, wasmHash: deployment.wasmHash };
  })(),
  funding: { kind: "friendbot", friendbotUrl: TESTNET_FRIENDBOT_URL, usdcSource: "testnet-pool" },
  caps: undefined,
  runCaps: undefined,
  feeCeilings: undefined,
  facilitator: {},
  explorer: { tx: (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}` },
});

/** What every pubnet profile shares: the network, its USDC and its explorer. */
const PUBNET_NETWORK = {
  id: "pubnet",
  caip2: "stellar:pubnet",
  passphrase: Networks.PUBLIC,
  usdc: { contract: USDC_PUBNET_ADDRESS, code: "USDC", issuer: USDC_PUBNET_ISSUER, decimals: 7 },
  extraAssets: [],
  explorer: { tx: (hash: string) => `https://stellar.expert/explorer/public/tx/${hash}` },
} as const satisfies Partial<NetworkProfile>;

/** The `--network` option every harness takes. */
export const NETWORK_OPTION = { network: { type: "string", default: "testnet" } } as const;

export function parseNetworkId(value: string | undefined): NetworkId {
  if (value === undefined || value === "testnet") return "testnet";
  if (value === "pubnet") return "pubnet";
  throw new ProfileError("network_unknown", `--network must be testnet or pubnet, not "${value}"`);
}

type Env = Readonly<Record<string, string | undefined>>;

/** The published pubnet deployment record of the upto contract (written by the contract tooling). */
export const UPTO_PUBNET_RECORD = join(REPO_ROOT, "contracts/stellar/deployments/pubnet.json");

export interface ResolveOptions {
  readonly env?: Env;
  /** Whether the run selects an upto case (pubnet then needs a contract and the upto fee ceiling). */
  readonly needsUpto?: boolean;
  /** The pubnet deployment record of the upto contract; `UPTO_PUBNET_RECORD` by default. */
  readonly uptoRecord?: string;
}

const XLM = 10_000_000n;

function decimalToUnits(value: string, decimals: number, name: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null || (match[2] ?? "").length > decimals) {
    throw new ProfileError(
      "pubnet_caps_missing",
      `${name} must be a positive amount with at most ${decimals} decimals`,
    );
  }
  const units =
    BigInt(match[1] ?? "0") * 10n ** BigInt(decimals) + BigInt((match[2] ?? "").padEnd(decimals, "0") || "0");
  if (units <= 0n) throw new ProfileError("pubnet_caps_missing", `${name} must be greater than zero`);
  return units;
}

/** A positive integer, digits only: `1e6`, `300_000`, `0` and blanks are refused, never ignored. */
function positiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value.trim()) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new ProfileError("pubnet_caps_missing", `${name} must be a positive integer`);
  }
  return Number(value);
}

/**
 * Refuses a secret file that is a symlink, not a regular file, or readable by group or others.
 * `what` names it in the message; `missing` and `unsafe` are the codes.
 */
export function checkSecretFile(
  path: string,
  what = "the treasury secret file",
  codes: { missing: string; unsafe: string } = {
    missing: "pubnet_treasury_missing",
    unsafe: "pubnet_treasury_unsafe",
  },
): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new ProfileError(codes.missing, `${what} names no readable file`);
  }
  if (!stat.isFile()) throw new ProfileError(codes.unsafe, `${what} is not a regular file`);
  if ((stat.mode & 0o077) !== 0) {
    throw new ProfileError(codes.unsafe, `${what} is readable by group or others (chmod 600 it)`);
  }
}

/**
 * The upto contract of a pubnet run: RAIL402_PUBNET_UPTO_CONTRACT and _WASM_HASH together (never one
 * without the other), checked against the published deployment record when it exists; the record
 * alone when they are unset.
 */
function pubnetUpto(env: Env, recordFile: string): NetworkProfile["upto"] {
  const contract = (env["RAIL402_PUBNET_UPTO_CONTRACT"] ?? "").trim();
  const wasmHash = (env["RAIL402_PUBNET_UPTO_WASM_HASH"] ?? "").trim().toLowerCase();
  if ((contract === "") !== (wasmHash === "")) {
    throw new ProfileError(
      "pubnet_upto_missing",
      "set RAIL402_PUBNET_UPTO_CONTRACT and RAIL402_PUBNET_UPTO_WASM_HASH together",
    );
  }
  if (wasmHash !== "" && !/^[0-9a-f]{64}$/.test(wasmHash)) {
    throw new ProfileError("pubnet_upto_missing", "RAIL402_PUBNET_UPTO_WASM_HASH must be 64 hex characters");
  }
  const record = readUptoRecord(recordFile);
  if (
    record !== undefined &&
    contract !== "" &&
    (record.contract !== contract || record.wasmHash !== wasmHash)
  ) {
    throw new ProfileError(
      "pubnet_upto_mismatch",
      `RAIL402_PUBNET_UPTO_CONTRACT/_WASM_HASH differ from the published pubnet record (${record.contract}, ${record.wasmHash})`,
    );
  }
  if (contract !== "") return { contract, wasmHash };
  if (record !== undefined) return record;
  const deployment = UPTO_DEPLOYMENTS["stellar:pubnet"];
  return deployment === undefined
    ? undefined
    : { contract: deployment.address, wasmHash: deployment.wasmHash };
}

/**
 * The upto contract and WASM hash of a pubnet deployment record (`contract_id`, `wasm_sha256`,
 * `caip2: stellar:pubnet`), or undefined when there is no record yet. A record in another shape is refused.
 */
export function readUptoRecord(path: string): { contract: string; wasmHash: string } | undefined {
  if (!existsSync(path)) return undefined;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new ProfileError("pubnet_upto_mismatch", "the pubnet upto deployment record is not JSON");
  }
  const contract = record["contract_id"];
  const wasmHash = record["wasm_sha256"];
  if (
    record["caip2"] !== "stellar:pubnet" ||
    typeof contract !== "string" ||
    !/^C[A-Z2-7]{55}$/.test(contract) ||
    typeof wasmHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(wasmHash)
  ) {
    throw new ProfileError(
      "pubnet_upto_mismatch",
      "the pubnet upto deployment record needs caip2 stellar:pubnet, contract_id and wasm_sha256",
    );
  }
  return { contract, wasmHash };
}

/**
 * The profile for `--network`. Testnet needs nothing. Pubnet refuses to start without at least one
 * RPC URL (`RAIL402_PUBNET_RPC_URLS`, comma-separated), the treasury secret file, the four
 * per-harness caps, the two whole-run caps, the facilitator's exact fee ceiling, and, when an upto
 * case runs, an upto contract and the facilitator's upto fee ceiling.
 */
export function resolveProfile(id: NetworkId, options: ResolveOptions = {}): NetworkProfile {
  if (id === "testnet") return TESTNET_PROFILE;
  const env = options.env ?? process.env;
  const rpcUrls = pubnetRpcUrls(env);
  const secretFile = env["RAIL402_TREASURY_SECRET_FILE"];
  if (secretFile === undefined || secretFile === "") {
    throw new ProfileError(
      "pubnet_treasury_missing",
      "set RAIL402_TREASURY_SECRET_FILE to the operator treasury's secret file",
    );
  }
  checkSecretFile(secretFile);
  const capNames = [
    "RAIL402_PUBNET_MAX_SPEND_XLM",
    "RAIL402_PUBNET_MAX_SPEND_USDC",
    "RAIL402_PUBNET_MAX_SETTLEMENTS",
    "RAIL402_PUBNET_MAX_NEW_ACCOUNTS",
    "RAIL402_PUBNET_RUN_MAX_XLM",
    "RAIL402_PUBNET_RUN_MAX_USDC_LOSS",
    "PUBNET_MAX_TX_FEE_STROOPS",
    ...(options.needsUpto === true ? ["PUBNET_UPTO_MAX_TX_FEE_STROOPS"] : []),
  ] as const;
  const missing = capNames.filter((name) => (env[name] ?? "").trim() === "");
  if (missing.length > 0) throw new ProfileError("pubnet_caps_missing", `set ${missing.join(", ")}`);
  const text = (name: string) => env[name] ?? "";
  const caps: SpendCaps = {
    maxXlmStroops: decimalToUnits(text("RAIL402_PUBNET_MAX_SPEND_XLM"), 7, "RAIL402_PUBNET_MAX_SPEND_XLM"),
    maxUsdcBaseUnits: decimalToUnits(
      text("RAIL402_PUBNET_MAX_SPEND_USDC"),
      7,
      "RAIL402_PUBNET_MAX_SPEND_USDC",
    ),
    maxSettlements: positiveInteger(text("RAIL402_PUBNET_MAX_SETTLEMENTS"), "RAIL402_PUBNET_MAX_SETTLEMENTS"),
    maxNewAccounts: positiveInteger(
      text("RAIL402_PUBNET_MAX_NEW_ACCOUNTS"),
      "RAIL402_PUBNET_MAX_NEW_ACCOUNTS",
    ),
  };
  const runCaps: RunCaps = {
    maxNetXlmStroops: decimalToUnits(text("RAIL402_PUBNET_RUN_MAX_XLM"), 7, "RAIL402_PUBNET_RUN_MAX_XLM"),
    maxNetUsdcBaseUnits: decimalToUnits(
      text("RAIL402_PUBNET_RUN_MAX_USDC_LOSS"),
      7,
      "RAIL402_PUBNET_RUN_MAX_USDC_LOSS",
    ),
  };
  const uptoCeiling = text("PUBNET_UPTO_MAX_TX_FEE_STROOPS").trim();
  const feeCeilings: FeeCeilings = {
    exact: BigInt(positiveInteger(text("PUBNET_MAX_TX_FEE_STROOPS"), "PUBNET_MAX_TX_FEE_STROOPS")),
    upto:
      uptoCeiling === "" ? undefined : BigInt(positiveInteger(uptoCeiling, "PUBNET_UPTO_MAX_TX_FEE_STROOPS")),
  };
  const upto = pubnetUpto(env, options.uptoRecord ?? UPTO_PUBNET_RECORD);
  if (options.needsUpto === true && upto === undefined) {
    throw new ProfileError(
      "pubnet_upto_missing",
      "an upto case needs RAIL402_PUBNET_UPTO_CONTRACT and RAIL402_PUBNET_UPTO_WASM_HASH (no pubnet deployment is published)",
    );
  }
  const apiKeyFile = env["RAIL402_FACILITATOR_API_KEY_FILE"];
  return Object.freeze<NetworkProfile>({
    ...PUBNET_NETWORK,
    rpcUrls,
    upto,
    funding: { kind: "treasury", secretFile, accounts: "derived", sweepBack: true },
    caps,
    runCaps,
    feeCeilings,
    facilitator: apiKeyFile === undefined || apiKeyFile === "" ? {} : { apiKeyFile },
  });
}

/** RAIL402_PUBNET_RPC_URLS: one or more https RPC URLs, comma-separated, the first primary. */
function pubnetRpcUrls(env: Env): string[] {
  const rpcUrls = (env["RAIL402_PUBNET_RPC_URLS"] ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url !== "");
  if (rpcUrls.length === 0)
    throw new ProfileError("pubnet_rpc_missing", "set RAIL402_PUBNET_RPC_URLS to one or more https RPC URLs");
  for (const url of rpcUrls) {
    if (!url.startsWith("https://"))
      throw new ProfileError("pubnet_rpc_missing", "pubnet RPC URLs must use https");
  }
  return rpcUrls;
}

/**
 * The profile of a process that runs third-party code for a run (the live agent run's installed
 * packages): the network, its RPC URLs and USDC, and nothing that funds, signs, meters or
 * authenticates. On pubnet it reads RAIL402_PUBNET_RPC_URLS only. Its funding names no treasury file,
 * so no funder opens from it, and a `ProfileNetwork` on it refuses to submit anything, since no run
 * ever attaches a spend meter there.
 */
export function unfundedProfile(id: NetworkId, env: Env = process.env): NetworkProfile {
  if (id === "testnet") return TESTNET_PROFILE;
  return Object.freeze<NetworkProfile>({
    ...PUBNET_NETWORK,
    rpcUrls: pubnetRpcUrls(env),
    upto: undefined,
    funding: { kind: "treasury", secretFile: "", accounts: "derived", sweepBack: true },
    caps: undefined,
    runCaps: undefined,
    feeCeilings: undefined,
    facilitator: {},
  });
}

/** Refuses pubnet before its profile is resolved, in a harness that runs on testnet only. */
export function refusePubnet(network: string | undefined, what: string): void {
  if (parseNetworkId(network) !== "testnet") {
    throw new ProfileError("pubnet_not_supported", `${what} runs on the Stellar testnet only`);
  }
}

/**
 * The fee a settlement is counted at: the facilitator's fee ceiling for the scheme (the worst case,
 * not an estimate). Testnet only counts, at the service's testnet defaults.
 */
export function feeCeilingStroops(profile: NetworkProfile, scheme: "exact" | "upto"): bigint {
  const ceilings = profile.feeCeilings;
  if (ceilings === undefined) return scheme === "exact" ? 2_000_000n : 5_000_000n;
  if (scheme === "exact") return ceilings.exact;
  if (ceilings.upto === undefined) {
    throw new ProfileError("pubnet_caps_missing", "an upto settlement needs PUBNET_UPTO_MAX_TX_FEE_STROOPS");
  }
  return ceilings.upto;
}

/** What a pubnet run is bound to: the run id and its ledger cover all of it. */
export function runMaterial(profile: NetworkProfile, treasury: string, commit: string): RunMaterial {
  const caps = profile.caps;
  const runCaps = profile.runCaps;
  if (caps === undefined || runCaps === undefined) {
    throw new ProfileError("pubnet_caps_missing", "a pubnet run needs its caps");
  }
  return {
    commit,
    network: profile.caip2,
    treasury,
    runCaps,
    settings: {
      maxXlmStroops: String(caps.maxXlmStroops),
      maxUsdcBaseUnits: String(caps.maxUsdcBaseUnits),
      maxSettlements: String(caps.maxSettlements),
      maxNewAccounts: String(caps.maxNewAccounts),
      exactFeeCeiling: String(profile.feeCeilings?.exact ?? ""),
      uptoFeeCeiling: String(profile.feeCeilings?.upto ?? ""),
      uptoContract: profile.upto?.contract ?? "",
      rpc: createHash("sha256").update(profile.rpcUrls.join(",")).digest("hex").slice(0, 16),
    },
  };
}

// --- spending -------------------------------------------------------------------------------------

export interface Spent {
  xlmStroops: bigint;
  usdcBaseUnits: bigint;
  settlements: number;
  newAccounts: number;
}

export type Step = Partial<Spent>;

/**
 * Counts what a harness process spends and refuses a step, before it is submitted, that would pass a
 * cap: its own caps first, then the whole run's ledger. Without caps (testnet) it only counts.
 */
export class SpendMeter {
  readonly caps: SpendCaps | undefined;
  readonly ledger: RunLedger | undefined;
  readonly spent: Spent = { xlmStroops: 0n, usdcBaseUnits: 0n, settlements: 0, newAccounts: 0 };
  /** What came back to the treasury: swept USDC and merged XLM. */
  readonly returned = { xlmStroops: 0n, usdcBaseUnits: 0n };

  constructor(caps: SpendCaps | undefined, ledger?: RunLedger) {
    this.caps = caps;
    this.ledger = ledger;
  }

  #next(step: Step): Spent {
    return {
      xlmStroops: this.spent.xlmStroops + (step.xlmStroops ?? 0n),
      usdcBaseUnits: this.spent.usdcBaseUnits + (step.usdcBaseUnits ?? 0n),
      settlements: this.spent.settlements + (step.settlements ?? 0),
      newAccounts: this.spent.newAccounts + (step.newAccounts ?? 0),
    };
  }

  #check(next: Spent, what: string): void {
    const caps = this.caps;
    if (caps === undefined) return;
    const over = [
      next.xlmStroops > caps.maxXlmStroops
        ? `XLM ${next.xlmStroops} > ${caps.maxXlmStroops} stroops`
        : undefined,
      next.usdcBaseUnits > caps.maxUsdcBaseUnits
        ? `USDC ${next.usdcBaseUnits} > ${caps.maxUsdcBaseUnits} base units`
        : undefined,
      next.settlements > caps.maxSettlements
        ? `settlements ${next.settlements} > ${caps.maxSettlements}`
        : undefined,
      next.newAccounts > caps.maxNewAccounts
        ? `new accounts ${next.newAccounts} > ${caps.maxNewAccounts}`
        : undefined,
    ].filter((entry) => entry !== undefined);
    if (over.length > 0)
      throw new ProfileError("spend_cap_exceeded", `${what} would pass the cap: ${over.join(", ")}`);
  }

  /** Debits a step; throws `spend_cap_exceeded` and debits nothing when any cap would be passed. */
  debit(step: Step, what: string): void {
    const next = this.#next(step);
    this.#check(next, what);
    try {
      this.ledger?.debit(step, what);
    } catch (error) {
      if (error instanceof LedgerError)
        throw new ProfileError(error.code, error.message.replace(/^[a-z_]+: /, ""));
      throw error;
    }
    Object.assign(this.spent, next);
  }

  /** Refuses, without debiting, a step (a plan of what a run needs) that would pass a cap. */
  ensure(step: Step, what: string): void {
    this.#check(this.#next(step), what);
    try {
      this.ledger?.ensure(step, what);
    } catch (error) {
      if (error instanceof LedgerError)
        throw new ProfileError(error.code, error.message.replace(/^[a-z_]+: /, ""));
      throw error;
    }
  }

  /** Lowers a fee reservation to what the network charged. */
  release(xlmStroops: bigint): void {
    if (xlmStroops <= 0n) return;
    this.spent.xlmStroops -= xlmStroops;
    this.ledger?.release(xlmStroops);
  }

  /** Records funds returned to the treasury. */
  credit(step: { xlmStroops?: bigint; usdcBaseUnits?: bigint }): void {
    this.returned.xlmStroops += step.xlmStroops ?? 0n;
    this.returned.usdcBaseUnits += step.usdcBaseUnits ?? 0n;
    this.ledger?.credit(step);
  }

  /** One settlement, at the facilitator's fee ceiling (the worst case, not an estimate). */
  settlement(feeCeilingStroops: bigint, what = "a settlement"): void {
    this.debit({ settlements: 1, xlmStroops: feeCeilingStroops }, what);
  }
}

// --- the submission choke point --------------------------------------------------------------------

/** Who may pay for a transaction a pubnet harness submits, and the meter its fees go to. */
export interface SubmitPolicy {
  readonly meter: SpendMeter;
  /** The treasury: its fees are debited. */
  readonly treasury: string;
  /** A run account the treasury funded: its fees come out of a starting balance already debited. */
  readonly isRunAccount: (address: string) => boolean;
}

/**
 * A LocalNetwork-compatible client for a profile's network (passphrase and primary RPC). On a
 * treasury-funded network every transaction sent through its RPC client, by any helper, passes
 * `#beforeSend`: nothing is sent before a spend meter is attached, a fee paid by the treasury is
 * debited before it is sent, and a fee source that is neither the treasury nor a run account is refused.
 */
export class ProfileNetwork extends LocalNetwork {
  override readonly passphrase: string;
  readonly profile: NetworkProfile;
  #policy: SubmitPolicy | undefined;
  /** Fees reserved per transaction hash, so a resend of the same bytes is not debited twice. */
  readonly #reserved = new Map<string, bigint>();

  constructor(profile: NetworkProfile) {
    const primary = profile.rpcUrls[0];
    if (primary === undefined) throw new ProfileError("pubnet_rpc_missing", "the profile has no RPC URL");
    super(
      primary,
      profile.funding.kind === "friendbot" ? profile.funding.friendbotUrl : "https://friendbot.invalid",
    );
    this.passphrase = profile.passphrase;
    this.profile = profile;
    if (profile.funding.kind === "treasury") {
      const send = this.server.sendTransaction.bind(this.server);
      (this.server as { sendTransaction: rpc.Server["sendTransaction"] }).sendTransaction = async (
        transaction,
      ) => {
        this.#beforeSend(transaction);
        return send(transaction);
      };
    }
  }

  /** Attaches the run's meter and the accounts that may pay fees. */
  attach(policy: SubmitPolicy): void {
    this.#policy = policy;
  }

  #beforeSend(transaction: Transaction | FeeBumpTransaction): void {
    const policy = this.#policy;
    if (policy === undefined) {
      throw new ProfileError(
        "spend_unmetered",
        "nothing is submitted on a treasury-funded network before a run starts",
      );
    }
    const hash = transaction.hash().toString("hex");
    if (this.#reserved.has(hash)) return;
    const feeSource = transaction instanceof FeeBumpTransaction ? transaction.feeSource : transaction.source;
    const fee = BigInt(transaction.fee);
    if (feeSource === policy.treasury) {
      policy.meter.debit({ xlmStroops: fee }, `the fee of transaction ${hash.slice(0, 12)}`);
      this.#reserved.set(hash, fee);
    } else if (policy.isRunAccount(feeSource)) {
      this.#reserved.set(hash, 0n);
    } else {
      throw new ProfileError(
        "spend_unmetered",
        `fee source ${feeSource} is neither the treasury nor an account of this run`,
      );
    }
  }

  /** Submits, then lowers the fee reservation to the fee the network charged. */
  override async submit(
    transaction: Transaction | FeeBumpTransaction,
  ): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
    const hash = transaction.hash().toString("hex");
    let result: rpc.Api.GetSuccessfulTransactionResponse;
    try {
      result = await super.submit(transaction);
    } catch (error) {
      // A txBadSeq refusal applies nothing and charges no fee; the rebuilt transaction is reserved anew.
      if (error instanceof BadSequenceError) {
        const reserved = this.#reserved.get(hash) ?? 0n;
        this.#reserved.delete(hash);
        if (reserved > 0n) this.#policy?.meter.release(reserved);
      }
      throw error;
    }
    const reserved = this.#reserved.get(hash) ?? 0n;
    if (reserved > 0n) this.#policy?.meter.release(reserved - result.resultXdr.feeCharged().toBigInt());
    return result;
  }

  override async fund(...accounts: Keypair[]): Promise<void> {
    if (this.profile.funding.kind !== "friendbot") {
      throw new ProfileError(
        "friendbot_refused",
        `${this.profile.caip2} accounts are funded from the treasury, never by Friendbot`,
      );
    }
    await super.fund(...accounts);
  }
}

/** The WASM hash a deployed contract instance runs, hex; throws when the instance cannot be read. */
export async function contractWasmHash(net: LocalNetwork, contract: string): Promise<string> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contract).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const { entries } = await net.server.getLedgerEntries(key);
  const entry = entries[0];
  if (entry === undefined) throw new ProfileError("pubnet_upto_mismatch", `${contract} has no live instance`);
  const executable = entry.val.contractData().val().instance().executable();
  if (executable.switch() !== xdr.ContractExecutableType.contractExecutableWasm()) {
    throw new ProfileError("pubnet_upto_mismatch", `${contract} is not a WASM contract`);
  }
  return executable.wasmHash().toString("hex");
}

/** Refuses a run whose upto contract does not run the WASM its profile names. */
export async function checkUptoContract(
  net: LocalNetwork,
  upto: NonNullable<NetworkProfile["upto"]>,
): Promise<void> {
  const onChain = await contractWasmHash(net, upto.contract);
  if (onChain !== upto.wasmHash.toLowerCase()) {
    throw new ProfileError(
      "pubnet_upto_mismatch",
      `${upto.contract} runs WASM ${onChain}, not the expected ${upto.wasmHash}`,
    );
  }
}

// --- funding --------------------------------------------------------------------------------------

/** A contract account a run funds, and how it authorizes a transfer of its USDC back. */
export type ContractAuth =
  | { readonly kind: "simple"; readonly owner: Keypair }
  | { readonly kind: "oz"; readonly owner: Keypair; readonly verifier: string };

export interface AccountOptions {
  /** The fixture role; accounts of one role are derived together, so roles never swap between runs. */
  readonly role?: string;
  /** A fresh account for this run only, instead of one reused across runs. */
  readonly perRun?: boolean;
}

/** How a harness gets funded accounts on its network. */
export interface Funder {
  /** The account funding transfers come from. */
  readonly keypair: Keypair;
  readonly meter: SpendMeter;
  /**
   * `count` accounts with a USDC trustline holding exactly `usdc` USDC each (no trustline and no USDC
   * when `trust` is false).
   */
  accounts(count: number, usdc: string, trust?: boolean, options?: AccountOptions): Promise<Keypair[]>;
  /** Returns a run account's funds and merges it now, so a run holds few accounts at once. */
  close(account: Keypair): Promise<void>;
  /** USDC from the funder to any address (G… or C…). */
  transfer(to: string, amount: bigint): Promise<void>;
  /** The owner key of a contract account the run deploys (derived on pubnet, so it is never lost). */
  contractOwner(role: string): Keypair;
  /** Registers a funded contract account, so sweep-back can return its USDC. */
  trackContract(address: string, auth: ContractAuth): void;
  /**
   * Deploys the fixture smart account (a simple custom account whose constructor binds its owner)
   * owned by a run key, tracked.
   */
  smartAccount(role?: string): Promise<{ address: string; owner: Keypair }>;
  /** Returns what the run left in its accounts; called once, whatever happened. */
  sweepBack(): Promise<SweepResult>;
  /** Ends the run: closes the ledger this process claimed. */
  finish(): void;
}

export interface SweepResult {
  readonly status: "done" | "partial" | "not-needed";
  readonly transactions: readonly string[];
  /** Raw failure messages, for the local log only: they may name RPC URLs. */
  readonly problems: readonly string[];
  /** What is still outside the treasury after the sweep. */
  readonly stranded: {
    readonly usdcBaseUnits: bigint;
    readonly xlmStroops: bigint;
    readonly accounts: readonly string[];
  };
}

const NOTHING_STRANDED = { usdcBaseUnits: 0n, xlmStroops: 0n, accounts: [] } as const;

/** Leftovers a sweep may tolerate: none. Any stranded USDC or unmerged account fails the sweep. */
export const SWEEP_DUST = { usdcBaseUnits: 0n, xlmStroops: 0n } as const;

/** Testnet: the Friendbot treasury of testnet.ts, counted but never capped. */
export class FriendbotFunder implements Funder {
  readonly treasury: Treasury;
  readonly meter = new SpendMeter(undefined);

  constructor(treasury: Treasury) {
    this.treasury = treasury;
  }

  get keypair(): Keypair {
    return this.treasury.keypair;
  }

  accounts(count: number, usdc: string, trust = true): Promise<Keypair[]> {
    return this.treasury.accounts(count, usdc, trust);
  }

  async close(): Promise<void> {
    // Testnet funds are Friendbot's; nothing is returned.
  }

  transfer(to: string, amount: bigint): Promise<void> {
    return this.treasury.transfer(to, amount);
  }

  contractOwner(): Keypair {
    return Keypair.random();
  }

  trackContract(): void {
    // Testnet funds are Friendbot's; nothing is returned.
  }

  async smartAccount(): Promise<{ address: string; owner: Keypair }> {
    const owner = Keypair.random();
    return { address: await deploySimpleAccount(this.treasury.net, this.treasury.keypair, owner), owner };
  }

  sweepBack(): Promise<SweepResult> {
    return Promise.resolve({
      status: "not-needed",
      transactions: [],
      problems: [],
      stranded: NOTHING_STRANDED,
    });
  }

  finish(): void {
    // Nothing to close on testnet.
  }
}

/** XLM a pubnet run account starts with: two base reserves, a trustline reserve and fees. */
export const PUBNET_STARTING_BALANCE_XLM = "2";
/** XLM set aside, before deploying, for a smart-account payer (two transactions and storage rent). */
export const CONTRACT_ACCOUNT_DEPLOY_STROOPS = 50_000_000n;

/** The OpenZeppelin smart account's code: its signers change only with its own authorization. */
const OZ_ACCOUNT_WASM_HASH = hash(fixtureWasm("oz_smart_account.wasm")).toString("hex");

interface TrackedContract {
  readonly address: string;
  readonly auth: ContractAuth;
  readonly signer: EntrySigner;
}

/**
 * Pubnet: funds from the operator treasury. Run accounts are derived from the treasury seed, the
 * label and a role (`<label>/<role>/<n>`), so a role always maps to the same accounts and only the
 * operator can sign for them; a missing account is created (counted as a new account), and its USDC
 * is set to exactly what the role asks. Contract-account owners are derived the same way. Each
 * account and contract is written to the run's registry before it is funded. `sweepBack` returns the
 * USDC of every run account and contract account and merges the accounts into the treasury.
 */
export class TreasuryFunder implements Funder {
  readonly keypair: Keypair;
  readonly meter: SpendMeter;
  readonly net: LocalNetwork;
  readonly label: string;
  readonly ledger: RunLedger | undefined;
  readonly #ownsLedger: boolean;
  readonly #seed: Buffer;
  readonly #runScope: string;
  readonly #used = new Map<string, Keypair>();
  /** Run accounts this run saw on the network: one that is gone at the sweep was merged by its key. */
  readonly #existed = new Set<string>();
  /** The merges of accounts closed during the run. */
  readonly #closed: string[] = [];
  readonly #contracts = new Map<string, TrackedContract>();
  readonly #ownerPaths = new Map<string, string>();
  readonly #counters = new Map<string, number>();
  readonly #asset: Asset;
  readonly #usdcContract: string;
  #sweep: Promise<SweepResult> | undefined;

  constructor(
    net: LocalNetwork,
    profile: NetworkProfile,
    label: string,
    options: { asset?: Asset; secretFile?: string; ledger?: RunLedger; ownsLedger?: boolean } = {},
  ) {
    const secretFile =
      options.secretFile ?? (profile.funding.kind === "treasury" ? profile.funding.secretFile : undefined);
    if (secretFile === undefined)
      throw new ProfileError("pubnet_treasury_missing", "no treasury secret file");
    this.keypair = readTreasury(secretFile);
    this.#seed = this.keypair.rawSecretKey();
    this.ledger = options.ledger;
    this.#ownsLedger = options.ownsLedger === true;
    this.#runScope = options.ledger?.runId ?? randomBytes(8).toString("hex");
    this.meter = new SpendMeter(profile.caps, options.ledger);
    this.net = net;
    this.label = label;
    this.#asset = options.asset ?? new Asset(profile.usdc.code, profile.usdc.issuer);
    this.#usdcContract = this.#asset.contractId(net.passphrase);
    if (net instanceof ProfileNetwork) {
      net.attach({
        meter: this.meter,
        treasury: this.keypair.publicKey(),
        isRunAccount: (address) => this.#used.has(address),
      });
    }
  }

  /** The key at a derivation path: the same for every run of this treasury. */
  keyAt(path: string): Keypair {
    const seed = hkdfSync("sha256", this.#seed, "rail402 conformance treasury account", path, 32);
    return Keypair.fromRawEd25519Seed(Buffer.from(seed));
  }

  /** The `n`th run account of a role: `<label>/<role>/<n>`. */
  derived(role: string, n = 0): Keypair {
    return this.keyAt(`${this.label}/${role}/${String(n)}`);
  }

  #nextPath(role: string, perRun: boolean): string {
    const key = `${perRun ? "run" : "fixed"}:${role}`;
    const n = this.#counters.get(key) ?? 0;
    this.#counters.set(key, n + 1);
    return perRun
      ? `${this.#runScope}/${this.label}/${role}/${String(n)}`
      : `${this.label}/${role}/${String(n)}`;
  }

  async #exists(address: string): Promise<boolean> {
    try {
      await this.net.server.getAccount(address);
      return true;
    } catch {
      return false;
    }
  }

  async #hasTrustline(address: string): Promise<boolean> {
    const key = xdr.LedgerKey.trustline(
      new xdr.LedgerKeyTrustLine({
        accountId: Keypair.fromPublicKey(address).xdrAccountId(),
        asset: this.#asset.toTrustLineXDRObject(),
      }),
    );
    const { entries } = await this.net.server.getLedgerEntries(key);
    return entries.length > 0;
  }

  /** 0 for an account without a trustline; throws when the balance cannot be read. */
  #usdcBalance(address: string): Promise<bigint> {
    return this.net.tokenBalance(this.#usdcContract, address);
  }

  async accounts(
    count: number,
    usdc: string,
    trust = true,
    options: AccountOptions = {},
  ): Promise<Keypair[]> {
    const wanted = trust && usdc !== "0" ? decimalToUnits(usdc, 7, "USDC amount") : 0n;
    const role = options.role ?? `${trust ? "holder" : "bare"}-${usdc}`;
    const accounts: Keypair[] = [];
    for (let index = 0; index < count; index++) {
      const path = this.#nextPath(role, options.perRun === true);
      const account = this.keyAt(path);
      const address = account.publicKey();
      // Registered before anything is sent, so a crash leaves an account the operator can recover.
      this.ledger?.register({ kind: "account", harness: this.label, address, path });
      this.#used.set(address, account);
      await this.#prepare(account, trust, wanted);
      accounts.push(account);
    }
    return accounts;
  }

  /** Makes the account exist with exactly the fixture state its role asks for. */
  async #prepare(account: Keypair, trust: boolean, wanted: bigint): Promise<void> {
    const address = account.publicKey();
    if (!(await this.#exists(address))) {
      this.meter.debit(
        { newAccounts: 1, xlmStroops: BigInt(PUBNET_STARTING_BALANCE_XLM) * XLM },
        `creating ${address}`,
      );
      await this.net.classic(this.keypair, [
        Operation.createAccount({ destination: address, startingBalance: PUBNET_STARTING_BALANCE_XLM }),
      ]);
    }
    this.#existed.add(address);
    // Persisted too, so a recovery sweep in a fresh process can make the same merged-away check.
    this.ledger?.markSeen(address);
    const trusted = await this.#hasTrustline(address);
    const balance = trusted ? await this.#usdcBalance(address) : 0n;
    if (!trust) {
      // A bare account holds no trustline, even if an earlier run left one behind.
      if (trusted) {
        await this.#returnUsdc(account, balance, [Operation.changeTrust({ asset: this.#asset, limit: "0" })]);
      }
      return;
    }
    if (!trusted) {
      await this.net.classic(
        this.keypair,
        [Operation.changeTrust({ asset: this.#asset, source: address })],
        [account],
      );
    }
    if (balance < wanted) await this.#pay(address, wanted - balance);
    else if (balance > wanted) await this.#returnUsdc(account, balance - wanted);
  }

  /** USDC from a run account back to the treasury, with any extra operations of that account. */
  async #returnUsdc(
    account: Keypair,
    amount: bigint,
    extra: xdr.Operation[] = [],
  ): Promise<string | undefined> {
    const operations = [
      ...(amount > 0n
        ? [
            Operation.payment({
              destination: this.keypair.publicKey(),
              asset: this.#asset,
              amount: unitsToDecimal(amount),
            }),
          ]
        : []),
      ...extra,
    ];
    if (operations.length === 0) return undefined;
    const result = await this.net.classic(account, operations);
    if (amount > 0n) this.meter.credit({ usdcBaseUnits: amount });
    return result.txHash;
  }

  async #pay(destination: string, amount: bigint): Promise<void> {
    this.meter.debit({ usdcBaseUnits: amount }, `sending ${amount} USDC base units to ${destination}`);
    await this.net.classic(this.keypair, [
      Operation.payment({ destination, asset: this.#asset, amount: unitsToDecimal(amount) }),
    ]);
  }

  async transfer(to: string, amount: bigint): Promise<void> {
    if (!to.startsWith("C")) {
      await this.#pay(to, amount);
      return;
    }
    const contract = this.#contracts.get(to);
    if (contract === undefined) {
      throw new ProfileError(
        "pubnet_contract_untracked",
        `${to} is not a contract account of this run; track it before funding it`,
      );
    }
    await this.#checkOwner(contract);
    // A contract address receives through the asset contract.
    this.meter.debit({ usdcBaseUnits: amount }, `sending ${amount} USDC base units to ${to}`);
    await this.#invoke(this.#transferCall(this.keypair.publicKey(), to, amount), []);
  }

  /**
   * Refuses to fund a contract account unless the chain shows that only the run can move what it
   * receives: the fixture account owned by the run's derived key (its constructor bound the owner and
   * nothing can change it), or the OpenZeppelin smart account (its signers, bound by its constructor,
   * change only with its own authorization). A ledger that cannot be read refuses too.
   */
  async #checkOwner({ address, auth }: TrackedContract): Promise<void> {
    if (auth.kind === "simple") {
      const owner = await simpleAccountOwner(this.net, address);
      if (owner === auth.owner.publicKey()) return;
      throw new ProfileError(
        "pubnet_contract_owner_unverified",
        owner === undefined
          ? `${address} does not run the fixture account's code`
          : `${address} is owned by ${owner}, not by the run's key`,
      );
    }
    if ((await contractCode(this.net, address))?.wasmHash === OZ_ACCOUNT_WASM_HASH) return;
    throw new ProfileError(
      "pubnet_contract_owner_unverified",
      `${address} does not run the OpenZeppelin smart account's code`,
    );
  }

  #transferCall(from: string, to: string, amount: bigint): xdr.Operation {
    return new Contract(this.#usdcContract).call(
      "transfer",
      nativeToScVal(from, { type: "address" }),
      nativeToScVal(to, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    );
  }

  /** A Soroban call from the treasury, its address entries signed by `signers` before it is prepared. */
  async #invoke(operation: xdr.Operation, signers: readonly { address: string; sign: EntrySigner }[]) {
    const build = async (op: xdr.Operation) =>
      new TransactionBuilder(await this.net.server.getAccount(this.keypair.publicKey()), {
        fee: BASE_FEE,
        networkPassphrase: this.net.passphrase,
      })
        .addOperation(op)
        .setTimeout(60)
        .build();
    // Built again from a fresh sequence number if the network answers txBadSeq.
    return this.net.submitBuilt(async () => {
      let transaction = await build(operation);
      if (signers.length > 0) {
        const simulation = await this.net.server.simulateTransaction(transaction);
        if (!rpc.Api.isSimulationSuccess(simulation) || simulation.result === undefined) {
          throw new Error(`simulation failed: ${"error" in simulation ? simulation.error : "no result"}`);
        }
        const expiration = (await this.net.latestLedger()) + 60;
        const auth = await Promise.all(
          simulation.result.auth.map(async (entry) => {
            if (entry.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount())
              return entry;
            const credentials = addressCredentialsOf(entry);
            const address = Address.fromScAddress(credentials.address()).toString();
            const signer = signers.find((candidate) => candidate.address === address);
            if (signer === undefined) throw new Error(`no signer for ${address}`);
            credentials.signatureExpirationLedger(expiration);
            return signer.sign(entry, this.net.passphrase);
          }),
        );
        const invoke = transaction.operations[0];
        if (invoke?.type !== "invokeHostFunction") throw new Error("unexpected operation");
        transaction = await build(Operation.invokeHostFunction({ func: invoke.func, auth }));
      }
      // Prepared with the signed entries, so the contract account's own check is in the resources.
      const prepared = await this.net.server.prepareTransaction(transaction);
      prepared.sign(this.keypair);
      return prepared;
    });
  }

  contractOwner(role: string): Keypair {
    const path = this.#nextPath(`owner-${role}`, false);
    const owner = this.keyAt(path);
    this.#ownerPaths.set(owner.publicKey(), path);
    return owner;
  }

  trackContract(address: string, auth: ContractAuth): void {
    const ownerPath = this.#ownerPaths.get(auth.owner.publicKey());
    if (ownerPath === undefined) {
      throw new ProfileError(
        "pubnet_owner_unknown",
        "a contract account's owner must come from contractOwner(), so its funds can always be returned",
      );
    }
    this.ledger?.register({
      kind: "contract",
      harness: this.label,
      address,
      auth: auth.kind,
      ownerPath,
      ...(auth.kind === "oz" ? { verifier: auth.verifier } : {}),
    });
    this.#contracts.set(address, { address, auth, signer: contractSigner(auth) });
  }

  async smartAccount(role = "simple"): Promise<{ address: string; owner: Keypair }> {
    this.meter.ensure({ xlmStroops: CONTRACT_ACCOUNT_DEPLOY_STROOPS }, "deploying a smart account");
    const owner = this.contractOwner(role);
    const address = await deploySimpleAccount(this.net, this.keypair, owner);
    this.trackContract(address, { kind: "simple", owner });
    return { address, owner };
  }

  /** One account's USDC back to the treasury and the account merged into it; the merge's hash. */
  async #merge(account: Keypair, reserved = 0n): Promise<string> {
    const address = account.publicKey();
    const trusted = await this.#hasTrustline(address);
    const balance = trusted ? await this.#usdcBalance(address) : 0n;
    const native = await this.net.nativeBalance(address);
    const operations = [
      ...(balance > 0n
        ? [
            Operation.payment({
              destination: this.keypair.publicKey(),
              asset: this.#asset,
              amount: unitsToDecimal(balance),
            }),
          ]
        : []),
      ...(trusted ? [Operation.changeTrust({ asset: this.#asset, limit: "0" })] : []),
      Operation.accountMerge({ destination: this.keypair.publicKey() }),
    ];
    const result = await this.net.classic(account, operations);
    this.meter.credit({
      usdcBaseUnits: balance,
      xlmStroops: native - result.resultXdr.feeCharged().toBigInt() - reserved,
    });
    return result.txHash;
  }

  async close(account: Keypair): Promise<void> {
    const address = account.publicKey();
    if (!this.#used.has(address)) throw new Error(`${address} is not an account of this run`);
    // Its starting balance is back, so it no longer counts against the caps; only its fees do.
    const reserved = BigInt(PUBNET_STARTING_BALANCE_XLM) * XLM;
    this.#closed.push(await this.#merge(account, reserved));
    this.meter.release(reserved);
    this.#used.delete(address);
    this.#existed.delete(address);
    this.ledger?.markClosed(address);
  }

  /** Every run account's and contract account's USDC back to the treasury, and the accounts merged into it. */
  sweepBack(options: { merge?: boolean } = {}): Promise<SweepResult> {
    this.#sweep ??= this.#sweepOnce(options.merge !== false);
    return this.#sweep;
  }

  async #sweepOnce(merge: boolean): Promise<SweepResult> {
    const transactions = [...this.#closed];
    const problems: string[] = [];
    if (this.#used.size === 0 && this.#contracts.size === 0 && this.#closed.length === 0) {
      return { status: "not-needed", transactions, problems, stranded: NOTHING_STRANDED };
    }
    for (const contract of this.#contracts.values()) {
      try {
        const balance = await this.#usdcBalance(contract.address);
        if (balance === 0n) continue;
        const result = await this.#invoke(
          this.#transferCall(contract.address, this.keypair.publicKey(), balance),
          [{ address: contract.address, sign: contract.signer }],
        );
        this.meter.credit({ usdcBaseUnits: balance });
        transactions.push(result.txHash);
      } catch (error) {
        problems.push(`${contract.address}: ${messageOf(error)}`);
      }
    }
    for (const [address, account] of this.#used) {
      try {
        if (!(await this.#exists(address))) {
          // An account the run never created holds nothing. One it saw that is gone was merged by
          // whoever holds its key (or cannot be read): its funds did not come back, so the sweep fails.
          if (this.#existed.has(address)) {
            problems.push(
              `${address}: the run's account no longer exists (merged outside the run, or unreadable); its funds were not returned`,
            );
          }
          continue;
        }
        if (!merge) {
          const trusted = await this.#hasTrustline(address);
          const balance = trusted ? await this.#usdcBalance(address) : 0n;
          const hash = await this.#returnUsdc(account, balance);
          if (hash !== undefined) transactions.push(hash);
          continue;
        }
        transactions.push(await this.#merge(account));
      } catch (error) {
        problems.push(`${address}: ${messageOf(error)}`);
      }
    }
    const stranded = await this.#stranded(merge, problems);
    const partial =
      problems.length > 0 ||
      stranded.usdcBaseUnits > SWEEP_DUST.usdcBaseUnits ||
      stranded.xlmStroops > SWEEP_DUST.xlmStroops;
    if (stranded.accounts.length > 0) {
      this.ledger?.strand(stranded);
      log(
        `sweep-back left ${stranded.usdcBaseUnits} USDC base units and ${stranded.xlmStroops} stroops in ` +
          `${String(stranded.accounts.length)} account(s): ${stranded.accounts.join(", ")}`,
      );
    }
    if (problems.length > 0) log(`sweep-back problems: ${problems.join("; ")}`);
    return { status: partial ? "partial" : "done", transactions, problems, stranded };
  }

  /** What is still outside the treasury: USDC anywhere, and the XLM of accounts that were not merged. */
  async #stranded(merge: boolean, problems: string[]): Promise<SweepResult["stranded"]> {
    let usdcBaseUnits = 0n;
    let xlmStroops = 0n;
    const accounts: string[] = [];
    const addresses = [...this.#contracts.keys(), ...this.#used.keys()];
    for (const address of addresses) {
      try {
        const contract = address.startsWith("C");
        if (!contract && !(await this.#exists(address))) continue;
        const usdc = contract || (await this.#hasTrustline(address)) ? await this.#usdcBalance(address) : 0n;
        const xlm = !contract && merge ? await this.net.nativeBalance(address) : 0n;
        if (usdc > 0n || xlm > 0n) {
          usdcBaseUnits += usdc;
          xlmStroops += xlm;
          accounts.push(address);
        }
      } catch (error) {
        problems.push(`${address}: its balance could not be read after the sweep (${messageOf(error)})`);
        accounts.push(address);
      }
    }
    return { usdcBaseUnits, xlmStroops, accounts };
  }

  /**
   * Takes over the run accounts and contract accounts of a run's registry (a run that crashed), so
   * `sweepBack` returns their funds. Every key is derived again from the treasury seed and must match.
   * `seen` are the addresses the crashed run recorded as existing on the network, so the sweep can
   * still report one merged away by whoever held its key, instead of skipping it.
   */
  recover(entries: readonly RegistryEntry[], seen: readonly string[] = []): void {
    for (const address of seen) this.#existed.add(address);
    for (const entry of entries) {
      if (entry.kind === "account") {
        const account = this.keyAt(entry.path);
        if (account.publicKey() !== entry.address) {
          throw new ProfileError("pubnet_run_mismatch", `${entry.address} is not derived from this treasury`);
        }
        this.#used.set(entry.address, account);
      } else {
        const owner = this.keyAt(entry.ownerPath);
        const auth: ContractAuth =
          entry.auth === "simple"
            ? { kind: "simple", owner }
            : { kind: "oz", owner, verifier: entry.verifier ?? "" };
        this.#contracts.set(entry.address, { address: entry.address, auth, signer: contractSigner(auth) });
      }
    }
  }

  finish(): void {
    if (this.#ownsLedger) this.ledger?.close();
  }
}

/** How a tracked contract account signs a transfer of its own USDC. */
function contractSigner(auth: ContractAuth): EntrySigner {
  return auth.kind === "simple"
    ? simpleAccountSigner(auth.owner)
    : ozSmartAccountSigner({ verifier: auth.verifier, key: auth.owner, contextRuleIds: [OZ_DEFAULT_RULE] });
}

function readTreasury(secretFile: string): Keypair {
  checkSecretFile(secretFile);
  return Keypair.fromSecret(readFileSync(secretFile, "utf8").trim());
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unitsToDecimal(units: bigint): string {
  const whole = units / XLM;
  const fraction = (units % XLM).toString().padStart(7, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** The funder for a profile: Friendbot and the testnet pool on testnet, the treasury on pubnet. */
export async function openFunder(
  net: LocalNetwork,
  profile: NetworkProfile,
  label: string,
  usdc = "5",
): Promise<Funder> {
  if (profile.funding.kind === "friendbot") {
    log("opening a treasury: Friendbot XLM, then USDC from the testnet XLM/USDC pool");
    return new FriendbotFunder(await new Treasury(net).open(usdc));
  }
  log(`funding from the operator treasury, capped (${label})`);
  return new TreasuryFunder(net, profile, label);
}

/** The sweep as evidence shows it: counts and amounts, never raw error messages. */
export function sweepObservation(sweep: SweepResult) {
  return {
    status: sweep.status,
    transactions: [...sweep.transactions],
    problems: sweep.problems.length,
    stranded: {
      usdcBaseUnits: sweep.stranded.usdcBaseUnits.toString(),
      xlmStroops: sweep.stranded.xlmStroops.toString(),
      accounts: [...sweep.stranded.accounts],
    },
  };
}

/** Fails the `sweep-back` case when anything above dust is left outside the treasury. */
export function assertSwept(sweep: SweepResult): void {
  if (sweep.status === "done" || sweep.status === "not-needed") return;
  throw new Error(
    `sweep-back left ${sweep.stranded.usdcBaseUnits} USDC base units and ${sweep.stranded.xlmStroops} stroops ` +
      `in ${String(sweep.stranded.accounts.length)} account(s)` +
      (sweep.problems.length > 0 ? ` (${String(sweep.problems.length)} step(s) failed; see the log)` : ""),
  );
}

/** The evidence `profile` block of a run. */
export function profileEvidence(profile: NetworkProfile, funder: Funder, sweep: SweepResult) {
  const caps = profile.caps;
  const ledger = funder instanceof TreasuryFunder ? funder.ledger : undefined;
  return {
    id: profile.id,
    funding: profile.funding.kind,
    rpcProviders: profile.rpcUrls.map((url) => new URL(url).hostname),
    caps:
      caps === undefined
        ? undefined
        : {
            maxXlmStroops: caps.maxXlmStroops.toString(),
            maxUsdcBaseUnits: caps.maxUsdcBaseUnits.toString(),
            maxSettlements: caps.maxSettlements,
            maxNewAccounts: caps.maxNewAccounts,
          },
    spent: {
      xlmStroops: funder.meter.spent.xlmStroops.toString(),
      usdcBaseUnits: funder.meter.spent.usdcBaseUnits.toString(),
      settlements: funder.meter.spent.settlements,
      newAccounts: funder.meter.spent.newAccounts,
    },
    returned: {
      xlmStroops: funder.meter.returned.xlmStroops.toString(),
      usdcBaseUnits: funder.meter.returned.usdcBaseUnits.toString(),
    },
    sweep: {
      status: sweep.status,
      transactions: [...sweep.transactions],
      stranded: {
        usdcBaseUnits: sweep.stranded.usdcBaseUnits.toString(),
        xlmStroops: sweep.stranded.xlmStroops.toString(),
      },
    },
    ...(ledger === undefined ? {} : { run: ledger.totals() }),
  };
}

/** Refuses pubnet in a harness, or a case, that runs on testnet only. */
export function testnetOnly(profile: NetworkProfile, what: string): void {
  if (profile.id !== "testnet") {
    throw new ProfileError("pubnet_not_supported", `${what} runs on the Stellar testnet only`);
  }
}

export interface StartOptions {
  readonly label?: string;
  readonly usdc?: string;
  readonly env?: Env;
  /** The facilitator URLs the harness calls: probed for access, then guarded (key, settlement caps). */
  readonly facilitators?: readonly string[];
  /** Where pubnet runs keep their ledgers; `.work/pubnet-runs` by default. */
  readonly runsDir?: string;
}

/** The facilitator guard of this process, once a pubnet run started. */
let guard: FacilitatorGuard | undefined;

/**
 * Opens the run's funder. On pubnet: reads the API key (when set) and checks that every facilitator
 * serves this run, checks the upto contract's WASM on chain, then joins the run ledger
 * (RAIL402_PUBNET_LEDGER), or claims the planned one RAIL402_PUBNET_RUN_CONFIRM names, or, without a
 * confirmation, plans a new run, prints its id and spends nothing. Every `/settle` request to the
 * facilitators is then counted against the caps before it is sent.
 */
export async function startRun(
  harness: string,
  profile: NetworkProfile,
  net: LocalNetwork,
  options: StartOptions = {},
): Promise<Funder> {
  if (profile.id === "testnet") return openFunder(net, profile, options.label ?? harness, options.usdc);
  const env = options.env ?? process.env;
  if (profile.funding.kind !== "treasury") throw new ProfileError("pubnet_treasury_missing", "no treasury");
  const treasury = readTreasury(profile.funding.secretFile).publicKey();
  const material = runMaterial(profile, treasury, gitCommit().replace(/-dirty$/, ""));
  const apiKey =
    profile.facilitator.apiKeyFile === undefined ? undefined : readApiKey(profile.facilitator.apiKeyFile);
  for (const url of options.facilitators ?? []) await checkFacilitatorAccess(url, profile.caip2, apiKey);
  if (profile.upto !== undefined) await checkUptoContract(net, profile.upto);

  const caps = profile.caps;
  const runCaps = profile.runCaps;
  log(
    `pubnet run: treasury ${treasury}, harness caps ` +
      (caps === undefined
        ? "none"
        : `${caps.maxXlmStroops} stroops, ${caps.maxUsdcBaseUnits} USDC base units, ` +
          `${caps.maxSettlements} settlements, ${caps.maxNewAccounts} new accounts`) +
      (runCaps === undefined
        ? ""
        : `; run caps ${runCaps.maxNetXlmStroops} stroops net, ${runCaps.maxNetUsdcBaseUnits} USDC base units net`),
  );
  const confirm = env["RAIL402_PUBNET_RUN_CONFIRM"];
  const ledgerFile = env["RAIL402_PUBNET_LEDGER"];
  const dir = options.runsDir ?? PUBNET_RUNS_DIR;
  let ledger: RunLedger;
  let owns: boolean;
  try {
    if (ledgerFile !== undefined && ledgerFile !== "") {
      if (confirm === undefined || confirm === "") {
        throw new ProfileError(
          "pubnet_run_unconfirmed",
          "RAIL402_PUBNET_LEDGER needs RAIL402_PUBNET_RUN_CONFIRM",
        );
      }
      ledger = RunLedger.join(ledgerFile, confirm, material, harness);
      owns = false;
    } else if (confirm === undefined || confirm === "") {
      const planned = planRun(material, dir);
      throw new ProfileError(
        "pubnet_run_unconfirmed",
        `this run spends real funds; check the caps and run again with RAIL402_PUBNET_RUN_CONFIRM=${planned.runId}`,
      );
    } else {
      ledger = RunLedger.claim(confirm, material, harness, dir);
      owns = true;
    }
  } catch (error) {
    if (error instanceof LedgerError)
      throw new ProfileError(error.code, error.message.replace(/^[a-z_]+: /, ""));
    throw error;
  }
  log(`pubnet run ${ledger.runId}: ledger ${ledger.path}`);
  const funder = new TreasuryFunder(net, profile, options.label ?? harness, { ledger, ownsLedger: owns });
  guard?.restore();
  guard = installFacilitatorGuard({
    urls: options.facilitators ?? [],
    meter: funder.meter,
    feeCeiling: (scheme) => feeCeilingStroops(profile, scheme),
    ...(apiKey === undefined ? {} : { apiKey }),
  });
  return funder;
}

/**
 * Runs the body of a funded run and returns the sweep: the run's funds go back to the treasury when
 * the body ends, when it throws (rethrown after the sweep) and on SIGINT or SIGTERM (the process then
 * exits with 130 or 143 once the sweep is done). The sweep runs once, whichever comes first.
 */
export async function withRun(funder: Funder, body: () => Promise<void>): Promise<SweepResult> {
  let finishing: Promise<SweepResult> | undefined;
  const finish = () =>
    (finishing ??= funder.sweepBack().finally(() => {
      funder.finish();
    }));
  const state = { signalled: false };
  const onSignal = (signal: NodeJS.Signals) => {
    if (state.signalled) {
      log(`${signal}: still returning the run's funds`);
      return;
    }
    state.signalled = true;
    log(`${signal}: returning the run's funds before exiting`);
    finish().then(
      (sweep) => {
        log(`sweep-back ${sweep.status}`);
        process.exit(signal === "SIGINT" ? 130 : 143);
      },
      (error: unknown) => {
        log(`sweep-back failed: ${messageOf(error)}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let failure: { error: unknown } | undefined;
  try {
    await body();
  } catch (error) {
    failure = { error };
  }
  try {
    const sweep = await finish();
    if (failure !== undefined) throw failure.error;
    return sweep;
  } finally {
    if (!state.signalled) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
}

/**
 * `exact` requirements on a profile's network. The test kit's builder types its network as testnet,
 * the network its private-network tests use; the payment it signs uses the client's passphrase, so
 * only the label needs to change for pubnet.
 */
export function requirementsOn(
  caip2: Caip2,
  ...args: Parameters<typeof requirementsFor>
): ReturnType<typeof requirementsFor> {
  const requirements = requirementsFor(...args);
  return (caip2 === requirements.network
    ? requirements
    : { ...requirements, network: caip2 }) as unknown as ReturnType<typeof requirementsFor>;
}
