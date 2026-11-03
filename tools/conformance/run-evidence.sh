#!/usr/bin/env bash
# The full conformance evidence run on the public Stellar testnet, in one command, from a clean
# checkout of main:
#
#   RAIL402_SPONSOR_SECRET_FILE=/path/to/sponsor-seed pnpm evidence            # records evidence
#   RAIL402_SPONSOR_SECRET_FILE=/path/to/sponsor-seed pnpm evidence --rehearse # prints, writes nothing
#
# It starts a local Rail402 from this checkout (two replicas over one Postgres schema, plus the extra
# deployments some harnesses need), then runs, in order:
#
#   canonical        exact and upto × G and C payers × USDC and TEST6, stock client and seller;
#                    also against RAIL402_EVIDENCE_HOSTED_URL when it is set (canonical-hosted)
#   live-matrix      exact and upto: settlements, refusals, replay, idempotency, expiry, smart accounts
#   concurrency      exact, upto and mixed; 3 batches of 20 plus duplicates across the two replicas
#   fault-recovery   SIGKILL at K0, K1 (exact and upto) and K3 (exact), its own process and schema
#   upstream-e2e     the upstream x402 e2e suite at the released tag (exact), and on a checkout with the
#                    Stellar upto mechanism (exact and upto, recorded as pre-merge); against the local
#                    Rail402, and also against RAIL402_EVIDENCE_HOSTED_URL when it is set
#   live-bazaar      cataloging and integrity rules, unsafe URLs, SSRF, encoded traversal and forged
#                    prices, a second asset and upto listings; also against RAIL402_EVIDENCE_HOSTED_URL
#                    and RAIL402_EVIDENCE_HOSTED_SELLER when it is set (live-bazaar-hosted), every case
#                    a deployed catalog can be shown black-box
#   live-agent       an agent's paid HTTP and MCP calls through the installed SDK, CLI and MCP server:
#                    a local rehearsal with its own Rail402 and demo seller
#   live-agent-hosted the same agent run against a deployed Bazaar and demo seller (when
#                    RAIL402_LIVE_AGENT_SELLER is set)
#   live-playground  the Playground's page in Chromium: every lab scenario, the refusal checks and the
#                    egress refusals, with a local Rail402, demo seller and Playground server (needs
#                    Chromium: pnpm --filter @rail402.dev/playground exec playwright install chromium)
#   live-playground-hosted the same run against a deployed Playground (when
#                    RAIL402_EVIDENCE_PLAYGROUND_URL is set)
#   rejection-audit  every refusal over HTTP, keyed and rate-limited deployments, and MCP; also
#                    against RAIL402_EVIDENCE_HOSTED_URL when it is set (rejection-audit-hosted),
#                    every case that needs no deployment of its own
#   ops              the operational exercises on the private network (needs the local Stellar network
#                    and Postgres; the step fails at once when either does not answer)
#   upto-contract    the settlement contract against its source: record, chain, fetch, rebuild
#   benchmark        latency, confirmation and sponsor cost against replica A and the x402.org
#                    facilitator, in the same window
#   codes-coverage   pnpm report first (the unit suite checks the pages and the manifest against the
#                    evidence just written), then pnpm test, pnpm test:integration (a failed test is
#                    retried once; the failed files are listed in its log) and pnpm codes:coverage
#                    --write: the error-code page's coverage record, from this commit. A rehearsal runs
#                    the same suites and prints the coverage without recording it
#   report           pnpm report, the older-format canonical file removed once the current one exists,
#                    then pnpm report --check --final: nothing in the older format is left, every cited
#                    commit is on main and the coverage record is no older than the evidence
#
# When a step fails, the evidence the other steps wrote is still in the tree. Commit it, then run only
# what failed and the report on the new commit, for example:
#
#   RAIL402_EVIDENCE_STEPS=codes-coverage,report RAIL402_SPONSOR_SECRET_FILE=… pnpm evidence
#
# Configuration (environment):
#   RAIL402_SPONSOR_SECRET_FILE   file holding the fee sponsor's S… seed (required; never printed). A
#                                 Friendbot-funded testnet account; its channels and settlement
#                                 authority are derived from it.
#   RAIL402_DATABASE_URL          Postgres for the replicas (default postgres://rail402:rail402@localhost:5432/rail402,
#                                 query parameters such as ?sslmode=require are kept); the run creates
#                                 and drops a schema of its own
#   TESTNET_ASSETS                accepted assets (default: Circle testnet USDC and TEST6)
#   TESTNET_MAX_TX_FEE_STROOPS    exact fee ceiling (default 2000000: TEST6 payments cost more than USDC)
#   TESTNET_UPTO_MAX_TX_FEE_STROOPS  upto fee ceiling (default: the service's testnet default)
#   TESTNET_CHANNEL_COUNT         channels the two replicas share (default 24: a batch of 20 plus
#                                 duplicates settles at once, each taking a few testnet ledgers)
#   SETTLE_CHANNEL_WAIT_MS        how long a settlement waits for a free channel (default 30000)
#   RAIL402_X402_CHECKOUT         x402-foundation/x402 at the tag of the pinned @x402 version, prepared as
#                                 its e2e README describes (default ../x402)
#   RAIL402_X402_UPTO_CHECKOUT    an x402 checkout with the Stellar upto mechanism, on a branch pushed to a
#                                 public fork: recording refuses a commit no remote branch contains
#                                 (unset: that run is skipped)
#   RAIL402_EVIDENCE_STEPS        comma list of the steps to run (default: all, in the order above)
#   RAIL402_EVIDENCE_PORT         first of five local ports (default 8801)
#   RAIL402_EVIDENCE_HOSTED_URL   a deployed Rail402 (e.g. https://testnet.rail402.dev) the canonical run,
#                                 the upstream e2e suite, the live Bazaar run and the rejection audit also
#                                 run against, recorded beside the local runs under -hosted file names
#                                 (unset: only the local runs)
#   RAIL402_EVIDENCE_HOSTED_SELLER the deployed demo seller the hosted live Bazaar run pays (default
#                                 https://demo.rail402.dev)
#   RAIL402_BENCHMARK_REFERENCE   the facilitator measured beside replica A (default https://x402.org/facilitator)
#   RAIL402_LIVE_AGENT_ARGS       extra arguments for live-agent and live-agent-hosted
#   RAIL402_LIVE_AGENT_REGISTRY   an npm registry (https, e.g. https://registry.npmjs.org/): live-agent and
#                                 live-agent-hosted install the published packages of this checkout's
#                                 version from it instead of the pack-check tarballs (unset: tarballs)
#   RAIL402_LIVE_AGENT_SELLER     a deployed demo seller (https) for live-agent-hosted; unset: skipped
#   RAIL402_LIVE_AGENT_BAZAAR     the deployed Rail402 it settles through (default https://testnet.rail402.dev)
#   RAIL402_LIVE_AGENT_IMPOSTOR   a listing id in that Bazaar that must be refused as a mismatch (optional)
#   RAIL402_EVIDENCE_PLAYGROUND_URL  a deployed Playground (https) for live-playground-hosted; unset: skipped
#   STELLAR_CLI                   the stellar CLI (default: stellar on PATH; ~/.cargo/bin is added)
#   GITHUB_TOKEN                  read by the upstream watch the run starts with, which records the open
#                                 upstream drift (its fingerprint, or none) in every evidence file
#                                 (optional; without it GitHub allows few unauthenticated calls an hour)
#   RAIL402_TEST_RPC_URL, RAIL402_TEST_DATABASE_URL  the local services ops and codes-coverage use
#                                 (defaults http://localhost:8000/rpc and the Postgres above)
#
# The local replicas report version <package version>+<commit> on /health (RAIL402_VERSION).
#
# --network pubnet runs a reduced, spend-capped step list against a deployed pubnet Rail402 instead
# (no local replicas, no Friendbot, no TEST6; every harness funds from the operator treasury and
# returns the run's USDC at the end):
#
#   canonical        exact and upto × G and C payers × USDC
#   live-matrix      exact and upto
#   concurrency      exact and upto, 1 batch of 5 plus 1 duplicate
#   upstream-e2e     the upstream suite in mainnet mode, from RAIL402_X402_PUBNET_CHECKOUT (a checkout
#                    whose Stellar client passes STELLAR_RPC_URL); unset: recorded as a skipped case
#                    waiting on that dependency, which a final report refuses
#   rejection-audit  every refusal that needs no deployment of its own
#   live-bazaar      cataloging, integrity and the pubnet catalog policy (https only, no mcp:// tools),
#                    paying RAIL402_EVIDENCE_PUBNET_SELLER, a public demo seller (https), in USDC
#   live-agent       the agent's paid HTTP and MCP calls through the SDK, CLI and MCP server against
#                    RAIL402_EVIDENCE_HOSTED_URL and RAIL402_EVIDENCE_PUBNET_SELLER, from a payer the
#                    treasury funds with all the session may spend
#   report           pnpm report, then pnpm report --check
#
# It needs RAIL402_EVIDENCE_HOSTED_URL (the pubnet service), RAIL402_TREASURY_SECRET_FILE,
# RAIL402_PUBNET_RPC_URLS, the four per-harness caps RAIL402_PUBNET_MAX_SPEND_XLM,
# RAIL402_PUBNET_MAX_SPEND_USDC, RAIL402_PUBNET_MAX_SETTLEMENTS and RAIL402_PUBNET_MAX_NEW_ACCOUNTS,
# the two whole-run caps RAIL402_PUBNET_RUN_MAX_XLM (net XLM) and RAIL402_PUBNET_RUN_MAX_USDC_LOSS
# (net USDC), the service's fee ceilings PUBNET_MAX_TX_FEE_STROOPS and PUBNET_UPTO_MAX_TX_FEE_STROOPS,
# the upto contract (RAIL402_PUBNET_UPTO_CONTRACT and _WASM_HASH, or the published pubnet deployment
# record), RAIL402_EVIDENCE_PUBNET_SELLER for live-bazaar and live-agent (unset: those steps fail and
# say so) and, when the service requires keys, RAIL402_FACILITATOR_API_KEY_FILE.
# Run it once without RAIL402_PUBNET_RUN_CONFIRM: it plans a run (a ledger under .work/pubnet-runs/),
# prints its id and spends nothing. Set RAIL402_PUBNET_RUN_CONFIRM to that id to run it once: the run
# claims the ledger, every harness debits it, and it is closed at the end (also on failure or Ctrl-C),
# so a second run needs a new plan and a new confirmation (--rehearse still pays, it only writes
# nothing). After a crash, `node --conditions=@rail402/source tools/conformance/src/pubnet-run.ts sweep
# --ledger <file>` returns the funds of every account the run registered. RAIL402_EVIDENCE_STEPS picks
# steps from the list above.
#
# Logs and, with --rehearse, every harness's printed evidence go to .work/evidence-run/<time>/. Exits
# non-zero if any step failed, after running the others and the report.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

