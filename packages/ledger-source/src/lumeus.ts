import { LedgerSourceError, type LedgerSourceCode } from "./errors.ts";
import { readCapped, type Fetch } from "./http.ts";

/**
 * Lumeus, a hosted Stellar data service: its Activity API (decoded history by account and contract) selects
 * which ledgers hold candidate transactions, and its RPC serves ledger bytes inside the RPC's retention.
 * Neither is trusted for content: every ledger read is verified against its own hashes and, when
 * configured, an independent anchor before anything is classified.
 */
export type LumeusNetwork = "stellar:testnet" | "stellar:pubnet";
export type LumeusProduct = "activity" | "rpc";

/** The only hosts a Lumeus key is ever sent to, per network and product. */
export const LUMEUS_HOSTS: Readonly<Record<LumeusNetwork, Readonly<Record<LumeusProduct, string>>>> = {
  "stellar:testnet": { activity: "api-testnet.lumeus.dev", rpc: "rpc-testnet.lumeus.dev" },
  "stellar:pubnet": { activity: "api.lumeus.dev", rpc: "rpc.lumeus.dev" },
};

/** The default endpoint of a Lumeus product on a network. */
export const lumeusUrl = (network: LumeusNetwork, product: LumeusProduct): string =>
  `https://${LUMEUS_HOSTS[network][product]}`;

/** The network whose Lumeus host `host` is, or undefined when it is not a Lumeus host. */
export function lumeusHostNetwork(host: string): LumeusNetwork | undefined {
  for (const network of Object.keys(LUMEUS_HOSTS) as LumeusNetwork[]) {
    if (Object.values(LUMEUS_HOSTS[network]).includes(host.toLowerCase())) return network;
  }
  return undefined;
}

const KEY = /^lum_(test|live)_[A-Za-z0-9_-]{8,256}$/;
const PUBLISHABLE_KEY = /^lum_pub_(test|live)_[A-Za-z0-9_-]{8,256}$/;

/** Whether `key` has the shape of a Lumeus publishable key (`lum_pub_test_…` or `lum_pub_live_…`). */
export const isPublishableLumeusKey = (key: string): boolean => PUBLISHABLE_KEY.test(key);

/**
 * Checks a key's shape and that it belongs to `network`: a `lum_test_` key only for testnet hosts, a
 * `lum_live_` key only for mainnet hosts. Publishable keys (`lum_pub_test_…`, `lum_pub_live_…`, read-only
 * and limited to their allowed origins) pass only with `publishable: true`; webhook keys never do. The
 * error never repeats the key.
 */
export function checkLumeusKey(
  key: string,
  network: LumeusNetwork,
  options: { readonly publishable?: boolean } = {},
): void {
  const match = KEY.exec(key) ?? (options.publishable === true ? PUBLISHABLE_KEY.exec(key) : null);
  if (match === null) {
    throw new LedgerSourceError(
      "lumeus_key_invalid",
      options.publishable === true
        ? "the Lumeus key is not a server or publishable key (lum_test_…, lum_live_…, lum_pub_…)"
        : "the Lumeus key is not a server key (lum_test_… or lum_live_…)",
    );
  }
  const keyNetwork: LumeusNetwork = match[1] === "test" ? "stellar:testnet" : "stellar:pubnet";
  if (keyNetwork !== network) {
    throw new LedgerSourceError(
      "lumeus_key_invalid",
      `a ${match[1] ?? ""} key belongs to ${keyNetwork}, not ${network}`,
    );
  }
}

/** The error codes the Lumeus APIs document; any other code is counted as `other`. */
const LUMEUS_CODES = new Set([
  "invalid_request",
  "unauthorized",
  "payment_required",
  "forbidden",
  "not_found",
  "topic_search_disabled",
  "method_not_allowed",
  "conflict",
  "generation_changed",
  "history_unavailable",
  "precondition_failed",
  "response_too_large",
  "precondition_required",
  "rate_limited",
  "internal_error",
  "not_implemented",
  "busy",
  "query_timeout",
  "index_not_ready",
  "topic_coverage",
  "unavailable",
  "submission_outcome_unknown",
]);
const LABEL_STATUSES = new Set([0, 400, 401, 402, 403, 404, 405, 409, 413, 429, 500, 501, 502, 503, 504]);

/**
 * A bounded metric label for a failed Lumeus request: a documented Lumeus code, `transport` or `body`,
 * `http_<status>` for a common status, else `other`. The code comes from the response body, which is
 * not trusted, so it never becomes a label as it is.
 */
