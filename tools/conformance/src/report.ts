/**
 * Renders the generated sections of the public reference pages from checked evidence and the code
 * registry. A page marks each generated section with
 *
 *     {/* generated:begin <id> *\/} … {/* generated:end *\/}
 *
 * and everything between the markers is replaced; the prose around them is left alone. The evidence
 * manifest is rewritten at the same time.
 *
 *   pnpm report                    render the pages and the manifest
 *   pnpm report --check            exit 1 when a page or the manifest is out of date
 *   pnpm report --check --final    also exit 1 when a file is still in the older format, a cited
 *                                  commit (evidence, deployment record or error-code coverage record)
 *                                  is not on main, or the coverage record is older than the evidence;
 *                                  the evidence run ends with this, so a published page never links a
 *                                  lost commit or a stale coverage record, and when a required check
 *                                  (canonical client, exact, upto, upstream e2e, discovery, MCP) is
 *                                  skipped waiting on a dependency
 *   pnpm report --check --final --require-networks stellar:testnet,stellar:pubnet
 *                                  also exit 1 when a network × scheme cell of the matrix has no
 *                                  settled transaction, or only runs against a local service back it
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as prettier from "prettier";
import { EVIDENCE_DIR, REPO_ROOT, commitIsAncestor, commitOnRelease } from "./evidence.ts";
import {
  buildManifest,
  loadEvidenceSet,
  manifestPath,
  publicationProblems,
  readManifest,
  renderManifest,
  type EvidenceSet,
  type LoadedEvidence,
} from "./evidence-set.ts";
import { codeGroups } from "@rail402.dev/service/codes";
import { clientCodeGroups } from "./client-codes.ts";
import { renderClientCodeGroups, renderCodeGroups, renderCoverage } from "./render-codes.ts";
import { allRegistered, readCoverageRecord } from "./codes-coverage.ts";
import { UNEXERCISED } from "./codes-unexercised.ts";
import { renderBenchmark, renderCurrent, renderLegacy } from "./render-evidence.ts";
import {
  renderCanonical,
  renderCasesFor,
  renderConcurrency,
  renderFaultRecovery,
  renderMcp,
  renderPlayground,
  renderRejections,
  renderRelease,
  renderSettlements,
  renderSummary,
  renderSupported,
  renderUpstreamRuns,
} from "./render-report.ts";
import type { Evidence } from "./evidence.ts";
import { EXERCISES } from "./ops-exercises.ts";
import {
  renderAssets,
  renderBoundaries,
  renderExerciseSummary,
  renderExercises,
  renderOpsRun,
  renderThreatSummary,
  renderTopic,
} from "./render-security.ts";
import { loadThreats, type ThreatRegistry } from "./threats.ts";
import { loadFindings } from "./findings.ts";
import { securityReportPage } from "./render-findings.ts";
import { renderRunbookAlerts } from "../../../deploy/monitoring/alerts.ts";
import { renderLocalDrills } from "./drills.ts";
import {
  MATRIX_NETWORKS,
  checkProblems,
  matrixProblems,
  renderCheckMatrix,
  renderNetworkMatrix,
  renderSkipped,
  renderTestedAgainst,
  skipProblems,
} from "./render-matrix.ts";
import {
  loadDeploymentRecord,
  renderDeploymentRecord,
  renderDeployments,
  UPTO_PUBNET_DEPLOYMENT_RECORD,
  type DeploymentRecord,
} from "./render-deployment.ts";

export interface ReportContext {
  readonly evidence: EvidenceSet;
  readonly threats: ThreatRegistry;
  /** The `upto` settlement contract's testnet deployment record. */
  readonly deployment: DeploymentRecord;
  /** The `upto` settlement contract's pubnet deployment record. */
  readonly pubnetDeployment: DeploymentRecord;
}

const THREAT_TOPICS = [
  "replay",
  "front-running",
  "fee-sponsorship",
  "catalog-poisoning",
  "ssrf",
  "smart-accounts",
  "mcp-paid-calls",
  "upto-contract",
  "exact-payments",
  "operations",
  "playground",
  "spec-watch",
  "network-isolation",
  "access-keys",
  "key-custody",
  "supply-chain",
  "discovery-limits",
  "hosted-mcp",
  "explorer",
  "explorer-web",
  "pubnet-harness",
] as const;

