/**
 * An in-memory upstream for the watcher's tests: the GitHub REST calls the watcher makes (and only
 * those), the npm registry and watched URLs, behind one `fetch`. Any other call fails the test.
 */
import { createHash } from "node:crypto";

export interface FakeCommit {
  readonly sha: string;
  readonly date: string;
  readonly message: string;
  /** Paths the commit touched, with each one's new content (undefined deletes it). */
  readonly files: Record<string, string | undefined>;
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  state_reason: string | null;
  /** Who closed the issue; GitHub reports it on a single-issue read only. */
  closed_by: { login: string } | null;
  labels: { name: string }[];
  user: { login: string };
  pull_request?: unknown;
  comments: string[];
}

export const blobSha = (content: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest("hex");

export const sha = (seed: string) => createHash("sha1").update(seed).digest("hex");

export const BOT = "github-actions[bot]";

export class FakeUpstream {
  readonly repository: string;
  readonly tracker: string;
  /** Oldest first, on the watched branch. */
  readonly commits: FakeCommit[] = [];
  readonly blobs = new Map<string, string>();
  readonly tags = new Map<string, { type: "commit" | "tag"; sha: string; target?: string }>();
  readonly npm = new Map<string, { latest: string; versions: string[]; time: Record<string, string> }>();
  readonly urls = new Map<string, string>();
  readonly issues: FakeIssue[] = [];
  readonly labels = new Set<string>();
  /** Every call, as `METHOD path`. */
  readonly calls: string[] = [];
  /** Calls the watcher is not expected to make. */
  readonly unexpected: string[] = [];
  /** Requests whose `METHOD url` matches answer with this status. */
  readonly failures: { pattern: RegExp; status: number }[] = [];

  constructor(repository = "x402-foundation/x402", tracker = "tolgayayci/rail402") {
    this.repository = repository;
    this.tracker = tracker;
  }

  commit(message: string, files: Record<string, string | undefined>, date: string): string {
    const commitSha = sha(`${this.commits.length}:${message}`);
    this.commits.push({ sha: commitSha, date, message, files });
    for (const content of Object.values(files)) {
      if (content !== undefined) this.blobs.set(blobSha(content), content);
    }
    return commitSha;
  }

  get head(): FakeCommit {
    const last = this.commits.at(-1);
    if (last === undefined) throw new Error("no commits");
    return last;
  }

  /** File contents at a commit (inclusive), or undefined. */
  contentAt(path: string, at: string): string | undefined {
    let content: string | undefined;
    for (const entry of this.commits) {
      if (path in entry.files) content = entry.files[path];
      if (entry.sha === at) break;
    }
    return content;
  }

  /** The last commit at or before `at` touching `path` (or anything under `path/`). */
  lastCommitFor(path: string, at = this.head.sha): string | undefined {
    let found: string | undefined;
    for (const entry of this.commits) {
      if (Object.keys(entry.files).some((file) => file === path || file.startsWith(`${path}/`)))
        found = entry.sha;
      if (entry.sha === at) break;
    }
    return found;
  }

  issue(fields: Partial<FakeIssue> & { body: string }): FakeIssue {
    const created: FakeIssue = {
      number: this.issues.length + 1,
      title: "an issue",
      state: "open",
      state_reason: null,
      closed_by: null,
      labels: [],
      user: { login: BOT },
      comments: [],
      ...fields,
    };
    this.issues.push(created);
    return created;
  }

  get writes(): string[] {
    return this.calls.filter((call) => !call.startsWith("GET "));
  }

  readonly fetch = (input: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    const url = new URL(input);
    const call = `${method} ${url.pathname}${url.search}`;
    this.calls.push(call);
    for (const failure of this.failures) {
      if (failure.pattern.test(`${method} ${input}`))
        return Promise.resolve(json({ message: "injected" }, failure.status));
    }
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const answer =
      url.host === "api.github.com"
        ? this.#github(method, url, body)
        : url.host === "registry.npmjs.org"
          ? this.#npm(method, url)
          : this.#url(method, input);
    if (answer === undefined) {
      this.unexpected.push(call);
      return Promise.reject(new Error(`unexpected call: ${call}`));
    }
    return Promise.resolve(answer);
  };

  #npm(method: string, url: URL): Response | undefined {
    if (method !== "GET") return undefined;
    const name = decodeURIComponent(url.pathname.slice(1));
    const entry = this.npm.get(name);
    if (entry === undefined) return json({ error: "Not found" }, 404);
    return json({
      name,
      "dist-tags": { latest: entry.latest },
      versions: Object.fromEntries(entry.versions.map((version) => [version, {}])),
      time: entry.time,
    });
  }

  #url(method: string, input: string): Response | undefined {
    if (method !== "GET") return undefined;
    const body = this.urls.get(input);
    return body === undefined ? undefined : new Response(body, { status: 200 });
  }

  #github(method: string, url: URL, body: Record<string, unknown>): Response | undefined {
    const path = decodeURIComponent(url.pathname);
    const query = url.searchParams;
    const upstream = `/repos/${this.repository}`;
    const tracker = `/repos/${this.tracker}`;
    let match: RegExpExecArray | null;

    if (method === "GET" && (match = new RegExp(`^${upstream}/branches/(.+)$`).exec(path))) {
      return json({
        name: match[1],
        commit: { sha: this.head.sha, commit: { committer: { date: this.head.date } } },
      });
    }
    if (method === "GET" && (match = new RegExp(`^${upstream}/contents/(.+)$`).exec(path))) {
      const content = this.contentAt(match[1] as string, query.get("ref") ?? this.head.sha);
      return content === undefined
        ? json({ message: "Not Found" }, 404)
        : json({ type: "file", sha: blobSha(content) });
    }
    if (method === "GET" && path === `${upstream}/commits`) {
      const target = query.get("path") ?? "";
      const since = query.get("since");
      const page = Number(query.get("page") ?? "1");
      const perPage = Number(query.get("per_page") ?? "30");
      const touching = this.commits
        .filter((entry) =>
          Object.keys(entry.files).some((file) => file === target || file.startsWith(`${target}/`)),
        )
        .filter((entry) => since === null || entry.date >= since)
        .reverse();
      return json(
        touching.slice((page - 1) * perPage, page * perPage).map((entry) => ({
          sha: entry.sha,
          commit: { message: entry.message, committer: { date: entry.date } },
        })),
      );
    }
    if (method === "GET" && (match = new RegExp(`^${upstream}/git/blobs/([0-9a-f]{40})$`).exec(path))) {
      const content = this.blobs.get(match[1] as string);
      return content === undefined
        ? json({ message: "Not Found" }, 404)
        : json({ encoding: "base64", content: Buffer.from(content).toString("base64") });
    }
    if (method === "GET" && (match = new RegExp(`^${upstream}/git/commits/([0-9a-f]{40})$`).exec(path))) {
      const entry = this.commits.find((candidate) => candidate.sha === match?.[1]);
      return entry === undefined
        ? json({ message: "Not Found" }, 404)
        : json({ committer: { date: entry.date } });
    }
    if (method === "GET" && (match = new RegExp(`^${upstream}/git/ref/tags/(.+)$`).exec(path))) {
      const tag = this.tags.get(match[1] as string);
      return tag === undefined
        ? json({ message: "Not Found" }, 404)
        : json({ object: { type: tag.type, sha: tag.sha } });
    }
    if (method === "GET" && (match = new RegExp(`^${upstream}/git/tags/([0-9a-f]{40})$`).exec(path))) {
      const tag = [...this.tags.values()].find((candidate) => candidate.sha === match?.[1]);
      return tag?.target === undefined
        ? json({ message: "Not Found" }, 404)
        : json({ object: { type: "commit", sha: tag.target } });
    }

    // The tracker repository: issues, comments and the label.
    if (method === "GET" && path === `${tracker}/issues`) {
      const label = query.get("labels");
      const state = query.get("state") ?? "open";
      const found = this.issues
        .filter((issue) => label === null || issue.labels.some((entry) => entry.name === label))
        .filter((issue) => state === "all" || issue.state === state)
        .sort((a, b) => b.number - a.number);
      return json(found.map(({ comments: _comments, closed_by: _closedBy, ...issue }) => issue));
    }
    if (method === "GET" && (match = new RegExp(`^${tracker}/issues/(\\d+)$`).exec(path))) {
      const issue = this.issues.find((candidate) => candidate.number === Number(match?.[1]));
      if (issue === undefined) return json({ message: "Not Found" }, 404);
      const { comments: _comments, ...fields } = issue;
      return json(fields);
    }
    if (method === "GET" && (match = new RegExp(`^${tracker}/labels/(.+)$`).exec(path))) {
      return this.labels.has(match[1] as string)
        ? json({ name: match[1] })
        : json({ message: "Not Found" }, 404);
    }
    if (method === "POST" && path === `${tracker}/labels`) {
      this.labels.add(String(body["name"]));
      return json({ name: body["name"] }, 201);
    }
    if (method === "POST" && path === `${tracker}/issues`) {
      const labels = (body["labels"] as string[] | undefined) ?? [];
      const created = this.issue({
        title: String(body["title"]),
        body: String(body["body"]),
        labels: labels.map((name) => ({ name })),
      });
      return json(
        { number: created.number, html_url: `https://github.com/${this.tracker}/issues/${created.number}` },
        201,
      );
    }
    if (method === "PATCH" && (match = new RegExp(`^${tracker}/issues/(\\d+)$`).exec(path))) {
      const issue = this.issues.find((candidate) => candidate.number === Number(match?.[1]));
      if (issue === undefined) return json({ message: "Not Found" }, 404);
      if (typeof body["title"] === "string") issue.title = body["title"];
      if (typeof body["body"] === "string") issue.body = body["body"];
      if (body["state"] === "closed" || body["state"] === "open") {
        issue.state = body["state"];
        // The watcher writes with the workflow token.
        issue.closed_by = issue.state === "closed" ? { login: BOT } : null;
      }
      if (typeof body["state_reason"] === "string") issue.state_reason = body["state_reason"];
      return json({ number: issue.number });
    }
    if (method === "POST" && (match = new RegExp(`^${tracker}/issues/(\\d+)/comments$`).exec(path))) {
      const issue = this.issues.find((candidate) => candidate.number === Number(match?.[1]));
      if (issue === undefined) return json({ message: "Not Found" }, 404);
      issue.comments.push(String(body["body"]));
      return json({ id: issue.comments.length }, 201);
    }
    return undefined;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
