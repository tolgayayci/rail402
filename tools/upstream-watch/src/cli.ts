/** The upstream:watch command as a function, so tests can run it against a fake upstream. */
import { parseArgs } from "node:util";
import { FetchIncomplete, compare, type Comparison } from "./compare.ts";
import { GitHub, type Fetch } from "./github.ts";
import { applyIssue, planIssue, type IssueAction } from "./issues.ts";
import { loadWatchList, type WatchList } from "./watch-list.ts";

export interface CliDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly fetch?: Fetch;
  readonly list?: WatchList;
  readonly now?: () => Date;
}

export const USAGE =
  "usage: pnpm upstream:watch [--check | --json | --report-issue --tracker <owner/name> [--watch-commit <sha>] [--dry-run]]";

/** Runs the command; resolves to its exit code. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const { out, err } = deps;
  const { values: args } = parseArgs({
    args: [...argv],
    options: {
      check: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "report-issue": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      tracker: { type: "string" },
      "watch-commit": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (args.help) {
    out(USAGE);
    return 0;
  }

  const tracker = args.tracker ?? deps.env["GITHUB_REPOSITORY"];
  const watchCommit = args["watch-commit"];
  if (args["report-issue"] && (tracker === undefined || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(tracker))) {
    err(`error: --report-issue needs --tracker <owner/name>\n${USAGE}`);
    return 2;
  }
  if (watchCommit !== undefined && !/^[0-9a-f]{40}$/.test(watchCommit)) {
    err("error: --watch-commit must be a full commit SHA");
    return 2;
  }

  const list = deps.list ?? loadWatchList();
  const github = new GitHub({
    token: deps.env["GITHUB_TOKEN"],
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  if (args["report-issue"] && !args["dry-run"] && !github.canWrite) {
    err("error: --report-issue writes the issue and needs GITHUB_TOKEN (or use --dry-run)");
    return 2;
  }

  let comparison: Comparison;
  try {
    comparison = await compare(list, {
      github,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  } catch (error) {
    if (error instanceof FetchIncomplete) {
      err(`error: ${error.message}\nNothing was written.`);
      return 2;
    }
    throw error;
  }

  if (args["report-issue"] && tracker !== undefined) {
    const options = { github, list, tracker, watchCommit };
    const action = await planIssue(comparison, options);
    if (args["dry-run"]) {
      printAction(action, out);
    } else {
      const number = await applyIssue(action, options);
      const suffix = action.kind === "none" ? `: ${action.reason}` : "";
      out(`${action.kind}${number === undefined ? "" : ` #${number}`}${suffix}`);
    }
    return 0;
  }

  if (args.json) out(JSON.stringify(comparison, null, 2));
  else printSummary(comparison, out);
  return comparison.drift.length > 0 ? 1 : 0;
}

function printSummary(result: Comparison, out: (line: string) => void): void {
  const { checked } = result;
  out(
    `${result.repository}@${result.branch} ${result.head.sha.slice(0, 12)}: checked ${checked.files} files, ` +
      `${checked.pending} pending, ${checked.packages} packages, ${checked.urls} URLs against ${result.baselineRef}`,
  );
  for (const entry of result.drift) {
    out(
      `${entry.kind.padEnd(12)} ${entry.id}  ${entry.pinned.slice(0, 12)} -> ${entry.current.slice(0, 12)}`,
    );
  }
  for (const path of result.unreleased) {
    if (path.commits.length > 0) out(`unreleased   ${path.path}  ${path.commits.length} commit(s)`);
  }
  out(
    result.drift.length === 0
      ? "no drift"
      : `${result.drift.length} drifted; fingerprint ${result.fingerprint}`,
  );
}

function printAction(action: IssueAction, out: (line: string) => void): void {
  if (action.kind === "none") {
    out(`dry run: no change (${action.reason})`);
    return;
  }
  const target = action.kind === "create" ? "a new issue" : `#${action.number}`;
  out(`dry run: would ${action.kind} ${target}`);
  if (action.kind === "create" || action.kind === "update") out(`\ntitle: ${action.title}\n\n${action.body}`);
  if (action.kind === "update" || action.kind === "close") out(`\ncomment:\n${action.comment}`);
}
