#!/usr/bin/env bash
# Runs a Rail402 testnet facilitator on this machine with Docker, in one command:
#
#   ./deploy/docker.sh
#
# Builds the image, creates a fee sponsor account funded by Friendbot, writes the service's
# secrets to .env (git-ignored, mode 600), starts Postgres and the service with Docker Compose and
# waits until /ready passes. Needs Docker with Compose v2, curl and bash. Run it from the repository
# root. An existing .env is never overwritten: the script reuses it and only starts the stack.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT=8080
FRIENDBOT="https://friendbot.stellar.org"

say() { printf '==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || fail "docker is not installed"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"
command -v curl >/dev/null || fail "curl is not installed"

version="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
say "building the image rail402:local ($version)"
docker build --quiet --build-arg RAIL402_VERSION="$version" -t rail402:local . >/dev/null

if [[ -e .env ]]; then
  say "reusing the existing .env"
else
  say "creating a testnet fee sponsor"
  # The key is generated inside the image, which carries the Stellar SDK.
  keys="$(docker run --rm rail402:local node -e '
    const { Keypair } = require("@stellar/stellar-sdk");
    const { randomBytes } = require("node:crypto");
    const sponsor = Keypair.random();
    console.log(sponsor.publicKey());
    console.log(sponsor.secret());
    console.log(randomBytes(32).toString("hex"));
  ')"
  sponsor="$(sed -n 1p <<<"$keys")"
  secret="$(sed -n 2p <<<"$keys")"
  cursor="$(sed -n 3p <<<"$keys")"

  say "funding $sponsor with Friendbot"
  curl -fsS -o /dev/null "$FRIENDBOT?addr=$sponsor" || fail "Friendbot did not fund $sponsor"

  (
    umask 077
    cat >.env <<EOF
NETWORKS=stellar:testnet
TESTNET_RPC_URL=https://soroban-testnet.stellar.org
TESTNET_SPONSOR_SECRET=$secret
SEARCH_CURSOR_SECRET=$cursor
EOF
  )
  say "wrote .env (sponsor $sponsor)"
fi

say "starting Postgres and the service"
docker compose --profile service up -d

say "waiting for http://127.0.0.1:$PORT/ready (first start provisions the channel accounts)"
for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$PORT/ready" >/dev/null 2>&1; then
    say "ready: http://127.0.0.1:$PORT"
    curl -fsS "http://127.0.0.1:$PORT/supported"
    echo
    exit 0
  fi
  sleep 2
done
docker compose --profile service logs --tail 50 rail402 >&2
fail "the service did not become ready; the logs are above"
