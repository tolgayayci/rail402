/**
 * The sections of the conformance page that read across runs or render one kind of run in its own
 * shape: the tested release, the summary by check, `/supported`, the settlement matrix, expiration,
 * idempotency, concurrency, crash recovery, rejections, the upstream e2e runs and the MCP rows.
 * Like render-evidence.ts, output depends only on the evidence files.
 */
import type { CheckId, Evidence, EvidenceCase, EvidenceKind, EvidenceTransaction } from "./evidence.ts";
import { CHECK_IDS, EVIDENCE_DIR, EVIDENCE_KINDS } from "./evidence.ts";
import type { EvidenceSet, LoadedEvidence } from "./evidence-set.ts";
import { HOSTED_BAZAAR_NOT_APPLICABLE } from "./upstream-e2e-output.ts";
import {
  code,
  commitLink,
  day,
  escape,
  integer,
  packageList,
  prose,
  renderCurrent,
  reportedVersion,
  runHeader,
  table,
  txLink,
  units,
} from "./render-evidence.ts";

/** A current-format run with its file name. */
export interface Run {
  readonly file: string;
  readonly evidence: Evidence;
}

/** Every current-format run, in file-name order. */
export function currentRuns(set: EvidenceSet, kinds?: readonly EvidenceKind[]): Run[] {
  return set.files
    .filter((file): file is Extract<LoadedEvidence, { format: "current" }> => file.format === "current")
    .filter((file) => kinds === undefined || kinds.includes(file.kind))
    .map((file) => ({ file: file.file, evidence: file.evidence }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** The run in `file`, if it is recorded in the current format. */
export function runOf(set: EvidenceSet, file: string): Run | undefined {
  return currentRuns(set).find((run) => run.file === file);
}

/**
 * The runs this page reports: everything but the operational exercises, which run on a private network
 * and are reported on their own page.
 */
const CONFORMANCE_KINDS = EVIDENCE_KINDS.filter((kind) => kind !== "ops");
/** The runs the summary counts: a benchmark measures, and also measures other facilitators. */
const SUMMARY_KINDS = CONFORMANCE_KINDS.filter((kind) => kind !== "benchmark");

const pathOf = (file: string) => `${EVIDENCE_DIR}/${file}`;
const none = (file: string) => `No run has been recorded yet (${code(pathOf(file))}).`;

// --- 1. tested release --------------------------------------------------------------------------

export function renderRelease(set: EvidenceSet): string {
  const runs = currentRuns(set, CONFORMANCE_KINDS);
  if (runs.length === 0) {
    return "No run in the current evidence format has been recorded yet; the sections below show the older runs.";
  }
  const commits = [...new Set(runs.map((run) => run.evidence.harness.commit))];
  const packages: Record<string, string> = {};
  for (const run of runs) Object.assign(packages, run.evidence.packages);
  const targets = [
    ...new Set(
      runs.map(
        (run) =>
          `${code(run.evidence.target.facilitatorUrl)} (${run.evidence.target.mode}, ${reportedVersion(run.evidence)})`,
      ),
    ),
  ];
  const upstream = runs.flatMap((run) =>
    run.evidence.upstream === undefined
      ? []
      : [
          `${code(run.evidence.upstream.repository)} ${run.evidence.upstream.version} at ${code(run.evidence.upstream.ref)}${run.evidence.upstream.preMerge ? " (not yet merged upstream)" : ""}`,
        ],
  );
  const rows: string[][] = [
    ["Rail402 commit", commits.map(commitLink).join(", ")],
    ["Runs", runs.map((run) => `${code(run.file)} (${day(run.evidence.startedAt)})`).join(", ")],
    ["Facilitator", targets.join("; ")],
    ["Network", [...new Set(runs.map((run) => code(run.evidence.network)))].join(", ")],
    ["Packages", packageList(packages)],
    ...(upstream.length === 0 ? [] : [["Upstream", [...new Set(upstream)].join("; ")]]),
  ];
  return table(["Field", "Value"], rows);
}

// --- 2. summary by check ------------------------------------------------------------------------

/** Why a check no run records yet has no evidence, for the checks whose run depends on a third party. */
const UNRECORDED: Partial<Record<CheckId, string>> = {
  "agent-payments": "the live-agent run's explorer check needs stellar.expert's testnet API",
};

/**
 * Counts every check across the testnet runs. A check no testnet run carries (front-running and
 * observability need a network Rail402 can fault) is counted from the operational tests on the private
 * network instead, and labelled so.
 */
export function renderSummary(set: EvidenceSet): string {
  const casesOf = (kinds: readonly EvidenceKind[]) =>
    currentRuns(set, kinds).flatMap((run) => run.evidence.cases.map((entry) => ({ run, entry })));
  const cases = casesOf(SUMMARY_KINDS);
  const opsCases = casesOf(["ops"]);
  const legacy = set.files.filter((file) => file.format === "legacy").map((file) => code(file.file));
  const rows = CHECK_IDS.map((check) => {
    const onTestnet = cases.filter(({ entry }) => entry.checks.includes(check));
    const privateNetwork = onTestnet.length === 0;
    const matching = privateNetwork
      ? opsCases.filter(({ entry }) => entry.checks.includes(check))
      : onTestnet;
    const count = (status: EvidenceCase["status"]) =>
      matching.filter(({ entry }) => entry.status === status).length;
    const reasons = [
      ...new Set(matching.flatMap(({ entry }) => (entry.skipReason === undefined ? [] : [entry.skipReason]))),
    ];
    const runs = [...new Set(matching.map(({ run }) => code(run.file)))];
    return [
      code(check),
      String(count("passed")),
      count("failed") === 0 ? "0" : `**${String(count("failed"))}**`,
      String(count("skipped")),
      matching.length === 0
        ? "not recorded yet"
        : privateNetwork
          ? `${runs.join(", ")} ([operational tests](/security/operational-tests), private network)`
          : runs.join(", "),
      matching.length === 0 ? escape(UNRECORDED[check] ?? "") : reasons.map(escape).join("; "),
    ];
  });
  return [
    table(["Check", "Passed", "Failed", "Skipped", "Recorded in", "Why skipped"], rows),
    ...(legacy.length === 0
      ? []
      : [
          `Runs recorded in the older format (${legacy.join(", ")}) name no check ids and are not counted here; their sections below show them.`,
        ]),
  ].join("\n\n");
}

// --- 3. canonical ---------------------------------------------------------------------------------

function observation(entry: EvidenceCase, key: string): unknown {
  return entry.observations?.[key];
}

function amountOf(tx: EvidenceTransaction, symbol: string | undefined): string {
  return `${units(tx.amount, tx.decimals)}${symbol === undefined ? "" : ` ${symbol}`}`;
}

export function renderCanonical(file: string, evidence: Evidence): string {
  const payments = evidence.cases.filter(
    (entry) => entry.transactions !== undefined || entry.scheme !== undefined,
  );
  const rows = payments
    .filter((entry) => entry.id !== "supported-upto")
    .map((entry) => {
      const tx = entry.transactions?.[0];
      const wire = observation(entry, "wire") as { payloadKeys?: string[]; cap?: string } | undefined;
      return [
        code(entry.id),
        escape(entry.scheme ?? ""),
        escape(entry.asset ?? ""),
        entry.payer === undefined ? "" : code(`${entry.payer}…`),
        escape((observation(entry, "client") as string | undefined) ?? ""),
        wire?.payloadKeys === undefined ? "" : code(`{ ${wire.payloadKeys.join(", ")} }`),
        tx === undefined
          ? entry.status === "skipped"
            ? `skipped: ${escape(entry.skipReason ?? "")}`
            : entry.status
          : `${txLink(tx.hash, tx.explorer)} ${amountOf(tx, entry.asset)}${wire?.cap === undefined ? "" : ` of a ${units(wire.cap, tx.decimals)} cap`}, fee ${integer(tx.feeChargedStroops)} stroops`,
        entry.status === "failed" ? "**failed**" : entry.status,
      ];
    });
  return [
    runHeader(pathOf(file), evidence),
    table(["Case", "Scheme", "Asset", "Payer", "Client", "Payload", "Settlement", "Result"], rows),
  ].join("\n\n");
}

// --- 4. /supported ------------------------------------------------------------------------------

/**
 * `/supported` as the hosted service answered it during the canonical run against it; the local run's
 * answer only when no hosted run is recorded, and said so.
 */
export function renderSupported(set: EvidenceSet): string {
  const hosted = runOf(set, "canonical-hosted-stellar-testnet.json");
  const run = hosted ?? runOf(set, "canonical-stellar-testnet.json");
  if (run === undefined) return none("canonical-hosted-stellar-testnet.json");
  const reference = run.evidence.cases.find((entry) => entry.id === "supported")?.observations?.[
    "reference"
  ] as { url?: string; available?: boolean; sameShape?: boolean } | undefined;
  const comparison =
    reference?.available === true
      ? `Compared with ${code(reference.url ?? "")}: the Stellar \`exact\` kind has ${reference.sameShape === true ? "the same shape" : "**a different shape**"}.`
      : "The reference facilitator could not be read during the run, so no comparison is recorded.";
  const { target } = run.evidence;
  const version = `, version ${code(target.healthVersion)}`;
  const answered =
    hosted === undefined
      ? `No run against a hosted service is recorded. \`GET /supported\` as the local ${code(target.facilitatorUrl)}${version} answered it during the canonical run (${day(run.evidence.startedAt)}):`
      : `\`GET /supported\` as the hosted ${code(target.facilitatorUrl)}${version} answered it during the canonical run against it (${code(run.file)}, ${day(run.evidence.startedAt)}):`;
  return [
    answered,
    ["```json", JSON.stringify(target.supported, null, 2), "```"].join("\n"),
    comparison,
  ].join("\n\n");
}

// --- 5. settlement matrix -----------------------------------------------------------------------

export function renderSettlements(set: EvidenceSet): string {
  const rows: string[][] = [];
  for (const run of currentRuns(set, ["canonical", "live-matrix"])) {
    for (const entry of run.evidence.cases) {
      for (const tx of entry.transactions ?? []) {
        rows.push([
          code(tx.scheme),
          escape(entry.asset ?? tx.asset),
          code(`${tx.payerType}…`),
          entry.payTo === undefined ? "" : code(`${entry.payTo}…`),
          amountOf(tx, entry.asset),
          integer(tx.feeChargedStroops),
          String(tx.ledger),
          txLink(tx.hash, tx.explorer),
          `${code(run.file)} ${code(entry.id)}`,
        ]);
      }
    }
  }
  if (rows.length === 0) return none("canonical-stellar-testnet.json");
  return table(
    ["Scheme", "Asset", "Payer", "payTo", "Amount", "Fee (stroops)", "Ledger", "Transaction", "Case"],
    rows,
  );
}

// --- cases by check -----------------------------------------------------------------------------

function observationList(entry: EvidenceCase, keys: readonly string[]): string {
  return keys
    .filter((key) => entry.observations?.[key] !== undefined)
    .map((key) => `${key} ${code(String(entry.observations?.[key] as string | number))}`)
    .join(", ");
}

function caseCell(entry: EvidenceCase): string {
  if (entry.status === "skipped") return `skipped: ${escape(entry.skipReason ?? "")}`;
  const parts = [
    ...(entry.transactions ?? []).map((tx) => `tx ${txLink(tx.hash, tx.explorer)}`),
    ...[...new Set((entry.rejections ?? []).map((rejection) => code(rejection.code)))],
  ];
  const detail = parts.length === 0 ? entry.status : parts.join("; ");
  return entry.status === "failed" ? `**failed**: ${detail}` : detail;
}

/** Every case carrying `check`, from the current-format runs of the given kinds. */
export function renderCasesFor(
  set: EvidenceSet,
  check: CheckId,
  kinds: readonly EvidenceKind[],
  details: readonly string[] = [],
): string {
  const rows = currentRuns(set, kinds).flatMap((run) =>
    run.evidence.cases
      .filter((entry) => entry.checks.includes(check))
      .map((entry) => [
        `${code(run.file)} ${code(entry.id)}`,
        prose(entry.title),
        caseCell(entry),
        ...(details.length === 0 ? [] : [observationList(entry, details)]),
      ]),
  );
  if (rows.length === 0) return `No run has recorded a ${code(check)} case yet.`;
  return table(["Case", "What it proves", "Result", ...(details.length === 0 ? [] : ["Observed"])], rows);
}

// --- 7. concurrency -----------------------------------------------------------------------------

export function renderConcurrency(file: string, evidence: Evidence): string {
  const batches = evidence.cases.filter((entry) => entry.id.startsWith("batch-"));
  const sequences = evidence.cases.find((entry) => entry.id === "distinct-sequences");
  const rows = batches.map((entry) => {
    const seen = (key: string) => String((entry.observations?.[key] as number | string | undefined) ?? "");
    return [
      code(entry.id),
      escape(seen("scheme") || (entry.scheme ?? "")),
      seen("replicas"),
      `${seen("size")} + ${seen("duplicates")} duplicates`,
      `${(Number(seen("wallMs")) / 1000).toFixed(1)} s`,
      seen("leaseWaitP95Seconds") === "" ? "" : `≤ ${seen("leaseWaitP95Seconds")} s`,
      seen("maxChannelsInUse"),
      seen("sequenceConflicts"),
      entry.status === "failed" ? "**failed**" : entry.status,
    ];
  });
  const collisions = (sequences?.observations?.["collisions"] as unknown[] | undefined)?.length ?? 0;
  return [
    runHeader(pathOf(file), evidence),
    table(
      [
        "Batch",
        "Scheme",
        "Replicas",
        "Payments",
        "Wall time",
        "Lease wait p95",
        "Max channels in use",
        "Sequence conflicts",
        "Result",
      ],
      rows,
    ),
    sequences === undefined
      ? ""
      : `Across the run, ${integer(Number(sequences.observations?.["transactions"] ?? 0))} settlement transactions used distinct (channel, sequence) pairs; collisions: ${String(collisions)}.`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

// --- 9. crash recovery --------------------------------------------------------------------------

export function renderFaultRecovery(file: string, evidence: Evidence): string {
  const rows = evidence.cases.map((entry) => {
    const text = (key: string) => entry.observations?.[key] as string | undefined;
    const envelopes = (entry.observations?.["distinctEnvelopes"] as string[] | undefined) ?? [];
    const sends = entry.observations?.["sendsAfterRestart"];
    const tx = entry.transactions?.[0];
    return [
      code(entry.id),
      prose(entry.title),
      escape(
        `${text("killedAt")?.slice(11, 19) ?? ""} → ${text("restartedAt")?.slice(11, 19) ?? ""} → ${text("recoveredAt")?.slice(11, 19) ?? ""}`,
      ),
      code(text("state") ?? entry.status),
      typeof sends === "number" ? String(sends) : "–",
      String(envelopes.length),
      tx === undefined ? code(`${(text("transaction") ?? "").slice(0, 8)}…`) : txLink(tx.hash, tx.explorer),
      entry.status === "failed" ? `**failed**: ${escape(text("error") ?? "")}` : entry.status,
    ];
  });
  return [
    runHeader(pathOf(file), evidence),
    table(
      [
        "Case",
        "What it proves",
        "Killed → restarted → recovered (UTC)",
        "Final state",
        "Sends after restart",
        "Distinct envelopes",
        "Transaction",
        "Result",
      ],
      rows,
    ),
  ].join("\n\n");
}

// --- 11. rejections -----------------------------------------------------------------------------

export function renderRejections(file: string, evidence: Evidence): string {
  const rejections = evidence.cases.flatMap((entry) => entry.rejections ?? []);
  const surfaces = [...new Set(rejections.map((rejection) => rejection.surface))].sort();
  const rows = surfaces.map((surface) => {
    const own = rejections.filter((rejection) => rejection.surface === surface);
    const cases = evidence.cases.filter((entry) =>
      (entry.rejections ?? []).some((rejection) => rejection.surface === surface),
    );
    return [
      code(surface),
      String(cases.length),
      String(own.length),
      String(new Set(own.map((rejection) => rejection.code)).size),
    ];
  });
  return [
    runHeader(pathOf(file), evidence),
    table(["Surface", "Cases", "Refusals checked", "Distinct codes"], rows),
    table(
      ["Case", "What it proves", "Result"],
      evidence.cases.map((entry) => [code(entry.id), prose(entry.title), caseCell(entry)]),
    ),
    "Every code and its reason are listed on the [error codes](/reference/error-codes) page.",
  ].join("\n\n");
}

// --- 12. upstream e2e ---------------------------------------------------------------------------

const UPSTREAM_FILES = [
  "upstream-e2e-stellar-testnet.json",
  "upstream-e2e-hosted-stellar-testnet.json",
  "upstream-e2e-upto-stellar-testnet.json",
  "upstream-e2e-upto-hosted-stellar-testnet.json",
  "upstream-e2e-upto-premerge-stellar-testnet.json",
  "upstream-e2e-upto-premerge-hosted-stellar-testnet.json",
];

/** The suite's Bazaar discovery validation for one run: its result, or why it did not run. */
function bazaarValidation(run: Run): string {
  const entry = run.evidence.cases.find((candidate) => candidate.id === "bazaar-discovery-validation");
  if (entry === undefined) return "not recorded";
  if (entry.status === "skipped") {
    // Runs recorded before the reason was spelled out name only the refusal; the rationale is the same.
    return run.evidence.target.mode === "hosted"
      ? escape(HOSTED_BAZAAR_NOT_APPLICABLE)
      : `skipped: ${escape(entry.skipReason ?? "")}`;
  }
  const discovered = observation(entry, "discovered");
  return `${entry.status === "passed" ? "passed" : "**failed**"}${typeof discovered === "string" ? ` (${escape(discovered)})` : ""}`;
}

export function renderUpstreamRuns(set: EvidenceSet): string {
  const runs = UPSTREAM_FILES.flatMap((file) => {
    const run = runOf(set, file);
    return run === undefined ? [] : [run];
  });
  if (runs.length === 0) return "No run in the current evidence format has been recorded yet.";
  const rows = runs.flatMap((run) => {
    const suite = run.evidence.cases.filter(
      (entry) =>
        entry.checks.includes("upstream-e2e") &&
        entry.status !== "skipped" &&
        entry.id !== "bazaar-discovery-validation",
    );
    const schemes = [...new Set(suite.map((entry) => entry.scheme ?? "exact"))];
    const upstream = run.evidence.upstream;
    return schemes.map((scheme) => {
      const own = suite.filter((entry) => (entry.scheme ?? "exact") === scheme);
      return [
        code(run.file),
        run.evidence.target.mode,
        code(scheme),
        upstream === undefined ? "" : `${code(upstream.ref)}${upstream.preMerge ? " (pre-merge)" : ""}`,
        `${String(own.filter((entry) => entry.status === "passed").length)} / ${String(own.length)}`,
        bazaarValidation(run),
      ];
    });
  });
  // The suite against the deployed service is its own run; say so while it is missing.
  if (!runs.some((run) => run.evidence.target.mode === "hosted")) {
    rows.push(["the deployed service", "hosted", "", "", "not recorded yet", ""]);
  }
  const skipped = [
    ...new Map(
      runs.flatMap((run) =>
        run.evidence.cases
          .filter((entry) => entry.status === "skipped" && entry.id !== "bazaar-discovery-validation")
          .map((entry) => [entry.id, `${prose(entry.title)}: ${escape(entry.skipReason ?? "")}`] as const),
      ),
    ).values(),
  ];
  return [
    table(["Run", "Mode", "Scheme", "Upstream", "Passed", "Bazaar validation"], rows),
    ...(skipped.length === 0
      ? []
      : ["Recorded as not applicable or skipped:", skipped.map((line) => `- ${line}`).join("\n")]),
  ].join("\n\n");
}

// --- 14. MCP ------------------------------------------------------------------------------------

export function renderMcp(set: EvidenceSet): string {
  const audit = runOf(set, "rejection-audit-stellar-testnet.json");
  const rows = (audit?.evidence.cases ?? [])
    .filter((entry) => entry.checks.includes("mcp"))
    .map((entry) => [code(entry.id), prose(entry.title.replace(/^MCP: /, "")), caseCell(entry)]);
  // The upstream suite's stock MCP client and server, paying through Rail402.
  const suite = UPSTREAM_FILES.flatMap((file) => {
    const run = runOf(set, file);
    return (run?.evidence.cases ?? [])
      .filter((entry) => entry.checks.includes("mcp") && entry.checks.includes("upstream-e2e"))
      .map((entry) => [code(file), escape(entry.title), caseCell(entry)]);
  });
  const agent = currentRuns(set, ["live-agent"]);
  const parts: string[] = [];
  if (rows.length === 0 && suite.length === 0 && agent.length === 0) {
    return "No MCP run has been recorded yet (`rejection-audit.ts --mcp`, the upstream e2e suite or a live agent run).";
  }
  if (rows.length > 0) {
    parts.push(
      `Tool refusals from ${code(pathOf("rejection-audit-stellar-testnet.json"))}, each an \`isError\` result with a coded \`structuredContent.error\` and \`paid: "none"\`:`,
      table(["Case", "What it proves", "Result"], rows),
    );
  }
  if (suite.length > 0) {
    parts.push(
      "Paid tool calls by the upstream e2e suite's MCP client and server, settled through Rail402:",
      table(["Run", "Call", "Result"], suite),
    );
  }
  for (const run of agent) {
    parts.push(
      run.evidence.target.mode === "local"
        ? "A local rehearsal: Rail402, its Bazaar and the demo seller ran on the machine that recorded it, so its listings existed only for the run; its transactions are on the public testnet. The explorer proof is stellar.expert's API."
        : `A hosted run against ${code(run.evidence.target.facilitatorUrl)}: its listings and their versions stay in that Bazaar. The explorer proof is stellar.expert's API.`,
      renderCurrent(pathOf(run.file), run.evidence),
    );
  }
  return parts.join("\n\n");
}

// --- 15. Playground -----------------------------------------------------------------------------

/** The Playground runs: with local services, then against a deployed Rail402 or Playground. */
export const PLAYGROUND_FILES = [
  "live-playground-local-stellar-testnet.json",
  "live-playground-stellar-testnet.json",
] as const;

export function renderPlayground(set: EvidenceSet): string {
  const runs = PLAYGROUND_FILES.flatMap((file) => {
    const run = runOf(set, file);
    return run === undefined ? [] : [run];
  });
  if (runs.length === 0) return none(PLAYGROUND_FILES[0]);
  return runs
    .map((run) =>
      [
        run.evidence.target.mode === "local"
          ? "A local rehearsal: Rail402, its Bazaar, the demo seller and the Playground server ran on the machine that recorded it; its transactions are on the public testnet. The explorer proof is stellar.expert's API."
          : `A run against ${code(run.evidence.target.facilitatorUrl)}: its transactions and the listings it read stay on the public testnet and in that Bazaar. The explorer proof is stellar.expert's API.`,
        renderCurrent(pathOf(run.file), run.evidence),
      ].join("\n\n"),
    )
    .join("\n\n");
}
