#!/usr/bin/env bash
# Verifies a deployed contract (by default the upto settlement contract) against its source.
#
#   scripts/contracts/verify.sh --network testnet     use contracts/stellar/deployments/testnet.json
#   scripts/contracts/verify.sh --record <file>       use another deployment record
#   scripts/contracts/verify.sh --wasm <file> [--rev <git-rev>]
#                                                     rebuild <git-rev> (default HEAD) and compare with a wasm file
#   --contract <name>                                 verify another contract of build.sh (default upto;
#                                                     a deployment record names its own contract)
#   --recipe <sep58|release>                          build with this recipe instead of the contract's own
#                                                     (an older build of a contract, e.g. a replaced deployment)
#
# With a deployment record it rebuilds the recorded commit from a clean export with the contract's
# build recipe (common.sh), checks the source archive and the result against the recorded hashes,
# downloads the wasm that the contract instance runs and checks it too, then prints the embedded
# metadata (SEP-55 `source_repo` for upto, SEP-58 for the test contracts). Every step runs in the
# pinned build image, so only Docker, git and jq (and curl for upto) are needed. Exits non-zero on
# any mismatch.
set -euo pipefail

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
# shellcheck source=scripts/contracts/common.sh
source scripts/contracts/common.sh

record=""
wasm_file=""
rev="HEAD"
contract="upto"
recipe=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)
      record="contracts/stellar/deployments/${2:?--network needs a name}.json"
      shift 2
      ;;
    --record)
      record="${2:?--record needs a file}"
      shift 2
      ;;
    --wasm)
      wasm_file="${2:?--wasm needs a file}"
      shift 2
      ;;
    --rev)
      rev="${2:?--rev needs a revision}"
      shift 2
      ;;
    --contract)
      contract="${2:?--contract needs a name}"
      shift 2
      ;;
    --recipe)
      recipe="${2:?--recipe needs a name}"
      [[ "$recipe" == "sep58" || "$recipe" == "release" ]] || fail "unknown recipe: $recipe (known: sep58, release)"
      shift 2
      ;;
    -h | --help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[[ -n "$record" || -n "$wasm_file" ]] || fail "give --network, --record or --wasm (see --help)"
command -v docker >/dev/null || fail "docker is not installed"
command -v jq >/dev/null || fail "jq is not installed"
if [[ -n "$record" && -f "$record" ]]; then
  contract="$(jq -r '.contract // empty' "$record")"
  contract="${contract:-upto}"
fi
select_contract "$contract"
[[ -z "$recipe" ]] || CONTRACT_RECIPE="$recipe"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
CARGO_CACHE="$(mkdir -p "$CARGO_CACHE" && cd "$CARGO_CACHE" && pwd)"

expected=""
expected_source=""
if [[ -n "$record" ]]; then
  [[ -f "$record" ]] || fail "no deployment record at $record"
  rev="$(jq -er .commit "$record")"
  expected="$(jq -er .wasm_sha256 "$record")"
  contract_id="$(jq -er .contract_id "$record")"
  rpc_url="$(jq -er .rpc_url "$record")"
  passphrase="$(jq -er .network_passphrase "$record")"
  expected_source="$(jq -r '.source_sha256 // empty' "$record")"
else
  [[ -f "$wasm_file" ]] || fail "no wasm at $wasm_file"
  expected="$(sha256 "$wasm_file")"
fi

git cat-file -e "$rev^{commit}" 2>/dev/null || fail "revision $rev is not in this repository"
say "rebuilding $CONTRACT_CRATE at $(git rev-parse --short "$rev")"
export_source "$rev" "$work/source"
source_sha="$(build_source "$work/source" "$work/out")"
if [[ -n "$expected_source" ]]; then
  printf 'source        %s\n' "$source_sha"
  [[ "$source_sha" == "$expected_source" ]] || fail "the source archive does not match the record ($expected_source)"
fi
built="$(sha256 "$work/out/$CONTRACT_WASM")"
printf 'rebuilt       %s\n' "$built"
printf 'expected      %s\n' "$expected"
[[ "$built" == "$expected" ]] || fail "the rebuilt wasm does not match"

if [[ -n "$record" ]]; then
  say "fetching the wasm that $contract_id runs"
  mkdir -p "$work/fetched"
  docker run --rm --platform "$BUILD_PLATFORM" --network host --user "$(id -u):$(id -g)" --volume "$work/fetched:/out" "$BUILD_IMAGE" \
    contract fetch --id "$contract_id" --rpc-url "$rpc_url" --network-passphrase "$passphrase" \
    --out-file /out/deployed.wasm >&2
  deployed="$(sha256 "$work/fetched/deployed.wasm")"
  printf 'deployed      %s\n' "$deployed"
  [[ "$deployed" == "$expected" ]] || fail "the deployed wasm does not match the record"
fi

docker run --rm --platform "$BUILD_PLATFORM" --user "$(id -u):$(id -g)" --volume "$work/out:/out:ro" "$BUILD_IMAGE" \
  contract info meta --wasm "/out/$CONTRACT_WASM" 2>/dev/null
say "verified: $built"
