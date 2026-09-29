# Security policy

Rail402 verifies and settles payments and holds a fee-sponsor key, so security reports are taken seriously.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
**[Report a vulnerability](https://github.com/tolgayayci/rail402/security/advisories/new)** (Security tab →
"Report a vulnerability"). Do not open a public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with it. You will get an answer
within five working days. Fixes are released as a new version with a GitHub security advisory, and reporters
are credited unless they ask not to be.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | Yes       |
| < 0.2   | No        |

The npm packages under `@rail402.dev` before 0.2.0 come from an earlier prototype and are not maintained.

## Scope

In scope: the service in `apps/rail402` and the packages in `packages/`, for example a payment that verifies
but should not, a settlement that moves funds the payer did not authorize, anything that makes the sponsor
pay for more than network fees, or a way to create or change a Bazaar listing for a `payTo` you do not
control.

The hosted instance at `https://testnet.rail402.dev` runs on the Stellar testnet, where funds have no value.
Please do not load-test it or attack its infrastructure; run your own instance for that.

How keys are held and rotated is described in [Operations](https://docs.rail402.dev/operations).
