#!/usr/bin/env node
// Turns a spec-drift report into exactly one tracking issue — opened, kept current, and closed —
// in THIS repository. Nothing is ever sent upstream (CLAUDE.md §3.8c): an issue in our own repo is
// internal, and that is the only thing this touches.
//
// Idempotency is the whole point. A weekly job that opened a fresh issue every run would train the
// maintainer to ignore it. So:
//   • drift, no open issue      → open one, @-mention + assign the maintainer (+ Copilot, below)
//   • drift, issue already open, SAME fingerprint  → do nothing (no new noise)
//   • drift, issue already open, fingerprint CHANGED → update the body + leave a "what's new" comment
//   • no drift, issue open       → close it with a note that the specs are current again
//   • no drift, nothing open     → nothing to do
//
// The fingerprint (the sorted set of changed file → current SHA) rides in an HTML comment in the
// body, so "has anything changed since last week?" is answerable without a database.
//
// The issue is also the handoff to the automated fix agent — Claude Code, run by the SAME workflow
// via anthropics/claude-code-action right after this script (subscription-authenticated; see
// spec-watch.yml). The body carries the test verdict (breaking / non-breaking / inconclusive, from
// scripts/spec-watch-tests.mjs), a link to the draft `spec-drift/<fingerprint>` branch, and the
// instructions Claude follows: analyse the drift, apply fixes on a working branch, open a DRAFT
// pull request, and report back as a comment on this issue. Claude proposes and applies; it never
// merges — a human does. So the workflow can gate that step on "did anything actually change?",
// this script emits `action` (created|updated|unchanged|closed|none) and `issue` (the number) as
// step outputs.
//
// Usage: node scripts/spec-watch-issue.mjs --report report.json
//          [--tests tests.json] [--branch spec-drift/<fp>] [--dry-run]
//   env: GH_TOKEN (in Actions), SPEC_DRIFT_MENTION (default: tolgayayci)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LABEL = "spec-drift";
const MENTION = process.env.SPEC_DRIFT_MENTION || "tolgayayci";
const UPSTREAM_WEB = "https://github.com/x402-foundation/x402";
const DRY = process.argv.includes("--dry-run");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}

const report = JSON.parse(readFileSync(arg("--report"), "utf8"));
const testsPath = arg("--tests");
const tests = testsPath && existsSync(testsPath) ? JSON.parse(readFileSync(testsPath, "utf8")) : null;
const draftBranch = arg("--branch") || null;

function gh(args, opts = {}) {
  return execFileSync("gh", args, { encoding: "utf8", ...opts }).trim();
}

function repoNwo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    return gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  } catch {
    return null;
  }
}

// ── issue body ────────────────────────────────────────────────────────────────
function modulesCell(modules) {
  if (!modules.length) return "—";
  return modules
    .map(m => `\`${m.path}\`${m.humanOnly ? " ⚠️" : ""}${m.exists ? "" : " (path gone)"}`)
    .join(", ");
}

function verdictBlock() {
  if (!tests) {
    return "⚪ **Unmeasured** — the test steps produced no report this run; see the workflow log before treating this drift as safe.";
  }
  const label =
    {
      breaking: "🔴 **BREAKING**",
      "non-breaking": "🟢 **Non-breaking**",
      inconclusive: "⚪ **Inconclusive**",
    }[tests.verdict] ?? `**${tests.verdict}**`;
  return `${label} — ${tests.reason}`;
}

function testsTable() {
  if (!tests) return [];
  const mark = { pass: "✅ pass", fail: "❌ fail", skipped: "⏭️ skipped" };
  return [
    `**Test report** (run against the deployed facilitator before this issue was filed):`,
    ``,
    `| Check | Result | Detail |`,
    `|---|---|---|`,
    ...tests.suites.map(s => `| ${s.name} | ${mark[s.outcome] ?? s.outcome} | ${s.detail} |`),
    ``,
  ];
}

