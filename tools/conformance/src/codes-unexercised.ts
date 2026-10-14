/**
 * Why a registered code is produced by no test and no recorded conformance run. Every code the
 * committed coverage record (tools/conformance/codes-coverage.json) does not show exercised needs an
 * entry here, and an exercised code must not keep one; the unit tests check both, and the error-code
 * page prints these reasons.
 */
export const UNEXERCISED: Readonly<Record<string, string>> = {
  forbidden:
    "Part of the shared HTTP set; the service does not return it. API keys have no per-endpoint scopes: a request without a valid key is refused with `unauthorized`.",
  method_not_allowed:
    "Part of the shared HTTP set; the service does not return it. A method a route does not serve is answered like an unknown route, with `not_found` (rejection audit case `unknown-route`).",
  service_unavailable:
    "Part of the shared HTTP set; the service does not return it. Readiness is reported by `/ready`, and a settlement that cannot run answers the scheme's own code, such as `settle_exact_stellar_channel_unavailable`.",
};
