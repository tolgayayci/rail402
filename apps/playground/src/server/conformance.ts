import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_ERROR_CODES, ERROR_REGISTRY } from "@rail402.dev/errors";

/**
 * The conformance panel: the acceptance criteria as data, so the frontend can render
 * "the reviewer's console" — every graded criterion with its status and the evidence behind it.
 *
 * Honesty is the design constraint. Nothing here asserts a criterion beyond what its evidence
 * shows:
 *   - `supported-extra` is computed LIVE against the facilitator's `/supported` on every call —
 *     the response is included verbatim, and the criterion is judged from that same body.
 *   - `e2e-suite`, `settled-hash-per-scheme`, and the audited half of `reason-on-every-rejection`
 *     are resolved from the repo's measured status artifacts (`docs/status/*.json`, shipped with
 *     the image) — the same files the conformance evidence is generated from, with the same verdict
 *     vocabulary. The upstream e2e suite currently passes 2 of 4 scenarios; that renders as
 *     `failing`, because it is.
 *   - A missing or unparsable artifact yields status `unknown` with a note — never a silent "met".
 */

/** Where the status artifacts live: `<repo root>/docs/status`, resolved relative to this module
 * (four levels up from both `src/server/` and `dist/server/`, and from `/app/apps/playground` in
 * the Docker image, whose build copies `docs/status` in). */
export const DEFAULT_STATUS_DIR = fileURLToPath(
  new URL("../../../../docs/status", import.meta.url),
);

export type AcceptanceStatus = "met" | "failing" | "blocked" | "unknown";

export interface AcceptanceEntry {
  /** Stable string id the frontend keys panels on. */
  readonly id:
    | "stock-client"
    | "supported-extra"
    | "payload-verbatim"
    | "e2e-suite"
    | "settled-hash-per-scheme"
    | "reason-on-every-rejection";
  /** Acceptance criterion number (1–6). */
  readonly rfpCriterion: number;
  readonly criterion: string;
  readonly status: AcceptanceStatus;
  /** Where a reviewer can press this criterion themselves, in the playground. */
  readonly how: string;
  /** What was observed — structured, from the source that measured it. Never invented. */
  readonly evidence: Record<string, unknown>;
}

export interface SettledHash {
  readonly transaction: string;
  readonly note?: string;
}

export interface StatusEvidence {
  readonly acceptance: {
    readonly criteria: readonly {
      readonly id: number;
      readonly status: string;
      readonly evidence?: string;
      readonly transaction?: string;
    }[];
    readonly settlements: readonly { readonly scheme: string; readonly transaction: string; readonly note?: string }[];
  } | null;
  readonly dual: {
    readonly generatedAt?: string;
    readonly verdict?: string;
    readonly note?: string;
    readonly pinned?: { readonly sha?: string; readonly scenarios?: { readonly passed?: number; readonly failed?: number } };
  } | null;
  readonly rejectionAudit: {
    readonly status?: string;
    readonly observedAt?: string;
    readonly observations?: {
      readonly casesPassed?: number;
      readonly casesTotal?: number;
      readonly referenceTransaction?: string;
    };
  } | null;
}

/**
 * Read the three status artifacts. Defensive on purpose: a missing or malformed file becomes
 * `null` (rendered as `unknown` downstream), because the panel refusing to load would hide the
 * criteria that DO have evidence.
 */
export function loadStatusEvidence(statusDir: string): StatusEvidence {
  const read = (name: string): unknown => {
    try {
      return JSON.parse(readFileSync(join(statusDir, name), "utf8")) as unknown;
    } catch {
      return null;
    }
  };
  const acceptanceRaw = read("acceptance.json") as {
    criteria?: unknown;
    settlements?: unknown;
  } | null;
  const acceptance =
    acceptanceRaw && Array.isArray(acceptanceRaw.criteria) && Array.isArray(acceptanceRaw.settlements)
      ? (acceptanceRaw as NonNullable<StatusEvidence["acceptance"]>)
      : null;
  return {
    acceptance,
    dual: read("conformance-dual.json") as StatusEvidence["dual"],
    rejectionAudit: read("rejection-audit.json") as StatusEvidence["rejectionAudit"],
  };
}

/** Registry-wide stats: the numeric half of "a non-null reason on every rejection". */
export function errorRegistryStats(): {
  total: number;
  retryable: number;
  surfaces: Record<string, number>;
} {
  let retryable = 0;
  const surfaces: Record<string, number> = {};
  for (const code of ALL_ERROR_CODES) {
    const def = ERROR_REGISTRY[code];
    if (def.retryable) retryable += 1;
    surfaces[def.surface] = (surfaces[def.surface] ?? 0) + 1;
  }
  return { total: ALL_ERROR_CODES.length, retryable, surfaces };
}

/**
 * The full registry as a browsable artifact — the break-it bench's reference as data. One entry
 * per code, every `reason` non-empty by construction (it is non-optional at the type level).
 */
