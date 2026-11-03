/**
 * The tracking issue's title, body and comments. Upstream text (commit titles, diffs) is untrusted:
 * it is only ever placed in code spans or fenced blocks, never as Markdown or HTML, so it cannot
 * mention people, link anywhere, inject markup or imitate the hidden marker. Links are built here,
 * to github.com and npmjs.com only.
 */
import type { Comparison, Drift, FileDrift, PackageDrift, UpstreamCommit } from "./compare.ts";
import { ABSENT } from "./compare.ts";
import type { WatchList } from "./watch-list.ts";

export const MARKER = "<!-- rail402-upstream-watch:v1";
/** GitHub refuses issue bodies above 65,536 characters; stay well below. */
export const MAX_BODY = 60_000;
export const WATCH_PATH = "tools/upstream-watch/watch.json";

export interface RenderContext {
  readonly list: WatchList;
  /** The repository that holds the watch list and the issue, `owner/name`. */
  readonly tracker: string;
  /** The commit of the watch list that was compared, when known. */
  readonly watchCommit?: string | undefined;
  /** The previous tracking issue, closed, that this one follows. */
  readonly follows?: number | undefined;
}

const short = (sha: string) => sha.slice(0, 7);
const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Upstream text as one inline code span: one line, at most `max` characters, no backticks (they
 * would end the span), `|` escaped for tables and comment openers broken up.
 */
export function escapeUpstream(text: string, max = 160): string {
  let flat = text
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/`/g, "'")
    .replace(/<!--/g, "<!-\u200b-")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length > max) flat = `${flat.slice(0, max - 1)}…`;
  if (flat === "") flat = "(empty)";
  return `\`${flat.replace(/\|/g, "\\|")}\``;
}

/**
 * A fenced block that upstream content cannot close, with format characters (bidirectional overrides,
 * zero-width characters) removed and comment openers broken up.
 */
