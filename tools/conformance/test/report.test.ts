import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, runFileName } from "../src/evidence.ts";
import { PAGES, applyBlocks, hostedFileName, renderAll } from "../src/report.ts";
import { code, escape, prose, renderBenchmark, renderCurrent, units } from "../src/render-evidence.ts";
import type { Evidence, EvidenceTransaction } from "../src/evidence.ts";
import type { EvidenceSet } from "../src/evidence-set.ts";
import {
  renderCanonical,
  renderFaultRecovery,
  renderMcp,
  renderRelease,
  renderSettlements,
  renderSummary,
  renderSupported,
  renderUpstreamRuns,
} from "../src/render-report.ts";
import { HOSTED_BAZAAR_NOT_APPLICABLE } from "../src/upstream-e2e-output.ts";
import { loadDeploymentRecord, renderDeploymentRecord, renderDeployments } from "../src/render-deployment.ts";

describe("generated pages", () => {
  it("are up to date with the committed evidence (run `pnpm report` after changing either)", async () => {
    for (const file of await renderAll()) {
      expect(file.current, `${file.path} is out of date; run pnpm report`).toBe(file.rendered);
    }
  });

  it("covers every page that carries generated blocks", () => {
    const marked = readdirSync(join(REPO_ROOT, "docs"), { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".mdx") || path.endsWith(".md"))
      .filter((path) => readFileSync(join(REPO_ROOT, "docs", path), "utf8").includes("generated:begin"))
      .map((path) => `docs/${path}`)
      .sort();
    expect([...PAGES.map((page) => page.path)].sort()).toEqual(marked);
  });
});

describe("the settlement contract page", () => {
  it("shows the deployment record's own values, so a changed record changes the page", () => {
    const record = loadDeploymentRecord(REPO_ROOT);
    const page = readFileSync(join(REPO_ROOT, "docs/reference/upto-contract.mdx"), "utf8");
    for (const value of [
      record.commit,
      record.source_sha256,
      record.bldimg,
      record.deployer,
      record.transactions.deploy.tx,
      ...(record.previous ?? []).map((entry) => entry.contract_id),
    ]) {
      expect(page).toContain(value);
    }
    const moved = { ...record, commit: "f".repeat(40) };
    const revision = (rendered: string) =>
      rendered.split("\n").find((line) => line.startsWith("| Source revision"));
    expect(revision(renderDeploymentRecord(moved))).toContain(`\`${"f".repeat(40)}\``);
    expect(revision(renderDeploymentRecord(moved))).not.toContain(record.commit);
    expect(renderDeployments(record)).toContain(
      `https://stellar.expert/explorer/testnet/contract/${record.contract_id}`,
    );
  });

  it("names each replaced deployment's deploy transaction, source revision and note", () => {
    const record = loadDeploymentRecord(REPO_ROOT);
    const replaced = {
      contract_id: record.contract_id,
      wasm_sha256: record.wasm_sha256,
      commit: "e".repeat(40),
      salt_preimage: "earlier",
      deploy: record.transactions.deploy,
    };
    const plain = renderDeploymentRecord({ ...record, previous: [replaced] });
    expect(plain).toContain(
      `deployed in \`${record.transactions.deploy.tx}\` (ledger ${record.transactions.deploy.ledger}) from source revision \`${"e".repeat(40)}\` |`,
    );
    const noted = renderDeploymentRecord({
      ...record,
      previous: [{ ...replaced, note: "Built another way." }],
    });
    expect(noted).toContain(`\`${"e".repeat(40)}\`. Built another way. |`);
  });
});

