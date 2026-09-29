#!/usr/bin/env bash
# Deploys a Rail402 testnet facilitator to Railway, in one command:
#
#   ./deploy/railway.sh [project-name]
#
# Creates a Railway project (default name "rail402-testnet"), applies the infrastructure in
# .railway/railway.ts (Postgres and the Rail402 service, both in US East next to the public Stellar
# testnet RPC), creates a fee sponsor account funded by Friendbot, sets the secrets (on stdin, never
# on the command line), deploys the checked-out commit, adds a railway.app domain and waits until
# /ready passes.
#
# Needs the Railway CLI, logged in (`railway login`), Node 24 with npm, git and curl. Uncommitted
# changes are not deployed: the script uploads a copy of HEAD. With more than one Railway workspace,
# set RAILWAY_WORKSPACE to its name or ID.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
name="${1:-rail402-testnet}"
service="rail402"
region="us-east4-eqdc4a" # keep in step with REGION in .railway/railway.ts
friendbot="https://friendbot.stellar.org"

say() { printf '==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

for tool in railway node git curl; do command -v "$tool" >/dev/null || fail "$tool is not installed"; done
railway whoami >/dev/null 2>&1 || fail "log in to Railway first: railway login"

# Work from a copy of HEAD: `railway init` links the directory it runs in to the new project, and
# this keeps the checkout's own link untouched.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git -C "$root" archive HEAD | tar -x -C "$work"
version="$(git -C "$root" rev-parse --short HEAD)"
cd "$work"

say "creating the Railway project $name"
init=(railway init --name "$name" --json)
[[ -n "${RAILWAY_WORKSPACE:-}" ]] && init+=(--workspace "$RAILWAY_WORKSPACE")
project="$("${init[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.slice(s.indexOf("{"))).id))')"

say "applying .railway/railway.ts"
# The authoring file imports the Railway SDK; install the pinned version next to it.
sdk="$(node -e 'console.log(require(process.argv[1]).devDependencies.railway)' "$work/package.json")"
echo '{ "private": true }' >"$work/.railway/package.json"
npm install --prefix "$work/.railway" --no-audit --no-fund --silent "railway@$sdk" >/dev/null
railway config apply --file "$work/.railway/railway.ts" --yes >/dev/null

say "creating a testnet fee sponsor"
keys="$(node "$work/deploy/stellar-keys.ts")"
sponsor="$(sed -n 1p <<<"$keys")"
secret="$(sed -n 2p <<<"$keys")"
cursor="$(sed -n 3p <<<"$keys")"
curl -fsS -o /dev/null "$friendbot?addr=$sponsor" || fail "Friendbot did not fund $sponsor"
printf '%s' "$secret" | railway variable set TESTNET_SPONSOR_SECRET --stdin --service "$service" --skip-deploys --json >/dev/null
printf '%s' "$cursor" | railway variable set SEARCH_CURSOR_SECRET --stdin --service "$service" --skip-deploys --json >/dev/null
railway variable set "RAIL402_VERSION=$version" --service "$service" --skip-deploys --json >/dev/null
unset secret cursor keys

# The authoring file places Postgres in US East, but a new Postgres starts in Railway's default
# region: set its region and deploy that configuration, which moves it together with its volume.
say "moving Postgres to $region"
environment="$(railway environment list --json | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const list = JSON.parse(s.slice(s.search(/[[{]/)));
    console.log((list.environments ?? list).find((env) => env.name === "production").id);
  })')"
postgres="$(railway service list --json | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    console.log(JSON.parse(s.slice(s.search(/[[{]/))).find((svc) => svc.name === "Postgres").id);
  })')"
railway api 'mutation($s: String!, $e: String!, $input: ServiceInstanceUpdateInput!) {
    serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: $input) }' --compact \
  --variables "{\"s\":\"$postgres\",\"e\":\"$environment\",\"input\":{\"multiRegionConfig\":{\"$region\":{\"numReplicas\":1}}}}" \
  >/dev/null
railway api 'mutation($s: String!, $e: String!) { serviceInstanceDeployV2(serviceId: $s, environmentId: $e) }' \
  --compact --variables "{\"s\":\"$postgres\",\"e\":\"$environment\"}" >/dev/null

say "deploying commit $version"
railway up "$work" --path-as-root --service "$service" --detach --json >/dev/null

url="$(railway domain --service "$service" --port 8080 --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.slice(s.indexOf("{"))).domain))')"

say "waiting for $url/ready (the image builds first; this takes a few minutes)"
for _ in $(seq 1 180); do
  if curl -fsS "$url/ready" >/dev/null 2>&1; then
    say "ready: $url"
    say "project $name ($project); fee sponsor $sponsor"
    say "manage it from any directory with: railway link --project $project"
    exit 0
  fi
  sleep 5
done
fail "$url did not become ready; check the build and deploy logs in the Railway dashboard"
