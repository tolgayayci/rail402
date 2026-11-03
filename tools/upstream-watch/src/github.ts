/**
 * The few GitHub REST calls the watcher makes, over an injectable `fetch`. Reads use the token when
 * one is given (CI passes the workflow's GITHUB_TOKEN); writes need it.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** An upstream answer the watcher could not use: a network error, a non-2xx status or a malformed body. */
export class UpstreamError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

export interface GitHubOptions {
  readonly fetch?: Fetch;
  readonly token?: string | undefined;
  readonly apiUrl?: string;
  readonly timeoutMs?: number;
}

/** Encodes each segment of a slash-separated path or ref for use in a URL path. */
export const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export class GitHub {
  readonly #fetch: Fetch;
  readonly #token: string | undefined;
  readonly #apiUrl: string;
  readonly #timeoutMs: number;

  constructor(options: GitHubOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#token = options.token === "" ? undefined : options.token;
    this.#apiUrl = options.apiUrl ?? "https://api.github.com";
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  get canWrite(): boolean {
    return this.#token !== undefined;
  }

  /** GET that must succeed. */
  async get<T>(path: string): Promise<T> {
    const found = await this.#call<T>("GET", path, undefined, false);
    if (found === undefined) throw new UpstreamError(`GET ${path}: 404`, 404);
    return found;
  }

  /** GET where 404 means "does not exist". */
  async find<T>(path: string): Promise<T | undefined> {
    return this.#call<T>("GET", path, undefined, true);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.#call<T>("POST", path, body, false)) as T;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return (await this.#call<T>("PATCH", path, body, false)) as T;
  }

  async #call<T>(method: string, path: string, body: unknown, missingOk: boolean): Promise<T | undefined> {
    if (method !== "GET" && this.#token === undefined) {
      throw new UpstreamError(`${method} ${path}: a token is required to write`);
    }
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "rail402-upstream-watch",
    };
    if (this.#token !== undefined) headers["authorization"] = `Bearer ${this.#token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiUrl}${path}`, {
        method,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new UpstreamError(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 404 && missingOk) return undefined;
    if (!response.ok) {
      throw new UpstreamError(`${method} ${path}: HTTP ${response.status}`, response.status);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new UpstreamError(`${method} ${path}: the answer is not JSON`, response.status);
    }
  }
}
