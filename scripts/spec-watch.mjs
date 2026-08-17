#!/usr/bin/env node
// Weekly spec-drift detector.
//
// The RFP grades conformance UPKEEP as heavily as the initial build: the x402 discovery
// conventions "have all changed and will change again", and "drift, not inability, is the failure
// mode this screens for" (CLAUDE.md §2). `scripts/spec-drift-check.sh` already answers "has any
// pinned spec moved?" — but only to a human reading the Actions log. This script produces the
// machine-readable report the weekly watcher builds on: a JSON file (--out) consumed by
// scripts/spec-watch-tests.mjs (test verdict), scripts/spec-watch-branch.mjs (draft branch) and
// scripts/spec-watch-issue.mjs (tracking issue), plus the workflow's step outputs. The report
// carries the real diff excerpt of every drifted file so downstream consumers — including the
// Copilot coding agent, once the issue is assigned to it — see what actually changed.
//
// It NEVER fails: being behind an evolving spec is information, not a defect. It also never talks to
// anyone outside this repo — it only READS the public upstream (CLAUDE.md §2, §3.8c).
//
// Usage: node scripts/spec-watch.mjs [--out report.json]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PINS_PATH = join(REPO_ROOT, "docs/research/spec-pins.json");
const MAP_PATH = join(REPO_ROOT, "docs/research/spec-module-map.json");
const UPSTREAM = "https://github.com/x402-foundation/x402.git";
const WORKDIR = join(process.env.TMPDIR || tmpdir(), "x402-spec-drift");

// How much of each file's diff to embed in the report. Bounded so the drift doc and issue can never
// blow up on a large refactor, with an honest truncation marker when it does.
const DIFF_MAX_LINES = 220;
const DIFF_MAX_CHARS = 6000;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
}

// A blobless clone gives full commit history for `git log -- <path>` without downloading every
// file's contents. A cache is only reusable if it still has an origin to fetch from.
function syncUpstream() {
  const reusable =
    existsSync(join(WORKDIR, ".git")) &&
    (() => {
      try {
        git(["-C", WORKDIR, "remote", "get-url", "origin"]);
        git(["-C", WORKDIR, "fetch", "--quiet", "origin", "main"]);
        return true;
      } catch {
        return false;
      }
    })();
  if (!reusable) {
    rmSync(WORKDIR, { recursive: true, force: true });
    git(["clone", "--quiet", "--filter=blob:none", "--single-branch", "--branch", "main", UPSTREAM, WORKDIR]);
  }
  try {
    git(["-C", WORKDIR, "checkout", "--quiet", "origin/main"]);
  } catch {
    /* detached checkout is best-effort; rev-parse below is the source of truth */
  }
  return git(["-C", WORKDIR, "rev-parse", "HEAD"]);
}

function lastTouch(path) {
  // Full SHA, short SHA, subject, and ISO date of the commit that last touched `path` upstream.
  const raw = git(["-C", WORKDIR, "log", "-1", "--format=%H%x09%h%x09%cI%x09%s", "--", path]);
  if (!raw) return null;
  const [full, short, date, ...subj] = raw.split("\t");
  return { full, short, date, subject: subj.join("\t") };
}

function fileDiff(pinned, current, path) {
  let diff;
  try {
    diff = git(["-C", WORKDIR, "diff", `${pinned}..${current}`, "--", path]);
  } catch {
    return { excerpt: "(diff unavailable — pinned commit not in history)", truncated: false };
  }
  const lines = diff.split("\n");
  let truncated = false;
  let out = lines.slice(0, DIFF_MAX_LINES);
  if (lines.length > DIFF_MAX_LINES) truncated = true;
  let text = out.join("\n");
  if (text.length > DIFF_MAX_CHARS) {
    text = text.slice(0, DIFF_MAX_CHARS);
    truncated = true;
  }
  return { excerpt: text || "(no textual diff)", truncated };
}

function modulesFor(map, path) {
  const entry = map?.files?.[path];
  if (!entry) return { summary: null, modules: [] };
  return {
    summary: entry.summary || null,
    modules: (entry.modules || []).map(m => ({
      path: m.path,
      why: m.why,
      humanOnly: !!m.humanOnly,
      exists: existsSync(join(REPO_ROOT, m.path)),
    })),
  };
}

// ── run ─────────────────────────────────────────────────────────────────────
const pins = JSON.parse(readFileSync(PINS_PATH, "utf8"));
const map = existsSync(MAP_PATH) ? JSON.parse(readFileSync(MAP_PATH, "utf8")) : { files: {} };

const upstreamHead = syncUpstream();

const drifted = [];
const ok = [];
const missing = [];

for (const [path, pinned] of Object.entries(pins.files)) {
  if (String(pinned).startsWith("unpinned-")) continue; // version-tracked, not a commit pin
  const touch = lastTouch(path);
  if (!touch) {
    missing.push({ path, pinned });
    continue;
  }
  const matches =
    touch.full.startsWith(pinned) || pinned.startsWith(touch.short) || pinned.startsWith(touch.full);
  if (matches) {
    ok.push(path);
    continue;
  }
  const { summary, modules } = modulesFor(map, path);
  const { excerpt, truncated } = fileDiff(pinned, touch.full, path);
  drifted.push({
    path,
    pinned,
    current: touch.full,
    currentShort: touch.short,
    subject: touch.subject,
    date: touch.date,
    summary,
    modules,
    diffExcerpt: excerpt,
    diffTruncated: truncated,
  });
}

// A stable identity for THIS drift wave. Same set of (file, current SHA) → same fingerprint, so the
// issue manager can tell "nothing new since last week" from "the drift set changed" and stay quiet
// on the former. Missing files count too — a spec being deleted upstream is drift.
const fingerprint = createHash("sha256")
  .update(
    [...drifted.map(d => `${d.path}:${d.current}`), ...missing.map(m => `${m.path}:MISSING`)]
      .sort()
      .join("\n"),
  )
  .digest("hex")
  .slice(0, 16);

const report = {
  checkedAt: new Date().toISOString(),
  repository: pins.repository,
  branch: pins.branch || "main",
  snapshotDate: pins.snapshotDate,
  pinnedRepoHead: pins.repoHead,
  upstreamHead,
  driftCount: drifted.length + missing.length,
  fingerprint,
  drifted,
  missing,
  ok,
};

const outPath = arg("--out");
if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));

// Step outputs for the workflow (also printed for a local run).
const outputs = `drifted=${report.driftCount > 0}\ncount=${report.driftCount}\nfingerprint=${fingerprint}\n`;
if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, outputs, { flag: "a" });

// Human log.
console.log(`spec-watch: upstream ${upstreamHead.slice(0, 7)} · snapshot ${report.snapshotDate}`);
if (report.driftCount === 0) {
  console.log("spec-watch: no drift — all pinned spec files are current.");
} else {
  console.log(`spec-watch: ${report.driftCount} file(s) drifted (fingerprint ${fingerprint}):`);
  for (const d of drifted)
    console.log(`  DRIFTED  ${d.path}  ${d.pinned} -> ${d.currentShort}  (${d.subject})`);
  for (const m of missing) console.log(`  MISSING  ${m.path}  (pinned ${m.pinned})`);
}