export function listErrorRegistry(): readonly {
  code: string;
  reason: string;
  retryable: boolean;
  surface: string;
  provenance: string;
}[] {
  return ALL_ERROR_CODES.map(code => {
    const def = ERROR_REGISTRY[code];
    return {
      code,
      reason: def.reason,
      retryable: def.retryable,
      surface: def.surface,
      provenance: def.provenance,
    };
  });
}

/**
 * Judge `supported-extra` from the live `/supported` body itself. Met only when at least one
 * Stellar kind is advertised and every Stellar kind carries `extra.areFeesSponsored === true` —
 * the flag stock clients hard-require before paying.
 */
export function assessSupported(supported: unknown): {
  status: AcceptanceStatus;
  evidence: Record<string, unknown>;
} {
  const kinds = (supported as { kinds?: unknown } | null)?.kinds;
  if (!Array.isArray(kinds)) {
    return {
      status: "failing",
      evidence: { stellarKinds: 0, note: "the facilitator's /supported has no kinds array" },
    };
  }
  const stellar = kinds.filter(
    (k): k is { network: string; scheme?: unknown; extra?: { areFeesSponsored?: unknown } } =>
      typeof (k as { network?: unknown } | null)?.network === "string" &&
      (k as { network: string }).network.startsWith("stellar:"),
  );
  const sponsoredOnAll =
    stellar.length > 0 && stellar.every(k => k.extra?.areFeesSponsored === true);
  return {
    status: sponsoredOnAll ? "met" : "failing",
    evidence: {
      stellarKinds: stellar.length,
      schemes: stellar.map(k => k.scheme).filter((s): s is string => typeof s === "string"),
      areFeesSponsoredOnAllStellarKinds: sponsoredOnAll,
    },
  };
}

/** Same verdict vocabulary as scripts/generate-conformance.mjs — the two must not diverge. */
const DUAL_TO_CRITERION: Record<string, { status: AcceptanceStatus; note: string }> = {
  green: { status: "met", note: "passes at the pinned spec SHA and at latest main" },
  drift: {
    status: "met",
    note: "passes at the pinned spec SHA; latest main fails — the spec moved",
  },
  regression: {
    status: "failing",
    note: "does not pass at the pinned spec SHA; see packages/conformance/README.md for the diagnosis",
  },
  blocked: { status: "blocked", note: "not run: no funded testnet accounts configured" },
};

/** Group the curated settlements by scheme, dropping malformed rows rather than inventing them. */
export function groupSettlements(
  evidence: StatusEvidence,
): Record<string, readonly SettledHash[]> {
  const out: Record<string, SettledHash[]> = {};
  for (const s of evidence.acceptance?.settlements ?? []) {
    if (typeof s?.scheme !== "string" || typeof s?.transaction !== "string") continue;
    (out[s.scheme] ??= []).push({
      transaction: s.transaction,
      ...(typeof s.note === "string" ? { note: s.note } : {}),
    });
  }
  return out;
}

export interface ConformanceReport {
  readonly network: string;
  readonly facilitatorUrl: string;
  readonly checkedAt: string;
  /** The facilitator's live /supported response, verbatim. */
  readonly supported: unknown;
  readonly acceptance: readonly AcceptanceEntry[];
  readonly settledHashes: Record<string, readonly SettledHash[]>;
  readonly errorRegistry: { total: number; retryable: number; surfaces: Record<string, number> };
  /** Provenance of everything above: which artifact said it, and when. */
  readonly sources: Record<string, Record<string, unknown>>;
}

