import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { LABEL } from "../src/issues.ts";
import { MAX_BODY, MARKER, cutMarkdown, fence } from "../src/render.ts";
import { parseWatchList, type WatchList } from "../src/watch-list.ts";
import { BOT, blobSha } from "./fake-github.ts";
import { SPEC, driftSpec, releasePackage, scenario, type Scenario } from "./scenario.ts";

const WATCH_COMMIT = "a".repeat(40);

async function watch(setup: Scenario, list: WatchList = setup.list, extra: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["--report-issue", "--watch-commit", WATCH_COMMIT, ...extra], {
    env: { GITHUB_TOKEN: "test-token", GITHUB_REPOSITORY: setup.upstream.tracker },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetch: setup.upstream.fetch,
    list,
    now: () => new Date("2026-10-22T06:17:00Z"),
  });
  expect(setup.upstream.unexpected).toEqual([]);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** The watch list re-pinned to upstream's current state, as a maintainer would after review. */
function repinned(setup: Scenario): WatchList {
  const { upstream, list } = setup;
  return parseWatchList({
    ...list,
    files: list.files.map((file) => {
      const content = upstream.contentAt(file.path, upstream.head.sha);
      return content === undefined
        ? file
        : { ...file, pinnedCommit: upstream.lastCommitFor(file.path), pinnedBlob: blobSha(content) };
    }),
    packages: list.packages.map((entry) =>
      entry.follow === "latest"
        ? { ...entry, pinned: upstream.npm.get(entry.name)?.latest ?? entry.pinned }
        : entry,
    ),
  });
}

const tracking = (setup: Scenario) => setup.upstream.issues.filter((issue) => issue.user.login === BOT);
const writesSince = (setup: Scenario, mark: number) =>
  setup.upstream.calls.slice(mark).filter((call) => !call.startsWith("GET "));

