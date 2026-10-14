import { describe, expect, it } from "vitest";
import { checkEvidence, type Evidence, type EvidenceCase } from "../src/evidence.ts";
import { PLAYGROUND_CASES, livePlaygroundProblems } from "../src/live-playground-checks.ts";

const PAYER = "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A";
const SPONSOR = "GDZREJ6UXJDL7IMLRMHP4F6RM37TF3WUGRB7GPE5G4IUIXKS6ISZPVEQ";
const hashOf = (index: number) => index.toString(16).padStart(64, "0");

const transaction = (hash: string) => ({
  hash,
  ledger: 10,
  scheme: "exact",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  decimals: 7,
  amount: "10000",
  payerType: "G" as const,
  feeChargedStroops: "100",
  feeSource: SPONSOR,
  innerSource: SPONSOR,
  innerSequence: "1",
  transfers: [{ from: PAYER, to: SPONSOR, amount: "10000" }],
  explorer: `https://stellar.expert/explorer/testnet/tx/${hash}`,
});

const PAYING = new Set(["pay-exact", "replay", "pay-upto", "agent-mcp", "sell-listed", "refusal-session"]);
const REFUSED = new Set([
  "cap-below-price",
  "replay",
  "overcharge",
  "refusal-network",
  "refusal-asset",
  "refusal-amount",
  "refusal-recipient",
  "refusal-session",
  "ssrf-literal",
  "ssrf-metadata",
  "redirect",
]);

/** A run where every case passed, with the transactions and observations each needs. */
function complete(): EvidenceCase[] {
  const classic = [1, 2, 3].map((index) => ({ hash: hashOf(index), ledger: 9 }));
  let next = 10;
  const cases = PLAYGROUND_CASES.map((id): EvidenceCase => {
    const observations: Record<string, unknown> = {};
    if (id === "onboarding") observations["classicTransactions"] = classic;
    if (REFUSED.has(id) && id !== "replay" && id !== "refusal-session")
      observations["balancesUnchanged"] = true;
    if (id === "secret-scan") observations["secretScan"] = { hits: 0, plantedLeakFound: true };
    return {
      id,
      title: id,
      checks: ["playground"],
      status: "passed",
      elapsedMs: 1,
      ...(PAYING.has(id) ? { transactions: [transaction(hashOf(next++))] } : {}),
      ...(REFUSED.has(id)
        ? { rejections: [{ surface: "http" as const, operation: id, code: "payment_refused", reason: "no" }] }
        : {}),
      observations,
    };
  });
  const hashes = [
    ...classic.map((item) => item.hash),
    ...cases.flatMap((entry) => (entry.transactions ?? []).map((item) => item.hash)),
  ];
  const explorer = cases.find((entry) => entry.id === "explorer");
  if (explorer !== undefined) {
    explorer.observations = { transactions: hashes.map((hash) => ({ hash, apiStatus: 200 })) };
  }
  return cases;
}

function document(cases: EvidenceCase[]): Evidence {
  const count = (status: EvidenceCase["status"]) => cases.filter((entry) => entry.status === status).length;
  return {
    schemaVersion: 2,
    kind: "live-playground",
    runId: "run",
    startedAt: "2026-10-03T10:00:00.000Z",
    finishedAt: "2026-10-03T10:10:00.000Z",
    network: "stellar:testnet",
    target: { mode: "local", facilitatorUrl: "http://127.0.0.1:8080", healthVersion: "0.4.0", supported: {} },
    harness: { commit: "c".repeat(40), dirty: false },
    packages: { "@rail402.dev/playground": "0.4.0" },
    command: "node tools/conformance/src/live-playground.ts",
    config: {},
    accounts: { payer: PAYER },
    summary: {
      total: cases.length,
      passed: count("passed"),
      failed: count("failed"),
      skipped: count("skipped"),
    },
    cases,
  };
}

const replace = (cases: EvidenceCase[], id: string, change: (entry: EvidenceCase) => EvidenceCase) =>
  cases.map((entry) => (entry.id === id ? change(entry) : entry));