export function lumeusCodeLabel(code: string | undefined, status: number): string {
  if (code === "transport" || code === "body") return code;
  if (code !== undefined && LUMEUS_CODES.has(code)) return code;
  if (code === undefined && LABEL_STATUSES.has(status)) return `http_${String(status)}`;
  return "other";
}

/**
 * Checks that `url` is https on `network`'s Lumeus host for `product`, with no credentials, query or
 * fragment, and returns it. The Lumeus key is sent only to URLs that pass this check.
 */
export function lumeusEndpoint(url: string, network: LumeusNetwork, product: LumeusProduct): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LedgerSourceError("source_config_invalid", `the Lumeus ${product} URL is not a URL`);
  }
  const expected = LUMEUS_HOSTS[network][product];
  if (
    parsed.protocol !== "https:" ||
    parsed.host !== expected ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new LedgerSourceError(
      "source_config_invalid",
      `the Lumeus ${product} URL for ${network} must be https://${expected}`,
    );
  }
  return parsed;
}

/** At most `max` calls at once; the others wait their turn in order. */
export class Limiter {
  readonly max: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(max: number) {
    if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("a limiter needs at least one slot");
    this.max = max;
  }

  get active(): number {
    return this.#active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.max) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else this.#active++;
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next === undefined) this.#active--;
      else next();
    }
  }
}

/** The most Lumeus requests in flight per workspace that its guidance allows for history walks. */
export const LUMEUS_MAX_CONCURRENCY = 8;

/** A Lumeus failure, with the server's code, its request id and any `Retry-After`. */
export class LumeusError extends LedgerSourceError {
  readonly status: number | undefined;
  readonly lumeusCode: string | undefined;
  readonly requestId: string | undefined;

  constructor(
    code: LedgerSourceCode,
    message: string,
    details: {
      readonly status?: number;
      readonly lumeusCode?: string;
      readonly requestId?: string;
      readonly retryAfterSeconds?: number;
      readonly retryable?: boolean;
      readonly cause?: unknown;
    } = {},
  ) {
    super(code, message, {
      ...(details.retryable === undefined ? {} : { retryable: details.retryable }),
      ...(details.cause === undefined ? {} : { cause: details.cause }),
      ...(details.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: details.retryAfterSeconds }),
    });
    this.name = "LumeusError";
    this.status = details.status;
    this.lumeusCode = details.lumeusCode;
    this.requestId = details.requestId;
  }
}

/**
 * What an Activity route is about: an account's history (`/accounts/{G}/activity`), one contract's
 * token movements and events (`/contracts/{C}/activity`), or the `approve` events that name an address
 * in a topic (`/accounts/{C}/contract-events?name=approve`, Lumeus topic search): the allowances granted
 * to a settlement contract that emits no events of its own and moves no funds itself.
 */
export interface ActivityRoute {
  readonly kind: "account" | "contract" | "approvals";
  readonly address: string;
}

/** The read view a walk is pinned to (Activity `read_view`). */
export interface ReadView {
  readonly network: string;
  readonly generation: string;
  readonly decoderVersion: string;
  readonly snapshotLedger: number;
  readonly publishedThrough: number;
}

/** The parts of an Activity record discovery uses. */
export interface ActivityRecord {
  readonly id: string;
  readonly kind: string;
  readonly type: string;
  readonly ledger: number;
  readonly txHash: string;
}

/** One complete walk of `[since, until)`. */
export interface WindowResult {
  readonly route: ActivityRoute;
  readonly since: number;
  /** Exclusive; the snapshot's next ledger for an open window. */
  readonly until: number | undefined;
  readonly readView: ReadView;
  /** The last ledger the walk covered (`scanned_through_ledger`): the checkpoint. */
  readonly scannedThrough: number;
  readonly records: readonly ActivityRecord[];
  readonly pages: number;
}

/**
 * One page of a ranged walk, handed over as soon as it is read so the caller stores its records and
 * checkpoint together: a failure later in the walk loses at most the page under way.
 */
export interface WalkStep {
  readonly route: ActivityRoute;
  /** The window the page belongs to (`until` exclusive). */
  readonly since: number;
  readonly until: number | undefined;
  readonly readView: ReadView;
  /** This page's records. */
  readonly records: readonly ActivityRecord[];
  /**
   * The last ledger every record is known for once this page is stored: on a window's last page its
   * `scanned_through_ledger`; on an earlier page the ledger before the page's last record (records come in
   * ascending order, so every earlier ledger is complete); null when the page moves nothing.
   */
  readonly scannedThrough: number | null;
  /** This page completed its window. */
  readonly complete: boolean;
}