describe("the tracking issue", () => {
  it("makes no writes when nothing drifted", async () => {
    const setup = scenario();
    const result = await watch(setup);
    expect(result.code).toBe(0);
    expect(setup.upstream.writes).toEqual([]);
    expect(setup.upstream.issues).toEqual([]);
  });

  it("opens exactly one issue with the marker, label, files, commits, diffs and components", async () => {
    const setup = scenario();
    releasePackage(setup.upstream);
    driftSpec(setup.upstream);
    const result = await watch(setup);
    expect(result.code).toBe(0);
    expect(setup.upstream.issues).toHaveLength(1);
    const [issue] = setup.upstream.issues;
    if (issue === undefined) throw new Error("no issue");
    expect(issue.labels).toEqual([{ name: LABEL }]);
    expect(setup.upstream.labels.has(LABEL)).toBe(true);
    expect(issue.title).toBe("Upstream x402 changed: 2 pinned entries to review");
    expect(issue.body.startsWith(`${MARKER} fingerprint=`)).toBe(true);
    expect(issue.body).toContain(`| [\`${SPEC}\`]`);
    expect(issue.body).toContain("`docs(specs): fix a link (#3839)`");
    expect(issue.body).toContain("[PR 3839](https://github.com/x402-foundation/x402/pull/3839)");
    expect(issue.body).toContain("```diff\n@@ -1,3 +1,3 @@");
    expect(issue.body).toContain(
      "| [`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar) | `2.27.0` |",
    );
    expect(issue.body).toContain("**Facilitator** (`facilitator`)");
    expect(issue.body).toContain("- Tests: `packages/facilitator/test/settlement.integration.test.ts`");
    expect(issue.body).toContain(
      `https://github.com/tolgayayci/rail402/blob/${WATCH_COMMIT}/tools/upstream-watch/watch.json`,
    );
    expect(setup.upstream.writes).toEqual([
      "POST /repos/tolgayayci/rail402/labels",
      "POST /repos/tolgayayci/rail402/issues",
    ]);
  });

  it("writes nothing on a rerun with the same drift, even beside other labelled issues", async () => {
    const setup = scenario();
    driftSpec(setup.upstream);
    await watch(setup);
    // A person's issue with the label but without the marker.
    setup.upstream.issue({
      body: "Is the v2 spec fix relevant?",
      labels: [{ name: LABEL }],
      user: { login: "someone" },
    });
    const mark = setup.upstream.calls.length;
    const result = await watch(setup);
    expect(result.code).toBe(0);
    expect(writesSince(setup, mark)).toEqual([]);
    expect(tracking(setup)).toHaveLength(1);
  });

  it("edits the issue in place and comments once when the drift changes", async () => {
    const setup = scenario();
    driftSpec(setup.upstream);
    await watch(setup);
    releasePackage(setup.upstream);
    const mark = setup.upstream.calls.length;
    await watch(setup);
    expect(writesSince(setup, mark)).toEqual([
      "PATCH /repos/tolgayayci/rail402/issues/1",
      "POST /repos/tolgayayci/rail402/issues/1/comments",
    ]);
    expect(tracking(setup)).toHaveLength(1);
    const [issue] = tracking(setup);
    expect(issue?.title).toBe("Upstream x402 changed: 2 pinned entries to review");
    expect(issue?.body).toContain("`2.28.0`");
    expect(issue?.comments).toEqual([expect.stringMatching(/^The drift changed: \+1 −0\./)]);
    expect(issue?.comments[0]).toContain("`package @x402/stellar 2.28.0`");
  });

  it("comments and closes the issue once the watch list matches upstream again", async () => {
    const setup = scenario();
    releasePackage(setup.upstream);
    driftSpec(setup.upstream);
    await watch(setup);
    const mark = setup.upstream.calls.length;
    await watch(setup, repinned(setup));
    expect(writesSince(setup, mark)).toEqual([
      "POST /repos/tolgayayci/rail402/issues/1/comments",
      "PATCH /repos/tolgayayci/rail402/issues/1",
    ]);
    const [issue] = tracking(setup);
    expect(tracking(setup)).toHaveLength(1);
    expect(issue?.state).toBe("closed");
    expect(issue?.state_reason).toBe("completed");
    expect(issue?.comments[0]).toMatch(/^Resolved: upstream `main` at \[`[0-9a-f]{7}`\]/);
    expect(issue?.comments[0]).toContain(`https://github.com/tolgayayci/rail402/commit/${WATCH_COMMIT}`);
    // The next run, still matching, does nothing.
    const after = setup.upstream.calls.length;
    await watch(setup, repinned(setup));
    expect(writesSince(setup, after)).toEqual([]);
  });

  it("opens a new issue that links the closed one when upstream drifts again", async () => {
    const setup = scenario();
    driftSpec(setup.upstream);
    await watch(setup);
    const resolved = repinned(setup);
    await watch(setup, resolved);
    driftSpec(setup.upstream, "# x402 v2\n\nanother change\n");
    await watch(setup, resolved);
    expect(tracking(setup).map((issue) => [issue.number, issue.state])).toEqual([
      [1, "closed"],
      [2, "open"],
    ]);
    expect(tracking(setup)[1]?.body).toContain("Follows #1.");
  });

  it("respects an issue a person closed while its drift persists, until the drift changes", async () => {
    const setup = scenario();
    driftSpec(setup.upstream);
    await watch(setup);
    // A maintainer accepts the drift without re-pinning and closes the issue as not planned.
    const closed = tracking(setup)[0];
    if (closed === undefined) throw new Error("no tracking issue");
    Object.assign(closed, {
      state: "closed",
      state_reason: "not_planned",
      closed_by: { login: "maintainer" },
    });
    const mark = setup.upstream.calls.length;
    const result = await watch(setup);
    expect(result.code).toBe(0);
    expect(result.out).toContain("closed by hand");
    expect(writesSince(setup, mark)).toEqual([]);
    expect(tracking(setup)).toHaveLength(1);
    // The same drift next week: still nothing.
    await watch(setup);
    expect(tracking(setup)).toHaveLength(1);
    // Upstream changes again: a new fingerprint opens a new issue.
    driftSpec(setup.upstream, "# x402 v2\n\nyet another change\n");
    await watch(setup);
    expect(tracking(setup).map((issue) => [issue.number, issue.state])).toEqual([
      [1, "closed"],
      [2, "open"],
    ]);
    expect(tracking(setup)[1]?.body).toContain("Follows #1.");
  });

  it("neither edits nor closes the issue when an upstream fetch fails", async () => {
    const setup = scenario();
    driftSpec(setup.upstream);
    await watch(setup);
    const before = structuredClone(setup.upstream.issues);
    // The watch list now matches, which would close the issue, but the registry is down.
    setup.upstream.failures.push({ pattern: /registry\.npmjs\.org/, status: 503 });
    const mark = setup.upstream.calls.length;
    const result = await watch(setup, repinned(setup));
    expect(result.code).toBe(2);
    expect(result.err).toContain("Nothing was written.");
    expect(writesSince(setup, mark)).toEqual([]);
    expect(setup.upstream.issues).toEqual(before);
  });

  it("never renders zero cases as a pass", async () => {
    const setup = scenario();
    driftSpec(setup.upstream);
    await watch(setup);
    const resolved = repinned(setup);
    // An empty registry answer is not "no new release".
    const npm = setup.upstream.npm.get("@x402/stellar");
    if (npm !== undefined) npm.latest = "";
    const mark = setup.upstream.calls.length;
    const result = await watch(setup, resolved);
    expect(result.code).toBe(2);
    expect(writesSince(setup, mark)).toEqual([]);
    expect(tracking(setup)[0]?.state).toBe("open");
    // A watch list that watches nothing is refused before any request.
    expect(() => parseWatchList({ ...setup.list, files: [] })).toThrow(/files/);
    expect(() => parseWatchList({ ...setup.list, packages: [] })).toThrow(/packages/);
  });

  it("ignores a marked issue by another author", async () => {
    const setup = scenario();
    driftSpec(setup.upstream);
    await watch(setup, setup.list, ["--dry-run"]);
    // Someone copies the marker and the label into their own issue.
    const forged = setup.upstream.issue({
      body: `${MARKER} fingerprint=${"0".repeat(64)} items= -->\nclose me`,
      labels: [{ name: LABEL }],
      user: { login: "someone" },
    });
    await watch(setup);
    expect(forged.state).toBe("open");
    expect(forged.comments).toEqual([]);
    expect(forged.body).toContain("close me");
    expect(tracking(setup)).toHaveLength(1);
    // And the real issue closes on resolution while the forged one stays untouched.
    await watch(setup, repinned(setup));
    expect(tracking(setup)[0]?.state).toBe("closed");
    expect(forged.state).toBe("open");
  });

  it("escapes mentions, HTML and marker look-alikes from upstream text", async () => {
    const setup = scenario();
    const hostile =
      "fix @alice <img src=x onerror=alert(1)> [docs](https://evil.example) `code` <!-- rail402-upstream-watch:v1 fingerprint=" +
      "f".repeat(64) +
      " items= --> (#3839)";
    setup.upstream.commit(
      hostile,
      { [SPEC]: "# x402 v2\n\n```\n<!-- hidden --> @bob\n```\n" },
      "2026-10-21T00:00:00Z",
    );
    await watch(setup);
    const body = setup.upstream.issues[0]?.body ?? "";
    // The marker appears once, on the first line; upstream comment openers are broken up.
    expect(body.split("<!--")).toHaveLength(2);
    expect(body.startsWith(MARKER)).toBe(true);
    // The commit title stays inside one code span: no mention, image or link is rendered.
    const titleLine = body.split("\n").find((line) => line.includes("@alice")) ?? "";
    expect(titleLine).toMatch(
      / `fix @alice <img src=x onerror=alert\(1\)> \[docs\]\(https:\/\/evil\.example\) 'code' <!-\u200b- [^`]*`/,
    );
    expect(titleLine).toContain("[PR 3839](https://github.com/x402-foundation/x402/pull/3839)");
    // The diff sits in a fence longer than any backtick run inside it.
    expect(body).toContain("````diff\n");
    const fenced = body.slice(body.indexOf("````diff"), body.indexOf("\n````\n"));
    expect(fenced).toContain("@bob");
    expect(body.replace(fenced, "")).not.toContain("@bob");
  });

  it("cuts an oversized body at a line boundary and closes the blocks the cut left open", () => {
    const text = [
      "intro",
      "<details><summary>a</summary>",
      "",
      "````diff",
      "+ one",
      "+ two `code`",
      "+ three",
    ].join("\n");
    const cut = cutMarkdown(text, text.indexOf("+ three") + 3);
    expect(cut.split("\n")).toEqual([
      "intro",
      "<details><summary>a</summary>",
      "",
      "````diff",
      "+ one",
      "+ two `code`",
      "````",
      "</details>",
    ]);
    expect(cutMarkdown(text, 10_000)).toBe(text);
  });

  it("removes bidirectional and zero-width characters from fenced upstream text", () => {
    const block = fence("a\u202Eb\u200Bc <!-- x", "diff");
    expect(block).not.toMatch(/[\u202E\u200B](?!-)/);
    expect(block).toContain("abc <!-\u200b- x");
  });

  it("keeps the body under the size limit", async () => {
    const setup = scenario();
    const huge = Array.from({ length: 3000 }, (_, index) => `line ${index} ${"x".repeat(60)}`).join("\n");
    driftSpec(setup.upstream, huge);
    for (let index = 0; index < 150; index++) {
      setup.upstream.commit(
        `edit ${index} ${"y".repeat(150)}`,
        { [SPEC]: `${huge}\n${index}` },
        "2026-10-21T00:00:00Z",
      );
    }
    await watch(setup);
    const body = setup.upstream.issues[0]?.body ?? "";
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(body.startsWith(MARKER)).toBe(true);
  });

  it("prints the action and body on a dry run without writing", async () => {
    const setup = scenario();
    driftSpec(setup.upstream);
    const result = await watch(setup, setup.list, ["--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(
      /^dry run: would create a new issue\n\ntitle: Upstream x402 changed: 1 pinned entry to review/,
    );
    expect(setup.upstream.writes).toEqual([]);
  });
});