export type BlockRenderer = (context: ReportContext) => string;

export interface PageSpec {
  /** Repository-relative path of the page. */
  readonly path: string;
  readonly blocks: Readonly<Record<string, BlockRenderer>>;
}

type RunRenderer = (file: string, evidence: Evidence) => string;

/**
 * A block backed by one evidence run. Candidates are file names in order of preference, so a run in
 * the current format replaces an older file under a different name. A current-format run is rendered
 * by `render` when given, else as a generic case table.
 */
function runBlock(candidates: readonly string[], render?: RunRenderer): BlockRenderer {
  return ({ evidence }) => {
    const loaded = candidates
      .map((name) => evidence.files.find((file) => file.file === name))
      .find((file): file is LoadedEvidence => file !== undefined);
    if (loaded === undefined) {
      return `No run has been recorded yet (\`${EVIDENCE_DIR}/${candidates[0] ?? ""}\`).`;
    }
    if (loaded.format === "legacy") return renderLegacy(`${EVIDENCE_DIR}/${loaded.file}`, loaded.evidence);
    return render === undefined
      ? renderCurrent(`${EVIDENCE_DIR}/${loaded.file}`, loaded.evidence)
      : render(loaded.file, loaded.evidence);
  };
}

/** The file name of the run against a deployed Rail402 that is kept beside a local run's `file`. */
export function hostedFileName(file: string): string {
  return file.replace(/-(stellar-(?:testnet|pubnet))\.json$/, "-hosted-$1.json");
}

/**
 * A block backed by one harness's run against the local Rail402 and its run against a deployed one
 * (`hostedFileName`), each rendered as `runBlock` would; `olderHosted` lists older files that stand in
 * for the hosted run until it is recorded. With `hostedExpected`, the block says when no hosted run is
 * recorded; otherwise a missing hosted run is left out.
 */
function targetsBlock(
  file: string,
  options: { render?: RunRenderer; olderHosted?: readonly string[]; hostedExpected?: boolean } = {},
): BlockRenderer {
  const hosted = [hostedFileName(file), ...(options.olderHosted ?? [])];
  const local = runBlock([file], options.render);
  const deployed = runBlock(hosted, options.render);
  return (context) => {
    const recorded = (name: string) => context.evidence.files.some((entry) => entry.file === name);
    const parts = [local(context)];
    if (hosted.some(recorded)) parts.push(deployed(context));
    else if (options.hostedExpected === true) {
      parts.push(
        `No run against the deployed service has been recorded yet (\`${EVIDENCE_DIR}/${hosted[0] ?? ""}\`).`,
      );
    }
    return parts.join("\n\n");
  };
}

/**
 * A block backed by several runs of one harness (one per variant, each also against a deployed Rail402
 * when recorded), each rendered in turn; the ones not recorded yet are left out, and the block says so
 * when none is.
 */
function runsBlock(files: readonly string[], render: RunRenderer): BlockRenderer {
  return ({ evidence }) => {
    const loaded = files
      .flatMap((name) => [name, hostedFileName(name)])
      .map((name) => evidence.files.find((file) => file.file === name))
      .filter((file): file is LoadedEvidence => file !== undefined);
    if (loaded.length === 0) return `No run has been recorded yet (\`${EVIDENCE_DIR}/${files[0] ?? ""}\`).`;
    return loaded
      .map((file) =>
        file.format === "legacy"
          ? renderLegacy(`${EVIDENCE_DIR}/${file.file}`, file.evidence)
          : render(file.file, file.evidence),
      )
      .join("\n\n");
  };
}

