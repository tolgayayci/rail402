#!/usr/bin/env bash
# Runs the published load-test package against a local staging stack: the release image with the
# production limits (2 CPUs and 3 GiB for the service, 1.5 CPUs and 2 GiB for its own Postgres), the
# production facilitator settings plus the overrides a private network needs, and the local private
# Stellar network for the settle probe. It never touches a service other people use.
#
#   IMAGE=rail402-facilitator:<tag> tools/loadtest/package.sh
#
# Settings (environment): IMAGE (required), OUT (default tools/loadtest/published/<UTC date>),
# STELLAR_DOCKER_NETWORK and STELLAR_RPC (the Docker network and in-network RPC of the local Stellar
# quickstart, default rail402_default and http://rail402-stellar-1:8000/rpc), SERVICE_CPUS and
# DRIVER_CPUS (cpusets, default 0-3 and 6,7), DURATION, WARMUP, CLOSED_DURATION, CLOSED_WARMUP (seconds),
# CONCURRENCY (closed-loop clients, default "1 4 16 64"), CATALOGS (default "A B"). On a shared host,
# LOAD_WAIT_BELOW (a 1-minute load average, default off) holds each run until the host's load average is
# below it, checking every LOAD_WAIT_POLL seconds (default 120) for at most LOAD_WAIT_MAX seconds (default
# 5400), after which the run starts anyway; each run's host.json records the wait and the load it started at.
#
# The stack's containers, network and volumes are named rail402-loadtest-* and removed at the end.
set -euo pipefail