describe("applyBlocks", () => {
  const page = [
    "intro",
    "{/* generated:begin a */}",
    "old a",
    "{/* generated:end */}",
    "middle",
    "{/* generated:begin b */}",
    "{/* generated:end */}",
    "outro",
  ].join("\n");

  it("replaces only the content between markers", () => {
    expect(applyBlocks("p", page, { a: "new a", b: "new b" })).toBe(
      [
        "intro",
        "{/* generated:begin a */}\n\nnew a\n\n{/* generated:end */}",
        "middle",
        "{/* generated:begin b */}\n\nnew b\n\n{/* generated:end */}",
        "outro",
      ].join("\n"),
    );
  });

  it("refuses unknown, missing, duplicated and unbalanced blocks", () => {
    expect(() => applyBlocks("p", page, { a: "x" })).toThrow(/unknown generated block "b"/);
    expect(() => applyBlocks("p", page, { a: "x", b: "y", c: "z" })).toThrow(/missing generated blocks: c/);
    expect(() =>
      applyBlocks("p", `${page}\n{/* generated:begin a */}\n{/* generated:end */}`, { a: "", b: "" }),
    ).toThrow(/appears twice/);
    expect(() => applyBlocks("p", "{/* generated:begin a */}\ntext", { a: "" })).toThrow(/no matching end/);
    expect(() =>
      applyBlocks("p", "{/* generated:begin a */}\n{/* generated:begin b */}\n{/* generated:end */}", {
        a: "",
        b: "",
      }),
    ).toThrow(/no matching end/);
    expect(() => applyBlocks("p", "text\n{/* generated:end */}", {})).toThrow(/no matching begin/);
  });
});

describe("rendering helpers", () => {
  it("formats amounts in whole units", () => {
    expect(units("100000", 7)).toBe("0.01");
    expect(units("12345678", 7)).toBe("1.2345678");
    expect(units("1", 7)).toBe("0.0000001");
    expect(units("5000000", 6)).toBe("5");
    expect(units("-15", 1)).toBe("-1.5");
  });

  it("keeps evidence text inert inside MDX", () => {
    expect(escape("a <b> {c} | d_e *f*")).toBe("a &lt;b&gt; \\{c\\} \\| d\\_e \\*f\\*");
    expect(code("a`b")).toBe("``a`b``");
    expect(prose("/supported lists extra.areFeesSponsored for payTo via __check_auth")).toBe(
      "`/supported` lists `extra.areFeesSponsored` for `payTo` via `__check_auth`",
    );
  });

  it("renders a current-format run with its provenance and every case", () => {
    const evidence: Evidence = {
      schemaVersion: 2,
      kind: "live-matrix",
      runId: "r",
      startedAt: "2026-09-30T10:00:00.000Z",
      finishedAt: "2026-09-30T10:05:00.000Z",
      network: "stellar:testnet",
      target: {
        mode: "local",
        facilitatorUrl: "http://localhost:8080",
        healthVersion: "0.2.1",
        supported: {},
      },
      harness: { commit: "c".repeat(40), dirty: false },
      packages: { "@x402/core": "2.27.0", "@x402/stellar": "2.27.0" },
      command: "node live-matrix.ts",
      config: {},
      accounts: {},
      summary: { total: 3, passed: 1, failed: 1, skipped: 1 },
      cases: [
        {
          id: "refusals",
          title: "bad input is refused",
          checks: ["rejection-codes"],
          status: "passed",
          elapsedMs: 1,
          rejections: [
            { surface: "facilitator", operation: "verify", code: "invalid_payload", reason: "bad" },
            { surface: "facilitator", operation: "settle", code: "invalid_payload", reason: "bad" },
          ],
        },
        { id: "broken", title: "fails", checks: ["scheme-exact"], status: "failed", elapsedMs: 1 },
        {
          id: "upto",
          title: "upto",
          checks: ["scheme-upto"],
          status: "skipped",
          skipReason: "not advertised",
          elapsedMs: 0,
        },
      ],
    };
    const markdown = renderCurrent("tools/conformance/evidence/x.json", evidence);
    expect(markdown).toContain("**1 of 3 cases passed**, 1 failed, 1 skipped");
    expect(markdown).toContain("`@x402/core`, `@x402/stellar` 2.27.0");
    expect(markdown).toContain(
      `[\`ccccccc\`](https://github.com/tolgayayci/rail402/commit/${"c".repeat(40)})`,
    );
    expect(markdown).toContain("| `refusals` | Bad input is refused | `invalid_payload` |");
    expect(markdown).toContain("| `broken` | Fails | **failed** |");
    expect(markdown).toContain("| `upto` | Upto | skipped: not advertised |");
  });
});

