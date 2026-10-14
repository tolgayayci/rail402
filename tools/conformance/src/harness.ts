/**
 * What every schemaVersion 2 harness shares: reading the target facilitator, recording cases with
 * their rejections, transactions and observations, describing a settlement transaction from the
 * chain, and assembling the evidence document that `writeEvidence` checks and writes.
 */
import { randomUUID } from "node:crypto";
import { FeeBumpTransaction, TransactionBuilder, rpc, type Transaction } from "@stellar/stellar-sdk";
import { reportCode } from "@rail402.dev/errors";
import { onChainSettlement, type LocalNetwork } from "@rail402.dev/testkit";
import type {
  CheckId,
  Evidence,
  EvidenceCase,
  EvidenceKind,
  EvidenceRejection,
  EvidenceTransaction,
  Provenance,
} from "./evidence.ts";
import { log } from "./testnet.ts";

export type Network = Evidence["network"];

/** A stellar.expert link for a testnet transaction. */
export function explorerUrl(hash: string, network: Network = "stellar:testnet"): string {
  return `https://stellar.expert/explorer/${network === "stellar:pubnet" ? "public" : "testnet"}/tx/${hash}`;
}

/** `local` for a facilitator on this machine, `hosted` otherwise. */
export function modeOf(url: string): "local" | "hosted" {
  const { hostname } = new URL(url);
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname) ? "local" : "hosted";
}

/** A facilitator URL without trailing slashes. */
export function baseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export type Target = Evidence["target"];

/** The facilitator under test: its mode, the version `/health` reports, and `/supported` verbatim. */
export async function readTarget(url: string, mode = modeOf(url)): Promise<Target> {
  const base = baseUrl(url);
  const health: { version?: unknown } = await fetch(`${base}/health`)
    .then(async (response) => (response.ok ? ((await response.json()) as { version?: unknown }) : {}))
    .catch(() => ({}));
  const supported = await fetch(`${base}/supported`);
  if (!supported.ok) throw new Error(`GET ${base}/supported answered HTTP ${String(supported.status)}`);
  return {
    mode,
    facilitatorUrl: base,
    healthVersion: typeof health.version === "string" && health.version !== "" ? health.version : "unknown",
    supported: await supported.json(),
  };
}

/** The facilitator's signers for a network family, from `/supported`. */
export function supportedSigners(supported: unknown, family = "stellar:*"): string[] {
  const signers = (supported as { signers?: Record<string, unknown> } | undefined)?.signers?.[family];
  return Array.isArray(signers)
    ? signers.filter((signer): signer is string => typeof signer === "string")
    : [];
}

// --- cases ----------------------------------------------------------------------------------------

export interface CaseSpec {
  readonly id: string;
  readonly title: string;
  readonly checks: readonly CheckId[];
  readonly scheme?: "exact" | "upto";
  readonly asset?: string;
  readonly payer?: "G" | "C";
  readonly payTo?: "G" | "C";
}

/** What a running case records into its evidence. */
export interface CaseContext {
  rejection(rejection: EvidenceRejection): void;
  transaction(transaction: EvidenceTransaction): void;
  observe(key: string, value: unknown): void;
}

/**
 * Runs cases one after another and keeps their evidence. A case passes when its function returns
 * and fails when it throws; the error message is kept as an observation.
 */
export class CaseRecorder {
  readonly cases: EvidenceCase[] = [];
  readonly startedAt = new Date().toISOString();
  private readonly only: ReadonlySet<string> | undefined;

  /** `only`: run just these case ids; the others are left out of the evidence. */
  constructor(only?: Iterable<string>) {
    this.only = only === undefined ? undefined : new Set(only);
  }

  /** Whether a case id is selected by `only`. */
  selected(id: string): boolean {
    return this.only === undefined || this.only.has(id);
  }

