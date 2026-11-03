import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  RegistryError,
  classifyLedger,
  evidenceProblems,
  parseRegistry,
  registryEvidence,
  type RegistryDocument,
  type RegistryEvidence,
} from "../src/index.ts";
import { REGISTRIES } from "../src/registry-data.ts";
import { ADDRESSES, BETA_LEDGERS, EVIDENCE, ledgerMeta, testnetDocument } from "./helpers.ts";

const PACKAGE = new URL("../", import.meta.url);

const problems = (document: unknown): readonly string[] => {
  try {
    parseRegistry(document);
    return [];
  } catch (error) {
    if (error instanceof RegistryError) return error.problems;
    throw error;
  }
};

const withAccount = (change: Record<string, unknown>): RegistryDocument => {
  const document = testnetDocument();
  const [rail402] = document.facilitators;
  if (rail402 === undefined) throw new Error("fixture");
  const [first, ...rest] = rail402.accounts;
  return {
    ...document,
    facilitators: [
      { ...rail402, accounts: [{ ...first, ...change }, ...rest] },
      ...document.facilitators.slice(1),
    ],
  } as unknown as RegistryDocument;
};

describe("the registry schema", () => {
  it("accepts the test registry", () => {
    expect(problems(testnetDocument())).toEqual([]);
  });

  it("refuses a registry entry without evidence or a ledger range", () => {
    expect(problems(withAccount({ evidence: [] })).join()).toMatch(/evidence/);
    expect(problems(withAccount({ validFromLedger: undefined })).join()).toMatch(/validFromLedger/);
    expect(problems(withAccount({ validToLedger: undefined })).join()).toMatch(/validToLedger/);
    expect(problems(withAccount({ epoch: "2020-01-01" })).join()).toMatch(/unknown epoch/);
    expect(problems(withAccount({ validFromLedger: 10, validToLedger: 5 })).join()).toMatch(/precedes/);
  });

  it("refuses evidence that is not https, not hashed or not archived under its hash", () => {
    for (const evidence of [
      { ...EVIDENCE, url: "http://example.org/supported" },
      { ...EVIDENCE, sha256: "abc" },
      { ...EVIDENCE, archive: "../../etc/passwd" },
      { ...EVIDENCE, archivedAt: "yesterday" },
    ]) {
      expect(problems(withAccount({ evidence: [evidence] })).length).toBeGreaterThan(0);
    }
  });

  it("refuses an address claimed by two facilitators in overlapping ledgers", () => {
    const document = testnetDocument();
    const [, x402org] = document.facilitators;
    if (x402org === undefined) throw new Error("fixture");
    const clash = {
      ...x402org,
      accounts: [
        ...x402org.accounts,
        {
          ...x402org.accounts[0],
          address: ADDRESSES.sponsor,
          validFromLedger: 5_400_000,
        } as (typeof x402org.accounts)[number],
      ],
    };
    expect(problems({ ...document, facilitators: [document.facilitators[0], clash] }).join()).toMatch(
      /overlaps/,
    );
  });

  it("refuses unknown fields, unknown tiers and the shaped tier", () => {
    expect(problems({ ...testnetDocument(), extra: true }).length).toBeGreaterThan(0);
    const document = testnetDocument();
    const [first] = document.facilitators;
    expect(problems({ ...document, facilitators: [{ ...first, tier: "shaped" }] }).length).toBeGreaterThan(0);
  });
});

