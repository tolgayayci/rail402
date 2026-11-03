/**
 * Compares the watch list with upstream: spec files on the upstream branch (git blob SHAs), npm
 * releases and normalised URL bodies. The result is a sorted drift set with a fingerprint over
 * `(kind, id, pinned, current)`. Unreleased commits to upstream source directories are collected
 * for information only and never enter the fingerprint.
 *
 * Every watched entry must be checked: a fetch error, a non-2xx answer or an empty answer makes the
 * whole comparison fail with FetchIncomplete, so a broken run can never read as "no drift".
 */
import { createHash } from "node:crypto";
import { unifiedDiff } from "./diff.ts";
import { UpstreamError, encodePath, type Fetch, type GitHub } from "./github.ts";
import type { WatchList, WatchedFile, WatchedPackage, WatchedUrl } from "./watch-list.ts";

/** Raised when any watched entry could not be checked; carries every problem found. */
export class FetchIncomplete extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`upstream could not be fully checked:\n  ${problems.join("\n  ")}`);
    this.name = "FetchIncomplete";
    this.problems = problems;
  }
}

export interface UpstreamCommit {
  readonly sha: string;
  readonly date: string;
  /** The first line of the commit message, as upstream wrote it (untrusted text). */
  readonly title: string;
}

interface DriftBase {
  readonly id: string;
  readonly pinned: string;
  readonly current: string;
  readonly affects: readonly string[];
}

export interface FileDrift extends DriftBase {
  /** `file`: the blob changed; `file-added`: a pending file appeared; `file-removed`: a pinned file is gone. */
  readonly kind: "file" | "file-added" | "file-removed";
  readonly pinnedCommit: string | undefined;
  /** Upstream commits that touched the file after `pinnedCommit`, newest first. */
  readonly commits: readonly UpstreamCommit[];
  /** False when the commit list was cut at the page limit. */
  readonly commitsComplete: boolean;
  /** Unified diff from the pinned blob to the current one; undefined when too large to compute. */
  readonly diff: string | undefined;
}

export interface PackageDrift extends DriftBase {
  readonly kind: "package";
  readonly published: string | undefined;
  /** The upstream commit the release tag points at, when the package names one and it exists. */
  readonly releaseCommit: string | undefined;
  readonly releaseTag: string | undefined;
}

export interface UrlDrift extends DriftBase {
  readonly kind: "url";
}

export type Drift = FileDrift | PackageDrift | UrlDrift;

export interface UnreleasedPath {
  readonly path: string;
  readonly affects: readonly string[];
  readonly note: string;
  readonly commits: readonly UpstreamCommit[];
}

export interface Comparison {
  readonly checkedAt: string;
  readonly repository: string;
  readonly branch: string;
  readonly head: { readonly sha: string; readonly date: string };
  readonly baselineRef: string;
  readonly baselineCommit: string;
  /** How many entries of each kind were checked; never zero for files and packages. */
  readonly checked: {
    readonly files: number;
    readonly pending: number;
    readonly packages: number;
    readonly urls: number;
  };
  readonly drift: readonly Drift[];
  /** sha256 over the sorted `(kind, id, pinned, current)` tuples of `drift`. */
  readonly fingerprint: string;
  readonly unreleased: readonly UnreleasedPath[];
}

export interface CompareOptions {
  readonly github: GitHub;
  /** For npm and watched URLs. */
  readonly fetch?: Fetch;
  readonly npmRegistry?: string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  /** Pages of 100 commits read per file before the list is marked incomplete. */
  readonly commitPages?: number;
}

/** Marks a file absent upstream in `pinned`/`current`. */
export const ABSENT = "absent";
const MAX_URL_BYTES = 2_000_000;

export function fingerprintOf(drift: readonly Drift[]): string {
  const tuples = drift.map((entry) => [entry.kind, entry.id, entry.pinned, entry.current]);
  return createHash("sha256").update(JSON.stringify(tuples)).digest("hex");
}

const KIND_ORDER: Record<Drift["kind"], number> = {
  file: 0,
  "file-added": 1,
  "file-removed": 2,
  package: 3,
  url: 4,
};