export function buildConformanceReport(input: {
  network: string;
  facilitatorUrl: string;
  supported: unknown;
  evidence: StatusEvidence;
  checkedAt: string;
}): ConformanceReport {
  const { network, facilitatorUrl, supported, evidence, checkedAt } = input;
  const registry = errorRegistryStats();
  const settledHashes = groupSettlements(evidence);
  const curated = (id: number) => evidence.acceptance?.criteria.find(c => c?.id === id);

  const entries: AcceptanceEntry[] = [];

  // 1 — unmodified canonical client. Curated evidence: the stock-client settlement.
  const c1 = curated(1);
  entries.push({
    id: "stock-client",
    rfpCriterion: 1,
    criterion: "An unmodified canonical client completes a payment end to end",
    status: c1?.status === "met" ? "met" : "unknown",
    how: "Pay /demo/convert in the first-payment scene: the browser buyer is the stock @x402/fetch client and the seller is the stock @x402/hono middleware. Every settlement is a fresh proof.",
    evidence: c1
      ? {
          note: c1.evidence,
          ...(typeof c1.transaction === "string" ? { transaction: c1.transaction } : {}),
        }
      : { note: "no curated acceptance evidence shipped with this deployment" },
  });

  // 2 — /supported emits areFeesSponsored. Judged from the live body included in this response.
  const supportedAssessment = assessSupported(supported);
  entries.push({
    id: "supported-extra",
    rfpCriterion: 2,
    criterion: "`/supported` emits the Stellar `extra` contract including `areFeesSponsored`",
    status: supportedAssessment.status,
    how: "Checked live against this deployment's facilitator on every call to this endpoint; the `supported` block in this response is that reply, verbatim.",
    evidence: supportedAssessment.evidence,
  });

  // 3 — payload accepted verbatim.
  const c3 = curated(3);
  entries.push({
    id: "payload-verbatim",
    rfpCriterion: 3,
    criterion: "The spec `payload: {transaction}` format is accepted verbatim",
    status: c3?.status === "met" ? "met" : "unknown",
    how: "The break-it bench (/attack/verify, /attack/settle) forwards the browser's signed payload to the facilitator byte-for-byte; corrupt any field and the refusal is the facilitator's own, with a coded reason.",
    evidence: c3
      ? { note: c3.evidence }
      : { note: "no curated acceptance evidence shipped with this deployment" },
  });

  // 4 — the upstream e2e suite. Resolved from the run that measured it, or unknown.
  const dualVerdict = evidence.dual?.verdict;
  const mapped = (dualVerdict && DUAL_TO_CRITERION[dualVerdict]) || {
    status: "unknown" as const,
    note: "no dual conformance run is recorded in this deployment",
  };
  entries.push({
    id: "e2e-suite",
    rfpCriterion: 4,
    criterion: "A passing run of the x402 repo's e2e suite",
    status: mapped.status,
    how: "Measured by packages/conformance running the UNMODIFIED upstream suite against this facilitator; recorded in docs/status/conformance-dual.json. Not assertable by hand.",
    evidence: {
      note: mapped.note,
      ...(evidence.dual
        ? {
            verdict: evidence.dual.verdict,
            ...(evidence.dual.pinned?.scenarios ? { scenarios: evidence.dual.pinned.scenarios } : {}),
            ...(evidence.dual.pinned?.sha ? { pinnedSha: evidence.dual.pinned.sha } : {}),
            ...(evidence.dual.note ? { detail: evidence.dual.note } : {}),
          }
        : {}),
    },
  });

  // 5 — a settled hash per scheme. Judged from the hashes actually present, not the curated status.
  const schemesWithHashes = Object.keys(settledHashes).filter(
    s => (settledHashes[s]?.length ?? 0) > 0,
  );
  const bothSchemes = schemesWithHashes.includes("exact") && schemesWithHashes.includes("upto");
  entries.push({
    id: "settled-hash-per-scheme",
    rfpCriterion: 5,
    criterion: "A published settled transaction hash per scheme",
    status: evidence.acceptance ? (bothSchemes ? "met" : "failing") : "unknown",
    how: "The hashes are under settledHashes in this response, each a public stellar.expert receipt. Every playground scene mints new ones.",
    evidence: { schemes: schemesWithHashes },
  });

  // 6 — a non-null reason on every rejection. Registry stats are computed here and now (the
  // type-level guarantee, counted); the audited half comes from the live rejection audit.
  const audit = evidence.rejectionAudit;
  const auditEvidence = audit
    ? {
        status: audit.status,
        ...(audit.observations?.casesPassed !== undefined
          ? { casesPassed: audit.observations.casesPassed }
          : {}),
        ...(audit.observations?.casesTotal !== undefined
          ? { casesTotal: audit.observations.casesTotal }
          : {}),
        ...(audit.observedAt ? { observedAt: audit.observedAt } : {}),
      }
    : null;
  entries.push({
    id: "reason-on-every-rejection",
    rfpCriterion: 6,
    criterion: "A non-null reason on every rejection",
    status: audit ? (audit.status === "pass" ? "met" : "failing") : "unknown",
    how: "GET /conformance/errors is the full registry — every code with its reason. The break-it bench shows the coded refusals live; the audit drove every rejection path over HTTP.",
    evidence: {
      registry: { total: registry.total, allHaveReason: listErrorRegistry().every(e => e.reason.length > 0) },
      audit: auditEvidence ?? "no rejection audit recorded in this deployment",
    },
  });

  return {
    network,
    facilitatorUrl,
    checkedAt,
    supported,
    acceptance: entries,
    settledHashes,
    errorRegistry: registry,
    sources: {
      supported: { live: true, checkedAt },
      acceptance: { present: evidence.acceptance !== null, file: "docs/status/acceptance.json" },
      conformanceDual: {
        present: evidence.dual !== null,
        file: "docs/status/conformance-dual.json",
        ...(evidence.dual?.generatedAt ? { generatedAt: evidence.dual.generatedAt } : {}),
      },
      rejectionAudit: {
        present: evidence.rejectionAudit !== null,
        file: "docs/status/rejection-audit.json",
        ...(evidence.rejectionAudit?.observedAt
          ? { observedAt: evidence.rejectionAudit.observedAt }
          : {}),
      },
    },
  };
}