describe("the published registries", () => {
  it("parse, and name the right network and epochs", () => {
    expect(REGISTRIES["stellar:testnet"].network).toBe("stellar:testnet");
    expect(REGISTRIES["stellar:pubnet"].network).toBe("stellar:pubnet");
    expect(REGISTRIES["stellar:testnet"].document.epochs.map((epoch) => epoch.id)).toContain("2025-12-17");
  });

  it("archive every piece of evidence under its SHA-256", () => {
    for (const registry of Object.values(REGISTRIES)) {
      for (const evidence of registryEvidence(registry.document)) {
        const file = new URL(evidence.archive, PACKAGE);
        expect(existsSync(file), evidence.archive).toBe(true);
        expect(createHash("sha256").update(readFileSync(file)).digest("hex"), evidence.archive).toBe(
          evidence.sha256,
        );
        expect(evidence.archive).toContain(evidence.sha256);
        expect(evidenceProblems(evidence, readFileSync(file)), evidence.archive).toEqual([]);
      }
    }
  });

  it("keep third-party pages only as extracts whose statement names the account", () => {
    for (const registry of Object.values(REGISTRIES)) {
      for (const facilitator of registry.document.facilitators) {
        for (const account of facilitator.accounts) {
          for (const evidence of account.evidence) {
            if (new URL(evidence.url).hostname === "api.github.com") expect(evidence.kind).toBe("extract");
            if (evidence.kind !== "extract") continue;
            const archived = readFileSync(new URL(evidence.archive, PACKAGE));
            expect(evidenceProblems(evidence, archived, account.address), evidence.archive).toEqual([]);
          }
        }
      }
    }
  });

  it("match every upto contract's WASM hash to its deployment record", () => {
    for (const registry of Object.values(REGISTRIES)) {
      for (const entry of registry.document.uptoContracts) {
        if (entry.deploymentRecord === undefined) continue;
        const record = JSON.parse(
          readFileSync(new URL(`../../../${entry.deploymentRecord}`, import.meta.url), "utf8"),
        ) as {
          contract_id: string;
          wasm_sha256: string;
          previous?: { contract_id: string; wasm_sha256: string }[];
        };
        const known = [record, ...(record.previous ?? [])].find(
          (item) => item.contract_id === entry.contract,
        );
        expect(known?.wasm_sha256, entry.contract).toBe(entry.wasmSha256);
      }
    }
  });
});

describe("the concluded beta on testnet", () => {
  it("labels settlements through the beta's testnet contracts as beta history, whoever submitted them", () => {
    const ctx = {
      network: "stellar:testnet" as const,
      epoch: "2025-12-17",
      passphrase: Networks.TESTNET,
      registry: REGISTRIES["stellar:testnet"],
    };
    const rows = [3_912_565, 3_953_878].flatMap(
      (sequence) => classifyLedger(ledgerMeta(sequence, BETA_LEDGERS), ctx).rows,
    );
    expect(
      rows.map((row) => [
        row.txHash.slice(0, 8),
        row.ruleId,
        row.attribution.tier,
        row.amount,
        row.maxAmount,
      ]),
    ).toEqual([
      ["5ec8b20c", "R-UPTO-BETA", "rail402-beta", "3500000", "10000000"],
      ["b38c1add", "R-UPTO-BETA", "rail402-beta", "3500000", "10000000"],
    ]);
    expect(rows[0]?.attribution.evidenceUrl).toContain(
      "CBHDZLYADBUEBP3KK4WLPG3TWKSYWQO4MTVKYCRY3Z6WY4QFLNJYBSEU",
    );
  });

  it("closes every concluded beta contract's range, so later calls are not beta history", () => {
    for (const registry of Object.values(REGISTRIES)) {
      for (const entry of registry.document.uptoContracts.filter((item) => item.rule === "R-UPTO-BETA")) {
        expect(entry.validToLedger, entry.contract).not.toBeNull();
        const end = entry.validToLedger ?? 0;
        expect(registry.uptoContractAt(entry.contract, entry.epoch, end)?.rule).toBe("R-UPTO-BETA");
        expect(registry.uptoContractAt(entry.contract, entry.epoch, end + 1)).toBeUndefined();
      }
    }
  });

  it("refuses a beta contract owned by a facilitator outside the beta tier", () => {
    const document = structuredClone(REGISTRIES["stellar:pubnet"].document);
    const [entry] = document.uptoContracts;
    if (entry !== undefined) entry.facilitatorId = "built-on-stellar";
    expect(() => parseRegistry(document)).toThrow(/rail402-beta facilitator/);
  });
});

