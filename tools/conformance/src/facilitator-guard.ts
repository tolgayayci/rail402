/**
 * What stands between a pubnet harness and the facilitator it pays through.
 *
 * - The API key: read from RAIL402_FACILITATOR_API_KEY_FILE (owner-only), sent as
 *   `Authorization: Bearer <key>`, which Rail402 accepts whether or not it also takes `X-API-Key`.
 * - Access, before anything is spent: a probe `/verify` (an empty payment that is never settled)
 *   shows whether the facilitator refuses this caller as `unauthorized` or `forbidden`; a run without
 *   a key, or with a key the facilitator refuses, stops there.
 * - Settlements, at the wire: every `POST /settle` to a guarded facilitator is debited against the
 *   caps, at the facilitator's fee ceiling for its scheme, before it is sent, whoever sends it (the
 *   harness, a stock seller, the forwarder in front of a third-party suite). One that would pass a cap
 *   is never sent and fails with `spend_cap_exceeded`.
 */
import { readFileSync } from "node:fs";
import { ProfileError, checkSecretFile, type SpendMeter } from "./network.ts";

export interface GuardOptions {
  /** Facilitator base URLs; requests to anything else pass untouched. */
  readonly urls: readonly string[];
  readonly meter: SpendMeter;
  readonly feeCeiling: (scheme: "exact" | "upto") => bigint;
  readonly apiKey?: string;
}

export interface FacilitatorGuard {
  readonly fetch: typeof fetch;
  /** Puts the global `fetch` back. */
  restore(): void;
}

/** Reads the API key file: owner-only, not a link, one non-empty line. */
export function readApiKey(file: string): string {
  checkSecretFile(file, "the facilitator API key file", {
    missing: "pubnet_api_key_missing",
    unsafe: "pubnet_api_key_unsafe",
  });
  const key = readFileSync(file, "utf8").trim();
  if (key === "" || /\s/.test(key)) {
    throw new ProfileError("pubnet_api_key_missing", "the facilitator API key file must hold one key");
  }
  return key;
}

const base = (url: string) => url.replace(/\/+$/, "");

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The scheme a `/settle` body asks for; undefined when the body cannot be read. */
export function settleScheme(body: unknown): "exact" | "upto" | undefined {
  let text: string | undefined;
  if (typeof body === "string") text = body;
  else if (body instanceof Uint8Array) text = Buffer.from(body).toString("utf8");
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as { paymentRequirements?: { scheme?: unknown } };
    const scheme = parsed.paymentRequirements?.scheme;
    return scheme === "exact" || scheme === "upto" ? scheme : undefined;
  } catch {
    return undefined;
  }
}

/** A `fetch` that counts settlements and carries the key for the facilitators in `options`. */
export function guardedFetch(options: GuardOptions, inner: typeof fetch): typeof fetch {
  const bases = options.urls.map(base);
  const ceiling = (scheme: "exact" | "upto" | undefined): bigint => {
    if (scheme !== undefined) return options.feeCeiling(scheme);
    // An unreadable body is counted at the higher ceiling that is configured.
    const exact = options.feeCeiling("exact");
    try {
      const upto = options.feeCeiling("upto");
      return upto > exact ? upto : exact;
    } catch {
      return exact;
    }
  };
  return async (input, init) => {
    const url = requestUrl(input);
    const target = bases.find((entry) => url === entry || url.startsWith(`${entry}/`));
    if (target === undefined) return inner(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const path = new URL(url).pathname.slice(new URL(target).pathname.replace(/\/+$/, "").length);
    if (method === "POST" && path === "/settle") {
      const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      const scheme = settleScheme(body);
      options.meter.settlement(
        ceiling(scheme),
        `a /settle request${scheme === undefined ? "" : ` (${scheme})`}`,
      );
    }
    if (options.apiKey === undefined) return inner(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("authorization") && !headers.has("x-api-key")) {
      headers.set("authorization", `Bearer ${options.apiKey}`);
    }
    return inner(input, { ...init, headers });
  };
}

/** Installs the guard as the process's global `fetch`. */
export function installFacilitatorGuard(options: GuardOptions): FacilitatorGuard {
  const original = globalThis.fetch;
  const guarded = guardedFetch(options, original);
  globalThis.fetch = guarded;
  return {
    fetch: guarded,
    restore: () => {
      if (globalThis.fetch === guarded) globalThis.fetch = original;
    },
  };
}

/**
 * Refuses a run against a facilitator that would refuse it for its key: `pubnet_api_key_missing` when
 * no key is set and the facilitator wants one, `pubnet_api_key_refused` when the key is not accepted.
 * Any other answer (the probe's empty payment is refused as invalid) means the caller is served.
 */
export async function checkFacilitatorAccess(
  url: string,
  network: string,
  apiKey: string | undefined,
  inner: typeof fetch = globalThis.fetch,
): Promise<void> {
  const requirements = { scheme: "exact", network };
  let response: Response;
  try {
    response = await inner(`${base(url)}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: { x402Version: 2, accepted: requirements, payload: {} },
        paymentRequirements: requirements,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ProfileError(
      "pubnet_facilitator_unreachable",
      `${base(url)} did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const codes = [body["error"], body["invalidReason"], body["errorReason"]];
  const refused =
    response.status === 401 ||
    response.status === 403 ||
    codes.includes("unauthorized") ||
    codes.includes("forbidden");
  if (!refused) return;
  throw apiKey === undefined
    ? new ProfileError(
        "pubnet_api_key_missing",
        `${base(url)} requires an API key on ${network}: set RAIL402_FACILITATOR_API_KEY_FILE`,
      )
    : new ProfileError("pubnet_api_key_refused", `${base(url)} refuses the API key for ${network}`);
}
