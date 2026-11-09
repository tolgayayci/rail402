import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { httpError, keySignupError, toErrorBody, type Rail402Error } from "@rail402.dev/errors";
import type { IssueLimits, IssueOutcome, IssueRequest, IssuedKeyRow } from "@rail402.dev/store-postgres";
import type { StellarNetwork } from "@rail402.dev/stellar";
import { ISSUED_KEY_ID_PREFIX, newAccessKey, type AccessKeyRecord, type AccessKeys } from "./access.ts";
import type { KeySignupConfig } from "./config.ts";
import type { Logger } from "@rail402.dev/facilitator";
import type { Metrics } from "./metrics.ts";

/**
 * Access keys for signed-in GitHub accounts. `GET /keys/new` sends the browser to GitHub with a state
 * kept in a cookie; `GET /keys/callback` checks the state, reads the account's public profile (no scope
 * is asked for, and the GitHub token is never stored) and issues the account one key, shown once as
 * JSON. Signing in again replaces the key. The database keeps the key's digest only.
 */

/** Where the store issues keys: `PostgresIssuedKeys` in the service. */
export interface IssuedKeyStore {
  issue(request: IssueRequest, limits: IssueLimits): Promise<IssueOutcome>;
  list(now?: Date): Promise<IssuedKeyRow[]>;
}

export interface SignupDependencies {
  readonly config: KeySignupConfig;
  readonly store: IssuedKeyStore;
  readonly accessKeys: AccessKeys;
  readonly metrics: Metrics;
  readonly log: Logger;
  /** Whether a request reached the host that serves `config.network`. */
  readonly onSignupHost: (c: Context) => boolean;
  /** Seconds to wait before another sign-up request from this client (0 = go). */
  readonly signupWait: (c: Context) => Promise<number>;
  /** Defaults to the global `fetch`; tests pass their own. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** The cookie holding the sign-in state between `/keys/new` and `/keys/callback`. */
export const SIGNUP_STATE_COOKIE = "__Host-rail402-signup";
/** How long a sign-in may take, from `/keys/new` to `/keys/callback`. */
const STATE_MAX_AGE_SECONDS = 600;
/** How long GitHub may take to answer one call. */
const GITHUB_TIMEOUT_MS = 10_000;
const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_USER = "https://api.github.com/user";
/** Sign-up requests per minute from one client address. */
export const SIGNUP_REQUESTS_PER_MINUTE = 10;

/** An issued key's row as the access record every replica matches requests against. */
export function issuedRecord(row: IssuedKeyRow): AccessKeyRecord {
  return {
    id: row.id,
    sha256: Buffer.from(row.sha256, "hex"),
    networks: row.networks as StellarNetwork[],
    requestsPerMinute: row.requestsPerMinute,
    sponsorBudgetStroopsPerHour: row.sponsorBudgetStroopsPerHour,
    expiresAt: row.expiresAt,
    revoked: row.revoked,
    legacy: false,
    scopes: [],
    issued: true,
  };
}

/** The id of the key issued to a GitHub account: stable, so signing in again replaces it. */
export function issuedKeyId(githubUserId: string): string {
  return `${ISSUED_KEY_ID_PREFIX}${githubUserId}`;
}

export function signupRoutes(deps: SignupDependencies): Hono {
  const { config, metrics, log } = deps;
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const app = new Hono();

  const refuse = (c: Context, error: Rail402Error, retryAfter?: number) => {
    metrics.keySignups.inc({ outcome: error.code });
    c.header("Cache-Control", "no-store");
    if (retryAfter !== undefined) c.header("Retry-After", String(retryAfter));
    return c.json(toErrorBody(error), error.status as 400);
  };

  // Every sign-up route: only on the host serving the keys' network, under a small per-address limit.
  app.use("*", async (c, next) => {
    // Middleware contexts carry an untyped input; the hooks only read headers.
    const context = c as Context;
    if (!deps.onSignupHost(context)) return c.notFound();
    const wait = await deps.signupWait(context);
    if (wait > 0) {
      metrics.keySignups.inc({ outcome: "rate_limited" });
      c.header("Retry-After", String(wait));
      return c.json(toErrorBody(httpError("rate_limited")), 429);
    }
    await next();
    return undefined;
  });

  app.get("/new", (c) => {
    if (deps.accessKeys.issuedKeys !== "on") return refuse(c, keySignupError("key_signup_closed"));
    const state = randomBytes(24).toString("base64url");
    setCookie(c, SIGNUP_STATE_COOKIE, state, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      maxAge: STATE_MAX_AGE_SECONDS,
    });
    const target = new URL(GITHUB_AUTHORIZE);
    target.searchParams.set("client_id", config.clientId);
    target.searchParams.set("redirect_uri", config.callbackUrl.href);
    target.searchParams.set("state", state);
    // No scope: the public profile (id, login, account age) is all a key needs.
    target.searchParams.set("scope", "");
    target.searchParams.set("allow_signup", "false");
    c.header("Cache-Control", "no-store");
    return c.redirect(target.href, 302);
  });