export const PAGES: readonly PageSpec[] = [
  {
    path: "docs/reference/conformance.mdx",
    blocks: {
      release: ({ evidence }) => renderRelease(evidence),
      "tested-against": ({ evidence }) => renderTestedAgainst(evidence),
      matrix: ({ evidence }) => `${renderNetworkMatrix(evidence)}\n\n${renderCheckMatrix(evidence)}`,
      skipped: ({ evidence }) => renderSkipped(evidence),
      summary: ({ evidence }) => renderSummary(evidence),
      canonical: targetsBlock("canonical-stellar-testnet.json", {
        render: renderCanonical,
        // The older-format canonical run, against the deployed service.
        olderHosted: ["canonical-exact-stellar-testnet.json"],
        hostedExpected: true,
      }),
      supported: ({ evidence }) => renderSupported(evidence),
      settlements: ({ evidence }) => renderSettlements(evidence),
      expiration: ({ evidence }) =>
        renderCasesFor(
          evidence,
          "expiration",
          ["live-matrix"],
          [
            "estimatedLedgerSeconds",
            "shortExpirationLedger",
            "shortLatestLedgerAtSigning",
            "freshExpirationOffset",
          ],
        ),
      idempotency: ({ evidence }) => renderCasesFor(evidence, "idempotency", ["live-matrix"]),
      "live-matrix": targetsBlock("live-matrix-stellar-testnet.json"),
      concurrency: runsBlock(
        [
          "concurrency-stellar-testnet.json",
          "concurrency-upto-stellar-testnet.json",
          "concurrency-mixed-stellar-testnet.json",
        ],
        renderConcurrency,
      ),
      "crash-recovery": runBlock(["fault-recovery-stellar-testnet.json"], renderFaultRecovery),
      "rejection-audit": targetsBlock("rejection-audit-stellar-testnet.json", {
        render: renderRejections,
        hostedExpected: true,
      }),
      "upstream-e2e": runBlock(["upstream-e2e-stellar-testnet.json"]),
      "upstream-e2e-runs": ({ evidence }) => renderUpstreamRuns(evidence),
      "live-bazaar": targetsBlock("live-bazaar-stellar-testnet.json", { hostedExpected: true }),
      mcp: ({ evidence }) => renderMcp(evidence),
      playground: ({ evidence }) => renderPlayground(evidence),
      "upto-contract": runBlock(["upto-contract-stellar-testnet.json"]),
      benchmark: runBlock(["benchmark-stellar-testnet.json"], (file, evidence) =>
        renderBenchmark(`${EVIDENCE_DIR}/${file}`, evidence),
      ),
    },
  },
  {
    path: "docs/security/threat-model.mdx",
    blocks: {
      assets: ({ threats }) => renderAssets(threats),
      boundaries: ({ threats }) => renderBoundaries(threats),
      summary: ({ threats }) => renderThreatSummary(threats),
      ...Object.fromEntries(
        THREAT_TOPICS.map((topic): [string, BlockRenderer] => [
          `topic-${topic}`,
          ({ threats }) => renderTopic(threats, topic),
        ]),
      ),
    },
  },
  {
    path: "docs/security/operational-tests.mdx",
    blocks: {
      run: ({ evidence }) => renderOpsRun(evidence),
      summary: ({ evidence }) => renderExerciseSummary(EXERCISES, evidence),
      exercises: ({ evidence }) => renderExercises(EXERCISES, evidence),
      drills: () => renderLocalDrills(),
    },
  },
  securityReportPage(() => loadFindings()),
  {
    path: "docs/runbook.mdx",
    blocks: { alerts: () => renderRunbookAlerts() },
  },
  {
    path: "docs/reference/upto-contract.mdx",
    blocks: {
      deployments: ({ deployment, pubnetDeployment }) => renderDeployments(deployment, pubnetDeployment),
      "deployment-record": ({ deployment }) => renderDeploymentRecord(deployment),
      "pubnet-deployment-record": ({ pubnetDeployment }) => renderDeploymentRecord(pubnetDeployment),
    },
  },
  {
    path: "docs/reference/error-codes.mdx",
    blocks: {
      codes: () => renderCodeGroups(codeGroups),
      "client-codes": () => renderClientCodeGroups(clientCodeGroups),
      coverage: () => renderCoverage(readCoverageRecord(), UNEXERCISED, allRegistered()),
    },
  },
];

const BEGIN = /\{\/\* generated:begin ([a-z0-9-]+) \*\/\}/g;
const END = "{/* generated:end */}";

