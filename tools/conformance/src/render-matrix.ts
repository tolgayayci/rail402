/**
 * The final report's cross-run sections: the network × scheme matrix of settled transactions, what
 * the runs were tested against (the release, the upstream baseline of the watch list) and every
 * skipped case grouped by why it was skipped. Output depends only on the evidence files, the watch
 * list and the workspace version; the gates (`*Problems`) back `pnpm report --check --final`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWatchList, type WatchList } from "../../upstream-watch/src/watch-list.ts";
import type { CheckId, EvidenceKind } from "./evidence.ts";
import { REPO_ROOT, SKIP_CATEGORIES } from "./evidence.ts";
import type { EvidenceSet } from "./evidence-set.ts";
import { code, escape, table, txLink } from "./render-evidence.ts";
import { currentRuns, type Run } from "./render-report.ts";

export const MATRIX_NETWORKS = ["stellar:testnet", "stellar:pubnet"] as const;
export const MATRIX_SCHEMES = ["exact", "upto"] as const;
/** The runs whose settled cases back a matrix cell: an unmodified client paying through Rail402. */
const MATRIX_KINDS: readonly EvidenceKind[] = ["canonical", "live-matrix", "live-agent"];
/** Hashes shown per cell; the source files list the rest. */
const HASHES_PER_CELL = 3;

type MatrixNetwork = (typeof MATRIX_NETWORKS)[number];
type MatrixScheme = (typeof MATRIX_SCHEMES)[number];

interface Cell {
  readonly network: MatrixNetwork;
  readonly scheme: MatrixScheme;
  readonly transactions: { hash: string; explorer: string }[];
  readonly runs: Run[];
}

function cells(set: EvidenceSet): Cell[] {
  const runs = currentRuns(set, MATRIX_KINDS);
  return MATRIX_NETWORKS.flatMap((network) =>
    MATRIX_SCHEMES.map((scheme) => {
      const backing: Run[] = [];
      const transactions: { hash: string; explorer: string }[] = [];
      for (const run of runs.filter((entry) => entry.evidence.network === network)) {
        const settled = run.evidence.cases
          .filter((entry) => entry.status === "passed")
          .flatMap((entry) => entry.transactions ?? [])
          .filter((transaction) => transaction.scheme === scheme);
        if (settled.length === 0) continue;
        backing.push(run);
        for (const transaction of settled)
          transactions.push({ hash: transaction.hash, explorer: transaction.explorer });
      }
      return { network, scheme, transactions, runs: backing };
    }),
  );
}

const localOnly = (cell: Cell) =>
  cell.runs.length > 0 && cell.runs.every((run) => run.evidence.target.mode === "local");

export function renderNetworkMatrix(set: EvidenceSet): string {
  const all = cells(set);
  const rows = MATRIX_NETWORKS.map((network) => [
    code(network),
    ...MATRIX_SCHEMES.map((scheme) => {
      const cell = all.find((entry) => entry.network === network && entry.scheme === scheme);
      if (cell === undefined || cell.transactions.length === 0) return "none recorded";
      const shown = cell.transactions
        .slice(0, HASHES_PER_CELL)
        .map((entry) => txLink(entry.hash, entry.explorer));
      const more = cell.transactions.length - shown.length;
      return (
        `${shown.join(", ")}${more > 0 ? ` and ${String(more)} more` : ""} in ` +
        `${cell.runs.map((run) => code(run.file)).join(", ")}${localOnly(cell) ? " (local runs only)" : ""}`
      );
    }),
  ]);
  return table(["Network", ...MATRIX_SCHEMES.map(code)], rows);
}

/**
 * Cells a final report cannot leave as they are, for the networks it must cover: no settled
 * transaction, or only runs against a local service.
 */
export function matrixProblems(set: EvidenceSet, networks: readonly string[]): string[] {
  const problems: string[] = [];
  for (const cell of cells(set).filter((entry) => networks.includes(entry.network))) {
    const name = `${cell.network} × ${cell.scheme}`;
    if (cell.transactions.length === 0) problems.push(`${name}: no settled transaction is recorded`);
    else if (localOnly(cell)) problems.push(`${name}: only runs against a local service back it`);
  }
  return problems;
}

