#!/usr/bin/env bash
# Starts Rail402 as an external facilitator of the upstream x402 e2e suite. The suite runs this
# from e2e/facilitators/external-proxies/rail402/ with PORT, FACILITATOR_STELLAR_PRIVATE_KEY and
# STELLAR_RPC_URL set, and waits for "Facilitator listening" on stdout. Rail402 itself runs
# unmodified from RAIL402_ROOT; only the suite's variable names are mapped onto its own.
set -euo pipefail

: "${RAIL402_ROOT:?set RAIL402_ROOT to the Rail402 checkout}"
: "${PORT:?}"
: "${FACILITATOR_STELLAR_PRIVATE_KEY:?}"

export HOST=127.0.0.1
export STORE=memory
export NETWORKS=stellar:testnet
export TESTNET_SPONSOR_SECRET="$FACILITATOR_STELLAR_PRIVATE_KEY"
export TESTNET_RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
# The suite's sellers listen on localhost, so origin verification must be allowed to reach them.
export DISCOVERY_ALLOW_LOOPBACK=true
export RATE_LIMIT_PER_MINUTE=0
export LOG_LEVEL="${LOG_LEVEL:-warn}"
export SEARCH_MODEL_DIR="${SEARCH_MODEL_DIR:-$RAIL402_ROOT/.models}"

node --conditions=@rail402/source "$RAIL402_ROOT/apps/rail402/src/main.ts" &
service=$!
trap 'kill -TERM "$service" 2>/dev/null; wait "$service"' TERM INT

for _ in $(seq 1 120); do
  if ! kill -0 "$service" 2>/dev/null; then
    wait "$service"
    exit $?
  fi
  if curl -fsS "http://127.0.0.1:$PORT/ready" >/dev/null 2>&1; then
    echo "Facilitator listening on port $PORT"
    break
  fi
  sleep 0.5
done

wait "$service"
