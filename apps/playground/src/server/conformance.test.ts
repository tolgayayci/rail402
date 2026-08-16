import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { Keypair } from "@stellar/stellar-sdk";
import { ALL_ERROR_CODES } from "@rail402.dev/errors";
import { loadConfig, type PlaygroundConfig } from "./config.js";
import { createApp } from "./app.js";
import {
  DEFAULT_STATUS_DIR,
  assessSupported,
  buildConformanceReport,
  errorRegistryStats,
  groupSettlements,
  listErrorRegistry,
  loadStatusEvidence,
  type ConformanceReport,
} from "./conformance.js";

/**
 * The conformance panel's one product rule is honesty: no criterion may claim `met` beyond what
 * its evidence shows. These tests pin that — most importantly that a recorded e2e `regression`
 * verdict renders as `failing`, never `met`, and that missing artifacts render `unknown`.
 */

const SECRET = Keypair.random().secret();

/** A verbatim-shaped /supported: both schemes, both sponsored — the healthy case. */
const SUPPORTED = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } },
    {
      x402Version: 2,
      scheme: "upto",
      network: "stellar:testnet",
      extra: { uptoContract: "CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X", areFeesSponsored: true },
    },
  ],
  extensions: ["bazaar"],
};

/** Fixture status artifacts mirroring the real files' shapes — including the honest 2/4 e2e run. */
const FIXTURE_ACCEPTANCE = {
  network: "stellar:testnet",
  criteria: [
    { id: 1, criterion: "An unmodified canonical client…", status: "met", evidence: "stock client run", transaction: "3f6031ed".padEnd(64, "0") },
    { id: 2, criterion: "supported extra", status: "met", evidence: "byte-identical to x402.org" },
    { id: 3, criterion: "payload verbatim", status: "met", evidence: "no local variants" },
    { id: 5, criterion: "hash per scheme", status: "met", evidence: "hashes below" },
  ],
  settlements: [
    { scheme: "exact", transaction: "a".repeat(64), note: "stock client" },
    { scheme: "exact", transaction: "b".repeat(64) },
    { scheme: "upto", transaction: "c".repeat(64), note: "partial settlement" },
  ],
};
const FIXTURE_DUAL = {
  generatedAt: "2026-08-01T11:18:06.766Z",
  pinned: { sha: "183b2706", ok: false, scenarios: { passed: 2, failed: 2 } },
  latest: { sha: "ee1b148d", ok: false, scenarios: { passed: 2, failed: 2 } },
  verdict: "regression",
  note: "2 of 4 scenarios passed; the failing 2 are a diagnosed upstream harness defect.",
};
const FIXTURE_AUDIT = {
  check: "rejection-audit",
  status: "pass",
  observedAt: "2026-08-06T13:23:15.607Z",
  observations: { referenceTransaction: "d".repeat(64), casesPassed: 19, casesTotal: 19, cases: [] },
};