export function sortDrift(drift: readonly Drift[]): Drift[] {
  return [...drift].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

interface GitHubCommit {
  sha: string;
  commit: { message: string; committer: { date: string } | null };
}

const toCommit = (entry: GitHubCommit): UpstreamCommit => ({
  sha: entry.sha,
  date: entry.commit.committer?.date ?? "",
  title: entry.commit.message.split("\n", 1)[0] ?? "",
});

const isSha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

export async function compare(list: WatchList, options: CompareOptions): Promise<Comparison> {
  const { github } = options;
  const repo = `/repos/${list.upstream.repository}`;
  const problems: string[] = [];
  const attempt = async <T>(label: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  const branch = await attempt(`branch ${list.upstream.branch}`, () =>
    github.get<{ commit?: { sha?: unknown; commit?: { committer?: { date?: string } } } }>(
      `${repo}/branches/${encodePath(list.upstream.branch)}`,
    ),
  );
  const headSha = branch?.commit?.sha;
  if (!isSha(headSha)) {
    throw new FetchIncomplete([...problems, `branch ${list.upstream.branch}: no head commit in the answer`]);
  }
  const head = { sha: headSha, date: branch?.commit?.commit?.committer?.date ?? "" };

  /** Commits on the branch that touched `path`, newest first, until `stopAt` (exclusive). */
  const commitsSince = async (path: string, stopAt: string | undefined, since?: string) => {
    const commits: UpstreamCommit[] = [];
    const pages = options.commitPages ?? 3;
    for (let page = 1; page <= pages; page++) {
      const query = new URLSearchParams({ sha: head.sha, path, per_page: "100", page: String(page) });
      if (since !== undefined) query.set("since", since);
      const batch = await github.get<GitHubCommit[]>(`${repo}/commits?${query.toString()}`);
      if (!Array.isArray(batch)) throw new UpstreamError(`commits for ${path}: not a list`);
      for (const entry of batch) {
        if (!isSha(entry.sha)) throw new UpstreamError(`commits for ${path}: malformed commit`);
        if (entry.sha === stopAt) return { commits, complete: true };
        commits.push(toCommit(entry));
      }
      if (batch.length < 100) return { commits, complete: stopAt === undefined };
    }
    return { commits, complete: false };
  };

  const blobText = async (sha: string) => {
    const blob = await github.get<{ content?: unknown; encoding?: unknown }>(`${repo}/git/blobs/${sha}`);
    if (blob.encoding !== "base64" || typeof blob.content !== "string") {
      throw new UpstreamError(`blob ${sha}: unexpected encoding`);
    }
    return Buffer.from(blob.content, "base64").toString("utf8");
  };

  const currentBlob = async (path: string): Promise<string> => {
    const found = await github.find<{ type?: unknown; sha?: unknown }>(
      `${repo}/contents/${encodePath(path)}?ref=${head.sha}`,
    );
    if (found === undefined) return ABSENT;
    if (found.type !== "file" || !isSha(found.sha)) {
      throw new UpstreamError(`${path}: not a file in the answer`);
    }
    return found.sha;
  };

  const checkFile = async (file: WatchedFile): Promise<Drift | undefined> => {
    const current = await currentBlob(file.path);
    if (current === file.pinnedBlob) return undefined;
    const history = await commitsSince(file.path, file.pinnedCommit);
    const diff =
      current === ABSENT ? undefined : unifiedDiff(await blobText(file.pinnedBlob), await blobText(current));
    return {
      kind: current === ABSENT ? "file-removed" : "file",
      id: file.path,
      pinned: file.pinnedBlob,
      current,
      affects: file.affects,
      pinnedCommit: file.pinnedCommit,
      commits: history.commits,
      commitsComplete: history.complete,
      diff,
    };
  };

  const checkPending = async (file: WatchList["pending"][number]): Promise<Drift | undefined> => {
    const current = await currentBlob(file.path);
    if (current === ABSENT) return undefined;
    const history = await commitsSince(file.path, undefined);
    return {
      kind: "file-added",
      id: file.path,
      pinned: ABSENT,
      current,
      affects: file.affects,
      pinnedCommit: undefined,
      commits: history.commits,
      commitsComplete: history.complete,
      diff: unifiedDiff("", await blobText(current)),
    };
  };

  const fetcher: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeout = options.timeoutMs ?? 30_000;

  const checkPackage = async (entry: WatchedPackage): Promise<Drift | undefined> => {
    const registry = options.npmRegistry ?? "https://registry.npmjs.org";
    const url = `${registry}/${entry.name.replace("/", "%2F")}`;
    let document: {
      "dist-tags"?: { latest?: unknown };
      versions?: Record<string, unknown>;
      time?: Record<string, string>;
    };
    try {
      const response = await fetcher(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new UpstreamError(`HTTP ${response.status}`, response.status);
      document = (await response.json()) as typeof document;
    } catch (error) {
      throw new UpstreamError(`npm ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const current =
      entry.follow === "latest"
        ? document["dist-tags"]?.latest
        : newestInMajor(entry.pinned, document.versions);
    if (
      typeof current !== "string" ||
      !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(current)
    ) {
      throw new UpstreamError(`npm ${entry.name}: no ${entry.follow} version in the answer`);
    }
    if (current === entry.pinned) return undefined;
    const releaseTag = entry.releaseTag?.replace("{version}", current);
    const releaseCommit = releaseTag === undefined ? undefined : await tagCommit(releaseTag);
    return {
      kind: "package",
      id: entry.name,
      pinned: entry.pinned,
      current,
      affects: entry.affects,
      published: document.time?.[current],
      releaseTag,
      releaseCommit,
    };
  };

  /** The commit an upstream tag points at; undefined when the tag does not exist. */
  const tagCommit = async (tag: string): Promise<string | undefined> => {
    const ref = await github.find<{ object?: { type?: unknown; sha?: unknown } }>(
      `${repo}/git/ref/${encodePath(`tags/${tag}`)}`,
    );
    if (ref === undefined) return undefined;
    let object = ref.object;
    // Annotated tags point at a tag object first.
    for (let hops = 0; object?.type === "tag" && isSha(object.sha) && hops < 3; hops++) {
      const tagObject = await github.get<{ object?: { type?: unknown; sha?: unknown } }>(
        `${repo}/git/tags/${object.sha}`,
      );
      object = tagObject.object;
    }
    if (object?.type !== "commit" || !isSha(object.sha))
      throw new UpstreamError(`tag ${tag}: no commit in the answer`);
    return object.sha;
  };

  const checkUrl = async (entry: WatchedUrl): Promise<Drift | undefined> => {
    let body: string;
    try {
      const response = await fetcher(entry.url, { redirect: "error", signal: AbortSignal.timeout(timeout) });
      if (response.status !== 200) throw new UpstreamError(`HTTP ${response.status}`, response.status);
      body = await response.text();
    } catch (error) {
      throw new UpstreamError(`${entry.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (body.length > MAX_URL_BYTES)
      throw new UpstreamError(`${entry.url}: the answer is larger than ${MAX_URL_BYTES} bytes`);
    const current = hashBody(entry.normalize, body);
    if (current === entry.sha256) return undefined;
    return { kind: "url", id: entry.url, pinned: entry.sha256, current, affects: entry.affects };
  };

  const checks = await Promise.all([
    ...list.files.map((file) => attempt(file.path, () => checkFile(file))),
    ...list.pending.map((file) => attempt(file.path, () => checkPending(file))),
    ...list.packages.map((entry) => attempt(entry.name, () => checkPackage(entry))),
    ...list.urls.map((entry) => attempt(entry.url, () => checkUrl(entry))),
  ]);

  const baseline = await attempt("baseline commit", () =>
    github.get<{ committer?: { date?: unknown } }>(`${repo}/git/commits/${list.upstream.baselineCommit}`),
  );
  const since = baseline?.committer?.date;
  const unreleased: UnreleasedPath[] = [];
  if (typeof since === "string") {
    for (const entry of list.paths) {
      const history = await attempt(entry.path, () =>
        commitsSince(entry.path, list.upstream.baselineCommit, since),
      );
      if (history !== undefined) unreleased.push({ ...entry, commits: history.commits });
    }
  } else if (baseline !== undefined) {
    problems.push("baseline commit: no committer date in the answer");
  }

  if (problems.length > 0) throw new FetchIncomplete(problems);
  const drift = sortDrift(checks.filter((entry): entry is Drift => entry !== undefined));
  return {
    checkedAt: (options.now?.() ?? new Date()).toISOString(),
    repository: list.upstream.repository,
    branch: list.upstream.branch,
    head,
    baselineRef: list.upstream.baselineRef,
    baselineCommit: list.upstream.baselineCommit,
    checked: {
      files: list.files.length,
      pending: list.pending.length,
      packages: list.packages.length,
      urls: list.urls.length,
    },
    drift,
    fingerprint: fingerprintOf(drift),
    unreleased,
  };
}

const parseVersion = (version: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** The newest stable (no pre-release) version with the same major as `pinned`. */
export function newestInMajor(
  pinned: string,
  versions: Record<string, unknown> | undefined,
): string | undefined {
  const major = parseVersion(pinned)?.[0];
  let best: number[] | undefined;
  let bestText: string | undefined;
  for (const version of Object.keys(versions ?? {})) {
    const parsed = parseVersion(version);
    if (parsed === undefined || parsed[0] !== major) continue;
    if (best === undefined || compareTuples(parsed, best) > 0) {
      best = parsed;
      bestText = version;
    }
  }
  return bestText;
}

const compareTuples = (a: readonly number[], b: readonly number[]): number => {
  for (let index = 0; index < 3; index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

/** JSON with object keys sorted at every level, so key order never reads as a change. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The normalised body a watched URL is hashed over. Throws on an empty or unparseable answer. */
export function normalizeBody(normalize: WatchedUrl["normalize"], body: string): string {
  if (normalize === "text") {
    const text = body.replace(/\r\n/g, "\n").trim();
    if (text === "") throw new UpstreamError("the answer is empty");
    return text;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new UpstreamError("the answer is not JSON");
  }
  if (normalize === "json-sorted") return canonicalJson(parsed);
  // x402-supported-stellar: only the Stellar kinds, in a stable order.
  const kinds = (parsed as { kinds?: unknown }).kinds;
  if (!Array.isArray(kinds) || kinds.length === 0)
    throw new UpstreamError("no kinds in the /supported answer");
  const stellar = kinds
    .filter(
      (kind): kind is { network: string } =>
        kind !== null &&
        typeof kind === "object" &&
        String((kind as { network?: unknown }).network).startsWith("stellar:"),
    )
    .map(canonicalJson)
    .sort();
  return `[${stellar.join(",")}]`;
}

export function hashBody(normalize: WatchedUrl["normalize"], body: string): string {
  return createHash("sha256").update(normalizeBody(normalize, body)).digest("hex");
}
