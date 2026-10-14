import type { Context } from "hono";
import { toErrorBody, type ErrorOptions } from "@rail402.dev/errors";
import { playgroundError, type PlaygroundServerCode } from "./shared/codes.ts";

/** One access-log line, written when the response is complete. */
export interface RequestLog {
  /** Fields added to the line: never a path, query, header or body. */
  readonly fields: Record<string, unknown>;
  /** Set by a handler that streams its body; it then calls `write` itself once the stream ends. */
  deferred: boolean;
  write(extra?: Readonly<Record<string, unknown>>): void;
}

/** Hono environment of the Playground server's routes. */
export interface ServerEnv {
  Variables: {
    readonly requestId: string;
    /** The client's rate-limit key (an IPv4 address or an IPv6 /56). */
    readonly clientKey: string;
    /** The client's network, for fair shares of global limits (an IPv4 address or an IPv6 /48). */
    readonly networkKey: string;
    readonly requestLog: RequestLog;
  };
}

export type ServerContext = Context<ServerEnv>;

/** Options of a coded error reply. */
export type RefuseOptions = ErrorOptions & {
  readonly retryAfter?: number;
  readonly headers?: Record<string, string>;
};

/**
 * A coded error reply `{ error: { code, reason, retryable, details? } }` with the code's status.
 * `retryAfter` (seconds) adds `Retry-After`; the code is recorded on the access-log line.
 */
export function refuse(c: ServerContext, code: PlaygroundServerCode, options: RefuseOptions = {}): Response {
  c.get("requestLog").fields["code"] = code;
  return errorResponse(code, options);
}

/** The reply `refuse` sends, for handlers outside the main app's request context (the lab sub-app). */
export function errorResponse(code: PlaygroundServerCode, options: RefuseOptions = {}): Response {
  const error = playgroundError(code, options);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...options.headers,
  };
  if (options.retryAfter !== undefined) headers["retry-after"] = String(options.retryAfter);
  return new Response(JSON.stringify(toErrorBody(error)), { status: error.status, headers });
}

/** A request id: the caller's `x-request-id` when it is a short token, else a fresh one. */
export function requestIdOf(header: string | undefined): string {
  return header !== undefined && /^[A-Za-z0-9._:-]{1,64}$/.test(header) ? header : crypto.randomUUID();
}