let fixtureDir: string;
let emptyDir: string;
let stub: ServerType;
let facilitatorUrl: string;

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "pg-status-"));
  writeFileSync(join(fixtureDir, "acceptance.json"), JSON.stringify(FIXTURE_ACCEPTANCE));
  writeFileSync(join(fixtureDir, "conformance-dual.json"), JSON.stringify(FIXTURE_DUAL));
  writeFileSync(join(fixtureDir, "rejection-audit.json"), JSON.stringify(FIXTURE_AUDIT));
  emptyDir = mkdtempSync(join(tmpdir(), "pg-status-empty-"));

  const facilitator = new Hono();
  facilitator.get("/supported", c => c.json(SUPPORTED));
  await new Promise<void>(resolve => {
    stub = serve({ fetch: facilitator.fetch, port: 0 }, info => {
      facilitatorUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  stub.close();
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

function makeApp(deps: { statusDir?: string; fetchImpl?: typeof fetch } = {}) {
  const config: PlaygroundConfig = loadConfig({
    PLAYGROUND_DISPENSER_SECRET: SECRET,
    PLAYGROUND_FACILITATOR_URL: facilitatorUrl,
  } as NodeJS.ProcessEnv);
  return { config, ...createApp({ config, statusDir: deps.statusDir ?? fixtureDir, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }) };
}

describe("error registry projection", () => {
  it("covers the whole registry, every entry with a non-empty reason", () => {
    const listed = listErrorRegistry();
    expect(listed.length).toBe(ALL_ERROR_CODES.length);
    for (const entry of listed) {
      expect(entry.reason.length, `${entry.code} must carry a reason`).toBeGreaterThan(0);
      expect(typeof entry.retryable).toBe("boolean");
      expect(entry.surface.length).toBeGreaterThan(0);
      expect(["spec", "library", "local"]).toContain(entry.provenance);
    }
  });

  it("stats agree with the projection", () => {
    const stats = errorRegistryStats();
    const listed = listErrorRegistry();
    expect(stats.total).toBe(listed.length);
    expect(stats.retryable).toBe(listed.filter(e => e.retryable).length);
    expect(Object.values(stats.surfaces).reduce((a, b) => a + b, 0)).toBe(stats.total);
  });
});

describe("assessSupported", () => {
  it("is met only when every Stellar kind is sponsored", () => {
    expect(assessSupported(SUPPORTED).status).toBe("met");
    const unsponsored = {
      kinds: [{ scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: false } }],
    };
    expect(assessSupported(unsponsored).status).toBe("failing");
    const missingExtra = { kinds: [{ scheme: "exact", network: "stellar:testnet" }] };
    expect(assessSupported(missingExtra).status).toBe("failing");
    expect(assessSupported({}).status).toBe("failing");
    expect(assessSupported({ kinds: [] }).status).toBe("failing");
  });
});

describe("status evidence", () => {
  it("loads the fixture artifacts and groups settlements by scheme", () => {
    const evidence = loadStatusEvidence(fixtureDir);
    expect(evidence.acceptance).not.toBeNull();
    expect(evidence.dual?.verdict).toBe("regression");
    expect(evidence.rejectionAudit?.status).toBe("pass");
    const hashes = groupSettlements(evidence);
    expect(hashes["exact"]).toHaveLength(2);
    expect(hashes["upto"]).toHaveLength(1);
    expect(hashes["upto"]![0]!.note).toBe("partial settlement");
  });

  it("parses the REAL repo artifacts (schema drift between them and this parser fails here, not live)", () => {
    const evidence = loadStatusEvidence(DEFAULT_STATUS_DIR);
    expect(evidence.acceptance).not.toBeNull();
    expect(evidence.dual).not.toBeNull();
    expect(evidence.rejectionAudit).not.toBeNull();
    const hashes = groupSettlements(evidence);
    expect((hashes["exact"] ?? []).length).toBeGreaterThan(0);
    expect((hashes["upto"] ?? []).length).toBeGreaterThan(0);
  });

  it("treats missing files as null, never a fabricated shape", () => {
    const evidence = loadStatusEvidence(emptyDir);
    expect(evidence.acceptance).toBeNull();
    expect(evidence.dual).toBeNull();
    expect(evidence.rejectionAudit).toBeNull();
  });
});

describe("buildConformanceReport honesty", () => {
  const build = (overrides: Partial<Parameters<typeof buildConformanceReport>[0]> = {}) =>
    buildConformanceReport({
      network: "stellar:testnet",
      facilitatorUrl: "https://facilitator.example",
      supported: SUPPORTED,
      evidence: loadStatusEvidence(fixtureDir),
      checkedAt: "2026-08-15T00:00:00.000Z",
      ...overrides,
    });

  it("renders the recorded e2e regression as failing — never met", () => {
    const report = build();
    const e2e = report.acceptance.find(a => a.id === "e2e-suite")!;
    expect(e2e.status).toBe("failing");
    expect(e2e.evidence["scenarios"]).toEqual({ passed: 2, failed: 2 });
    expect(String(e2e.evidence["detail"])).toContain("upstream");
  });

  it("every met criterion carries evidence beyond a bare flag", () => {
    const report = build();
    expect(report.acceptance).toHaveLength(6);
    for (const entry of report.acceptance) {
      expect(entry.how.length).toBeGreaterThan(0);
      if (entry.status === "met") {
        expect(Object.keys(entry.evidence).length, `${entry.id} claims met`).toBeGreaterThan(0);
      }
    }
  });

  it("renders unknown, with the registry half still present, when no artifacts shipped", () => {
    const report = build({ evidence: loadStatusEvidence(emptyDir) });
    const byId = Object.fromEntries(report.acceptance.map(a => [a.id, a]));
    expect(byId["e2e-suite"]!.status).toBe("unknown");
    expect(byId["settled-hash-per-scheme"]!.status).toBe("unknown");
    expect(byId["stock-client"]!.status).toBe("unknown");
    // The live-judged criterion is unaffected by missing files.
    expect(byId["supported-extra"]!.status).toBe("met");
    // Registry stats are computed, not read from disk — they survive.
    const reasons = byId["reason-on-every-rejection"]!;
    expect(reasons.status).toBe("unknown");
    expect((reasons.evidence["registry"] as { total: number }).total).toBe(ALL_ERROR_CODES.length);
    expect(report.settledHashes).toEqual({});
  });

  it("judges settled-hash-per-scheme from the hashes present, not the curated claim", () => {
    const evidence = loadStatusEvidence(fixtureDir);
    const withoutUpto = {
      ...evidence,
      acceptance: {
        criteria: evidence.acceptance!.criteria,
        settlements: evidence.acceptance!.settlements.filter(s => s.scheme !== "upto"),
      },
    };
    const report = build({ evidence: withoutUpto });
    expect(report.acceptance.find(a => a.id === "settled-hash-per-scheme")!.status).toBe("failing");
  });
});

describe("wire: /conformance and /conformance/errors", () => {
  it("serves the full panel against a live facilitator stub", async () => {
    const { app } = makeApp();
    const res = await app.request("/conformance");
    expect(res.status).toBe(200);
    const report = (await res.json()) as ConformanceReport;
    expect(report.network).toBe("stellar:testnet");
    expect(report.supported).toEqual(SUPPORTED);
    expect(report.acceptance.find(a => a.id === "supported-extra")!.status).toBe("met");
    expect(report.errorRegistry.total).toBe(ALL_ERROR_CODES.length);
    expect(report.sources["conformanceDual"]!["present"]).toBe(true);
  });

  it("serves the browsable error registry", async () => {
    const { app } = makeApp();
    const res = await app.request("/conformance/errors");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; retryable: number; errors: { code: string; reason: string }[] };
    expect(body.total).toBe(ALL_ERROR_CODES.length);
    expect(body.errors).toHaveLength(ALL_ERROR_CODES.length);
    expect(body.errors.every(e => e.reason.length > 0)).toBe(true);
  });

  it("refuses with a coded 502 when the facilitator is unreachable", async () => {
    const { app } = makeApp({
      fetchImpl: (() => Promise.reject(new Error("connect ECONNREFUSED"))) as typeof fetch,
    });
    const res = await app.request("/conformance");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe("playground_facilitator_unreachable");
    expect(body.reason).toContain("/supported");
  });

  it("announces the panel in /session/config", async () => {
    const { app } = makeApp();
    const config = (await (await app.request("/session/config")).json()) as {
      demo: { conformance: { panelPath: string; errorsPath: string } };
    };
    expect(config.demo.conformance.panelPath).toBe("/conformance");
    expect(config.demo.conformance.errorsPath).toBe("/conformance/errors");
  });
});
