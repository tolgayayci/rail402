/**
 * Why a registered code is produced by no test and no recorded conformance run. Every code the
 * committed coverage record (tools/conformance/codes-coverage.json) does not show exercised needs an
 * entry here, and an exercised code must not keep one; the unit tests check both, and the error-code
 * page prints these reasons.
 */
export const UNEXERCISED: Readonly<Record<string, string>> = {
  method_not_allowed:
    "Part of the shared HTTP set; the service does not return it. A method a route does not serve is answered like an unknown route, with `not_found` (rejection audit case `unknown-route`).",
};