/**
 * What a final report needs beyond settled schemes on every network it covers, and the runs that can
 * back it: Bazaar cataloging and search (the live Bazaar and agent runs), and MCP responses (those runs
 * and the refusal audit's MCP cases).
 */
export const MATRIX_CHECKS: readonly { check: CheckId; title: string; kinds: readonly EvidenceKind[] }[] = [
  { check: "discovery", title: "Bazaar cataloging and search", kinds: ["live-bazaar", "live-agent"] },
  { check: "mcp", title: "MCP responses", kinds: ["live-bazaar", "live-agent", "rejection-audit"] },
];

interface CheckCell {
  readonly network: MatrixNetwork;
  readonly check: CheckId;
  readonly title: string;
  readonly passed: number;
  readonly runs: Run[];
}

function checkCells(set: EvidenceSet): CheckCell[] {
  return MATRIX_NETWORKS.flatMap((network) =>
    MATRIX_CHECKS.map(({ check, title, kinds }) => {
      const runs: Run[] = [];
      let passed = 0;
      for (const run of currentRuns(set, kinds).filter((entry) => entry.evidence.network === network)) {
        const count = run.evidence.cases.filter(
          (entry) => entry.status === "passed" && entry.checks.includes(check),
        ).length;
        if (count === 0) continue;
        runs.push(run);
        passed += count;
      }
      return { network, check, title, passed, runs };
    }),
  );
}

const checkLocalOnly = (cell: CheckCell) =>
  cell.runs.length > 0 && cell.runs.every((run) => run.evidence.target.mode === "local");

/** Bazaar cataloging and MCP per network: how many cases passed, in which runs. */
export function renderCheckMatrix(set: EvidenceSet): string {
  const all = checkCells(set);
  const rows = MATRIX_NETWORKS.map((network) => [
    code(network),
    ...MATRIX_CHECKS.map(({ check }) => {
      const cell = all.find((entry) => entry.network === network && entry.check === check);
      if (cell === undefined || cell.passed === 0) return "none recorded";
      return (
        `${String(cell.passed)} passed in ${cell.runs.map((run) => code(run.file)).join(", ")}` +
        (checkLocalOnly(cell) ? " (local runs only)" : "")
      );
    }),
  ]);
  return table(["Network", ...MATRIX_CHECKS.map(({ title, check }) => `${title} (${code(check)})`)], rows);
}

/**
 * Bazaar cataloging and MCP cells a final report cannot leave as they are, for the networks it must
 * cover: no passed case, or only runs against a local service.
 */
export function checkProblems(set: EvidenceSet, networks: readonly string[]): string[] {
  const problems: string[] = [];
  for (const cell of checkCells(set).filter((entry) => networks.includes(entry.network))) {
    const name = `${cell.network} × ${cell.check}`;
    if (cell.passed === 0) problems.push(`${name}: no passed case is recorded`);
    else if (checkLocalOnly(cell)) problems.push(`${name}: only runs against a local service back it`);
  }
  return problems;
}

/** The workspace version the evidence describes. */
export function workspaceVersion(root = REPO_ROOT): string {
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}