  app.get("/callback", async (c) => {
    const expected = getCookie(c, SIGNUP_STATE_COOKIE);
    deleteCookie(c, SIGNUP_STATE_COOKIE, { path: "/", secure: true });
    const state = c.req.query("state");
    if (expected === undefined || state === undefined || !sameText(expected, state))
      return refuse(c, keySignupError("key_signup_state_invalid"));
    if (c.req.query("error") !== undefined) return refuse(c, keySignupError("key_signup_cancelled"));
    const code = c.req.query("code");
    if (code === undefined || code === "" || code.length > 256)
      return refuse(c, keySignupError("key_signup_cancelled"));
    if (deps.accessKeys.issuedKeys !== "on") return refuse(c, keySignupError("key_signup_closed"));

    let account: GitHubAccount;
    try {
      account = await githubAccount(fetchFn, config, code);
    } catch (error) {
      log.warn({ err: error }, "key sign-up: GitHub did not complete the sign-in");
      return refuse(c, keySignupError("key_signup_provider_failed"));
    }
    const ageDays = (now() - account.createdAt.getTime()) / 86_400_000;
    if (ageDays < config.minAccountAgeDays) return refuse(c, keySignupError("key_signup_account_too_new"));

    const id = issuedKeyId(account.id);
    const { key, sha256 } = newAccessKey(id);
    let outcome: IssueOutcome;
    try {
      outcome = await deps.store.issue(
        {
          id,
          githubUserId: account.id,
          githubLogin: account.login,
          sha256,
          networks: [config.network],
          requestsPerMinute: config.requestsPerMinute,
          sponsorBudgetStroopsPerHour: config.sponsorBudgetStroopsPerHour,
          lifetimeDays: config.lifetimeDays,
        },
        { perHour: config.perHour, reissueSeconds: config.reissueSeconds },
      );
    } catch (error) {
      log.error({ err: error }, "key sign-up: the key could not be stored");
      metrics.keySignups.inc({ outcome: "internal_error" });
      c.header("Cache-Control", "no-store");
      return c.json(toErrorBody(httpError("internal_error")), 500);
    }
    switch (outcome.kind) {
      case "revoked":
        return refuse(c, keySignupError("key_signup_account_refused"));
      case "too_soon":
        return refuse(c, keySignupError("key_signup_too_soon"), outcome.retryAfterSeconds);
      case "cap_reached":
        return refuse(c, keySignupError("key_signup_limit_reached"), 3_600);
      case "issued":
        break;
    }
    // In force on this replica at once; the others read it from the database within seconds.
    deps.accessKeys.addIssued(issuedRecord(outcome.row));
    metrics.keySignups.inc({ outcome: "issued" });
    log.info(
      { keyId: id, githubLogin: account.login, issuedCount: outcome.row.issuedCount },
      "key sign-up: key issued",
    );
    c.header("Cache-Control", "no-store");
    return c.json({
      key,
      keyId: id,
      github: account.login,
      network: config.network,
      limits: {
        requestsPerMinute: outcome.row.requestsPerMinute,
        sponsorBudgetXlmPerHour: stroopsToXlm(outcome.row.sponsorBudgetStroopsPerHour),
      },
      expiresAt: outcome.row.expiresAt.toISOString(),
      replacedPreviousKey: outcome.row.issuedCount > 1,
      use: `Send it as "Authorization: Bearer <key>" to /verify and /settle on https://${config.callbackUrl.host}. It is shown once and never stored: keep it on your server. Signing in again replaces it.`,
    });
  });

  return app;
}

interface GitHubAccount {
  readonly id: string;
  readonly login: string;
  readonly createdAt: Date;
}

/** Exchanges the sign-in code for a token and reads the account it belongs to. The token is dropped. */
async function githubAccount(
  fetchFn: typeof fetch,
  config: KeySignupConfig,
  code: string,
): Promise<GitHubAccount> {
  const tokenResponse = await fetchFn(GITHUB_TOKEN, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl.href,
    }),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  const token = (await tokenResponse.json()) as { access_token?: unknown };
  if (!tokenResponse.ok || typeof token.access_token !== "string" || token.access_token === "")
    throw new Error(`GitHub refused the sign-in code (HTTP ${String(tokenResponse.status)})`);
  const userResponse = await fetchFn(GITHUB_USER, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token.access_token}`,
      "user-agent": "rail402-key-signup",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (!userResponse.ok)
    throw new Error(`GitHub did not return the account (HTTP ${String(userResponse.status)})`);
  const user = (await userResponse.json()) as {
    id?: unknown;
    login?: unknown;
    created_at?: unknown;
    type?: unknown;
  };
  const createdAt = typeof user.created_at === "string" ? new Date(user.created_at) : undefined;
  if (
    typeof user.id !== "number" ||
    !Number.isSafeInteger(user.id) ||
    user.id <= 0 ||
    typeof user.login !== "string" ||
    !/^[A-Za-z0-9-]{1,39}$/.test(user.login) ||
    user.type !== "User" ||
    createdAt === undefined ||
    Number.isNaN(createdAt.getTime())
  ) {
    throw new Error("GitHub returned an account without a usable id, login, type or creation date");
  }
  return { id: String(user.id), login: user.login, createdAt };
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const fraction = (stroops % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole.toString()}.${fraction}`;
}
