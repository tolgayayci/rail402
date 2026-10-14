/**
 * Codes the Playground returns or shows: its server's refusals (relay, proxies, lab sellers, seller
 * check), its startup refusal, and the browser app's own errors. Codes of the packages it builds on
 * (`egress_*`, `account_*`, `payment_*`, `key_invalid`, the discovery codes) are reused, never copied.
 */
import { defineCodes, errorFactory, mergeCodes } from "@rail402.dev/errors";

/** Returned by the Playground server, as `{ error: { code, reason, retryable, details? } }`. */
export const playgroundServerCodes = defineCodes({
  playground_config_invalid: {
    status: 500,
    retryable: false,
    reason: "The Playground server's configuration is invalid; it refused to start.",
  },
  playground_origin_not_allowed: {
    status: 403,
    retryable: false,
    reason: "This endpoint answers only same-origin requests from the Playground page.",
  },
  playground_request_invalid: {
    status: 400,
    retryable: false,
    reason: "The request is malformed.",
  },
  playground_request_too_large: {
    status: 413,
    retryable: false,
    reason: "The request body exceeds the size limit.",
  },
  playground_rate_limited: {
    status: 429,
    retryable: true,
    reason: "Too many requests; retry after the indicated delay.",
  },
  playground_feature_disabled: {
    status: 503,
    retryable: true,
    reason: "The operator has turned this feature off.",
  },
  playground_relay_target_invalid: {
    status: 400,
    retryable: false,
    reason: "The relay target is missing, not an absolute URL, or longer than 2048 bytes.",
  },
  playground_relay_method_not_allowed: {
    status: 405,
    retryable: false,
    reason: "The relay forwards only GET, HEAD, POST, PUT, PATCH and DELETE.",
  },
  playground_relay_header_not_allowed: {
    status: 400,
    retryable: false,
    reason: "A forwarded header is not on the relay's allowlist.",
  },
  playground_relay_loop: {
    status: 403,
    retryable: false,
    reason: "The relay does not send requests to the Playground itself; lab sellers are called directly.",
  },
  playground_relay_target_denied: {
    status: 403,
    retryable: false,
    reason: "The relay does not send requests to this host.",
  },
  playground_relay_busy: {
    status: 503,
    retryable: true,
    reason: "Too many relayed requests are in flight; retry shortly.",
  },
  playground_relay_host_busy: {
    status: 429,
    retryable: true,
    reason: "Too many relayed requests to this host; retry after the indicated delay.",
  },
  playground_upstream_unavailable: {
    status: 502,
    retryable: true,
    reason: "The facilitator or Bazaar did not answer in time or answered with an invalid response.",
  },
  playground_lab_unavailable: {
    status: 503,
    retryable: true,
    reason: "The lab seller cannot take payments now; retry shortly.",
  },
  playground_not_found: {
    status: 404,
    retryable: false,
    reason: "No route matches this path.",
  },
  playground_internal_error: {
    status: 500,
    retryable: true,
    reason: "An unexpected internal error occurred.",
  },
});

/** Raised and shown by the Playground page in the browser; never sent by the server. */
export const playgroundClientCodes = defineCodes({
  playground_wallet_storage_unavailable: {
    status: 503,
    retryable: false,
    reason:
      "This browser cannot store the wallet (no IndexedDB or WebCrypto); it lives in this tab only and is lost on reload.",
  },
  playground_wallet_locked: {
    status: 409,
    retryable: true,
    reason: "The wallet is in use in another tab; this tab is read-only until that tab closes.",
  },
  playground_wallet_missing: {
    status: 400,
    retryable: false,
    reason: "Create or import a testnet wallet first.",
  },
  playground_config_unavailable: {
    status: 503,
    retryable: true,
    reason: "The Playground's configuration could not be loaded; reload the page.",
  },
  playground_run_in_progress: {
    status: 409,
    retryable: true,
    reason: "Another run is in progress; wait for it to finish.",
  },
  playground_run_aborted: {
    status: 400,
    retryable: true,
    reason: "The run was stopped before it finished.",
  },
  playground_unexpected_error: {
    status: 500,
    retryable: false,
    reason: "Something unexpected went wrong; nothing more is known.",
  },
});

export const playgroundCodes = mergeCodes(playgroundServerCodes, playgroundClientCodes);

export type PlaygroundServerCode = keyof typeof playgroundServerCodes;
export type PlaygroundClientCode = keyof typeof playgroundClientCodes;
export type PlaygroundCode = PlaygroundServerCode | PlaygroundClientCode;

export const playgroundError = errorFactory(playgroundCodes);

/** Whether a string is one of the Playground's own codes. */
export function isPlaygroundCode(code: string): code is PlaygroundCode {
  return Object.hasOwn(playgroundCodes, code);
}