function composeBody() {
  const short = report.upstreamHead.slice(0, 7);
  const nwo = repoNwo();
  const rows = report.drifted.map(d => {
    const commit = `${UPSTREAM_WEB}/commit/${d.current}`;
    return `| \`${d.path}\` | \`${d.pinned}\` → [\`${d.currentShort}\`](${commit}) | ${d.subject} | ${modulesCell(d.modules)} |`;
  });
  for (const m of report.missing) {
    rows.push(`| \`${m.path}\` | \`${m.pinned}\` → **removed upstream** | file no longer exists | — |`);
  }

  const branchLines = draftBranch
    ? [
        `**Draft branch:** ${nwo ? `[\`${draftBranch}\`](https://github.com/${nwo}/tree/${draftBranch})` : `\`${draftBranch}\``} — ` +
          `pins bumped to the new SHAs, full diffs + this test report in \`docs/research/drift/DRIFT-${report.fingerprint}.md\`. ` +
          `Merging it asserts conformance — never merge before the checklist below passes.`,
        ``,
      ]
    : [];

  return [
    `### 🛰️ x402 spec drift — ${report.driftCount} file(s) changed upstream`,
    ``,
    `> Autogenerated weekly by \`.github/workflows/spec-watch.yml\`. A maintenance signal, **not** a build failure — the RFP grades keeping conformance current (CLAUDE.md §2).`,
    ``,
    `**Impact:** ${verdictBlock()}`,
    ``,
    ...testsTable(),
    ...branchLines,
    `---`,
    ``,
    `**Upstream:** [\`x402-foundation/x402@${short}\`](${UPSTREAM_WEB}/commits/main) · **Our snapshot:** ${report.snapshotDate} · **Checked:** ${report.checkedAt}`,
    ``,
    `| Spec file | Pinned → Current | Last upstream change | Implements (⚠️ = human-authored only) |`,
    `|---|---|---|---|`,
    ...rows,
    ``,
    `#### Next steps (human)`,
    `- [ ] Re-read each changed spec file above`,
    `- [ ] Update \`docs/research/spec-pins.json\` **and** \`docs/research/SPEC_SNAPSHOT.md\` in the same PR (the draft branch starts this)`,
    `- [ ] Re-run conformance: \`node packages/conformance/bin/conformance.mjs dual --servers=next\``,
    `- [ ] Record the conformance impact per affected module`,
    `- [ ] Review the automated draft PR (Claude) — merge only after the boxes above are checked`,
    ``,
    `#### For the automated fix agent (Claude Code, run by this workflow)`,
    `Work ONLY in this repository, and never merge anything — finish by opening a **draft pull request against \`main\`** and commenting a summary on this issue.`,
    `1. Start from the draft branch \`${draftBranch ?? `spec-drift/${report.fingerprint}`}\` — it already bumps \`docs/research/spec-pins.json\` and carries every diff in \`docs/research/drift/DRIFT-${report.fingerprint}.md\`.`,
    `2. Re-read each changed spec file at its new upstream commit (links in the table above) and update \`docs/research/SPEC_SNAPSHOT.md\` to match the new SHAs.`,
    `3. If the impact above is **BREAKING**: fix the affected modules named per file — with tests proving the new wire behaviour. Never touch \`contracts/\` or any path marked ⚠️ human-authored-only.`,
    `4. Run \`pnpm verify\` before finishing, keep the PR small, and name the spec commits it implements in the PR description.`,
    ``,
    `cc @${MENTION}`,
    ``,
    `<!-- spec-drift-fingerprint: ${report.fingerprint} -->`,
  ].join("\n");
}

function bodyFile(body) {
  const p = join(tmpdir(), `spec-drift-body-${report.fingerprint}.md`);
  writeFileSync(p, body);
  return p;
}

// Step outputs so the workflow can gate the Claude fix step on what actually happened here:
// `action` is created|updated|unchanged|closed|none, `issue` is the tracking issue number. Claude
// runs only on created/updated — an unchanged drift set must not re-spend a fix run every week.
function emitOutputs(action, issueNumber) {
  const lines = `action=${action}\nissue=${issueNumber ?? ""}\n`;
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, lines, { flag: "a" });
  console.log(`spec-watch: outputs — action=${action}${issueNumber != null ? ` issue=#${issueNumber}` : ""}`);
}