describe("the published entries", () => {
  it("list the hosted service's current and previous accounts without overlap, and no self-hosted ones", () => {
    const testnet = REGISTRIES["stellar:testnet"];
    expect(testnet.accountAt(ADDRESSES.sponsor, "2025-12-17", 5_330_311)?.facilitator.id).toBe("rail402");
    expect(testnet.accountAt(ADDRESSES.previousSponsor, "2025-12-17", 5_189_151)?.facilitator.id).toBe(
      "rail402",
    );
    expect(testnet.accountAt(ADDRESSES.previousSponsor, "2025-12-17", 5_330_311)).toBeUndefined();
    expect(testnet.accountAt(ADDRESSES.authority, "2025-12-17", 5_330_316)?.account.role).toBe(
      "upto-authority",
    );
    expect(testnet.accountAt(ADDRESSES.x402orgFeeBump, "2025-12-17", 5_330_791)?.facilitator.tier).toBe(
      "facilitator",
    );
    expect(testnet.uptoContractAt(ADDRESSES.upto, "2025-12-17", 5_330_316)?.rule).toBe("R-UPTO");
  });

  it("label the shared relayer and keep the beta apart from the hosted service", () => {
    const pubnet = REGISTRIES["stellar:pubnet"];
    expect(pubnet.facilitator("built-on-stellar")?.sharedRelayer).toBe(true);
    expect(pubnet.accountAt(ADDRESSES.beta, "pubnet", 63_985_581)?.facilitator.tier).toBe("rail402-beta");
    expect(pubnet.document.facilitators.some((entry) => entry.tier === "rail402")).toBe(false);
    expect(pubnet.uptoContractAt(ADDRESSES.betaUpto, "pubnet", 63_985_589)?.rule).toBe("R-UPTO-BETA");
  });
});

describe("evidence extracts", () => {
  const SOURCE = "b".repeat(64);
  const ADDRESS = ADDRESSES.sponsor;
  const extract = (change: Record<string, unknown> = {}): Buffer =>
    Buffer.from(
      `${JSON.stringify({
        kind: "extract",
        url: "https://api.github.com/repos/example/repo/issues/1",
        html_url: "https://github.com/example/repo/issues/1",
        created_at: "2026-01-01T00:00:00Z",
        author: "operator",
        statement: `Our fee-bump account is ${ADDRESS}`,
        sourceSha256: SOURCE,
        ...change,
      })}\n`,
    );
  const entry = (archived: Buffer, change: Record<string, unknown> = {}): RegistryEvidence => {
    const sha256 = createHash("sha256").update(archived).digest("hex");
    return {
      url: "https://api.github.com/repos/example/repo/issues/1",
      sha256,
      kind: "extract",
      sourceSha256: SOURCE,
      archivedAt: "2026-10-22T00:00:00Z",
      archive: `registry/evidence/${sha256}.json`,
      ...change,
    };
  };

  it("accepts an extract that quotes the entry's URL, source hash and account", () => {
    const archived = extract();
    expect(evidenceProblems(entry(archived), archived, ADDRESS)).toEqual([]);
    expect(problems(withAccount({ evidence: [entry(archived)] }))).toEqual([]);
  });

  it("refuses an extract for another URL, another source, without the account or with extra fields", () => {
    for (const [archived, pattern] of [
      [extract({ url: "https://api.github.com/repos/example/repo/issues/2" }), /quotes/],
      [extract({ sourceSha256: "c".repeat(64) }), /source SHA-256/],
      [extract({ statement: "no account here" }), /does not name/],
      [extract({ body: "the whole page" }), /not an evidence extract/],
      [Buffer.from("not json"), /not JSON/],
    ] as const) {
      expect(evidenceProblems(entry(archived), archived, ADDRESS).join()).toMatch(pattern);
    }
  });

  it("refuses an archive that does not hash to its entry, extract or copy", () => {
    const archived = extract();
    const tampered = extract({ author: "someone-else" });
    expect(evidenceProblems(entry(archived), tampered, ADDRESS).join()).toMatch(/SHA-256/);
    expect(evidenceProblems({ ...EVIDENCE }, Buffer.from("x")).join()).toMatch(/SHA-256/);
  });

  it("requires a source hash exactly for extracts", () => {
    const archived = extract();
    expect(
      problems(withAccount({ evidence: [entry(archived, { sourceSha256: undefined })] })).join(),
    ).toMatch(/sourceSha256/);
    expect(problems(withAccount({ evidence: [{ ...EVIDENCE, sourceSha256: SOURCE }] })).join()).toMatch(
      /sourceSha256/,
    );
    expect(
      problems(
        withAccount({ evidence: [entry(archived, { archive: `registry/evidence/${"d".repeat(64)}.txt` })] }),
      ).join(),
    ).toMatch(/JSON/);
  });
});