/** One Activity request's outcome, for metrics: `ok`, or the status and Lumeus code that failed it. */
export type ActivityOutcome = { readonly status: number; readonly code: string | undefined };

export interface LumeusActivityOptions {
  readonly network: LumeusNetwork;
  /** A server key of the same network. Sent only to the network's Activity host. */
  readonly apiKey: string;
  /** Defaults to the network's Activity host. */
  readonly url?: string;
  readonly fetch?: Fetch;
  /** Shared with the other Lumeus clients, so the workspace never has more than 8 requests in flight. */
  readonly limiter?: Limiter;
  readonly timeoutMs?: number;
  /** Attempts per page for 429 and 5xx answers (default 5). */
  readonly attempts?: number;
  /** The longest `Retry-After` waited for (default 60 s); a longer one stops with `lumeus_rate_limited`. */
  readonly maxRetryAfterSeconds?: number;
  /** Largest page body, in bytes (default 16 MiB). */
  readonly maxBytes?: number;
  /** Records per page (default: 1,000 for accounts, 200 for contracts, the Activity maximums). */
  readonly pageLimit?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Called after every request, for metrics. */
  readonly onRequest?: (outcome: ActivityOutcome) => void;
}

const HASH = /^[0-9a-f]{64}$/;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Walks Lumeus Activity routes ascending, following Lumeus' sync rules: the first page pins the read view
 * (generation and snapshot ledger) and every later page must keep it; `_links.next` is followed only on
 * the same origin and route; a walk ends at `range_complete` with `scanned_through_ledger` as the
 * checkpoint; 429 and 5xx answers are retried after `Retry-After` (never one over 60 s, and never
 * `query_timeout` unchanged); `generation_changed` and `query_timeout` are handed to the caller, which
 * restarts or narrows the window.
 */
export class LumeusActivity {
  readonly network: LumeusNetwork;
  readonly #options: LumeusActivityOptions;
  readonly #base: URL;
  readonly #authorization: string;

