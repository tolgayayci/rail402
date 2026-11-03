import { describe, expect, it } from "vitest";
import type { Evidence, EvidenceCase } from "../src/evidence.ts";
import type { EvidenceSet, LoadedEvidence } from "../src/evidence-set.ts";
import {
  checkProblems,
  matrixProblems,
  renderCheckMatrix,
  renderNetworkMatrix,
  renderSkipped,
  renderTestedAgainst,
  skipProblems,
} from "../src/render-matrix.ts";
import { loadWatchList } from "../../upstream-watch/src/watch-list.ts";

const COMMIT = "a".repeat(40);

const settled = (scheme: "exact" | "upto", hash: string): EvidenceCase => ({
  id: `${scheme}-${hash.slice(0, 4)}`,
  title: `${scheme} settles`,
  checks: [scheme === "exact" ? "scheme-exact" : "scheme-upto", "canonical-client"],
  scheme,
  status: "passed",
  elapsedMs: 1,
  transactions: [
    {
      hash: hash.repeat(64).slice(0, 64),
      ledger: 1,
      scheme,
      asset: "USDC",
      decimals: 7,
      amount: "1",
      payerType: "G",
      feeChargedStroops: "100",
      feeSource: "G",
      innerSource: "G",
      innerSequence: "1",
      transfers: [],
      explorer: `https://stellar.expert/explorer/testnet/tx/${hash}`,
    },
  ],
});

function run(
  file: string,
  network: Evidence["network"],
  mode: "local" | "hosted",
  cases: EvidenceCase[],
  kind: Evidence["kind"] = "canonical",
): LoadedEvidence {
  const evidence: Evidence = {
    schemaVersion: 2,
    kind,
    runId: file,
    startedAt: "2026-10-22T10:00:00.000Z",
    finishedAt: "2026-10-22T10:05:00.000Z",
    network,
    target: { mode, facilitatorUrl: "https://facilitator.example", healthVersion: "0.4.2", supported: {} },
    harness: { commit: COMMIT, dirty: false },
    packages: {},
    command: "node tools/conformance/src/canonical.ts",
    config: {},
    accounts: {},
    summary: {
      total: cases.length,
      passed: cases.filter((entry) => entry.status === "passed").length,
      failed: 0,
      skipped: cases.filter((entry) => entry.status === "skipped").length,
    },
    cases,
  };
  return {
    file,
    sha256: "0".repeat(64),
    commit: COMMIT,
    kind,
    format: "current",
    evidence,
  } as LoadedEvidence;
}

const set = (...files: LoadedEvidence[]): EvidenceSet => ({ files, problems: [] });

describe("the network × scheme matrix", () => {
  const testnet = run("canonical-hosted-stellar-testnet.json", "stellar:testnet", "hosted", [
    settled("exact", "1"),
    settled("upto", "2"),
  ]);

  it("lists settled hashes per cell with their files, and empty cells as none recorded", () => {
    const text = renderNetworkMatrix(set(testnet));
    expect(text).toContain("| `stellar:testnet` | [`11111111…`]");
    expect(text).toContain("in `canonical-hosted-stellar-testnet.json`");
    expect(text).toContain("| `stellar:pubnet` | none recorded | none recorded |");
  });

  it("fails the final gate only for the networks it is asked to cover", () => {
    expect(matrixProblems(set(testnet), [])).toEqual([]);
    expect(matrixProblems(set(testnet), ["stellar:testnet"])).toEqual([]);
    expect(matrixProblems(set(testnet), ["stellar:testnet", "stellar:pubnet"])).toEqual([
      "stellar:pubnet × exact: no settled transaction is recorded",
      "stellar:pubnet × upto: no settled transaction is recorded",
    ]);
  });

  it("refuses a cell backed only by runs against a local service", () => {
    const local = run("canonical-stellar-pubnet.json", "stellar:pubnet", "local", [settled("exact", "3")]);
    expect(renderNetworkMatrix(set(testnet, local))).toContain("(local runs only)");
    expect(matrixProblems(set(testnet, local), ["stellar:pubnet"])).toEqual([
      "stellar:pubnet × exact: only runs against a local service back it",
      "stellar:pubnet × upto: no settled transaction is recorded",
    ]);
  });
});