: "${IMAGE:?set IMAGE to the release image to measure}"
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
OUT=${OUT:-tools/loadtest/published/$(date -u +%F)}
STELLAR_DOCKER_NETWORK=${STELLAR_DOCKER_NETWORK:-rail402_default}
STELLAR_RPC=${STELLAR_RPC:-http://rail402-stellar-1:8000/rpc}
SERVICE_CPUS=${SERVICE_CPUS:-0-3}
DRIVER_CPUS=${DRIVER_CPUS:-6,7}
DURATION=${DURATION:-120}
WARMUP=${WARMUP:-30}
CLOSED_DURATION=${CLOSED_DURATION:-60}
CLOSED_WARMUP=${CLOSED_WARMUP:-10}
CONCURRENCY=${CONCURRENCY:-1 4 16 64}
CATALOGS=${CATALOGS:-A B}
POSTGRES_IMAGE=${POSTGRES_IMAGE:-postgres:18.6-alpine}
PG_PORT=${PG_PORT:-5433}
SERVICE_PORT=${SERVICE_PORT:-8795}
LOAD_WAIT_BELOW=${LOAD_WAIT_BELOW:-}
LOAD_WAIT_POLL=${LOAD_WAIT_POLL:-120}
LOAD_WAIT_MAX=${LOAD_WAIT_MAX:-5400}

NAME=rail402-loadtest
mkdir -p "$ROOT/tools/loadtest/results"
WORK=$(mktemp -d "$ROOT/tools/loadtest/results/package-XXXXXX")
RAW="$WORK/runs"
mkdir -p "$RAW"
chmod 700 "$WORK"
URL="http://127.0.0.1:$SERVICE_PORT"
NODE=(node --conditions=@rail402/source)

cleanup() {
  docker rm -f -v "$NAME-facilitator" "$NAME-postgres" >/dev/null 2>&1 || true
  docker network rm "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- the payers, the sponsor and the settings -------------------------------------------------------
# The probe's asset has a code of its own, so it never adds a second USDC to the corpus's assets.
"${NODE[@]}" tools/loadtest/src/settle-setup.ts --payers 20 --code LOAD \
  --out "$WORK/settle-setup.json" --sponsor-env "$WORK/sponsor.env"
PROBE_ASSET=$(node -e 'const s=require(process.argv[1]);console.log(`${s.asset}:${s.code}:7`)' "$WORK/settle-setup.json")
CORPUS_ASSETS=$("${NODE[@]}" tools/search-eval/src/http-main.ts --print-env | sed -n 's/^TESTNET_ASSETS=//p')
USD_ASSETS=$("${NODE[@]}" tools/search-eval/src/http-main.ts --print-env | sed -n 's/^TESTNET_BAZAAR_USD_ASSETS=//p')

# The production facilitator settings, then the overrides of this stack. Nothing secret: the secrets
# go to secrets.env below and are never recorded.
cat >"$WORK/public.env" <<EOF
NETWORKS=stellar:testnet
TESTNET_CHANNEL_COUNT=24
TESTNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR=100
TESTNET_UPTO_ZERO_SETTLEMENT=onchain
TESTNET_UPTO_TTL_KEEPER=true
TESTNET_RPC_URL=$STELLAR_RPC
TESTNET_ASSETS=$CORPUS_ASSETS,$PROBE_ASSET
TESTNET_BAZAAR_USD_ASSETS=$USD_ASSETS
TESTNET_UPTO_ENABLED=false
TRUSTED_PROXY_HOPS=0
ORIGIN_CHECK_INTERVAL_MS=3600000
TESTNET_BAZAAR_UNVERIFIED_TTL_HOURS=87600
RATE_LIMIT_PER_MINUTE=0
SEARCH_RATE_LIMIT_PER_MINUTE=0
EOF
OVERRIDES='{"TESTNET_RPC_URL":"the local private network","TESTNET_ASSETS":"the corpus testnet assets and the settle probe asset","TESTNET_BAZAAR_USD_ASSETS":"the corpus USD asset","TESTNET_UPTO_ENABLED":"false: the private network has no upto contract","TRUSTED_PROXY_HOPS":"0: no reverse proxy in front","ORIGIN_CHECK_INTERVAL_MS":"3600000 (the most allowed): the synthetic listings are on reserved .example hosts no origin check can reach, and would be withdrawn within a minute","TESTNET_BAZAAR_UNVERIFIED_TTL_HOURS":"87600: the synthetic listings carry past settlement dates and would expire","RATE_LIMIT_PER_MINUTE":"0: the driver is one client","SEARCH_RATE_LIMIT_PER_MINUTE":"0: the driver is one client"}'

host_facts() {
  # The host's load, the service's memory and the catalog's listings by state when a run starts and ends.
  local file=$1 phase=$2
  node -e '
    const fs = require("node:fs"), os = require("node:os");
    const [file, phase, mem, listings] = process.argv.slice(1);
    const facts = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    facts[phase] = { at: new Date().toISOString(), loadAverage: os.loadavg(), serviceMemory: mem,
      listings: Object.fromEntries(listings.trim().split("\n").filter(Boolean).map((l) => l.split("|")).map(([k, v]) => [k, Number(v)])) };
    fs.writeFileSync(file, JSON.stringify(facts, null, 2) + "\n");
  ' "$file" "$phase" "$(docker stats --no-stream --format '{{.MemUsage}}' "$NAME-facilitator")" \
    "$(docker exec "$NAME-postgres" psql -U rail402 -d rail402_loadtest -tA \
      -c 'SELECT state, count(*) FROM listings GROUP BY state' 2>/dev/null || true)"
}

start_stack() {
  cleanup
  local password cursor
  password=$(openssl rand -hex 16)
  cursor=$(openssl rand -hex 32)
  docker network create "$NAME" >/dev/null
  docker run -d --name "$NAME-postgres" --network "$NAME" -p "127.0.0.1:$PG_PORT:5432" \
    --cpus 1.5 --memory 2g --cpuset-cpus "$SERVICE_CPUS" --shm-size 256m --pids-limit 256 \
    -e POSTGRES_USER=rail402 -e POSTGRES_DB=rail402_loadtest -e "POSTGRES_PASSWORD=$password" \
    "$POSTGRES_IMAGE" >/dev/null
  until docker exec "$NAME-postgres" pg_isready -U rail402 -d rail402_loadtest >/dev/null 2>&1; do sleep 1; done
  # pg_isready answers during the image's first-start restart; wait for the server it keeps.
  sleep 3
  until docker exec "$NAME-postgres" pg_isready -U rail402 -d rail402_loadtest >/dev/null 2>&1; do sleep 1; done
  SEED="postgres://rail402:$password@127.0.0.1:$PG_PORT/rail402_loadtest"
  {
    echo "DATABASE_URL=postgres://rail402:$password@$NAME-postgres:5432/rail402_loadtest"
    echo "SEARCH_CURSOR_SECRET=$cursor"
    cat "$WORK/sponsor.env"
  } >"$WORK/secrets.env"
  chmod 600 "$WORK/secrets.env"
  docker create --name "$NAME-facilitator" --network "$NAME" -p "127.0.0.1:$SERVICE_PORT:8080" \
    --cpus 2 --memory 3g --cpuset-cpus "$SERVICE_CPUS" --pids-limit 512 \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
    --env-file "$WORK/public.env" --env-file "$WORK/secrets.env" "$IMAGE" >/dev/null
  docker network connect "$STELLAR_DOCKER_NETWORK" "$NAME-facilitator"
  docker start "$NAME-facilitator" >/dev/null
  local deadline=$((SECONDS + 600))
  # Ready but for the asset check: the corpus's assets are public testnet contracts, absent from the
  # private network, so that one check fails; every other one (the index included) must pass.
  until curl -s "$URL/ready" | node -e '
    let text = ""; process.stdin.on("data", (d) => (text += d)).on("end", () => {
      try {
        const checks = Object.entries(JSON.parse(text).checks);
        process.exit(checks.length > 0 && checks.every(([name, c]) => c.ok || name.endsWith(":assets")) ? 0 : 1);
      } catch { process.exit(1); }
    });'; do
    if [ $SECONDS -gt $deadline ] || [ "$(docker inspect -f '{{.State.Running}}' "$NAME-facilitator")" != true ]; then
      docker logs --tail 50 "$NAME-facilitator" >&2
      echo "the facilitator did not become ready" >&2
      exit 1
    fi
    sleep 2
  done
}

wait_for_load() {
  # Holds a run until the host's 1-minute load average is below LOAD_WAIT_BELOW, and records the wait.
  local file=$1 started=$SECONDS timed_out=false load
  [ -n "$LOAD_WAIT_BELOW" ] || return 0
  load=$(cut -d' ' -f1 /proc/loadavg)
  until node -e 'process.exit(Number(process.argv[1]) < Number(process.argv[2]) ? 0 : 1)' "$load" "$LOAD_WAIT_BELOW"; do
    if [ $((SECONDS - started)) -ge "$LOAD_WAIT_MAX" ]; then
      timed_out=true
      break
    fi
    echo "    load average $load, waiting for < $LOAD_WAIT_BELOW"
    sleep "$LOAD_WAIT_POLL"
    load=$(cut -d' ' -f1 /proc/loadavg)
  done
  node -e '
    const fs = require("node:fs");
    const [file, below, waited, timedOut, load] = process.argv.slice(1);
    const facts = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    facts.loadWait = { below: Number(below), waitedSeconds: Number(waited), timedOut: timedOut === "true",
      loadAverage1m: Number(load) };
    fs.writeFileSync(file, JSON.stringify(facts, null, 2) + "\n");
  ' "$file" "$LOAD_WAIT_BELOW" "$((SECONDS - started))" "$timed_out" "$load"
}

run() {
  local name=$1
  shift
  echo "--- $name"
  mkdir -p "$RAW/$name"
  wait_for_load "$RAW/$name/host.json"
  host_facts "$RAW/$name/host.json" before
  taskset -c "$DRIVER_CPUS" "${NODE[@]}" tools/loadtest/src/main.ts --url "$URL" --out "$RAW/$name" \
    --config-env "$WORK/public.env" --cpus 2 --memory 3g "$@" >"$RAW/$name.log"
  host_facts "$RAW/$name/host.json" after
}

for catalog in $CATALOGS; do
  start_stack
  open=(--duration "$DURATION" --warmup "$WARMUP")
  closed=(--duration "$CLOSED_DURATION" --warmup "$CLOSED_WARMUP")
  run "$catalog-warm-open-50" --seed "$SEED" --catalog "$catalog" --state warm --rate 50 "${open[@]}" --probe /health
  run "$catalog-warm-mixed-open-100" --state warm --mix mixed --rate 100 "${open[@]}"
  run "$catalog-uncached-open-100" --state uncached --rate 100 "${open[@]}" --probe /health
  run "$catalog-uncached-open-300" --state uncached --rate 300 "${open[@]}" --probe /health
  for clients in $CONCURRENCY; do
    run "$catalog-warm-closed-c$(printf %02d "$clients")" --state warm --concurrency "$clients" "${closed[@]}"
  done
  for clients in $CONCURRENCY; do
    run "$catalog-uncached-closed-c$(printf %02d "$clients")" --state uncached --concurrency "$clients" "${closed[@]}"
  done
  # 0.9 settlements a second: their due times drift across the ledger closes instead of keeping one
  # phase to them, so the latencies sample every point of the ledger interval.
  settle=(--settle "$URL" --settle-setup "$WORK/settle-setup.json" --settle-rate 0.9)
  run "$catalog-settle-alone" --state uncached --rate 0 --duration "$DURATION" --warmup 0 "${settle[@]}"
  run "$catalog-settle-under-uncached-open-100" --state uncached --rate 100 "${open[@]}" "${settle[@]}"
  # Above the uncached capacity the closed loops measure: the embedder saturates (and on catalog B the
  # service sheds discovery load).
  run "$catalog-settle-under-uncached-open-300" --state uncached --rate 300 "${open[@]}" "${settle[@]}"
  # Last: it adds listings, so the catalog is no longer the dataset.
  run "$catalog-cold-index-open-50" --store "$SEED" --state cold-index --rate 50 \
    "${open[@]}" --bump-seconds 10
  # The service's log stays with the raw runs (git-ignored), not in the package.
  docker logs "$NAME-facilitator" >"$WORK/facilitator-$catalog.log" 2>&1
done

# --- the package ---------------------------------------------------------------------------------
IMAGE_ID=$(docker image inspect -f '{{.Id}}' "$IMAGE")
PG_ID=$(docker image inspect -f '{{.Id}}' "$POSTGRES_IMAGE")
PG_DIGEST=$(docker image inspect -f '{{join .RepoDigests ","}}' "$POSTGRES_IMAGE")
VERSIONS=$(docker run --rm --entrypoint node "$IMAGE" -e '
  const fs = require("node:fs");
  const dir = fs.readdirSync("node_modules/.pnpm").find((d) => d.startsWith("onnxruntime-node@"));
  const ort = dir === undefined ? null : dir.slice("onnxruntime-node@".length);
  console.log(JSON.stringify({ node: process.version, onnxruntimeNode: ort, version: process.env.RAIL402_VERSION }));
')
node -e '
  const fs = require("node:fs");
  const [file, image, id, versions, pg, pgId, pgDigest, env, overrides, serviceCpus, driverCpus, rpc] = process.argv.slice(1);
  const settings = Object.fromEntries(fs.readFileSync(env, "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
  fs.writeFileSync(file, JSON.stringify({
    service: { image, imageId: id, ...JSON.parse(versions),
      limits: { cpus: 2, memory: "3g", pids: 512, cpuset: serviceCpus },
      hardening: "read-only root, all capabilities dropped, no-new-privileges, 64 MiB /tmp",
      settings, overrides: JSON.parse(overrides),
      secrets: "DATABASE_URL, SEARCH_CURSOR_SECRET and TESTNET_SPONSOR_SECRET set, not recorded" },
    postgres: { image: pg, imageId: pgId, repoDigests: pgDigest.split(",").filter(Boolean),
      limits: { cpus: 1.5, memory: "2g", shm: "256m", pids: 256, cpuset: serviceCpus } },
    driverCpuset: driverCpus,
    settleNetwork: { rpc, kind: "local private Stellar network (quickstart, standalone)" },
  }, null, 2) + "\n");
' "$WORK/stack.json" "$IMAGE" "$IMAGE_ID" "$VERSIONS" "$POSTGRES_IMAGE" "$PG_ID" "$PG_DIGEST" \
  "$WORK/public.env" "$OVERRIDES" "$SERVICE_CPUS" "$DRIVER_CPUS" "$STELLAR_RPC"
"${NODE[@]}" tools/loadtest/src/package.ts --raw "$RAW" --stack "$WORK/stack.json" --out "$OUT"
rm -f "$WORK/secrets.env" "$WORK/sponsor.env" "$WORK/settle-setup.json"
echo "raw runs in $RAW"
