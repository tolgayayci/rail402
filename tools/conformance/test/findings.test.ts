import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, commitOnRelease } from "../src/evidence.ts";
import {
  FORBIDDEN_WORDS_FILE,
  findingProblems,
  forbiddenWords,
  loadForbiddenWords,
  loadFindings,
  releaseProblems,
  type Finding,
  type FindingsRegister,
} from "../src/findings.ts";
import { loadThreats } from "../src/threats.ts";

const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");
const register = loadFindings();
const threats = loadThreats();
const onMain = (commit: string) => {
  const ancestry = commitOnRelease(commit);
  return ancestry.status === "unknown" ? undefined : ancestry.status === "reachable";
};

describe("the findings register", () => {
  it("gives every finding a severity, a status, a fix commit or an acceptance, and a test that exists", () => {
    expect(findingProblems(register, threats, { commitOnMain: onMain })).toEqual([]);
  });

  it("numbers findings in order", () => {
    const numbers = register.findings.map((entry) => Number(entry.id.slice(-3)));
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });
});

describe("finding checks", () => {
  const base = register.findings.find((entry) => entry.status === "fixed") as Finding;
  const withFinding = (changes: Partial<Finding>): FindingsRegister => ({
    ...register,
    findings: [{ ...base, ...changes }],
  });

  it("refuse a fixed finding without a commit or a test, and a test that does not exist", () => {
    expect(findingProblems(withFinding({ fix: null }), threats)).toEqual(
      expect.arrayContaining([`${base.id}: fixed without a fix commit`, `${base.id}: fixed without a test`]),
    );
    const problems = findingProblems(
      withFinding({
        fix: {
          commit: base.fix?.commit ?? null,
          tests: [
            "packages/sdk/test/nowhere.test.ts::a test",
            "packages/sdk/test/ledger.test.ts::never written",
          ],
        },
      }),
      threats,
    );
    expect(problems).toEqual([
      `${base.id}: test cites a missing file packages/sdk/test/nowhere.test.ts`,
      `${base.id}: packages/sdk/test/ledger.test.ts has no test named "never written"`,
    ]);
  });

  it("refuse an accepted finding without an acceptance, and an accepted high", () => {
    const problems = findingProblems(withFinding({ status: "accepted", severity: "high" }), threats);
    expect(problems).toEqual(
      expect.arrayContaining([
        `${base.id}: accepted without an acceptance text`,
        `${base.id}: a high finding cannot be accepted`,
      ]),
    );
  });

  it("refuse unknown reviews and threats, a fix commit off main, and dates out of order", () => {
    const problems = findingProblems(
      withFinding({ review: "REV-2000-01-none", threats: ["Z9"], resolvedAt: "2000-01-01" }),
      threats,
      { commitOnMain: () => false },
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        `${base.id}: unknown review REV-2000-01-none`,
        `${base.id}: unknown threat Z9`,
        `${base.id}: resolved before it was reported`,
        expect.stringMatching(/fix commit [0-9a-f]{12} is not on main/),
      ]),
    );
  });

  it("refuse internal wording in any text", () => {
    const words = ["codename", "build-farm"];
    expect(forbiddenWords("Found by the codename team on the build-farm", words)).toEqual([
      "codename",
      "build-farm",
    ]);
    expect(forbiddenWords("codenames from a build-farmer", words)).toEqual([]);
    expect(
      findingProblems(withFinding({ description: "Seen on Codename." }), threats, { forbiddenWords: words }),
    ).toEqual(['internal wording (codename): "Seen on Codename."']);
  });

  it("read the refused words from a local file that is never committed", () => {
    const root = mkdtempSync(join(tmpdir(), "rail402-words-"));
    try {
      expect(loadForbiddenWords(root, {})).toEqual([]);
      writeFileSync(join(root, FORBIDDEN_WORDS_FILE), "# local list\nCodename\n\nbuild-farm # vendor\n");
      expect(loadForbiddenWords(root, {})).toEqual(["codename", "build-farm"]);
      const other = join(root, "elsewhere.txt");
      writeFileSync(other, "other\n");
      expect(loadForbiddenWords(root, { RAIL402_FORBIDDEN_WORDS_FILE: other })).toEqual(["other"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(read(".gitignore").split("\n")).toContain(`/${FORBIDDEN_WORDS_FILE}`);
  });

  it("gate a release on the tag and on open or accepted critical and high findings", () => {
    const tagged = {
      ...register,
      testedRevision: { ...register.testedRevision, tag: "v1.0.0" },
      findings: [base],
    };
    expect(releaseProblems(tagged, "v1.0.0")).toEqual([]);
    expect(releaseProblems(tagged, "v1.0.1")).toEqual(["testedRevision.tag is v1.0.0, not v1.0.1"]);
    const open = {
      ...tagged,
      findings: [{ ...base, status: "open" as const, severity: "critical" as const }],
    };
    expect(releaseProblems(open, "v1.0.0")).toEqual([`${base.id}: critical finding is open`]);
  });
});