  constructor(options: LumeusActivityOptions) {
    checkLumeusKey(options.apiKey, options.network);
    this.#base = lumeusEndpoint(
      options.url ?? lumeusUrl(options.network, "activity"),
      options.network,
      "activity",
    );
    this.network = options.network;
    this.#options = options;
    this.#authorization = `Bearer ${options.apiKey}`;
  }

  /** Walks `[since, until)` (`until` exclusive; open to the snapshot when undefined) to its end. */
  async walk(route: ActivityRoute, since: number, until?: number): Promise<WindowResult> {
    const records: ActivityRecord[] = [];
    let pages = 0;
    for await (const page of this.#pages(route, since, until)) {
      pages++;
      records.push(...page.records);
      if (page.complete && page.scannedThrough !== undefined) {
        return {
          route,
          since,
          until,
          readView: page.readView,
          scannedThrough: page.scannedThrough,
          records,
          pages,
        };
      }
    }
    throw new LumeusError(
      "lumeus_response_invalid",
      `${routePath(route)}: the walk ended without completing`,
    );
  }

  /**
   * The pages of one walk of `[since, until)`, pinned to the first page's read view, each checked; ends
   * with the page that completes the window (its `scannedThrough` set and clamped as Lumeus documents).
   */
  async *#pages(
    route: ActivityRoute,
    since: number,
    until: number | undefined,
  ): AsyncGenerator<{
    readonly readView: ReadView;
    readonly records: readonly ActivityRecord[];
    readonly complete: boolean;
    readonly scannedThrough: number | undefined;
  }> {
    if (!Number.isSafeInteger(since) || since < 1 || (until !== undefined && until <= since)) {
      throw new LumeusError(
        "lumeus_request_refused",
        `the window ${String(since)}-${String(until)} is empty`,
      );
    }
    const path = routePath(route);
    const first = new URL(path, this.#base);
    if (route.kind === "approvals") first.searchParams.set("name", "approve");
    first.searchParams.set("order", "asc");
    first.searchParams.set(
      "limit",
      String(this.#options.pageLimit ?? (route.kind === "contract" ? 200 : 1_000)),
    );
    first.searchParams.set("since_ledger", String(since));
    if (until !== undefined) first.searchParams.set("until_ledger", String(until));
    let url = first;
    let pinned: ReadView | undefined;
    let newest = since;
    let seen = 0;
    for (;;) {
      const page = parsePage(await this.#get(url), route, since, until);
      if (pinned === undefined) pinned = page.readView;
      else if (
        page.readView.generation !== pinned.generation ||
        page.readView.snapshotLedger !== pinned.snapshotLedger
      ) {
        throw new LumeusError(
          "lumeus_response_invalid",
          `${path}: a page left the pinned read view (${pinned.generation}@${String(pinned.snapshotLedger)})`,
        );
      }
      if (page.readView.network !== (this.network === "stellar:pubnet" ? "pubnet" : "testnet")) {
        throw new LumeusError("lumeus_response_invalid", `${path}: the page is for ${page.readView.network}`);
      }
      // Ascending order is what makes a page's checkpoint safe: no record may go back in the ledger order.
      for (const record of page.records) {
        if (record.ledger < newest) {
          throw new LumeusError(
            "lumeus_response_invalid",
            `${path}: records are not in ascending ledger order (${String(record.ledger)} after ${String(newest)})`,
          );
        }
        newest = record.ledger;
      }
      seen += page.records.length;
      if (!page.complete) {
        yield { readView: pinned, records: page.records, complete: false, scannedThrough: undefined };
        url = this.#next(page.next, path);
        continue;
      }
      let scanned = page.scannedThrough;
      // A window starting past the published tip is empty and complete: nothing new is covered.
      if (scanned !== undefined && scanned < since - 1 && scanned === pinned.snapshotLedger && seen === 0) {
        scanned = since - 1;
      }
      if (
        scanned === undefined ||
        scanned < since - 1 ||
        scanned > pinned.snapshotLedger ||
        (until !== undefined && scanned >= until) ||
        (seen > 0 && scanned < newest)
      ) {
        throw new LumeusError(
          "lumeus_response_invalid",
          `${path}: scanned_through_ledger ${String(scanned)} is outside ${String(since)}-${String(until)}`,
        );
      }
      yield { readView: pinned, records: page.records, complete: true, scannedThrough: scanned };
      return;
    }
  }

  /**
   * Walks `[from, until)` in windows of at most `windowLedgers`, handing over every page as it is read
   * (see `WalkStep`), so the caller stores records and checkpoint together and a failure loses at most
   * one page. A `query_timeout` narrows the window (never the same request again) and resumes after the
   * last page handed over; a `generation_changed` restarts there without the old read view. Stops at
   * `until`, or at the snapshot when `until` is undefined.
   */
  async *walkRange(
    route: ActivityRoute,
    from: number,
    until: number | undefined,
    options: { readonly windowLedgers: number; readonly maxRestarts?: number } = { windowLedgers: 500_000 },
  ): AsyncGenerator<WalkStep> {
    let since = from;
    let width = Math.max(1, options.windowLedgers);
    let restarts = 0;
    while (until === undefined || since < until) {
      const end = until === undefined ? since + width : Math.min(until, since + width);
      // The last ledger every page handed over so far vouches for.
      let covered = since - 1;
      let scanned: number | undefined;
      try {
        for await (const page of this.#pages(route, since, end)) {
          const last = page.records.at(-1)?.ledger;
          const checkpoint = page.complete
            ? (page.scannedThrough ?? null)
            : last !== undefined && last - 1 > covered
              ? last - 1
              : null;
          yield {
            route,
            since,
            until: end,
            readView: page.readView,
            records: page.records,
            scannedThrough: checkpoint,
            complete: page.complete,
          };
          if (checkpoint !== null) covered = Math.max(covered, checkpoint);
          if (page.complete) scanned = page.scannedThrough;
        }
      } catch (error) {
        // Resume after what was already handed over.
        const resume = covered + 1;
        if (error instanceof LumeusError && error.code === "lumeus_query_timeout" && end - resume > 1) {
          since = resume;
          width = Math.max(1, Math.floor((end - resume) / 2));
          continue;
        }
        if (
          error instanceof LumeusError &&
          error.code === "lumeus_generation_changed" &&
          ++restarts <= (options.maxRestarts ?? 3)
        ) {
          since = resume;
          continue;
        }
        throw error;
      }
      restarts = 0;
      if (scanned === undefined) return;
      // The snapshot ends before the window: everything published is covered.
      if (scanned < end - 1) return;
      since = scanned + 1;
    }
  }

  #next(href: string | undefined, path: string): URL {
    if (href === undefined) {
      throw new LumeusError("lumeus_response_invalid", `${path}: an incomplete page has no next link`);
    }
    let next: URL;
    try {
      next = new URL(href, this.#base);
    } catch {
      throw new LumeusError("lumeus_response_invalid", `${path}: the next link is not a URL`);
    }
    // The key goes to the Activity origin only, and a next link stays on the route it continues.
    if (next.origin !== this.#base.origin || next.pathname !== path) {
      throw new LumeusError("lumeus_request_refused", `${path}: a next link leaves the route or the origin`);
    }
    return next;
  }

  async #get(url: URL): Promise<unknown> {
    const attempts = Math.max(1, this.#options.attempts ?? 5);
    const maxWait = this.#options.maxRetryAfterSeconds ?? 60;
    const sleep = this.#options.sleep ?? defaultSleep;
    const random = this.#options.random ?? Math.random;
    let last: LumeusError | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const answer = await this.#once(url);
      if (!(answer instanceof LumeusError)) return answer;
      last = answer;
      if (!answer.retryable) throw answer;
      const wait = answer.retryAfterSeconds;
      if (wait !== undefined && wait > maxWait) {
        throw new LumeusError(
          "lumeus_rate_limited",
          `${url.host} asks to wait ${String(wait)} s (${answer.lumeusCode ?? String(answer.status)}); stopping instead`,
          {
            ...(answer.status === undefined ? {} : { status: answer.status }),
            ...(answer.requestId === undefined ? {} : { requestId: answer.requestId }),
            retryAfterSeconds: wait,
            retryable: true,
          },
        );
      }
      if (attempt === attempts) break;
      const backoff = wait === undefined ? 2 ** (attempt - 1) : wait;
      await sleep(backoff * 1000 + Math.floor(random() * 500));
    }
    throw new LumeusError(
      last?.status === 429 ? "lumeus_rate_limited" : "lumeus_unavailable",
      `${url.host}: no answer after ${String(attempts)} attempts (${last?.message ?? "unknown"})`,
      {
        ...(last?.status === undefined ? {} : { status: last.status }),
        ...(last?.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: last.retryAfterSeconds }),
        retryable: true,
        cause: last,
      },
    );
  }

  /** One request: the parsed body, or a coded error (retryable for 429, 5xx and transport failures). */
  async #once(url: URL): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      let response: Response;
      try {
        response = await (this.#options.fetch ?? fetch)(url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(this.#options.timeoutMs ?? 30_000),
          headers: { authorization: this.#authorization, accept: "application/json" },
        });
      } catch (error) {
        this.#options.onRequest?.({ status: 0, code: "transport" });
        const timeout =
          error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
        return new LumeusError(
          "lumeus_unavailable",
          `${url.host}: ${timeout ? "timed out" : "unreachable"}`,
          {
            retryable: true,
            cause: error,
          },
        );
      }
      let body: Buffer;
      try {
        body = await readCapped(response, url, this.#options.maxBytes ?? 16 * 1024 * 1024);
      } catch (error) {
        this.#options.onRequest?.({ status: response.status, code: "body" });
        if (error instanceof LedgerSourceError && error.code === "object_too_large") {
          return new LumeusError("lumeus_response_invalid", error.message, { status: response.status });
        }
        return new LumeusError("lumeus_unavailable", `${url.host}: the response broke off`, {
          status: response.status,
          retryable: true,
          cause: error,
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        parsed = undefined;
      }
      if (response.status === 200) {
        this.#options.onRequest?.({ status: 200, code: undefined });
        if (parsed === undefined) {
          return new LumeusError("lumeus_response_invalid", `${url.host}: the page is not JSON`, {
            status: 200,
          });
        }
        return parsed;
      }
      const fields = (parsed ?? {}) as { code?: unknown; request_id?: unknown };
      const lumeusCode = typeof fields.code === "string" ? fields.code.slice(0, 64) : undefined;
      const requestId = typeof fields.request_id === "string" ? fields.request_id.slice(0, 64) : undefined;
      const retryAfter = Number(response.headers.get("retry-after") ?? "NaN");
      this.#options.onRequest?.({ status: response.status, code: lumeusCode });
      const details = {
        status: response.status,
        ...(lumeusCode === undefined ? {} : { lumeusCode }),
        ...(requestId === undefined ? {} : { requestId }),
        ...(Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfterSeconds: retryAfter } : {}),
      };
      const said = `${url.host} answered ${String(response.status)} ${lumeusCode ?? ""}${requestId === undefined ? "" : ` (${requestId})`}`;
      if (response.status >= 300 && response.status < 400) {
        return new LumeusError("lumeus_request_refused", `${said}; redirects are refused`, details);
      }
      if (response.status === 401 || response.status === 403) {
        return new LumeusError("lumeus_unauthorized", said, details);
      }
      if (response.status === 409 && lumeusCode === "generation_changed") {
        return new LumeusError("lumeus_generation_changed", said, details);
      }
      if (lumeusCode === "query_timeout") {
        return new LumeusError("lumeus_query_timeout", said, details);
      }
      if (RETRYABLE_STATUS.has(response.status)) {
        return new LumeusError(response.status === 429 ? "lumeus_rate_limited" : "lumeus_unavailable", said, {
          ...details,
          retryable: true,
        });
      }
      return new LumeusError("lumeus_request_refused", said, details);
    };
    return this.#options.limiter === undefined ? run() : this.#options.limiter.run(run);
  }
}