  async run(spec: CaseSpec, body: (context: CaseContext) => Promise<void>): Promise<boolean> {
    if (!this.selected(spec.id)) return false;
    const rejections: EvidenceRejection[] = [];
    const transactions: EvidenceTransaction[] = [];
    const observations: Record<string, unknown> = {};
    const context: CaseContext = {
      rejection: (rejection) => {
        rejections.push(rejection);
        // A refusal seen on the wire, from a service in another process, counts for code coverage.
        reportCode(rejection.code);
      },
      transaction: (transaction) => transactions.push(transaction),
      observe: (key, value) => {
        observations[key] = jsonSafe(value);
      },
    };
    const started = performance.now();
    let passed = false;
    try {
      await body(context);
      passed = true;
      log(`PASS ${spec.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      observations["error"] = message;
      log(`FAIL ${spec.id}: ${message}`);
    }
    this.cases.push({
      ...caseFields(spec),
      status: passed ? "passed" : "failed",
      elapsedMs: Math.round(performance.now() - started),
      ...(rejections.length === 0 ? {} : { rejections }),
      ...(transactions.length === 0 ? {} : { transactions }),
      ...(Object.keys(observations).length === 0 ? {} : { observations }),
    });
    return passed;
  }

  /** Records a case that cannot run here, with the reason. */
  skip(spec: CaseSpec, reason: string): void {
    if (!this.selected(spec.id)) return;
    log(`SKIP ${spec.id}: ${reason}`);
    this.cases.push({ ...caseFields(spec), status: "skipped", skipReason: reason, elapsedMs: 0 });
  }

  get failed(): number {
    return this.cases.filter((entry) => entry.status === "failed").length;
  }
}

function caseFields(spec: CaseSpec) {
  return {
    id: spec.id,
    title: spec.title,
    checks: [...spec.checks],
    ...(spec.scheme === undefined ? {} : { scheme: spec.scheme }),
    ...(spec.asset === undefined ? {} : { asset: spec.asset }),
    ...(spec.payer === undefined ? {} : { payer: spec.payer }),
    ...(spec.payTo === undefined ? {} : { payTo: spec.payTo }),
  };
}

/** A value made JSON-safe: bigints become decimal strings, `undefined` members are dropped. */
export function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item)),
  ) as unknown;
}

// --- transactions ---------------------------------------------------------------------------------

export interface TransactionFacts {
  readonly scheme: string;
  readonly asset: string;
  readonly decimals: number;
  readonly amount: bigint | string;
  readonly payerType: "G" | "C";
  readonly network?: Network;
  /** Keep the envelope and result XDR, so the file stands alone after the RPC's retention window. */
  readonly withXdr?: boolean;
}

/** A successful settlement transaction as evidence, read back from the chain. */
export async function settledTransaction(
  net: LocalNetwork,
  hash: string,
  facts: TransactionFacts,
): Promise<EvidenceTransaction> {
  const onChain = await onChainSettlement(net.server, net.passphrase, hash);
  let xdr: { envelopeXdr: string; resultXdr: string } | undefined;
  if (facts.withXdr === true) {
    const response = await net.server.getTransaction(hash);
    if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS)
      throw new Error(`${hash} is not successful`);
    xdr = {
      envelopeXdr: response.envelopeXdr.toXDR("base64"),
      resultXdr: response.resultXdr.toXDR("base64"),
    };
  }
  return {
    hash,
    ledger: onChain.ledger,
    scheme: facts.scheme,
    asset: facts.asset,
    decimals: facts.decimals,
    amount: facts.amount.toString(),
    payerType: facts.payerType,
    feeChargedStroops: onChain.feeChargedStroops.toString(),
    feeSource: onChain.feeSource,
    innerSource: onChain.innerSource,
    innerSequence: onChain.innerSequence,
    transfers: onChain.transfers.map((transfer) => ({
      from: transfer.from,
      to: transfer.to,
      amount: transfer.amount.toString(),
    })),
    explorer: explorerUrl(hash, facts.network),
    ...(xdr ?? {}),
  };
}

/** The inner transaction of a (fee-bump) envelope. */
export function innerTransaction(envelopeXdr: string, passphrase: string): Transaction {
  const envelope = TransactionBuilder.fromXDR(envelopeXdr, passphrase);
  return envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
}

// --- documents ------------------------------------------------------------------------------------

export interface EvidenceContext {
  readonly kind: EvidenceKind;
  readonly provenance: Provenance;
  readonly network: Network;
  readonly target: Target;
  readonly packages: Record<string, string>;
  readonly command: string;
  readonly config: Record<string, string | number | boolean>;
  readonly accounts: Record<string, string>;
  readonly upstream?: Evidence["upstream"];
  readonly startedAt: string;
  readonly finishedAt?: string;
}

/** A schemaVersion 2 evidence document; `writeEvidence` enforces the writer rules. */
export function buildEvidence(context: EvidenceContext, cases: readonly EvidenceCase[]): Evidence {
  const count = (status: EvidenceCase["status"]) => cases.filter((entry) => entry.status === status).length;
  return {
    schemaVersion: 2,
    kind: context.kind,
    runId: randomUUID(),
    startedAt: context.startedAt,
    finishedAt: context.finishedAt ?? new Date().toISOString(),
    network: context.network,
    target: context.target,
    harness: {
      commit: context.provenance.commit,
      dirty: false,
      ...(context.provenance.branch === undefined ? {} : { branch: context.provenance.branch }),
    },
    ...(context.upstream === undefined ? {} : { upstream: context.upstream }),
    packages: context.packages,
    command: context.command,
    config: context.config,
    accounts: context.accounts,
    summary: {
      total: cases.length,
      passed: count("passed"),
      failed: count("failed"),
      skipped: count("skipped"),
    },
    cases: [...cases],
  };
}