/** Replaces the content of every generated block; refuses unknown, missing or unbalanced markers. */
export function applyBlocks(page: string, text: string, blocks: Readonly<Record<string, string>>): string {
  const seen = new Set<string>();
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(BEGIN)) {
    const id = match[1] ?? "";
    const start = match.index;
    if (start < cursor) throw new Error(`${page}: generated block "${id}" starts inside another block`);
    if (seen.has(id)) throw new Error(`${page}: generated block "${id}" appears twice`);
    const content = blocks[id];
    if (content === undefined) throw new Error(`${page}: unknown generated block "${id}"`);
    const bodyStart = start + match[0].length;
    const end = text.indexOf(END, bodyStart);
    const nextBegin = text.slice(bodyStart).search(BEGIN);
    if (end === -1 || (nextBegin !== -1 && bodyStart + nextBegin < end)) {
      throw new Error(`${page}: generated block "${id}" has no matching end marker`);
    }
    seen.add(id);
    output += `${text.slice(cursor, bodyStart)}\n\n${content.trim()}\n\n`;
    cursor = end;
  }
  output += text.slice(cursor);
  if (countOf(text, END) !== seen.size)
    throw new Error(`${page}: an end marker has no matching begin marker`);
  const missing = Object.keys(blocks).filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`${page}: missing generated blocks: ${missing.join(", ")}`);
  return output;
}

/** Renders one page from its current text, formatted exactly as the repository's Prettier would. */
export async function renderPage(
  spec: PageSpec,
  text: string,
  context: ReportContext,
  root = REPO_ROOT,
): Promise<string> {
  const blocks = Object.fromEntries(Object.entries(spec.blocks).map(([id, render]) => [id, render(context)]));
  const path = join(root, spec.path);
  const options = (await prettier.resolveConfig(path)) ?? {};
  return prettier.format(applyBlocks(spec.path, text, blocks), { ...options, filepath: path });
}

export interface RenderedFile {
  readonly path: string;
  readonly current: string;
  readonly rendered: string;
}

/** Every generated file with its committed and freshly rendered content. */
export async function renderAll(root = REPO_ROOT, pages = PAGES): Promise<RenderedFile[]> {
  const evidence = loadEvidenceSet(root);
  if (evidence.problems.length > 0) {
    throw new Error(`evidence failed its checks:\n  ${evidence.problems.join("\n  ")}`);
  }
  const context: ReportContext = {
    evidence,
    threats: loadThreats(root),
    deployment: loadDeploymentRecord(root),
    pubnetDeployment: loadDeploymentRecord(root, UPTO_PUBNET_DEPLOYMENT_RECORD),
  };
  const rendered: RenderedFile[] = [];
  for (const spec of pages) {
    const current = readFileSync(join(root, spec.path), "utf8");
    rendered.push({ path: spec.path, current, rendered: await renderPage(spec, current, context, root) });
  }
  const manifest = manifestPath(root);
  const committed = readManifest(root);
  rendered.push({
    path: `${EVIDENCE_DIR}/manifest.json`,
    current: committed === undefined ? "" : readFileSync(manifest, "utf8"),
    rendered: renderManifest(buildManifest(evidence)),
  });
  return rendered;
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      final: { type: "boolean", default: false },
      "require-networks": { type: "string" },
    },
  });
  const required = (values["require-networks"] ?? "")
    .split(",")
    .map((network) => network.trim())
    .filter((network) => network !== "");
  const unknown = required.filter((network) => !(MATRIX_NETWORKS as readonly string[]).includes(network));
  if (unknown.length > 0) throw new Error(`--require-networks: unknown network ${unknown.join(", ")}`);
  if (required.length > 0 && !values.final) throw new Error("--require-networks applies to --check --final");
  const files = await renderAll();
  const stale = files.filter((file) => file.current !== file.rendered);
  if (values.check) {
    for (const file of stale) console.error(`out of date: ${file.path}`);
    if (stale.length > 0) {
      console.error("run `pnpm report` and commit the result");
      process.exit(1);
    }
    if (values.final) {
      const set = loadEvidenceSet();
      const problems = publicationProblems(
        set,
        (commit) => {
          const ancestry = commitOnRelease(commit);
          return ancestry.status === "unknown" ? undefined : ancestry.status === "reachable";
        },
        REPO_ROOT,
        (commit, of) => commitIsAncestor(commit, of),
      );
      problems.push(...skipProblems(set), ...matrixProblems(set, required), ...checkProblems(set, required));
      for (const problem of problems) console.error(`not publishable: ${problem}`);
      if (problems.length > 0) process.exit(1);
    }
    console.log(`${files.length} generated files are up to date`);
    return;
  }
  for (const file of stale) {
    writeFileSync(join(REPO_ROOT, file.path), file.rendered);
    console.log(`rendered ${file.path}`);
  }
  if (stale.length === 0) console.log(`${files.length} generated files were already up to date`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