function routePath(route: ActivityRoute): string {
  if (!/^[A-Z2-7]{56}$/.test(route.address)) {
    throw new LumeusError("lumeus_request_refused", "a route address must be a G… or C… strkey");
  }
  if (route.kind === "approvals") return `/accounts/${route.address}/contract-events`;
  return `/${route.kind === "account" ? "accounts" : "contracts"}/${route.address}/activity`;
}

interface Page {
  readonly readView: ReadView;
  readonly records: ActivityRecord[];
  readonly complete: boolean;
  readonly scannedThrough: number | undefined;
  readonly next: string | undefined;
}

const ledgerNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** Checks an Activity page's shape and that every record lies inside the window it was asked for. */
function parsePage(body: unknown, route: ActivityRoute, since: number, until: number | undefined): Page {
  const invalid = (what: string) =>
    new LumeusError("lumeus_response_invalid", `${routePath(route)}: ${what}`);
  if (body === null || typeof body !== "object") throw invalid("the page is not an object");
  const page = body as {
    read_view?: Record<string, unknown>;
    range_complete?: unknown;
    scanned_through_ledger?: unknown;
    _links?: { next?: { href?: unknown } };
    _embedded?: { records?: unknown };
  };
  const view = page.read_view;
  if (
    view === undefined ||
    typeof view["generation"] !== "string" ||
    typeof view["network"] !== "string" ||
    !ledgerNumber(view["snapshot_ledger"]) ||
    !ledgerNumber(view["published_through"])
  ) {
    throw invalid("the page has no read view");
  }
  if (typeof page.range_complete !== "boolean") throw invalid("range_complete is missing");
  const listed = page._embedded?.records;
  if (!Array.isArray(listed)) throw invalid("the page has no records list");
  const records = listed.map((item: unknown): ActivityRecord => {
    const record = (item ?? {}) as Record<string, unknown>;
    const ledger = record["ledger"];
    const txHash = record["tx_hash"];
    if (
      !ledgerNumber(ledger) ||
      typeof txHash !== "string" ||
      !HASH.test(txHash) ||
      typeof record["id"] !== "string" ||
      typeof record["kind"] !== "string" ||
      typeof record["type"] !== "string"
    ) {
      throw invalid("a record has no ledger, transaction hash, id, kind or type");
    }
    if (ledger < since || (until !== undefined && ledger >= until)) {
      throw invalid(`a record of ledger ${String(ledger)} lies outside ${String(since)}-${String(until)}`);
    }
    if (route.kind === "approvals" && (record["kind"] !== "contract_event" || record["type"] !== "approve")) {
      throw invalid("a topic-search record is not an approve event");
    }
    return { id: record["id"], kind: record["kind"], type: record["type"], ledger, txHash };
  });
  const scanned = page.scanned_through_ledger;
  const next = page._links?.next?.href;
  return {
    readView: {
      network: view["network"],
      generation: view["generation"],
      decoderVersion: typeof view["decoder_version"] === "string" ? view["decoder_version"] : "",
      snapshotLedger: view["snapshot_ledger"],
      publishedThrough: view["published_through"],
    },
    records,
    complete: page.range_complete,
    scannedThrough: typeof scanned === "number" && Number.isSafeInteger(scanned) ? scanned : undefined,
    next: typeof next === "string" ? next : undefined,
  };
}
