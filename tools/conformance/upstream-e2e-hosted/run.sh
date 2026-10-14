#!/usr/bin/env bash
# Joins a running Rail402 (RAIL402_FACILITATOR_URL, e.g. https://testnet.rail402.dev) to the upstream
# x402 e2e suite as an external facilitator. The suite runs this from
# e2e/facilitators/external-proxies/rail402-hosted/ with PORT set and waits for "Facilitator listening"
# on stdout. The forwarder passes /verify, /settle, /supported and /discovery/* through verbatim,
# status codes and EXTENSION-RESPONSES included, and answers /health and /close itself.
# The suite requires FACILITATOR_STELLAR_PRIVATE_KEY for every Stellar facilitator; this one never
# reads it, since the service under test holds its own sponsor.
set -euo pipefail

: "${RAIL402_ROOT:?set RAIL402_ROOT to the Rail402 checkout}"
: "${RAIL402_FACILITATOR_URL:?set RAIL402_FACILITATOR_URL to the facilitator under test}"
: "${PORT:?}"

exec node "$RAIL402_ROOT/tools/conformance/src/forwarder.ts" \
  --target "$RAIL402_FACILITATOR_URL" --port "$PORT" --hosted