// ── gh helpers (skipped under --dry-run) ───────────────────────────────────────
function findOpenIssue() {
  if (DRY) return null;
  const raw = gh([
    "issue",
    "list",
    "--label",
    LABEL,
    "--state",
    "open",
    "--json",
    "number,body",
    "--limit",
    "5",
  ]);
  const list = JSON.parse(raw || "[]");
  return list[0] || null;
}

function ensureLabel() {
  if (DRY) return;
  try {
    gh([
      "label",
      "create",
      LABEL,
      "--color",
      "BFD4F2",
      "--description",
      "Upstream x402 spec drift found by the weekly watcher",
      "--force",
    ]);
  } catch {
    /* label ops are best-effort; a missing label must not block the notification */
  }
}

function issueNumberFromUrl(url) {
  const m = /\/issues\/(\d+)\s*$/.exec(url || "");
  return m ? Number(m[1]) : null;
}

function createIssue(body) {
  const title = `Spec drift: ${report.driftCount} upstream x402 spec file(s) changed`;
  const bf = bodyFile(body);
  if (DRY) {
    console.log(`[dry-run] would CREATE issue "${title}" (label ${LABEL}, assignee ${MENTION})`);
    return null;
  }
  ensureLabel();
  let url;
  try {
    url = gh([
      "issue",
      "create",
      "--title",
      title,
      "--body-file",
      bf,
      "--label",
      LABEL,
      "--assignee",
      MENTION,
    ]);
  } catch {
    // Assignment can fail (e.g. maintainer not assignable); the @-mention still notifies, so open it anyway.
    url = gh(["issue", "create", "--title", title, "--body-file", bf, "--label", LABEL]);
  }
  console.log("spec-watch: opened a new drift issue.");
  return issueNumberFromUrl(url);
}

function updateIssue(number, body) {
  const bf = bodyFile(body);
  if (DRY) {
    console.log(`[dry-run] would EDIT issue #${number} and comment "drift set changed"`);
    return;
  }
  gh(["issue", "edit", String(number), "--body-file", bf]);
  gh([
    "issue",
    "comment",
    String(number),
    "--body",
    `The drift set changed as of ${report.checkedAt} (fingerprint \`${report.fingerprint}\`). Body updated. cc @${MENTION}`,
  ]);
  console.log(`spec-watch: updated existing drift issue #${number}.`);
}

function closeIssue(number) {
  if (DRY) {
    console.log(`[dry-run] would CLOSE issue #${number} (specs current again)`);
    return;
  }
  gh([
    "issue",
    "comment",
    String(number),
    "--body",
    `All pinned spec files are current again as of ${report.checkedAt} (upstream \`${report.upstreamHead.slice(0, 7)}\`). Closing — the weekly watcher will reopen a fresh issue if they drift again. Any \`spec-drift/*\` branches left behind can be deleted.`,
  ]);
  gh(["issue", "close", String(number)]);
  console.log(`spec-watch: closed drift issue #${number} — no drift.`);
}

function fingerprintOf(body) {
  const m = /spec-drift-fingerprint:\s*([0-9a-f]+)/.exec(body || "");
  return m ? m[1] : null;
}

// ── decide ─────────────────────────────────────────────────────────────────────
const existing = findOpenIssue();

if (report.driftCount > 0) {
  const body = composeBody();
  if (DRY) {
    console.log("──────── composed issue body (dry-run) ────────");
    console.log(body);
    console.log("───────────────────────────────────────────────");
  }
  if (!existing) {
    const number = createIssue(body);
    emitOutputs("created", number);
  } else if (fingerprintOf(existing.body) === report.fingerprint) {
    console.log(
      `spec-watch: drift unchanged since last run (fingerprint ${report.fingerprint}); issue #${existing.number} left as-is.`,
    );
    emitOutputs("unchanged", existing.number);
  } else {
    updateIssue(existing.number, body);
    emitOutputs("updated", existing.number);
  }
} else if (existing) {
  closeIssue(existing.number);
  emitOutputs("closed", existing.number);
} else {
  console.log("spec-watch: no drift and no open issue — nothing to do.");
  emitOutputs("none", null);
}