describe("live-playground evidence", () => {
  it("accepts a complete run, which is also valid schemaVersion 2 evidence", () => {
    const evidence = document(complete());
    expect(checkEvidence(evidence).problems).toEqual([]);
    expect(livePlaygroundProblems(evidence)).toEqual([]);
  });

  it("requires the session check to record the payment it made before the refusal", () => {
    const cases = replace(complete(), "refusal-session", (entry) => {
      const { transactions: _paid, ...rest } = entry;
      return rest;
    });
    expect(livePlaygroundProblems(document(cases))).toContain("case refusal-session records no transaction");
  });

  it("accepts the cases a run against a deployed Rail402 skips, with a reason", () => {
    const cases = complete().map((entry) =>
      ["sell-listed", "ssrf-literal", "redirect"].includes(entry.id)
        ? {
            id: entry.id,
            title: entry.title,
            checks: entry.checks,
            status: "skipped" as const,
            skipReason: "not here",
            elapsedMs: 0,
          }
        : entry,
    );
    // The explorer lists only what was paid.
    expect(livePlaygroundProblems(document(cases))).toEqual([]);
  });

  it("refuses a missing, failed or wrongly skipped case", () => {
    const cases = complete()
      .filter((entry) => entry.id !== "agent-mcp")
      .map((entry) =>
        entry.id === "pay-upto"
          ? { ...entry, status: "failed" as const }
          : entry.id === "overcharge"
            ? {
                id: entry.id,
                title: entry.title,
                checks: entry.checks,
                status: "skipped" as const,
                skipReason: "no",
                elapsedMs: 0,
              }
            : entry,
      );
    expect(livePlaygroundProblems(document(cases))).toEqual(
      expect.arrayContaining([
        "case agent-mcp is missing",
        "case pay-upto failed",
        "case overcharge must not be skipped",
      ]),
    );
  });

  it("refuses a payment without its transaction, a refusal without its code or with a moved balance", () => {
    let cases = replace(complete(), "pay-exact", ({ transactions: _, ...entry }) => entry);
    cases = replace(cases, "refusal-asset", ({ rejections: _, ...entry }) => entry);
    cases = replace(cases, "ssrf-metadata", (entry) => ({ ...entry, observations: {} }));
    expect(livePlaygroundProblems(document(cases))).toEqual([
      "case pay-exact records no transaction",
      "case refusal-asset records no rejection",
      "case ssrf-metadata does not record an unchanged balance",
    ]);
  });

  it("refuses onboarding without its three transactions and a transaction the explorer did not show", () => {
    let cases = replace(complete(), "onboarding", (entry) => ({
      ...entry,
      observations: { classicTransactions: [{ hash: hashOf(1) }] },
    }));
    cases = replace(cases, "explorer", (entry) => {
      const listed = entry.observations?.["transactions"] as { hash: string; apiStatus: number }[];
      return {
        ...entry,
        observations: {
          transactions: listed
            .filter((item) => item.hash !== hashOf(1))
            .map((item) => (item.hash === hashOf(10) ? { ...item, apiStatus: 404 } : item)),
        },
      };
    });
    expect(livePlaygroundProblems(document(cases))).toEqual([
      "onboarding must record its three setup transactions",
      `transaction ${hashOf(10)}: the explorer answered 404`,
      `transaction ${hashOf(1)} was not checked in the explorer`,
    ]);
  });

  it("refuses a secret scan with a hit, or one that did not find its planted leak", () => {
    for (const secretScan of [
      { hits: 1, plantedLeakFound: true },
      { hits: 0, plantedLeakFound: false },
    ]) {
      const cases = replace(complete(), "secret-scan", (entry) => ({
        ...entry,
        observations: { secretScan },
      }));
      expect(livePlaygroundProblems(document(cases))).toEqual([
        "the secret scan must record 0 hits and a found planted leak",
      ]);
    }
  });

  it("refuses a case that does not name the playground check, and another kind", () => {
    const cases = replace(complete(), "explorer", (entry) => ({ ...entry, checks: ["agent-payments"] }));
    expect(livePlaygroundProblems({ ...document(cases), kind: "live-agent" })).toEqual([
      "kind is live-agent, not live-playground",
      "case explorer does not name the playground check",
    ]);
  });
});
