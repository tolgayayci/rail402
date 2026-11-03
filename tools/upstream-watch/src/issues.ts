/**
 * Keeps one tracking issue in step with the drift:
 *
 *   no open issue + drift          create one (linking the last closed one, if any), unless a
 *                                  person closed the last one while this same drift persisted
 *   open issue + same fingerprint  nothing
 *   open issue + new fingerprint   edit it in place and add one comment saying what changed
 *   open issue + no drift          comment that it is resolved and close it as completed
 *
 * Only issues opened by the workflow's own identity with the marker on their first line count, so
 * an issue anyone else writes with the label and the marker is never edited or closed. Callers run
 * this only with a complete comparison: an incomplete one never reaches here.
 *
 * A person who closes the tracking issue while its drift persists (accepted, not planned) is
 * respected: no new issue opens for that same fingerprint. Once the drift changes, its fingerprint
 * changes and a new issue opens. The workflow closes issues only when the drift is gone, so an issue
 * it closed itself never blocks a new one.
 */
import type { Comparison } from "./compare.ts";
import type { GitHub } from "./github.ts";
import { body, changedComment, parseHeader, resolvedComment, title, type RenderContext } from "./render.ts";
import type { WatchList } from "./watch-list.ts";

export const LABEL = "upstream-drift";
/** The login GitHub gives GITHUB_TOKEN writes. */
export const WORKFLOW_AUTHOR = "github-actions[bot]";

export interface IssueOptions {
  readonly github: GitHub;
  readonly list: WatchList;
  /** `owner/name` of the repository whose issues are written. */
  readonly tracker: string;
  readonly author?: string;
  readonly watchCommit?: string | undefined;
}

export interface TrackerIssue {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly body: string | null;
  readonly user: { readonly login: string } | null;
  readonly labels: readonly ({ readonly name?: string } | string)[];
  readonly pull_request?: unknown;
  /** Present on a single-issue read only: who closed it. */
  readonly closed_by?: { readonly login: string } | null;
}

export type IssueAction =
  | { readonly kind: "none"; readonly reason: string; readonly number?: number }
  | { readonly kind: "create"; readonly title: string; readonly body: string; readonly follows?: number }
  | {
      readonly kind: "update";
      readonly number: number;
      readonly title: string;
      readonly body: string;
      readonly comment: string;
    }
  | { readonly kind: "close"; readonly number: number; readonly comment: string };

/** True only for an issue this workflow opened: its author, its label and the marker first. */
export function isTrackingIssue(issue: TrackerIssue, author = WORKFLOW_AUTHOR): boolean {
  return (
    issue.pull_request === undefined &&
    issue.user?.login === author &&
    issue.labels.some((label) => (typeof label === "string" ? label : label.name) === LABEL) &&
    parseHeader(issue.body ?? "") !== undefined
  );
}

async function trackingIssues(options: IssueOptions): Promise<TrackerIssue[]> {
  const query = new URLSearchParams({
    labels: LABEL,
    state: "all",
    sort: "created",
    direction: "desc",
    per_page: "100",
  });
  const issues = await options.github.get<TrackerIssue[]>(
    `/repos/${options.tracker}/issues?${query.toString()}`,
  );
  if (!Array.isArray(issues)) throw new Error("the issue list is not a list");
  return issues.filter((issue) => isTrackingIssue(issue, options.author)).sort((a, b) => b.number - a.number);
}

export async function planIssue(comparison: Comparison, options: IssueOptions): Promise<IssueAction> {
  const issues = await trackingIssues(options);
  const open = issues.find((issue) => issue.state === "open");
  const lastClosed = issues.find((issue) => issue.state === "closed");
  const context: RenderContext = {
    list: options.list,
    tracker: options.tracker,
    watchCommit: options.watchCommit,
  };
  const drifted = comparison.drift.length > 0;

  if (open === undefined) {
    if (!drifted) return { kind: "none", reason: "no drift and no open tracking issue" };
    if (lastClosed !== undefined && (await closedByHandWithSameDrift(lastClosed, comparison, options))) {
      return {
        kind: "none",
        reason: `#${String(lastClosed.number)}, the last tracking issue with this drift, was closed by hand; a new one opens once the drift changes`,
        number: lastClosed.number,
      };
    }
    const follows = lastClosed?.number;
    return {
      kind: "create",
      title: title(comparison),
      body: body(comparison, { ...context, follows }),
      ...(follows === undefined ? {} : { follows }),
    };
  }
  if (!drifted) return { kind: "close", number: open.number, comment: resolvedComment(comparison, context) };
  const previous = parseHeader(open.body ?? "");
  if (previous?.fingerprint === comparison.fingerprint) {
    return { kind: "none", reason: "the open tracking issue already shows this drift", number: open.number };
  }
  return {
    kind: "update",
    number: open.number,
    title: title(comparison),
    body: body(comparison, { ...context, follows: lastClosed?.number }),
    comment: changedComment(previous?.items ?? [], comparison),
  };
}

/**
 * Whether a person (not the workflow) closed `issue` while it described exactly this drift. The issue
 * list does not say who closed an issue, so the issue is read on its own, only when the fingerprints match.
 */
async function closedByHandWithSameDrift(
  issue: TrackerIssue,
  comparison: Comparison,
  options: IssueOptions,
): Promise<boolean> {
  if (parseHeader(issue.body ?? "")?.fingerprint !== comparison.fingerprint) return false;
  const full = await options.github.get<TrackerIssue>(
    `/repos/${options.tracker}/issues/${String(issue.number)}`,
  );
  return full.closed_by?.login !== (options.author ?? WORKFLOW_AUTHOR);
}

export async function applyIssue(action: IssueAction, options: IssueOptions): Promise<number | undefined> {
  const repo = `/repos/${options.tracker}`;
  switch (action.kind) {
    case "none":
      return action.number;
    case "create": {
      const label = await options.github.find(`${repo}/labels/${LABEL}`);
      if (label === undefined) {
        await options.github.post(`${repo}/labels`, {
          name: LABEL,
          color: "c5def5",
          description: "Upstream x402 changed since the pinned watch list",
        });
      }
      const created = await options.github.post<{ number: number }>(`${repo}/issues`, {
        title: action.title,
        body: action.body,
        labels: [LABEL],
      });
      return created.number;
    }
    case "update":
      await options.github.patch(`${repo}/issues/${action.number}`, {
        title: action.title,
        body: action.body,
      });
      await options.github.post(`${repo}/issues/${action.number}/comments`, { body: action.comment });
      return action.number;
    case "close":
      await options.github.post(`${repo}/issues/${action.number}/comments`, { body: action.comment });
      await options.github.patch(`${repo}/issues/${action.number}`, {
        state: "closed",
        state_reason: "completed",
      });
      return action.number;
  }
}

export async function reportIssue(comparison: Comparison, options: IssueOptions) {
  const action = await planIssue(comparison, options);
  const number = await applyIssue(action, options);
  return { action, number };
}