describe("report sections across runs", () => {
  const tx = (hash: string, scheme: string, amount: string): EvidenceTransaction => ({
    hash: hash.repeat(64),
    ledger: 100,
    scheme,
    asset: "C".repeat(56),
    decimals: 7,
    amount,
    payerType: "G",
    feeChargedStroops: "23130",
    feeSource: "G".repeat(56),
    innerSource: "G".repeat(56),
    innerSequence: "1",
    transfers: [],
    explorer: `https://stellar.expert/explorer/testnet/tx/${hash.repeat(64)}`,
  });
  const run = (
    kind: Evidence["kind"],
    cases: Evidence["cases"],
    extra: Partial<Evidence> = {},
  ): Evidence => ({
    schemaVersion: 2,
    kind,
    runId: kind,
    startedAt: "2026-09-30T10:00:00.000Z",
    finishedAt: "2026-09-30T10:05:00.000Z",
    network: "stellar:testnet",
    target: {
      mode: "local",
      facilitatorUrl: "http://localhost:8080",
      healthVersion: "0.3.0",
      supported: { kinds: [] },
    },
    harness: { commit: "c".repeat(40), dirty: false },
    packages: { "@x402/stellar": "2.27.0" },
    command: `node ${kind}.ts`,
    config: {},
    accounts: {},
    summary: {
      total: cases.length,
      passed: cases.filter((entry) => entry.status === "passed").length,
      failed: cases.filter((entry) => entry.status === "failed").length,
      skipped: cases.filter((entry) => entry.status === "skipped").length,
    },
    cases,
    ...extra,
  });
  const setOf = (...runs: [string, Evidence][]): EvidenceSet => ({
    files: runs.map(([file, evidence]) => ({
      file,
      sha256: "0".repeat(64),
      kind: evidence.kind,
      commit: evidence.harness.commit,
      format: "current" as const,
      evidence,
      branch: undefined,
    })),
    problems: [],
  });

  const canonical = run("canonical", [
    {
      id: "upto-usdc-g-payer",
      title: "upto",
      checks: ["scheme-upto", "fees-sponsored"],
      scheme: "upto",
      asset: "USDC",
      payer: "G",
      payTo: "G",
      status: "passed",
      elapsedMs: 1,
      transactions: [tx("a", "upto", "50000")],
      observations: { client: "stock", wire: { payloadKeys: ["authorization"], cap: "100000" } },
    },
    {
      id: "exact-test6-g-payer",
      title: "exact TEST6",
      checks: ["scheme-exact", "second-asset"],
      scheme: "exact",
      asset: "TEST6",
      payer: "G",
      status: "skipped",
      skipReason: "not accepted",
      elapsedMs: 0,
    },
  ]);

  it("counts every check across runs, with the reasons for skips", () => {
    const summary = renderSummary(setOf(["canonical-stellar-testnet.json", canonical]));
    expect(summary).toContain("| `scheme-upto` | 1 | 0 | 0 | `canonical-stellar-testnet.json` |  |");
    expect(summary).toContain(
      "| `second-asset` | 0 | 0 | 1 | `canonical-stellar-testnet.json` | not accepted |",
    );
    expect(summary).toContain("| `front-running` | 0 | 0 | 0 | not recorded yet |  |");
    expect(summary).toContain(
      "| `agent-payments` | 0 | 0 | 0 | not recorded yet | the live-agent run's explorer check needs stellar.expert's testnet API |",
    );
  });

  it("shows /supported as the hosted service answered it, and the local answer only without one", () => {
    const supported = (url: string) => ({
      kinds: [
        { x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } },
      ],
      signers: { "stellar:*": [url] },
    });
    const local = run("canonical", [], {
      target: {
        mode: "local",
        facilitatorUrl: "http://127.0.0.1:8801",
        healthVersion: "0.4.1+aaaaaaaaaaaa",
        supported: supported("GLOCAL"),
      },
    });
    const hosted = run("canonical", [], {
      startedAt: "2026-10-01T10:00:00.000Z",
      target: {
        mode: "hosted",
        facilitatorUrl: "https://testnet.rail402.dev",
        healthVersion: "0.4.1+bbbbbbbbbbbb",
        supported: supported("GHOSTED"),
      },
    });
    const both = renderSupported(
      setOf(["canonical-stellar-testnet.json", local], ["canonical-hosted-stellar-testnet.json", hosted]),
    );
    expect(both).toContain(
      "as the hosted `https://testnet.rail402.dev`, version `0.4.1+bbbbbbbbbbbb` answered it during the canonical run against it (`canonical-hosted-stellar-testnet.json`, 2026-10-01)",
    );
    expect(both).toContain('"GHOSTED"');
    expect(both).not.toContain("GLOCAL");
    const localOnly = renderSupported(setOf(["canonical-stellar-testnet.json", local]));
    expect(localOnly).toContain("No run against a hosted service is recorded.");
    expect(localOnly).toContain('"GLOCAL"');
  });

  it("names the commit of a local process that reported no version", () => {
    const unversioned = run("fault-recovery", [], {
      target: { mode: "local", facilitatorUrl: "http://127.0.0.1:4000", healthVersion: "dev", supported: {} },
    });
    const release = renderRelease(
      setOf(
        ["canonical-stellar-testnet.json", canonical],
        ["fault-recovery-stellar-testnet.json", unversioned],
      ),
    );
    expect(release).toContain("`http://localhost:8080` (local, version `0.3.0`)");
    expect(release).toContain("`http://127.0.0.1:4000` (local, from commit `cccccccccccc`)");
    expect(renderCurrent("x.json", unversioned)).toContain(
      "`http://127.0.0.1:4000` (local), from commit `cccccccccccc`",
    );
    // A hosted service's own answer is shown as it is.
    const hosted = { ...unversioned, target: { ...unversioned.target, mode: "hosted" as const } };
    expect(renderCurrent("x.json", hosted)).toContain("(hosted), version `dev`");
  });

  it("counts a check no testnet run carries from the operational tests, labelled as the private network", () => {
    const ops = run("ops", [
      { id: "front-run", title: "front run", checks: ["front-running"], status: "passed", elapsedMs: 1 },
      { id: "canonical-too", title: "x", checks: ["scheme-upto"], status: "passed", elapsedMs: 1 },
    ]);
    const summary = renderSummary(
      setOf(["canonical-stellar-testnet.json", canonical], ["ops-local-stellar-testnet.json", ops]),
    );
    expect(summary).toContain(
      "| `front-running` | 1 | 0 | 0 | `ops-local-stellar-testnet.json` ([operational tests](/security/operational-tests), private network) |  |",
    );
    // A check a testnet run carries is counted from the testnet runs only.
    expect(summary).toContain("| `scheme-upto` | 1 | 0 | 0 | `canonical-stellar-testnet.json` |  |");
    expect(summary).toContain("| `observability` | 0 | 0 | 0 | not recorded yet |  |");
  });

  it("keeps a run against a deployed service beside the local one", () => {
    const local = run("live-matrix", []);
    const hosted = { ...local, target: { ...local.target, mode: "hosted" as const } };
    expect(runFileName(local)).toBe("live-matrix-stellar-testnet.json");
    expect(runFileName(hosted)).toBe("live-matrix-hosted-stellar-testnet.json");
    expect(runFileName(hosted, "upto")).toBe("live-matrix-upto-hosted-stellar-testnet.json");
    expect(hostedFileName(runFileName(local, "upto"))).toBe(runFileName(hosted, "upto"));
  });

  it("renders the rejection audit against the deployed service beside the local one", () => {
    const refusal = {
      id: "verify-amount",
      title: "a tampered amount is refused",
      checks: ["rejection-codes" as const],
      status: "passed" as const,
      elapsedMs: 1,
      rejections: [
        {
          surface: "facilitator" as const,
          operation: "POST /verify",
          code: "invalid_payload",
          reason: "bad",
        },
      ],
    };
    const local = run("rejection-audit", [refusal]);
    const hosted = {
      ...local,
      target: { ...local.target, mode: "hosted" as const, facilitatorUrl: "https://testnet.rail402.dev" },
    };
    expect(runFileName(hosted)).toBe("rejection-audit-hosted-stellar-testnet.json");
    const block = PAGES.find((page) => page.path === "docs/reference/conformance.mdx")?.blocks[
      "rejection-audit"
    ];
    expect(block).toBeDefined();
    const render = (set: EvidenceSet) =>
      block?.({ evidence: set, threats: {} as never, deployment: {} as never }) ?? "";
    const both = render(setOf([runFileName(local), local], [runFileName(hosted), hosted]));
    expect(both).toContain("`tools/conformance/evidence/rejection-audit-stellar-testnet.json`");
    expect(both).toContain("`tools/conformance/evidence/rejection-audit-hosted-stellar-testnet.json`");
    expect(both).toContain("`https://testnet.rail402.dev` (hosted)");
    expect(render(setOf([runFileName(local), local]))).toContain(
      "No run against the deployed service has been recorded yet (`tools/conformance/evidence/rejection-audit-hosted-stellar-testnet.json`).",
    );
  });

  it("renders the canonical run with each payload's shape and an upto charge against its cap", () => {
    const markdown = renderCanonical("canonical-stellar-testnet.json", canonical);
    expect(markdown).toContain("`{ authorization }`");
    expect(markdown).toContain("0.005 USDC of a 0.01 cap, fee 23,130 stroops");
    expect(markdown).toContain("skipped: not accepted");
    expect(renderSettlements(setOf(["canonical-stellar-testnet.json", canonical]))).toContain(
      "| `upto` | USDC | `G…` | `G…` | 0.005 USDC | 23,130 | 100 |",
    );
  });

  it("renders crash recovery with its kill timeline and final state", () => {
    const markdown = renderFaultRecovery(
      "fault-recovery-stellar-testnet.json",
      run("fault-recovery", [
        {
          id: "k3-exact",
          title: "K3",
          checks: ["crash-recovery"],
          scheme: "exact",
          status: "passed",
          elapsedMs: 1,
          observations: {
            killedAt: "2026-09-30T10:00:01.000Z",
            restartedAt: "2026-09-30T10:00:40.000Z",
            recoveredAt: "2026-09-30T10:00:41.000Z",
            state: "expired",
            distinctEnvelopes: ["b".repeat(64)],
            sendsAfterRestart: 0,
            transaction: "b".repeat(64),
          },
        },
      ]),
    );
    expect(markdown).toContain(
      "| `k3-exact` | K3 | 10:00:01 → 10:00:40 → 10:00:41 | `expired` | 0 | 1 | `bbbbbbbb…` | passed |",
    );
  });

  it("labels an upstream run from an unmerged branch and lists what was not applicable", () => {
    const upstream = run(
      "upstream-e2e",
      [
        {
          id: "fetch-express-upto",
          title: "upto",
          checks: ["upstream-e2e", "scheme-upto"],
          scheme: "upto",
          status: "passed",
          elapsedMs: 1,
        },
        {
          id: "fetch-express-exact",
          title: "exact",
          checks: ["upstream-e2e", "scheme-exact"],
          scheme: "exact",
          status: "failed",
          elapsedMs: 1,
        },
        {
          id: "bazaar-discovery-validation",
          title: "the suite's Bazaar discovery validation",
          checks: ["discovery", "upstream-e2e"],
          status: "failed",
          elapsedMs: 0,
          observations: { result: "FAILED", discovered: "10/15" },
        },
        {
          id: "mcp-client-mcp-server-exact-stellar",
          title: "mcp-client pays mcp-server exact_stellar (upfront)",
          checks: ["upstream-e2e", "scheme-exact", "payload-transaction", "mcp"],
          scheme: "exact",
          status: "passed",
          elapsedMs: 1,
        },
        {
          id: "escrow",
          title: "escrow scheme scenarios",
          checks: ["upstream-e2e"],
          status: "skipped",
          skipReason: "no escrow",
          elapsedMs: 0,
        },
      ],
      {
        upstream: {
          repository: "x402-foundation/x402",
          ref: "feat/stellar-upto",
          commit: "d".repeat(40),
          version: "2.28.0",
          preMerge: true,
        },
      },
    );
    const markdown = renderUpstreamRuns(setOf(["upstream-e2e-upto-premerge-stellar-testnet.json", upstream]));
    expect(markdown).toContain("| `upto` | `feat/stellar-upto` (pre-merge) | 1 / 1 | **failed** (10/15) |");
    expect(markdown).toContain("| `exact` | `feat/stellar-upto` (pre-merge) | 1 / 2 | **failed** (10/15) |");
    expect(markdown).toContain("| the deployed service | hosted |  |  | not recorded yet |  |");
    expect(markdown).toContain("- Escrow scheme scenarios: no escrow");
    const withHosted = renderUpstreamRuns(
      setOf(
        ["upstream-e2e-upto-premerge-stellar-testnet.json", upstream],
        [
          "upstream-e2e-hosted-stellar-testnet.json",
          { ...upstream, target: { ...upstream.target, mode: "hosted" } },
        ],
      ),
    );
    expect(withHosted).not.toContain("not recorded yet");
    // A hosted run's skipped Bazaar validation is shown as not applicable, with why.
    const hostedSkip = run(
      "upstream-e2e",
      [
        upstream.cases[0] as Evidence["cases"][number],
        {
          id: "bazaar-discovery-validation",
          title: "the suite's Bazaar discovery validation",
          checks: ["discovery"],
          status: "skipped",
          skipReason: "an older reason",
          elapsedMs: 0,
        },
      ],
      { target: { ...upstream.target, mode: "hosted" } },
    );
    const hostedRow = renderUpstreamRuns(setOf(["upstream-e2e-hosted-stellar-testnet.json", hostedSkip]));
    expect(hostedRow).toContain(escape(HOSTED_BAZAAR_NOT_APPLICABLE));
    expect(hostedRow).not.toContain("an older reason");
    const mcp = renderMcp(setOf(["upstream-e2e-upto-premerge-stellar-testnet.json", upstream]));
    expect(mcp).toContain("Paid tool calls by the upstream e2e suite's MCP client and server");
    expect(mcp).toContain("mcp-client pays mcp-server exact\\_stellar (upfront)");
  });

  it("renders a current-format benchmark as the comparison table", () => {
    const stats = (p50: number) => ({ n: 2, p50, p95: p50 * 2, mean: p50, min: p50, max: p50 * 2 });
    const settle = (fee: number) => ({
      latencyMs: stats(5000),
      ledgersToConfirm: stats(2),
      sponsorFeeStroops: stats(fee),
      transactions: ["c".repeat(64)],
    });
    const result = (facilitator: string, concurrent: boolean) => ({
      facilitator,
      networkRoundTripMs: stats(40),
      verify: { latencyMs: stats(300) },
      settle: settle(23000),
      settleSmartAccount: settle(90000),
      ...(concurrent
        ? {
            concurrent: {
              ...settle(23000),
              batches: [{ size: 20, wallMs: 9000, succeeded: 20, uniqueTransactions: 20 }],
            },
          }
        : {}),
      failures: [],
    });
    const benchmark = run(
      "benchmark",
      [
        {
          id: "facilitator-1-127-0-0-1-8801",
          title: "under test",
          checks: ["fees-sponsored"],
          status: "passed",
          elapsedMs: 1,
          observations: { result: result("http://127.0.0.1:8801", true) },
        },
        {
          id: "facilitator-2-x402-org-facilitator",
          title: "reference",
          checks: ["fees-sponsored"],
          status: "passed",
          elapsedMs: 1,
          observations: { result: result("https://x402.org/facilitator", false) },
        },
      ],
      {
        config: {
          asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          amountBaseUnits: "100",
          samples: 2,
          smartAccountSamples: 2,
          batches: 1,
          batchSize: 20,
        },
      },
    );
    const markdown = renderBenchmark("tools/conformance/evidence/benchmark-stellar-testnet.json", benchmark);
    expect(markdown).toContain("| Metric | `127.0.0.1:8801` | `x402.org/facilitator` |");
    expect(markdown).toContain("20 of 20 settled, 20 distinct transactions, 9.0–9.0 s per batch");
    expect(markdown).toContain("| not run |");
    // Without measurements it falls back to the case table.
    const bare = run("benchmark", [
      { id: "x", title: "x", checks: ["fees-sponsored"], status: "passed", elapsedMs: 1 },
    ]);
    expect(renderBenchmark("b.json", bare)).toContain("| `x` |");
  });

  it("renders the MCP rows of the rejection audit", () => {
    const audit = run("rejection-audit", [
      {
        id: "mcp-unknown-tool",
        title: "MCP: an unknown tool is a JSON-RPC error carrying a code",
        checks: ["mcp", "rejection-codes"],
        status: "passed",
        elapsedMs: 1,
        rejections: [{ surface: "mcp", operation: "tools/call", code: "tool_unknown", reason: "unknown" }],
      },
    ]);
    const markdown = renderMcp(setOf(["rejection-audit-stellar-testnet.json", audit]));
    expect(markdown).toContain(
      "| `mcp-unknown-tool` | An unknown tool is a JSON-RPC error carrying a code | `tool_unknown` |",
    );
    expect(renderMcp(setOf())).toContain("No MCP run has been recorded yet");
  });
});
