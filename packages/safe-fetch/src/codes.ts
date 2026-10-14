import { Rail402Error, defineCodes, type ErrorOptions } from "@rail402.dev/errors";

/** Why an outbound request was refused or failed. Nothing reached the destination unless stated. */
export const egressCodes = defineCodes({
  egress_url_invalid: {
    status: 400,
    retryable: false,
    reason:
      "The URL is not an absolute http(s) URL, contains credentials or control characters, or is too long.",
  },
  egress_scheme_not_allowed: {
    status: 403,
    retryable: false,
    reason: "The URL scheme is not allowed; only https is fetched unless http is explicitly enabled.",
  },
  egress_port_not_allowed: {
    status: 403,
    retryable: false,
    reason: "The URL's port is not in the allowed list.",
  },
  egress_destination_not_allowed: {
    status: 403,
    retryable: false,
    reason: "The destination is a private, local or reserved address, or resolves to one.",
  },
  egress_dns_failed: {
    status: 502,
    retryable: true,
    reason: "The host name could not be resolved.",
  },
  egress_connection_failed: {
    status: 502,
    retryable: true,
    reason: "The connection was refused or reset, or the server answered with an invalid response.",
  },
  egress_tls_failed: {
    status: 502,
    retryable: false,
    reason: "The TLS handshake failed or the server certificate is not valid for the host.",
  },
  egress_redirect_not_allowed: {
    status: 403,
    retryable: false,
    reason: "The server answered with a redirect that is not allowed.",
  },
  egress_too_many_redirects: {
    status: 508,
    retryable: false,
    reason: "The server redirected more times than allowed.",
  },
  egress_request_too_large: {
    status: 413,
    retryable: false,
    reason: "The request headers or body exceed the size limit; nothing was sent.",
  },
  egress_response_too_large: {
    status: 502,
    retryable: false,
    reason: "The response headers or decoded body exceed the size limit, or use an unsupported encoding.",
  },
  egress_timeout: {
    status: 504,
    retryable: true,
    reason: "The server did not connect, answer or send data in time.",
  },
});

export type EgressCode = keyof typeof egressCodes;

/** Where in the request an egress error happened. */
export type EgressStage = "url" | "dns" | "connect" | "tls" | "request" | "redirect" | "response";

export class EgressError extends Rail402Error<EgressCode> {
  readonly stage: EgressStage;

  constructor(code: EgressCode, stage: EgressStage, options: ErrorOptions = {}) {
    super(code, egressCodes[code], options);
    this.stage = stage;
  }
}

export function isEgressError(value: unknown): value is EgressError {
  return value instanceof EgressError;
}
