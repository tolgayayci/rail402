import { describe, expect, it } from "vitest";
import { ABSENT, FetchIncomplete, compare, newestInMajor, type Comparison } from "../src/compare.ts";
import { unifiedDiff } from "../src/diff.ts";
import {
  PENDING,
  SOURCE,
  SPEC,
  STELLAR,
  SUPPORTED,
  driftSpec,
  releasePackage,
  scenario,
  supportedBody,
} from "./scenario.ts";

const run = (setup: ReturnType<typeof scenario>) =>
  compare(setup.list, {
    github: setup.github,
    fetch: setup.upstream.fetch,
    now: () => new Date("2026-10-22T00:00:00Z"),
  });

describe("compare", () => {
  it("finds no drift when upstream still matches every pin, and checks every entry", async () => {
    const setup = scenario();
    const result = await run(setup);
    expect(result.drift).toEqual([]);
    expect(result.checked).toEqual({ files: 2, pending: 1, packages: 2, urls: 1 });
    expect(result.head.sha).toBe(setup.upstream.head.sha);
    expect(setup.upstream.unexpected).toEqual([]);
    expect(setup.upstream.writes).toEqual([]);
  });

  it("reports a changed spec file with its commits and diff, and a new release with its commit", async () => {
    const setup = scenario();
    releasePackage(setup.upstream);
    driftSpec(setup.upstream);
    const result = await run(setup);
    expect(result.drift.map((entry) => [entry.kind, entry.id, entry.current])).toEqual([
      ["file", SPEC, expect.stringMatching(/^[0-9a-f]{40}$/)],
      ["package", "@x402/stellar", "2.28.0"],
    ]);
    const [file, release] = result.drift;
    if (file?.kind !== "file" || release?.kind !== "package") throw new Error("unexpected kinds");
    expect(file.commits.map((commit) => commit.title)).toEqual(["docs(specs): fix a link (#3839)"]);
    expect(file.commitsComplete).toBe(true);
    expect(file.diff).toContain("-line\n+line changed @alice");
    // The 2.28.0 tag is annotated: the watcher follows it to the release commit.
    expect(release.releaseCommit).toBe(
      setup.upstream.commits.find((entry) => entry.message === "release 2.28.0")?.sha,
    );
    expect(release.published).toBe("2026-09-29T19:00:00Z");
  });

  it("reports a pending file once it exists, and a pinned file that disappeared", async () => {
    const setup = scenario();
    setup.upstream.commit(
      "add upto on Stellar",
      { [PENDING]: "# upto on Stellar\n", [STELLAR]: undefined },
      "2026-10-23T00:00:00Z",
    );
    const result = await run(setup);
    expect(
      result.drift.map((entry) => [entry.kind, entry.id, entry.pinned === ABSENT, entry.current === ABSENT]),
    ).toEqual([
      ["file-added", PENDING, true, false],
      ["file-removed", STELLAR, false, true],
    ]);
  });

  it("follows only the pinned major when told to, and ignores pre-releases", () => {
    expect(newestInMajor("16.3.0", { "16.3.0": {}, "16.4.0": {}, "17.1.0": {}, "16.9.0-rc.1": {} })).toBe(
      "16.4.0",
    );
    expect(newestInMajor("16.3.0", {})).toBeUndefined();
  });

  it("hashes the reference /supported over its Stellar kinds only", async () => {
    const setup = scenario();
    setup.upstream.urls.set(
      SUPPORTED,
      JSON.stringify({
        kinds: [(JSON.parse(supportedBody()) as { kinds: unknown[] }).kinds[1], { network: "solana:x" }],
      }),
    );
    expect((await run(setup)).drift).toEqual([]);
    setup.upstream.urls.set(SUPPORTED, supportedBody({ areFeesSponsored: false }));
    expect((await run(setup)).drift.map((entry) => [entry.kind, entry.id])).toEqual([["url", SUPPORTED]]);
  });

  it("keeps unreleased source commits out of the fingerprint", async () => {
    const setup = scenario();
    driftSpec(setup.upstream);
    const before = await run(setup);
    setup.upstream.commit(
      "fix(stellar): typed errors (#2975)",
      { [`${SOURCE}/errors.ts`]: "export {};\n" },
      "2026-10-22T10:00:00Z",
    );
    const after = await run(setup);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.unreleased[0]?.commits.map((commit) => commit.title)).toEqual([
      "fix(stellar): typed errors (#2975)",
    ]);
    // The commit that touched the source directory before the baseline is not listed.
    expect(before.unreleased[0]?.commits).toEqual([]);
  });

  it("gives the same fingerprint whatever the order of the watch list", async () => {
    const setup = scenario();
    releasePackage(setup.upstream);
    driftSpec(setup.upstream);
    const forward = await run(setup);
    const reversed: Comparison = await compare(
      { ...setup.list, files: [...setup.list.files].reverse(), packages: [...setup.list.packages].reverse() },
      { github: setup.github, fetch: setup.upstream.fetch },
    );
    expect(reversed.fingerprint).toBe(forward.fingerprint);
    expect(reversed.drift.map((entry) => entry.id)).toEqual(forward.drift.map((entry) => entry.id));
  });

  it.each([
    ["a rate-limited contents call", /GET https:\/\/api\.github\.com\/repos\/[^ ]+\/contents\//, 403],
    ["a failing registry", /registry\.npmjs\.org/, 500],
    ["a failing watched URL", /x402\.org/, 503],
    ["a missing upstream branch", /\/branches\//, 404],
  ])("fails as incomplete on %s, never as no drift", async (_name, pattern, status) => {
    const setup = scenario();
    setup.upstream.failures.push({ pattern, status });
    await expect(run(setup)).rejects.toBeInstanceOf(FetchIncomplete);
  });

  it("fails as incomplete on empty answers", async () => {
    const setup = scenario();
    setup.upstream.urls.set(SUPPORTED, JSON.stringify({ kinds: [] }));
    const npm = setup.upstream.npm.get("@x402/stellar");
    if (npm !== undefined) npm.latest = "";
    const failure = await run(setup).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FetchIncomplete);
    expect((failure as FetchIncomplete).problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("no kinds in the /supported answer"),
        expect.stringContaining("npm @x402/stellar: no latest version"),
      ]),
    );
  });
});

describe("unifiedDiff", () => {
  it("writes hunks with context and nothing for equal texts", () => {
    expect(unifiedDiff("a\nb\nc\n", "a\nc\nd\n", 1)).toBe("@@ -1,3 +1,3 @@\n a\n-b\n c\n+d");
    expect(unifiedDiff("same\n", "same\n")).toBe("");
  });
});
