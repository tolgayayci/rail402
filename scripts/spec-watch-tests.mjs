#!/usr/bin/env node
// Composes the spec-drift TEST REPORT: did the upstream spec change actually break us?
//
// When the weekly watcher detects drift, the workflow runs three kinds of coverage before saying
// anything to a human:
//
//   1. our own test suite            — asserts conformance to the PINNED spec (in-process, fast)
//   2. the discovery-loop canary     — a real testnet settlement + cataloging + search, end to end
//   3. the upstream x402 e2e suite,  — via `packages/conformance dual`: the suite runs TWICE,
//      pinned vs latest                 at the pinned spec SHA and at latest main, against the
//                                       deployed facilitator, with stock upstream clients
//
// The dual run is the only honest breaking-change instrument. The suite does not fully pass even at
// the pinned SHA (a diagnosed upstream harness defect — see packages/conformance/README.md), so a
// bare exit code cannot distinguish "already imperfect" from "this drift broke something new".
// What can: the per-SHA scenario counts. Fewer scenarios passing at latest than at pinned means the
// spec change costs us conformance — that is BREAKING. Identical counts mean the drift is textual
// or additive at the wire level — NON-BREAKING (for now; the tracking issue still demands a re-read).
// No dual report at all means we must say INCONCLUSIVE, not guess.
//
// Usage: node scripts/spec-watch-tests.mjs --unit <success|failure|skipped>
//          --canary <success|failure|skipped> --dual-file docs/status/conformance-dual.json
//          --out report.json

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const outcomeWord = o => (o === "success" ? "pass" : o === "failure" ? "fail" : "skipped");

export function computeVerdict(dual, unitOutcome, canaryOutcome) {
  const caveats = [];
  if (unitOutcome === "failure")
    caveats.push(
      "our own test suite failed on main — unrelated to the drift, but fix it before trusting anything else",
    );
  if (canaryOutcome === "failure")
    caveats.push(
      "the discovery-loop canary failed — often testnet flakiness, read the log before blaming code",
    );
  const suffix = caveats.length ? ` Caveats: ${caveats.join("; ")}.` : "";

  if (!dual || dual.verdict === "blocked") {
    return {
      verdict: "inconclusive",
      reason:
        "the upstream e2e dual run produced no usable report, so wire-level impact is UNMEASURED — treat the drift as potentially breaking until it runs." +
        suffix,
    };
  }
  if (dual.verdict === "green") {
    return {
      verdict: "non-breaking",
      reason: "the upstream e2e suite passes at both the pinned and the latest spec commit." + suffix,
    };
  }
  if (dual.verdict === "drift") {
    return {
      verdict: "breaking",
      reason:
        "the upstream e2e suite passes at the pinned spec commit but FAILS at latest — this spec change breaks wire-level conformance." +
        suffix,
    };
  }
  // `regression`: the suite failed at the pinned SHA too, so compare scenario counts instead of
  // exit codes — the only comparison that isolates what THIS drift changed.
  const p = dual.pinned?.scenarios ?? { passed: 0, failed: 0 };
  const l = dual.latest?.scenarios ?? { passed: 0, failed: 0 };
  if (l.passed < p.passed) {
    return {
      verdict: "breaking",
      reason:
        `the suite fails at BOTH spec SHAs, but latest passes fewer scenarios (${l.passed} vs ${p.passed} at pinned) — ` +
        `this drift costs ${p.passed - l.passed} previously-passing scenario(s).` +
        suffix,
    };
  }
  return {
    verdict: "non-breaking",
    reason:
      `the suite fails identically at both spec SHAs (${p.passed} passed / ${p.failed} failed at pinned, ` +
      `${l.passed} / ${l.failed} at latest) — a pre-existing upstream harness condition (see packages/conformance/README.md), ` +
      "not new breakage from this drift." +
      suffix,
  };
}

export function composeReport({ unit, canary, dual }) {
  const scen = side =>
    side?.scenarios
      ? `${side.scenarios.passed} passed / ${side.scenarios.failed} failed`
      : "no scenario data";
  const dualRan = dual && dual.verdict !== "blocked";
  const suites = [
    {
      id: "unit",
      name: "Our test suite (vitest, in-process)",
      outcome: outcomeWord(unit),
      detail: "asserts conformance to the PINNED spec — it cannot see the new one",
    },
    {
      id: "canary",
      name: "Discovery-loop canary (real testnet settlement → catalog → search)",
      outcome: outcomeWord(canary),
      detail: "stock @x402 client against a locally spawned facilitator, friendbot-funded",
    },
    {
      id: "upstream-pinned",
      name: "Upstream x402 e2e @ pinned spec",
      outcome: dualRan ? (dual.pinned?.ok ? "pass" : "fail") : "skipped",
      detail: dualRan
        ? `${scen(dual.pinned)} at ${String(dual.pinned?.sha ?? "").slice(0, 8)}`
        : (dual?.note ?? "dual run did not produce a report"),
    },
    {
      id: "upstream-latest",
      name: "Upstream x402 e2e @ latest spec",
      outcome: dualRan ? (dual.latest?.ok ? "pass" : "fail") : "skipped",
      detail: dualRan ? `${scen(dual.latest)} at ${String(dual.latest?.sha ?? "").slice(0, 8)}` : "not run",
    },
  ];
  const { verdict, reason } = computeVerdict(dual, unit, canary);
  return {
    generatedAt: new Date().toISOString(),
    verdict,
    reason,
    suites,
    dual: dual
      ? {
          verdict: dual.verdict,
          facilitatorUrl: dual.facilitatorUrl ?? null,
          pinned: dual.pinned ?? null,
          latest: dual.latest ?? null,
        }
      : null,
  };
}

function main() {
  const arg = (name, fallback = null) => {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const dualFile = arg("--dual-file");
  const dual = dualFile && existsSync(dualFile) ? JSON.parse(readFileSync(dualFile, "utf8")) : null;
  const report = composeReport({ unit: arg("--unit", "skipped"), canary: arg("--canary", "skipped"), dual });

  const outPath = arg("--out");
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
  if (process.env.GITHUB_OUTPUT)
    writeFileSync(process.env.GITHUB_OUTPUT, `verdict=${report.verdict}\n`, { flag: "a" });

  console.log(`spec-watch-tests: verdict ${report.verdict.toUpperCase()} — ${report.reason}`);
  for (const s of report.suites) console.log(`  ${s.outcome.padEnd(7)} ${s.name} (${s.detail})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
