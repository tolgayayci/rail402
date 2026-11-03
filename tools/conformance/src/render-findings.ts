/**
 * Markdown for the public security report (`docs/security/report.mdx`) from the findings register and
 * the threat registry. Deterministic: the output depends only on those two files.
 */
import type { BlockRenderer, PageSpec } from "./report.ts";
import { SEVERITIES, STATUSES, type Finding, type FindingsRegister } from "./findings.ts";
import { REPOSITORY_URL, code, commitLink, escape, table } from "./render-evidence.ts";
import { parseTestRef, type ThreatRegistry } from "./threats.ts";

const STATUS_LABEL: Readonly<Record<Finding["status"], string>> = {
  open: "Open",
  fixed: "Fixed",
  accepted: "Accepted risk",
  "wont-fix": "Won't fix",
  duplicate: "Duplicate",
};

const SEVERITY_LABEL: Readonly<Record<Finding["severity"], string>> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

function sourceLink(path: string): string {
  return `[${code(path)}](${REPOSITORY_URL}/blob/main/${path})`;
}

export function renderTestedRevision(register: FindingsRegister): string {
  const revision = register.testedRevision;
  const rows: string[][] = [
    ["Release tag", revision.tag === null ? "not frozen yet" : code(revision.tag)],
    ["Commit", revision.commit === null ? "not frozen yet" : commitLink(revision.commit)],
    [
      "Images",
      Object.keys(revision.images).length === 0
        ? "none published for this revision"
        : Object.entries(revision.images)
            .map(([name, digest]) => `${code(name)} ${code(digest)}`)
            .join("<br />"),
    ],
    [
      "npm packages",
      Object.entries(revision.npm)
        .map(([name, version]) => code(`${name}@${version}`))
        .join(", "),
    ],
    ...Object.entries(revision.uptoWasm).map(([network, hash]) => [
      `upto contract WASM (${code(network)})`,
      hash === null ? "not deployed" : code(hash),
    ]),
  ];
  return table(["Item", "Value"], rows);
}

export function renderReviews(register: FindingsRegister): string {
  return table(
    ["Review", "Kind", "By", "Scope", "Dates", "Findings", "Report"],
    register.reviews.map((review) => [
      code(review.id),
      review.kind === "internal" ? "Internal" : "External",
      escape(review.by),
      escape(review.scope.join(", ")),
      review.from === review.to ? review.from : `${review.from} to ${review.to}`,
      String(register.findings.filter((entry) => entry.review === review.id).length),
      review.report === null ? "not published" : `[report](${review.report})`,
    ]),
  );
}

export function renderFindingSummary(register: FindingsRegister): string {
  const statuses = STATUSES.filter((status) => register.findings.some((entry) => entry.status === status));
  return table(
    ["Severity", ...statuses.map((status) => STATUS_LABEL[status]), "Total"],
    SEVERITIES.map((severity) => {
      const of = register.findings.filter((entry) => entry.severity === severity);
      return [
        SEVERITY_LABEL[severity],
        ...statuses.map((status) => String(of.filter((entry) => entry.status === status).length)),
        String(of.length),
      ];
    }),
  );
}

export function renderFindingTable(register: FindingsRegister): string {
  return table(
    ["ID", "Severity", "Component", "Finding", "Status", "Fix"],
    register.findings.map((entry) => [
      `[${entry.id}](#${entry.id.toLowerCase()})`,
      SEVERITY_LABEL[entry.severity],
      entry.component,
      escape(entry.title),
      STATUS_LABEL[entry.status],
      (entry.fix?.commit ?? null) === null ? "—" : commitLink(entry.fix?.commit ?? ""),
    ]),
  );
}

/** Each finding: what it was, and the fix with its regression tests, or the written acceptance. */
export function renderFindingDetails(register: FindingsRegister): string {
  return register.findings
    .map((entry) => {
      const parts = [
        `### ${entry.id}`,
        `**${escape(entry.title)}**`,
        `${SEVERITY_LABEL[entry.severity]} · ${entry.component} · ${STATUS_LABEL[entry.status]} · found by ${code(entry.review)} on ${entry.reportedAt}${entry.resolvedAt === null ? "" : `, resolved ${entry.resolvedAt}`}${entry.threats.length === 0 ? "" : ` · threats ${entry.threats.join(", ")}`}`,
        escape(entry.description),
      ];
      if (entry.fix !== null) {
        const tests = entry.fix.tests.map((ref) => {
          const { path, name } = parseTestRef(ref);
          return `- ${sourceLink(path)}: ${escape(name)}`;
        });
        parts.push(
          [
            entry.fix.commit === null
              ? "**Tests**"
              : `**Fixed in** ${commitLink(entry.fix.commit)}. **Tests**`,
            "",
            ...tests,
          ].join("\n"),
        );
      }
      if (entry.acceptance !== null) {
        parts.push(
          [
            `**Accepted** by the ${escape(entry.acceptance.approvedBy.toLowerCase())} on ${entry.acceptance.date}. ${escape(entry.acceptance.rationale)}`,
            "",
            ...entry.acceptance.mitigations.map((line) => `- ${escape(line)}`),
          ].join("\n"),
        );
      }
      return parts.join("\n\n");
    })
    .join("\n\n");
}

export function renderThreatModelSummary(threats: ThreatRegistry): string {
  const count = (status: string) => threats.threats.filter((entry) => entry.status === status).length;
  const rows = threats.topics
    .map((topic) => {
      const of = threats.threats.filter((entry) => entry.topic === topic.id);
      return [
        escape(topic.title),
        String(of.length),
        String(of.filter((entry) => entry.status === "mitigated").length),
        String(of.filter((entry) => entry.status === "accepted").length),
        String(of.filter((entry) => entry.status === "open").length),
      ];
    })
    .filter((row) => row[1] !== "0");
  return [
    `The [threat model](/security/threat-model) lists **${threats.threats.length} threats**: ${count("mitigated")} mitigated, ${count("accepted")} accepted with a stated residual risk, ${count("open")} open.`,
    table(["Topic", "Threats", "Mitigated", "Accepted", "Open"], rows),
  ].join("\n\n");
}

export function renderAcceptedThreats(threats: ThreatRegistry): string {
  return table(
    ["Threat", "Residual risk"],
    threats.threats
      .filter((entry) => entry.status === "accepted")
      .map((entry) => [`${entry.id}. ${escape(entry.title)}`, escape(entry.residual)]),
  );
}

/** The report page. `report.ts` renders it with the other generated pages. */
export function securityReportPage(load: () => FindingsRegister): PageSpec {
  const withRegister =
    (render: (register: FindingsRegister) => string): BlockRenderer =>
    () =>
      render(load());
  return {
    path: "docs/security/report.mdx",
    blocks: {
      revision: withRegister(renderTestedRevision),
      reviews: withRegister(renderReviews),
      summary: withRegister(renderFindingSummary),
      findings: withRegister(renderFindingTable),
      details: withRegister(renderFindingDetails),
      "threat-model": ({ threats }) => renderThreatModelSummary(threats),
      "accepted-threats": ({ threats }) => renderAcceptedThreats(threats),
    },
  };
}
