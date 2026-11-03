import { readFileSync } from "node:fs";

/**
 * Lumeus testnet Activity pages recorded for every registry route over ledgers 5,330,305–5,330,320 (the
 * committed ledger slice), and error bodies from the same API. Keys and request ids are not recorded.
 */
export interface LumeusRecording {
  readonly since: number;
  readonly until: number;
  /** Bodies by path and query without `limit`, query keys sorted. */
  readonly pages: Readonly<Record<string, unknown>>;
  readonly emptyPage: {
    readonly read_view: Record<string, unknown>;
    readonly _embedded: { readonly records: readonly unknown[] };
  };
  readonly errors: Readonly<Record<string, { readonly status: number; readonly body: unknown }>>;
}

export const RECORDING = JSON.parse(
  readFileSync(new URL("./fixtures/lumeus/testnet-5330305-5330320.json", import.meta.url), "utf8"),
) as LumeusRecording;

/**
 * Lumeus testnet topic search recorded for the beta upto contract CCMM3FMG… (the approve events naming
 * it as the spender) over ledgers 3,953,870–3,953,890: the beta settlement of ledger 3,953,878.
 */
export const BETA_APPROVALS = JSON.parse(
  readFileSync(
    new URL("./fixtures/lumeus/testnet-beta-approvals-3953870-3953890.json", import.meta.url),
    "utf8",
  ),
) as { readonly since: number; readonly until: number; readonly pages: Readonly<Record<string, unknown>> };

export const BETA_CONTRACT = "CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X";

/** A key of the right shape for tests; no such key exists. */
export const TEST_KEY = `lum_test_${"0".repeat(32)}`;

export const SPONSOR = "GDKMZDQWLPH466HID3JCZHV2TSPLYY2LOSQ4K2DUZTDUZQGVL6SEGH62";
export const UPTO_CONTRACT = "CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U";

/** The recording's lookup key of a request URL: its path and query without `limit`, keys sorted. */
export function recordingKey(url: URL): string {
  const query = [...url.searchParams]
    .filter(([key]) => key !== "limit")
    .sort(([a], [b]) => a.localeCompare(b));
  return `${url.pathname}?${new URLSearchParams(query).toString()}`;
}

export interface ActivityCall {
  readonly url: URL;
  readonly authorization: string | null;
}

/**
 * A fetch that answers Activity requests from the recording: a recorded page when there is one; for a
 * route inside the recorded window with no rows, an empty complete page; otherwise an empty complete page
 * scanned to the end of the requested window (capped at `head`). `override` can answer any call first.
 */
export function fakeActivity(
  options: {
    readonly head?: number;
    readonly override?: (call: ActivityCall, index: number) => Response | undefined;
  } = {},
) {
  const calls: ActivityCall[] = [];
  const head = options.head ?? RECORDING.until - 1;
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    const call = { url, authorization: headers.get("authorization") };
    calls.push(call);
    const special = options.override?.(call, calls.length - 1);
    if (special !== undefined) return Promise.resolve(special);
    const recorded = RECORDING.pages[recordingKey(url)] ?? BETA_APPROVALS.pages[recordingKey(url)];
    if (recorded !== undefined) return Promise.resolve(Response.json(recorded));
    const since = Number(url.searchParams.get("since_ledger"));
    const until = url.searchParams.get("until_ledger");
    const end = until === null ? head : Math.min(head, Number(until) - 1);
    return Promise.resolve(
      Response.json({
        ...RECORDING.emptyPage,
        read_view: { ...RECORDING.emptyPage.read_view, snapshot_ledger: head, published_through: head },
        range_complete: true,
        scanned_through_ledger: Math.max(end, Math.min(since - 1, head)),
        _links: { self: { href: `${url.pathname}${url.search}` } },
        _embedded: { records: [] },
      }),
    );
  };
  return { fetch: fetchFn, calls };
}

/** A JSON error response like the Activity API's. */
export function lumeusError(status: number, code: string, retryAfter?: number): Response {
  return Response.json(
    { code, error: code.replace(/_/g, " ") },
    { status, headers: retryAfter === undefined ? {} : { "retry-after": String(retryAfter) } },
  );
}