export function fence(content: string, info = ""): string {
  const clean = content.replace(/\p{Cf}+/gu, "");
  const longest = Math.max(0, ...[...clean.matchAll(/`+/g)].map((match) => match[0].length));
  const marks = "`".repeat(Math.max(3, longest + 1));
  return `${marks}${info}\n${clean.replace(/<!--/g, "<!-\u200b-")}\n${marks}`;
}

const github = (list: WatchList) => `https://github.com/${list.upstream.repository}`;

/** PR numbers named in an upstream commit title, as links to the upstream repository. */
function pullLinks(list: WatchList, title: string): string {
  const numbers = [...new Set([...title.matchAll(/#(\d{1,7})\b/g)].map((match) => match[1]))];
  return numbers.map((number) => `[PR ${number}](${github(list)}/pull/${number})`).join(", ");
}

function commitLine(list: WatchList, commit: UpstreamCommit): string {
  const links = pullLinks(list, commit.title);
  return (
    `[\`${short(commit.sha)}\`](${github(list)}/commit/${commit.sha}) ${commit.date.slice(0, 10)} ` +
    `${escapeUpstream(commit.title)}${links === "" ? "" : ` (${links})`}`
  );
}

const affects = (entry: Drift) => entry.affects.map((id) => `\`${id}\``).join(", ");

/** Header line: the marker, the fingerprint and the drifted items, for the next run to compare. */
export function header(comparison: Comparison): string {
  const items = Buffer.from(JSON.stringify(itemKeys(comparison.drift))).toString("base64url");
  return `${MARKER} fingerprint=${comparison.fingerprint} items=${items} -->`;
}

export function itemKeys(drift: readonly Drift[]): string[] {
  return drift.map((entry) => `${entry.kind} ${entry.id} ${entry.current}`);
}

/** The fingerprint and items of a body this tool wrote; undefined for anything else. */
export function parseHeader(body: string): { fingerprint: string; items: string[] } | undefined {
  const match = /^<!-- rail402-upstream-watch:v1 fingerprint=([0-9a-f]{64}) items=([A-Za-z0-9_-]*) -->/.exec(
    body,
  );
  if (match === null) return undefined;
  let items: string[] = [];
  try {
    const parsed: unknown = JSON.parse(Buffer.from(match[2] ?? "", "base64url").toString("utf8"));
    if (Array.isArray(parsed)) items = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    items = [];
  }
  return { fingerprint: match[1] ?? "", items };
}

export function title(comparison: Comparison): string {
  const count = comparison.drift.length;
  return `Upstream x402 changed: ${count} pinned ${count === 1 ? "entry" : "entries"} to review`;
}

interface Limits {
  readonly diffLines: number;
  readonly commitsPerFile: number;
}

const LIMITS: readonly Limits[] = [
  { diffLines: 80, commitsPerFile: 20 },
  { diffLines: 20, commitsPerFile: 10 },
  { diffLines: 0, commitsPerFile: 5 },
  { diffLines: 0, commitsPerFile: 0 },
];

/** The issue body, within MAX_BODY: diffs and commit lists shrink first, then the body is cut. */
export function body(comparison: Comparison, context: RenderContext): string {
  for (const limits of LIMITS) {
    const text = renderBody(comparison, context, limits);
    if (text.length <= MAX_BODY) return text;
  }
  const notice =
    "\n\n_The rest of this report was cut to fit the issue size limit; run `pnpm upstream:watch` for all of it._\n";
  const text = renderBody(comparison, context, LIMITS.at(-1) as Limits);
  return cutMarkdown(text, MAX_BODY - notice.length - CLOSERS_RESERVE) + notice;
}

/** Room kept for the fence and `</details>` lines a cut body closes. */
const CLOSERS_RESERVE = 200;

/**
 * The longest prefix of `text` within `limit` characters that ends at a line boundary, with any fence
 * or `<details>` block left open by the cut closed again, so the rest of the issue renders as written.
 * Inline code spans never cross a line, so a line cut never splits one.
 */
export function cutMarkdown(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const lines = head.slice(0, Math.max(0, head.lastIndexOf("\n"))).split("\n");
  let fenceMarks: string | undefined;
  let details = 0;
  for (const line of lines) {
    if (fenceMarks !== undefined) {
      if (line === fenceMarks) fenceMarks = undefined;
      continue;
    }
    const opening = /^(`{3,})/.exec(line);
    if (opening?.[1] !== undefined) fenceMarks = opening[1];
    else if (line.startsWith("<details>")) details++;
    else if (line.startsWith("</details>")) details = Math.max(0, details - 1);
  }
  const closers = [
    ...(fenceMarks === undefined ? [] : [fenceMarks]),
    ...Array<string>(details).fill("</details>"),
  ];
  return [...lines, ...closers].join("\n");
}

function renderBody(comparison: Comparison, context: RenderContext, limits: Limits): string {
  const { list, tracker } = context;
  const up = github(list);
  const watchRef = context.watchCommit ?? "main";
  const watchLink = `[\`${WATCH_PATH}\`](https://github.com/${tracker}/blob/${watchRef}/${WATCH_PATH})`;
  const files = comparison.drift.filter((entry): entry is FileDrift => entry.kind.startsWith("file"));
  const packages = comparison.drift.filter((entry): entry is PackageDrift => entry.kind === "package");
  const urls = comparison.drift.filter((entry) => entry.kind === "url");
  const out: string[] = [header(comparison), ""];

  out.push(
    `Rail402 is tested against [\`${list.upstream.repository}\`](${up}) at ` +
      `[\`${list.upstream.baselineRef}\`](${up}/commit/${list.upstream.baselineCommit}), as pinned in ${watchLink}. ` +
      `On ${comparison.checkedAt.slice(0, 10)} upstream \`${list.upstream.branch}\` at ` +
      `[\`${short(comparison.head.sha)}\`](${up}/commit/${comparison.head.sha}) differed in ` +
      `${comparison.drift.length} ${comparison.drift.length === 1 ? "entry" : "entries"}. ` +
      `Each needs a decision: a change in Rail402, or a note that none is needed and a new pin.`,
  );
  if (context.follows !== undefined) out.push("", `Follows #${context.follows}.`);

  if (files.length > 0) {
    out.push(
      "",
      "### Specification files",
      "",
      "| File | Pinned | Upstream now | Commits since the pin | Affects |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const file of files) {
      const pinned =
        file.pinned === ABSENT
          ? "not upstream"
          : `[\`${short(file.pinned)}\`](${up}/blob/${file.pinnedCommit ?? comparison.head.sha}/${file.id})`;
      const current =
        file.current === ABSENT
          ? "removed"
          : `[\`${short(file.current)}\`](${up}/blob/${comparison.head.sha}/${file.id})`;
      const count = `${file.commits.length}${file.commitsComplete ? "" : "+"}`;
      out.push(
        `| [\`${file.id}\`](${up}/commits/${list.upstream.branch}/${file.id}) | ${pinned} | ${current} | ${count} | ${affects(file)} |`,
      );
    }
    if (limits.commitsPerFile > 0) {
      out.push("", "#### Upstream commits");
      for (const file of files) {
        out.push("", `\`${file.id}\`:`, "");
        for (const commit of file.commits.slice(0, limits.commitsPerFile))
          out.push(`- ${commitLine(list, commit)}`);
        const more = file.commits.length - limits.commitsPerFile;
        if (more > 0 || !file.commitsComplete) {
          out.push(`- … [more in the file's history](${up}/commits/${list.upstream.branch}/${file.id})`);
        }
        if (file.commits.length === 0) out.push("- none listed; see the file's history");
      }
    }
    if (limits.diffLines > 0) {
      out.push("", "#### Diffs");
      for (const file of files)
        out.push(
          "",
          ...diffBlock(file, limits.diffLines, `${up}/commits/${list.upstream.branch}/${file.id}`),
        );
    } else {
      out.push(
        "",
        "Diffs are left out to fit the issue size limit; each file links to its upstream history.",
      );
    }
  }

  if (packages.length > 0) {
    out.push(
      "",
      "### Packages",
      "",
      "| Package | Pinned | Upstream | Published | Release commit | Affects |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const entry of packages) {
      const release =
        entry.releaseCommit === undefined
          ? "—"
          : `[\`${short(entry.releaseCommit)}\`](${up}/commit/${entry.releaseCommit})`;
      out.push(
        `| [\`${entry.id}\`](https://www.npmjs.com/package/${entry.id}) | \`${entry.pinned}\` | ` +
          `[\`${entry.current}\`](https://www.npmjs.com/package/${entry.id}/v/${entry.current}) | ` +
          `${entry.published?.slice(0, 10) ?? "—"} | ${release} | ${affects(entry)} |`,
      );
    }
  }

  if (urls.length > 0) {
    out.push("", "### URLs", "", "| URL | Pinned SHA-256 | Now | Affects |", "| --- | --- | --- | --- |");
    for (const entry of urls) {
      out.push(
        `| \`${entry.id}\` | \`${entry.pinned.slice(0, 12)}\` | \`${entry.current.slice(0, 12)}\` | ${affects(entry)} |`,
      );
    }
  }

  const componentIds = [...new Set(comparison.drift.flatMap((entry) => entry.affects))].sort();
  if (componentIds.length > 0) {
    out.push("", "### Affected Rail402 components");
    for (const id of componentIds) {
      const component = list.components[id];
      if (component === undefined) continue;
      const code = (values: readonly string[]) => values.map((value) => `\`${value}\``).join(", ");
      out.push(
        "",
        `**${component.title}** (\`${id}\`)`,
        `- Source: ${code(component.paths)}`,
        `- Tests: ${code(component.tests)}`,
        `- Docs: ${code(component.docs)}`,
      );
    }
  }

  const unreleased = comparison.unreleased.filter((entry) => entry.commits.length > 0);
  if (unreleased.length > 0) {
    out.push(
      "",
      "### Unreleased upstream commits",
      "",
      `For information only; these do not count as drift until they ship in a release. Commits to these directories on \`${list.upstream.branch}\` since \`${list.upstream.baselineRef}\`:`,
    );
    for (const entry of unreleased) {
      out.push("", `\`${entry.path}\` (${entry.affects.map((id) => `\`${id}\``).join(", ")}):`, "");
      for (const commit of entry.commits.slice(0, Math.max(limits.commitsPerFile, 3)))
        out.push(`- ${commitLine(list, commit)}`);
      if (entry.commits.length > Math.max(limits.commitsPerFile, 3))
        out.push(`- … ${entry.commits.length} in all`);
    }
  }

  out.push(
    "",
    "### To resolve",
    "",
    "- [ ] Read each change above and decide whether Rail402 needs one.",
    `- [ ] Re-pin changed files in \`${WATCH_PATH}\` (\`pinnedCommit\`, \`pinnedBlob\`); bump packages in the pnpm catalog and the watch list together.`,
    "- [ ] Run `pnpm verify` and the conformance runs of the affected components.",
    "- [ ] Note here that no change was needed, or link the commit that made it.",
    "",
    "Once the watch list on `main` matches upstream again, the next run closes this issue.",
  );
  return `${out.join("\n")}\n`;
}

function diffBlock(file: FileDrift, maxLines: number, history: string): string[] {
  if (file.diff === undefined) {
    return [
      `\`${file.id}\`: ${file.current === ABSENT ? "removed upstream" : "too many changes to show"}; see [its history](${history}).`,
    ];
  }
  const lines = file.diff.split("\n");
  const added = lines.filter((line) => line.startsWith("+")).length;
  const removed = lines.filter((line) => line.startsWith("-")).length;
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown.push(`… ${lines.length - maxLines} more lines`);
  return [
    `<details><summary><code>${escapeHtml(file.id)}</code> (+${added} −${removed})</summary>`,
    "",
    fence(shown.join("\n"), "diff"),
    "",
    "</details>",
  ];
}

export function changedComment(previous: readonly string[], comparison: Comparison): string {
  const now = itemKeys(comparison.drift);
  const before = new Set(previous);
  const after = new Set(now);
  const added = now.filter((item) => !before.has(item));
  const gone = previous.filter((item) => !after.has(item));
  const list = (items: string[]) => items.map((item) => `- ${escapeUpstream(item, 200)}`).join("\n");
  return [
    `The drift changed: +${added.length} −${gone.length}. The description above is up to date.`,
    ...(added.length > 0 ? ["", "New or changed:", list(added)] : []),
    ...(gone.length > 0 ? ["", "No longer drifted:", list(gone)] : []),
  ].join("\n");
}

export function resolvedComment(comparison: Comparison, context: RenderContext): string {
  const up = github(context.list);
  const watch =
    context.watchCommit === undefined
      ? `\`${WATCH_PATH}\``
      : `\`${WATCH_PATH}\` at [\`${short(context.watchCommit)}\`](https://github.com/${context.tracker}/commit/${context.watchCommit})`;
  return (
    `Resolved: upstream \`${context.list.upstream.branch}\` at [\`${short(comparison.head.sha)}\`](${up}/commit/${comparison.head.sha}) ` +
    `matches ${watch} again. Closing.`
  );
}