/** The release tag (`v…`) on a commit (`git describe --tags --exact-match`), if any. */
export function releaseTag(commit: string, root = REPO_ROOT): string | undefined {
  try {
    return execFileSync("git", ["describe", "--tags", "--exact-match", "--match", "v[0-9]*", commit], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export function renderTestedAgainst(
  set: EvidenceSet,
  list: WatchList = loadWatchList(),
  version = workspaceVersion(),
  tagOf: (commit: string) => string | undefined = releaseTag,
): string {
  const runs = currentRuns(set);
  // The newest run names the commit the report describes; its tag is the release, when it has one.
  const newest = [...runs].sort((a, b) => b.evidence.finishedAt.localeCompare(a.evidence.finishedAt))[0];
  const commit = newest?.evidence.harness.commit;
  const tag = commit === undefined ? undefined : tagOf(commit);
  const release =
    tag !== undefined
      ? `${code(tag)} (the tag on the evidence commit ${code(commit?.slice(0, 7) ?? "")})`
      : `${code(`v${version}`)} (workspace version${commit === undefined ? "" : `; the evidence commit ${code(commit.slice(0, 7))} has no release tag`})`;
  const drifts = runs
    .filter((run) => run.evidence.upstreamDrift !== undefined)
    .sort((a, b) => b.evidence.finishedAt.localeCompare(a.evidence.finishedAt));
  const drift = drifts[0]?.evidence.upstreamDrift;
  const issues = "https://github.com/tolgayayci/rail402/issues?q=label%3Aupstream-drift";
  const networks = [...new Set(runs.map((run) => run.evidence.network))].sort();
  const repository = list.upstream.repository;
  const upstream = `https://github.com/${repository}`;
  const pinned = list.packages.map((entry) => `${code(entry.name)} ${entry.pinned}`).join(", ");
  const rows = [
    ["Rail402 release", release],
    ["Networks", networks.length === 0 ? "none recorded" : networks.map(code).join(", ")],
    [
      "Upstream baseline",
      `[${code(repository)}](${upstream}) at [${code(list.upstream.baselineRef)}](${upstream}/commit/${list.upstream.baselineCommit}) ` +
        `(${code(list.upstream.baselineCommit.slice(0, 7))}), as pinned in ${code("tools/upstream-watch/watch.json")}`,
    ],
    ["Pinned packages", pinned],
    [
      "Open upstream drift",
      drift === undefined
        ? `not checked when the runs were recorded; see the open issue labelled \`upstream-drift\`, if any ([issues](${issues}))`
        : drift.fingerprint === null
          ? `none when ${code(drifts[0]?.file ?? "")} was recorded: the watch list matched upstream`
          : `fingerprint ${code(drift.fingerprint.slice(0, 12))} when ${code(drifts[0]?.file ?? "")} was recorded ([the tracking issue](${issues}))`,
    ],
  ];
  return table(["Field", "Value"], rows);
}

/** The checks a final report needs on every network it covers. */
export const REQUIRED_CHECKS: readonly CheckId[] = [
  "canonical-client",
  "scheme-exact",
  "scheme-upto",
  "upstream-e2e",
  "discovery",
  "mcp",
];

interface Skip {
  readonly category: string;
  readonly reason: string;
  readonly checks: readonly CheckId[];
  readonly network: string;
  readonly file: string;
}

function skips(set: EvidenceSet): Skip[] {
  return currentRuns(set).flatMap((run) =>
    run.evidence.cases
      .filter((entry) => entry.status === "skipped")
      .map((entry) => ({
        category: entry.skipCategory ?? "not categorised",
        reason: entry.skipReason ?? "",
        checks: entry.checks,
        network: run.evidence.network,
        file: run.file,
      })),
  );
}

export function renderSkipped(set: EvidenceSet): string {
  const all = skips(set);
  if (all.length === 0) return "No case was skipped.";
  const order = [...SKIP_CATEGORIES, "not categorised"];
  const groups = new Map<string, Skip[]>();
  for (const skip of all) {
    const key = `${skip.category}\u0000${skip.reason}`;
    groups.set(key, [...(groups.get(key) ?? []), skip]);
  }
  const rows = [...groups.values()]
    .sort(
      (a, b) =>
        order.indexOf(a[0]?.category ?? "") - order.indexOf(b[0]?.category ?? "") ||
        (a[0]?.reason ?? "").localeCompare(b[0]?.reason ?? ""),
    )
    .map((group) => {
      const first = group[0] as Skip;
      return [
        first.category,
        escape(first.reason),
        [...new Set(group.flatMap((skip) => skip.checks))].map(code).join(", "),
        [...new Set(group.map((skip) => skip.network))].map(code).join(", "),
        String(group.length),
        [...new Set(group.map((skip) => code(skip.file)))].join(", "),
      ];
    });
  return table(["Category", "Reason", "Checks", "Network", "Cases", "Runs"], rows);
}

/** Skips a final report refuses: a required check waiting on something, on a covered network. */
export function skipProblems(set: EvidenceSet, networks: readonly string[] = MATRIX_NETWORKS): string[] {
  return skips(set)
    .filter((skip) => skip.category === "pending-dependency" && networks.includes(skip.network))
    .filter((skip) => skip.checks.some((check) => REQUIRED_CHECKS.includes(check)))
    .map((skip) => `${skip.file}: a required check is skipped waiting on a dependency (${skip.reason})`);
}