describe("Bazaar cataloging and MCP per network", () => {
  const passed = (id: string, checks: EvidenceCase["checks"]): EvidenceCase => ({
    id,
    title: id,
    checks,
    status: "passed",
    elapsedMs: 1,
  });
  const bazaar = run(
    "live-bazaar-hosted-stellar-testnet.json",
    "stellar:testnet",
    "hosted",
    [passed("http-listed", ["discovery"]), passed("mcp-tool", ["discovery", "mcp"])],
    "live-bazaar",
  );

  it("counts passed cases per network and names their runs", () => {
    const text = renderCheckMatrix(set(bazaar));
    expect(text).toContain(
      "| `stellar:testnet` | 2 passed in `live-bazaar-hosted-stellar-testnet.json` | 1 passed in",
    );
    expect(text).toContain("| `stellar:pubnet` | none recorded | none recorded |");
  });

  it("fails the final gate for a covered network without them, or with local runs only", () => {
    expect(checkProblems(set(bazaar), ["stellar:testnet"])).toEqual([]);
    const local = run(
      "live-bazaar-stellar-pubnet.json",
      "stellar:pubnet",
      "local",
      [passed("http-listed", ["discovery"])],
      "live-bazaar",
    );
    // A canonical run naming the check does not back it: only the Bazaar, agent and audit runs do.
    const canonical = run("canonical-hosted-stellar-pubnet.json", "stellar:pubnet", "hosted", [
      passed("mcp-like", ["mcp"]),
    ]);
    expect(checkProblems(set(bazaar, local, canonical), ["stellar:pubnet"])).toEqual([
      "stellar:pubnet × discovery: only runs against a local service back it",
      "stellar:pubnet × mcp: no passed case is recorded",
    ]);
  });
});

describe("skipped cases", () => {
  const skipped = (id: string, reason: string, category?: EvidenceCase["skipCategory"]): EvidenceCase => ({
    id,
    title: id,
    checks: ["upstream-e2e"],
    status: "skipped",
    skipReason: reason,
    ...(category === undefined ? {} : { skipCategory: category }),
    elapsedMs: 0,
  });

  it("groups every skip by category and reason, older runs as not categorised", () => {
    const text = renderSkipped(
      set(
        run("upstream-e2e-stellar-testnet.json", "stellar:testnet", "local", [
          skipped("go", "no Go mechanism", "not-applicable"),
          skipped("python", "no Go mechanism", "not-applicable"),
          skipped("old", "an older reason"),
        ]),
      ),
    );
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^\| Category \| Reason/);
    expect(lines[2]).toMatch(/^\| not-applicable \| no Go mechanism .*\| 2 \|/);
    expect(lines[3]).toMatch(/^\| not categorised \| an older reason/);
  });

  it("refuses a required check skipped while it waits on a dependency", () => {
    const waiting = set(
      run("upstream-e2e-stellar-pubnet.json", "stellar:pubnet", "hosted", [
        skipped("upto", "waits for the upstream upto merge", "pending-dependency"),
        skipped("go", "no Go mechanism", "not-applicable"),
      ]),
    );
    expect(skipProblems(waiting)).toEqual([
      "upstream-e2e-stellar-pubnet.json: a required check is skipped waiting on a dependency (waits for the upstream upto merge)",
    ]);
    expect(skipProblems(waiting, ["stellar:testnet"])).toEqual([]);
  });
});

describe("tested against", () => {
  it("names the release, the networks and the watch list's upstream baseline and pins", () => {
    const list = loadWatchList();
    const text = renderTestedAgainst(
      set(run("c.json", "stellar:testnet", "hosted", [])),
      list,
      "0.4.2",
      () => undefined,
    );
    expect(text).toContain(
      `| Rail402 release | \`v0.4.2\` (workspace version; the evidence commit \`${COMMIT.slice(0, 7)}\` has no release tag) |`,
    );
    expect(text).toContain("not checked when the runs were recorded");
    expect(text).toContain(
      `[\`${list.upstream.baselineRef}\`](https://github.com/x402-foundation/x402/commit/${list.upstream.baselineCommit})`,
    );
    for (const entry of list.packages) expect(text).toContain(`\`${entry.name}\` ${entry.pinned}`);
    expect(text).toContain("label%3Aupstream-drift");
  });

  it("names the release tag on the evidence commit and the drift recorded at test time", () => {
    const drifted = run("d.json", "stellar:testnet", "hosted", []);
    const clean = run("e.json", "stellar:pubnet", "hosted", []);
    const withDrift = (loaded: LoadedEvidence, fingerprint: string | null, finishedAt: string) =>
      ({
        ...loaded,
        evidence: { ...loaded.evidence, finishedAt, upstreamDrift: { fingerprint } },
      }) as LoadedEvidence;
    const text = renderTestedAgainst(
      set(
        withDrift(drifted, "ab".repeat(32), "2026-10-22T10:05:00.000Z"),
        withDrift(clean, null, "2026-10-23T10:05:00.000Z"),
      ),
      loadWatchList(),
      "0.4.2",
      (commit) => (commit === COMMIT ? "v0.5.0" : undefined),
    );
    expect(text).toContain(
      `| Rail402 release | \`v0.5.0\` (the tag on the evidence commit \`${COMMIT.slice(0, 7)}\`) |`,
    );
    expect(text).toContain("none when `e.json` was recorded: the watch list matched upstream");
    const older = renderTestedAgainst(
      set(
        withDrift(drifted, "ab".repeat(32), "2026-10-24T10:05:00.000Z"),
        withDrift(clean, null, "2026-10-23T10:05:00.000Z"),
      ),
      loadWatchList(),
      "0.4.2",
      () => undefined,
    );
    expect(older).toContain("fingerprint `abababababab` when `d.json` was recorded");
  });
});