REHEARSE=false
NETWORK=testnet
while [[ $# -gt 0 ]]; do
  arg="$1"
  shift
  case "$arg" in
    --rehearse) REHEARSE=true ;;
    --network)
      NETWORK="${1:-}"
      shift || true
      ;;
    --network=*) NETWORK="${arg#--network=}" ;;
    -h | --help)
      sed -n '2,133p' "$0"
      exit 0
      ;;
    *)
      echo "run-evidence: unknown argument $arg (see --help)" >&2
      exit 64
      ;;
  esac
done
[[ "$NETWORK" == testnet || "$NETWORK" == pubnet ]] || {
  echo "run-evidence: --network must be testnet or pubnet" >&2
  exit 64
}

say() { printf '%s  %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
fail() {
  say "run-evidence: $*"
  exit 1
}

# --- configuration ---------------------------------------------------------------------------------
if [[ "$NETWORK" == testnet ]]; then
  : "${RAIL402_SPONSOR_SECRET_FILE:?set RAIL402_SPONSOR_SECRET_FILE to a file holding the sponsor seed}"
  [[ -r "$RAIL402_SPONSOR_SECRET_FILE" ]] || fail "cannot read $RAIL402_SPONSOR_SECRET_FILE"
else
  # A pubnet run starts no local service and never uses the testnet sponsor.
  [[ -n "${RAIL402_EVIDENCE_HOSTED_URL:-}" ]] || fail "a pubnet run needs RAIL402_EVIDENCE_HOSTED_URL (the pubnet Rail402)"
  for var in RAIL402_TREASURY_SECRET_FILE RAIL402_PUBNET_RPC_URLS RAIL402_PUBNET_MAX_SPEND_XLM \
    RAIL402_PUBNET_MAX_SPEND_USDC RAIL402_PUBNET_MAX_SETTLEMENTS RAIL402_PUBNET_MAX_NEW_ACCOUNTS \
    RAIL402_PUBNET_RUN_MAX_XLM RAIL402_PUBNET_RUN_MAX_USDC_LOSS PUBNET_MAX_TX_FEE_STROOPS \
    PUBNET_UPTO_MAX_TX_FEE_STROOPS; do
    [[ -n "${!var:-}" ]] || fail "a pubnet run needs $var"
  done
fi
DATABASE_URL_BASE="${RAIL402_DATABASE_URL:-postgres://rail402:rail402@localhost:5432/rail402}"
USDC_TESTNET="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
TEST6_TESTNET="$(jq -er .contract_id contracts/testing/deployments/test6-testnet.json)"
ASSETS="${TESTNET_ASSETS:-$USDC_TESTNET:USDC:7,$TEST6_TESTNET:TEST6:6}"
[[ "$ASSETS" == *"$TEST6_TESTNET"* ]] || fail "TESTNET_ASSETS must include TEST6 ($TEST6_TESTNET)"
MAX_FEE="${TESTNET_MAX_TX_FEE_STROOPS:-2000000}"
X402_CHECKOUT="${RAIL402_X402_CHECKOUT:-../x402}"
X402_UPTO_CHECKOUT="${RAIL402_X402_UPTO_CHECKOUT:-}"
STEPS="${RAIL402_EVIDENCE_STEPS:-canonical,live-matrix,concurrency,fault-recovery,upstream-e2e,live-bazaar,live-agent,live-agent-hosted,live-playground,live-playground-hosted,rejection-audit,ops,upto-contract,benchmark,codes-coverage,report}"
HOSTED_URL="${RAIL402_EVIDENCE_HOSTED_URL:-}"
BENCHMARK_REFERENCE="${RAIL402_BENCHMARK_REFERENCE:-https://x402.org/facilitator}"
TEST_RPC_URL="${RAIL402_TEST_RPC_URL:-http://localhost:8000/rpc}"
TEST_DATABASE_URL="${RAIL402_TEST_DATABASE_URL:-$DATABASE_URL_BASE}"
PORT="${RAIL402_EVIDENCE_PORT:-8801}"
CHANNELS="${TESTNET_CHANNEL_COUNT:-24}"
CHANNEL_WAIT_MS="${SETTLE_CHANNEL_WAIT_MS:-30000}"
# The version the local replicas and the agent run's Rail402 report on /health.
RAIL402_VERSION="$(jq -er .version apps/rail402/package.json)+$(git rev-parse --short=12 HEAD)"
export RAIL402_VERSION
A="http://127.0.0.1:$PORT"
B="http://127.0.0.1:$((PORT + 1))"
BAZAAR="http://127.0.0.1:$((PORT + 2))"
KEYED="http://127.0.0.1:$((PORT + 3))"
LIMITED="http://127.0.0.1:$((PORT + 4))"

OUT="$ROOT/.work/evidence-run/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
NODE=(node --conditions=@rail402/source)
WRITE=(--write)
$REHEARSE && WRITE=()

# --- preflight -------------------------------------------------------------------------------------
# The stellar CLI installs with cargo; a non-interactive shell often lacks ~/.cargo/bin.
if [[ -d "$HOME/.cargo/bin" && ":$PATH:" != *":$HOME/.cargo/bin:"* ]]; then
  PATH="$HOME/.cargo/bin:$PATH"
fi
for tool in node pnpm git jq docker curl "${STELLAR_CLI:-stellar}"; do
  command -v "$tool" >/dev/null || fail "$tool is not installed (or not on PATH)"
done
if ! $REHEARSE; then
  [[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || fail "evidence is recorded from main only (or --rehearse)"
  [[ -z "$(git status --porcelain)" ]] || fail "the checkout has uncommitted changes (or --rehearse)"
fi
say "commit $(git rev-parse --short HEAD), $($REHEARSE && echo "rehearsal: nothing is written" || echo "recording evidence")"
say "logs in ${OUT#"$ROOT"/}"

wanted() { [[ ",$STEPS," == *",$1,"* ]]; }
needs_service() {
  [[ "$NETWORK" == pubnet ]] && return 1
  local step
  for step in canonical live-matrix concurrency live-bazaar rejection-audit upto-contract benchmark; do
    wanted "$step" && return 0
  done
  return 1
}

# --- services --------------------------------------------------------------------------------------
# The database URL with the connection's search_path set to schema $2, keeping any query string.
schema_url() {
  local separator='?'
  [[ "$1" == *\?* ]] && separator='&'
  printf '%s%soptions=-c%%20search_path%%3D%s' "$1" "$separator" "$2"
}
PIDS=()
SCHEMA="evidence_$(date -u +%Y%m%d%H%M%S)"
SCHEMA_CREATED=false
BAZAAR_SCHEMA="${SCHEMA}_bazaar"
BAZAAR_SCHEMA_CREATED=false
# The pubnet run ledger this script claimed; closed on every exit.
PUBNET_LEDGER_TO_CLOSE=""
cleanup() {
  if [[ -n "$PUBNET_LEDGER_TO_CLOSE" ]]; then
    "${NODE[@]}" tools/conformance/src/pubnet-run.ts close --ledger "$PUBNET_LEDGER_TO_CLOSE" || true
  fi
  local pid
  for pid in "${PIDS[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done
  if $SCHEMA_CREATED; then
    "${NODE[@]}" tools/conformance/src/evidence-db.ts drop "$DATABASE_URL_BASE" "$SCHEMA" || true
  fi
  if $BAZAAR_SCHEMA_CREATED; then
    "${NODE[@]}" tools/conformance/src/evidence-db.ts drop "$DATABASE_URL_BASE" "$BAZAAR_SCHEMA" || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Starts a Rail402 from this checkout named $1 on port $2, with sponsor seed $3 and the common settings
# plus the given variables. The seed is exported inside the child's subshell, never passed as an
# argument, so it does not appear in any process's command line.
start_service() {
  local name="$1" port="$2" seed="$3"
  shift 3
  (
    export TESTNET_SPONSOR_SECRET="$seed"
    exec env HOST=127.0.0.1 PORT="$port" NETWORKS=stellar:testnet \
      TESTNET_RPC_URL=https://soroban-testnet.stellar.org \
      TESTNET_ASSETS="$ASSETS" TESTNET_MAX_TX_FEE_STROOPS="$MAX_FEE" \
      ${TESTNET_UPTO_MAX_TX_FEE_STROOPS:+TESTNET_UPTO_MAX_TX_FEE_STROOPS="$TESTNET_UPTO_MAX_TX_FEE_STROOPS"} \
      RATE_LIMIT_PER_MINUTE=0 LOG_LEVEL=info "$@" \
      "${NODE[@]}" apps/rail402/src/main.ts
  ) >"$OUT/service-$name.log" 2>&1 &
  PIDS+=("$!")
}

# Waits until the service last started answers /ready; fails at once if it exits.
wait_ready() {
  local url="$1" pid="${PIDS[-1]}"
  for _ in $(seq 1 180); do
    curl -fsS "$url/ready" >/dev/null 2>&1 && return 0
    kill -0 "$pid" 2>/dev/null || fail "the service for $url exited (see the service logs in $OUT)"
    sleep 1
  done
  fail "$url did not become ready (see the service logs in $OUT)"
}

# A fresh Friendbot-funded sponsor for a deployment whose settlements must not share the main
# sponsor's channels; its seed stays in this shell.
fresh_sponsor() {
  "${NODE[@]}" --input-type=module -e '
    import { Keypair } from "@stellar/stellar-sdk";
    const keypair = Keypair.random();
    const response = await fetch(`https://friendbot.stellar.org?addr=${keypair.publicKey()}`);
    if (!response.ok) throw new Error(`friendbot ${response.status}`);
    process.stdout.write(keypair.secret());
  '
}

if needs_service; then
  SPONSOR="$(tr -d '[:space:]' <"$RAIL402_SPONSOR_SECRET_FILE")"
  "${NODE[@]}" tools/conformance/src/evidence-db.ts create "$DATABASE_URL_BASE" "$SCHEMA"
  SCHEMA_CREATED=true
  DATABASE_URL="$(schema_url "$DATABASE_URL_BASE" "$SCHEMA")"
  say "starting two replicas over schema $SCHEMA"
  # One after the other: the first migrates the schema and provisions the channels.
  REPLICA=(STORE=postgres DATABASE_URL="$DATABASE_URL"
    TESTNET_CHANNEL_COUNT="$CHANNELS" SETTLE_CHANNEL_WAIT_MS="$CHANNEL_WAIT_MS")
  start_service a "$PORT" "$SPONSOR" "${REPLICA[@]}"
  wait_ready "$A"
  start_service b "$((PORT + 1))" "$SPONSOR" "${REPLICA[@]}"
  wait_ready "$B"
  unset REPLICA
  if wanted rejection-audit; then
    # Refusals only: they never settle, so they reuse the main sponsor and its provisioned channels.
    start_service keyed "$((PORT + 3))" "$SPONSOR" STORE=memory \
      TESTNET_AUTO_PROVISION_CHANNELS=false TESTNET_REQUIRE_API_KEY=true API_KEY_SHA256="$(printf '0%.0s' $(seq 64))"
    wait_ready "$KEYED"
    start_service limited "$((PORT + 4))" "$SPONSOR" STORE=memory \
      TESTNET_AUTO_PROVISION_CHANNELS=false RATE_LIMIT_PER_MINUTE=3
    wait_ready "$LIMITED"
  fi
  if wanted live-bazaar; then
    # Catalogs the run's own sellers on 127.0.0.1, and settles an upto zero off chain, which needs the
    # durable settlement ledger: a schema of its own.
    "${NODE[@]}" tools/conformance/src/evidence-db.ts create "$DATABASE_URL_BASE" "$BAZAAR_SCHEMA"
    BAZAAR_SCHEMA_CREATED=true
    BAZAAR_SPONSOR="$(fresh_sponsor)"
    start_service bazaar "$((PORT + 2))" "$BAZAAR_SPONSOR" STORE=postgres \
      DATABASE_URL="$(schema_url "$DATABASE_URL_BASE" "$BAZAAR_SCHEMA")" \
      DISCOVERY_ALLOW_LOOPBACK=true TESTNET_UPTO_ZERO_SETTLEMENT=offchain
    unset BAZAAR_SPONSOR
    wait_ready "$BAZAAR"
  fi
  unset SPONSOR
fi

# --- steps -----------------------------------------------------------------------------------------
FAILED=()
# Runs one harness; its evidence document (rehearsal) or log goes to $OUT/<step>.{json,log}.
run() {
  local step="$1"
  shift
  say "== $step"
  if "$@" >"$OUT/$step.json" 2>"$OUT/$step.log"; then
    say "   $step passed"
  else
    say "   $step FAILED (see ${OUT#"$ROOT"/}/$step.log)"
    FAILED+=("$step")
  fi
}
H=tools/conformance/src

# The open upstream drift at test time, recorded in every evidence file (best effort: a watch that
# cannot reach GitHub or npm records nothing, and the report says so).
UPSTREAM_DRIFT_RC=0
pnpm -s upstream:watch --json >"$OUT/upstream-drift.json" 2>"$OUT/upstream-drift.log" || UPSTREAM_DRIFT_RC=$?
case "$UPSTREAM_DRIFT_RC" in
  0) export RAIL402_UPSTREAM_DRIFT=none ;;
  1)
    RAIL402_UPSTREAM_DRIFT="$(jq -er .fingerprint "$OUT/upstream-drift.json" 2>/dev/null || true)"
    export RAIL402_UPSTREAM_DRIFT
    ;;
  *) say "the upstream watch could not check upstream (see ${OUT#"$ROOT"/}/upstream-drift.log); drift is not recorded" ;;
esac
say "upstream drift at test time: ${RAIL402_UPSTREAM_DRIFT:-not recorded}"

# The agent runs install the published packages from this registry when it is named (testnet and pubnet).
REGISTRY=()
[[ -n "${RAIL402_LIVE_AGENT_REGISTRY:-}" ]] && REGISTRY=(--registry "$RAIL402_LIVE_AGENT_REGISTRY")

# --- pubnet ----------------------------------------------------------------------------------------
if [[ "$NETWORK" == pubnet ]]; then
  PUBNET_STEPS="${RAIL402_EVIDENCE_STEPS:-canonical,live-matrix,concurrency,upstream-e2e,rejection-audit,live-bazaar,live-agent,report}"
  pubnet_wanted() { [[ ",$PUBNET_STEPS," == *",$1,"* ]]; }
  for step in ${PUBNET_STEPS//,/ }; do
    case "$step" in
      canonical | live-matrix | concurrency | upstream-e2e | rejection-audit | live-bazaar | live-agent | report) ;;
      *) fail "$step does not run on pubnet (see --help)" ;;
    esac
  done
  P="$RAIL402_EVIDENCE_HOSTED_URL"
  PUBNET_RUN=("${NODE[@]}" tools/conformance/src/pubnet-run.ts)
  if [[ -z "${RAIL402_PUBNET_RUN_CONFIRM:-}" ]]; then
    # The first attempt only plans the run: a fresh ledger and its id. Nothing is spent.
    RUN_ID="$("${PUBNET_RUN[@]}" plan)" || fail "the pubnet run could not be planned"
    say "planned pubnet run $RUN_ID; nothing was spent. Check the caps above, then run again with RAIL402_PUBNET_RUN_CONFIRM=$RUN_ID"
    exit 0
  fi
  # Claims the planned run once; every harness debits its ledger, and it is closed on exit.
  RAIL402_PUBNET_LEDGER="$("${PUBNET_RUN[@]}" claim --run "$RAIL402_PUBNET_RUN_CONFIRM")" ||
    fail "run $RAIL402_PUBNET_RUN_CONFIRM cannot start (see above); plan a new run without RAIL402_PUBNET_RUN_CONFIRM"
  export RAIL402_PUBNET_LEDGER
  PUBNET_LEDGER_TO_CLOSE="$RAIL402_PUBNET_LEDGER"
  say "pubnet run $RAIL402_PUBNET_RUN_CONFIRM: ledger ${RAIL402_PUBNET_LEDGER#"$ROOT"/}"
  pubnet_wanted canonical &&
    run canonical-pubnet "${NODE[@]}" $H/canonical.ts --facilitator "$P" --scheme exact,upto --asset usdc \
      --payer g,c --network pubnet "${WRITE[@]}"
  pubnet_wanted live-matrix &&
    run live-matrix-pubnet "${NODE[@]}" $H/live-matrix.ts --facilitator "$P" --scheme exact,upto \
      --network pubnet "${WRITE[@]}"
  if pubnet_wanted concurrency; then
    for scheme in exact upto; do
      run "concurrency-$scheme-pubnet" "${NODE[@]}" $H/concurrency.ts --facilitator "$P" --scheme "$scheme" \
        --batches 1 --size 5 --duplicates 1 --network pubnet "${WRITE[@]}"
    done
  fi
  if pubnet_wanted upstream-e2e; then
    if [[ -n "${RAIL402_X402_PUBNET_CHECKOUT:-}" ]]; then
      run upstream-e2e-pubnet "${NODE[@]}" $H/upstream-e2e.ts --x402 "$RAIL402_X402_PUBNET_CHECKOUT" \
        --target hosted --facilitator "$P" --allow-version-mismatch --network pubnet "${WRITE[@]}"
    else
      run upstream-e2e-pubnet "${NODE[@]}" $H/upstream-e2e.ts --target hosted --facilitator "$P" --network pubnet \
        --pending "RAIL402_X402_PUBNET_CHECKOUT is not set: no x402 checkout whose Stellar client passes STELLAR_RPC_URL" \
        "${WRITE[@]}"
    fi
  fi
  pubnet_wanted rejection-audit &&
    run rejection-audit-pubnet "${NODE[@]}" $H/rejection-audit.ts --facilitator "$P" --network pubnet \
      "${WRITE[@]}"
  # The Bazaar and agent runs pay a public seller: without one they cannot run, and the run says so.
  for step in live-bazaar live-agent; do
    if pubnet_wanted "$step" && [[ -z "${RAIL402_EVIDENCE_PUBNET_SELLER:-}" ]]; then
      say "   $step-pubnet FAILED: RAIL402_EVIDENCE_PUBNET_SELLER (a public demo seller, https) is not set"
      FAILED+=("$step-pubnet")
    fi
  done
  if [[ -n "${RAIL402_EVIDENCE_PUBNET_SELLER:-}" ]]; then
    S="$RAIL402_EVIDENCE_PUBNET_SELLER"
    pubnet_wanted live-bazaar &&
      run live-bazaar-pubnet "${NODE[@]}" $H/live-bazaar.ts --facilitator "$P" --seller "$S" --network pubnet \
        "${WRITE[@]}"
    pubnet_wanted live-agent &&
      run live-agent-pubnet "${NODE[@]}" $H/live-agent.ts --bazaar "$P" --seller "$S" "${REGISTRY[@]}" \
        --network pubnet "${WRITE[@]}"
  fi
  if pubnet_wanted report; then
    if $REHEARSE; then
      run report pnpm report:check
    else
      run report pnpm report
      run report-check pnpm report:check
    fi
  fi
  "${PUBNET_RUN[@]}" status --ledger "$RAIL402_PUBNET_LEDGER" >"$OUT/pubnet-run.json" || true
  say "the run's totals: ${OUT#"$ROOT"/}/pubnet-run.json"
  if [[ ${#FAILED[@]} -gt 0 ]]; then
    say "failed: ${FAILED[*]}"
    exit 1
  fi
  say "all pubnet steps passed"
  exit 0
fi

if wanted canonical; then
  run canonical "${NODE[@]}" $H/canonical.ts --facilitator "$A" --scheme exact,upto --asset usdc,test6 \
    --payer g,c "${WRITE[@]}"
  if [[ -n "$HOSTED_URL" ]]; then
    run canonical-hosted "${NODE[@]}" $H/canonical.ts --facilitator "$HOSTED_URL" --scheme exact,upto \
      --asset usdc,test6 --payer g,c "${WRITE[@]}"
  else
    say "== canonical-hosted skipped: RAIL402_EVIDENCE_HOSTED_URL is not set"
  fi
fi
wanted live-matrix &&
  run live-matrix "${NODE[@]}" $H/live-matrix.ts --facilitator "$A" --scheme exact,upto "${WRITE[@]}"
if wanted concurrency; then
  for scheme in exact upto mixed; do
    run "concurrency-$scheme" "${NODE[@]}" $H/concurrency.ts --facilitator "$A,$B" --scheme "$scheme" \
      --batches 3 --size 20 --duplicates 2 "${WRITE[@]}"
  done
fi
wanted fault-recovery &&
  run fault-recovery "${NODE[@]}" $H/fault-recovery.ts --database "$DATABASE_URL_BASE" \
    --cases k0-exact,k1-exact,k3-exact,k0-upto,k1-upto "${WRITE[@]}"
if wanted upstream-e2e; then
  run upstream-e2e "${NODE[@]}" $H/upstream-e2e.ts --x402 "$X402_CHECKOUT" --target local "${WRITE[@]}"
  if [[ -n "$X402_UPTO_CHECKOUT" ]]; then
    run upstream-e2e-upto "${NODE[@]}" $H/upstream-e2e.ts --x402 "$X402_UPTO_CHECKOUT" --schemes exact,upto \
      --target local --allow-version-mismatch "${WRITE[@]}"
  else
    say "== upstream-e2e-upto skipped: RAIL402_X402_UPTO_CHECKOUT is not set"
  fi
  if [[ -n "$HOSTED_URL" ]]; then
    run upstream-e2e-hosted "${NODE[@]}" $H/upstream-e2e.ts --x402 "$X402_CHECKOUT" --target hosted \
      --facilitator "$HOSTED_URL" "${WRITE[@]}"
    if [[ -n "$X402_UPTO_CHECKOUT" ]]; then
      run upstream-e2e-upto-hosted "${NODE[@]}" $H/upstream-e2e.ts --x402 "$X402_UPTO_CHECKOUT" \
        --schemes exact,upto --target hosted --facilitator "$HOSTED_URL" --allow-version-mismatch "${WRITE[@]}"
    fi
  else
    say "== upstream-e2e-hosted skipped: RAIL402_EVIDENCE_HOSTED_URL is not set"
  fi
fi
if wanted live-bazaar; then
  run live-bazaar "${NODE[@]}" $H/live-bazaar.ts --facilitator "$BAZAAR" "${WRITE[@]}"
  if [[ -n "$HOSTED_URL" ]]; then
    # A deployed catalog never reaches this machine's sellers: the cases that need one are skipped
    # with that reason, and the local run records them.
    run live-bazaar-hosted "${NODE[@]}" $H/live-bazaar.ts --facilitator "$HOSTED_URL" \
      --seller "${RAIL402_EVIDENCE_HOSTED_SELLER:-https://demo.rail402.dev}" "${WRITE[@]}"
  else
    say "== live-bazaar-hosted skipped: RAIL402_EVIDENCE_HOSTED_URL is not set"
  fi
fi
# The agent runs start their own Rail402 (local) or use a deployed one (hosted), and pay with the
# tarballs pack-check builds or the published packages, so they need none of the services above.
if wanted live-agent; then
  # shellcheck disable=SC2086 # extra arguments are split on purpose
  run live-agent "${NODE[@]}" $H/live-agent.ts "${REGISTRY[@]}" ${RAIL402_LIVE_AGENT_ARGS:-} "${WRITE[@]}"
fi
if wanted live-agent-hosted; then
  if [[ -n "${RAIL402_LIVE_AGENT_SELLER:-}" ]]; then
    IMPOSTOR=()
    [[ -n "${RAIL402_LIVE_AGENT_IMPOSTOR:-}" ]] && IMPOSTOR=(--impostor-listing "$RAIL402_LIVE_AGENT_IMPOSTOR")
    # shellcheck disable=SC2086 # extra arguments are split on purpose
    run live-agent-hosted "${NODE[@]}" $H/live-agent.ts --bazaar "${RAIL402_LIVE_AGENT_BAZAAR:-https://testnet.rail402.dev}" \
      --seller "$RAIL402_LIVE_AGENT_SELLER" "${IMPOSTOR[@]}" "${REGISTRY[@]}" ${RAIL402_LIVE_AGENT_ARGS:-} \
      "${WRITE[@]}"
  else
    say "== live-agent-hosted skipped: RAIL402_LIVE_AGENT_SELLER is not set"
  fi
fi
# The Playground runs start their own services (local) or use a deployed Playground (hosted).
wanted live-playground && run live-playground "${NODE[@]}" $H/live-playground.ts "${WRITE[@]}"
if wanted live-playground-hosted; then
  if [[ -n "${RAIL402_EVIDENCE_PLAYGROUND_URL:-}" ]]; then
    run live-playground-hosted "${NODE[@]}" $H/live-playground.ts --playground "$RAIL402_EVIDENCE_PLAYGROUND_URL" \
      "${WRITE[@]}"
  else
    say "== live-playground-hosted skipped: RAIL402_EVIDENCE_PLAYGROUND_URL is not set"
  fi
fi
if wanted rejection-audit; then
  run rejection-audit "${NODE[@]}" $H/rejection-audit.ts --facilitator "$A" --keyed "$KEYED" \
    --limited "$LIMITED" --mcp "${WRITE[@]}"
  if [[ -n "$HOSTED_URL" ]]; then
    # The keyed and rate-limited cases need deployments of their own: the local run records them.
    run rejection-audit-hosted "${NODE[@]}" $H/rejection-audit.ts --facilitator "$HOSTED_URL" --mcp "${WRITE[@]}"
  else
    say "== rejection-audit-hosted skipped: RAIL402_EVIDENCE_HOSTED_URL is not set"
  fi
fi
# The local services the private-network steps need; a step whose services are down fails at once
# instead of recording skipped rows.
local_services() {
  curl -fsS -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$TEST_RPC_URL" >/dev/null 2>&1 ||
    { say "   the local Stellar network does not answer at $TEST_RPC_URL (docker compose up)"; return 1; }
  "${NODE[@]}" tools/conformance/src/evidence-db.ts ping "$TEST_DATABASE_URL" >/dev/null 2>&1 ||
    { say "   Postgres does not answer at the test database URL"; return 1; }
}
if wanted ops; then
  if local_services; then
    run ops "${NODE[@]}" $H/ops.ts "${WRITE[@]}"
  else
    say "   ops FAILED: its local services are down"
    FAILED+=(ops)
  fi
fi
wanted upto-contract &&
  run upto-contract "${NODE[@]}" $H/upto-contract.ts --facilitator "$A" "${WRITE[@]}"
wanted benchmark &&
  run benchmark "${NODE[@]}" $H/benchmark.ts --facilitator "$A" --facilitator "$BENCHMARK_REFERENCE" \
    "${WRITE[@]}"
if wanted codes-coverage; then
  if local_services; then
    # The pages and the manifest first: the unit suite compares them with the evidence on disk, which
    # the steps above rewrote. A rehearsal wrote nothing, so it prints the coverage without recording.
    if $REHEARSE; then
      run codes-coverage bash tools/conformance/codes-coverage-step.sh
    else
      run codes-coverage bash tools/conformance/codes-coverage-step.sh --write
    fi
  else
    say "   codes-coverage FAILED: its local services are down"
    FAILED+=(codes-coverage)
  fi
fi

if wanted report; then
  if $REHEARSE; then
    # Nothing was recorded, so the committed pages must still match the committed evidence.
    run report pnpm report:check
  else
    # The current canonical run replaces the older-format one.
    if [[ -f tools/conformance/evidence/canonical-stellar-testnet.json ]]; then
      rm -f tools/conformance/evidence/canonical-exact-stellar-testnet.json
    fi
    run report pnpm report
    run report-final pnpm report:check --final
  fi
fi

if [[ ${#FAILED[@]} -gt 0 ]]; then
  say "failed: ${FAILED[*]}"
  exit 1
fi
say "all steps passed"
