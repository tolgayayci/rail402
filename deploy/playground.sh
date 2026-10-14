#!/usr/bin/env bash
# Deploys the Rail402 Playground to Railway, in one command:
#
#   ./deploy/playground.sh [--dry-run] <pay-to-account> [project-name]
#
# <pay-to-account> is the public G… testnet account the Playground's lab sellers are paid to (create
# it with `rail402 keys new` and `rail402 account setup`; its secret stays with you and never goes to
# Railway). Creates a Railway project (default name "rail402-playground"), applies the infrastructure
# in .railway/playground.ts (one stateless service in US East, next to Rail402 and the Stellar testnet
# RPC), sets the account and the commit, deploys the checked-out commit, adds a railway.app domain and
# waits until /ready passes. The Playground holds no secret, so none is set.
#
# --dry-run prints every step and command without contacting Railway or changing anything.
#
# Needs the Railway CLI, logged in (`railway login`), Node 24 with npm, git and curl. Uncommitted
# changes are not deployed: the script uploads a copy of HEAD. With more than one Railway workspace,
# set RAILWAY_WORKSPACE to its name or ID.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
service="playground"
domain="playground.rail402.dev"

say() { printf '==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

dry=false
if [[ "${1:-}" == "--dry-run" ]]; then
  dry=true
  shift
fi
pay_to="${1:-}"
name="${2:-rail402-playground}"

[[ -n "$pay_to" ]] || fail "usage: deploy/playground.sh [--dry-run] <pay-to-account> [project-name]"
# A secret seed must never be passed: say so without echoing it.
[[ "$pay_to" =~ ^S ]] && fail "that is a secret seed; pass the account's public G… address"
[[ "$pay_to" =~ ^G[A-Z2-7]{55}$ ]] || fail "the pay-to account must be a public G… address"
[[ "$name" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || fail "the project name must be lower-case letters, digits and dashes"
[[ "$name" == "rail402-stellar-prod" ]] && fail "the Playground never shares the facilitator's project"

commit="$(git -C "$root" rev-parse HEAD)"

# Runs a command, or prints it in a dry run.
run() {
  if $dry; then
    printf '    $ %s\n' "$*"
  else
    "$@"
  fi
}

if $dry; then
  say "dry run: nothing is created, changed or deployed"
else
  for tool in railway node npm git curl; do command -v "$tool" >/dev/null || fail "$tool is not installed"; done
  railway whoami >/dev/null 2>&1 || fail "log in to Railway first: railway login"
fi

# Work from a copy of HEAD: `railway init` links the directory it runs in to the new project, and
# this keeps the checkout's own link untouched.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
say "copying commit ${commit:0:12} to $work"
run git -C "$root" archive --output "$work/head.tar" HEAD
$dry || { tar -x -C "$work" -f "$work/head.tar" && rm "$work/head.tar"; }
cd "$work"

say "creating the Railway project $name"
init=(railway init --name "$name" --json)
[[ -n "${RAILWAY_WORKSPACE:-}" ]] && init+=(--workspace "$RAILWAY_WORKSPACE")
run "${init[@]}"

say "applying .railway/playground.ts"
# The authoring file imports the Railway SDK; install the pinned version next to it.
sdk="$(node -e 'console.log(require(process.argv[1]).devDependencies.railway)' "$root/package.json")"
$dry || echo '{ "private": true }' >"$work/.railway/package.json"
run npm install --prefix "$work/.railway" --no-audit --no-fund --silent "railway@$sdk"
run railway config apply --file "$work/.railway/playground.ts" --yes

say "setting the pay-to account and the commit"
run railway variable set "PLAYGROUND_PAY_TO=$pay_to" --service "$service" --skip-deploys --json
run railway variable set "RAIL402_COMMIT=$commit" --service "$service" --skip-deploys --json

say "deploying commit ${commit:0:12}"
run railway up "$work" --path-as-root --service "$service" --detach --json

if $dry; then
  run railway domain --service "$service" --port 8080 --json
  say "then: wait for <railway domain>/ready, and add $domain (Cloudflare CNAME + Railway TXT) when approved"
  exit 0
fi

url="$(railway domain --service "$service" --port 8080 --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.slice(s.indexOf("{"))).domain))')"

say "waiting for $url/ready (the image builds first; this takes a few minutes)"
for _ in $(seq 1 180); do
  if curl -fsS "$url/ready" >/dev/null 2>&1; then
    say "ready: $url"
    say "the public origin is https://$domain: add it with \`railway domain $domain --service $service\`"
    say "and the DNS records it prints; until then PUBLIC_URL names a host that does not answer yet"
    exit 0
  fi
  sleep 5
done
fail "$url did not become ready; check the build and deploy logs in the Railway dashboard"
