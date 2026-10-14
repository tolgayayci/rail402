#!/usr/bin/env bash
# Reproducible builds of the contracts in this repository.
#
#   scripts/contracts/build.sh                    build every contract into target/contracts/<name>/
#   scripts/contracts/build.sh --contract <name>  build only <name> (repeatable): upto, test-token,
#                                                 approve-spending-limit
#   scripts/contracts/build.sh --rev <git-rev>    build a committed revision instead of the working tree
#   scripts/contracts/build.sh --check            build and fail unless each result equals its committed
#                                                 fixture and provenance record
#   scripts/contracts/build.sh --update-fixture   build and write the fixtures and provenance records
#
# Each crate directory is the source root of its contract: its files (and nothing else) are
# archived and the archive's SHA-256 is recorded. The test contracts embed it in the wasm as SEP-58
# `source_sha256`; the upto contract is built the way stellar.expert's release workflow builds it,
# with SEP-55 `source_repo` metadata (see common.sh). Every build runs inside the digest-pinned image
# from common.sh. Any change inside a crate, tests included, changes its source hash. Needs Docker,
# git and jq (and curl for the upto contract's stellar-cli). Run from anywhere inside the repository.
set -euo pipefail

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
# shellcheck source=scripts/contracts/common.sh
source scripts/contracts/common.sh

rev=""
mode="build"
selected=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --contract)
      selected+=("${2:?--contract needs a name}")
      shift 2
      ;;
    --rev)
      rev="${2:?--rev needs a revision}"
      shift 2
      ;;
    --check) mode="check" && shift ;;
    --update-fixture) mode="update" && shift ;;
    -h | --help)
      sed -n '2,17p' "$0"
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[[ ${#selected[@]} -gt 0 ]] || selected=("${CONTRACTS[@]}")

command -v docker >/dev/null || fail "docker is not installed"
command -v jq >/dev/null || fail "jq is not installed"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
CARGO_CACHE="$(mkdir -p "$CARGO_CACHE" && cd "$CARGO_CACHE" && pwd)"
cli_version="$(docker run --rm --platform "$BUILD_PLATFORM" "$BUILD_IMAGE" version --only-version 2>/dev/null || true)"

# build_one <name>: builds one contract and writes target/contracts/<name>/{<wasm>,provenance.json}.
build_one() {
  select_contract "$1"
  local out="target/contracts/$CONTRACT_NAME" src="$work/$CONTRACT_NAME"
  rm -rf "$out"
  mkdir -p "$out"

  say "exporting ${rev:-the working tree} of $CONTRACT_CRATE"
  export_source "$rev" "$src"
  say "building $CONTRACT_NAME ($CONTRACT_RECIPE build) in $BUILD_IMAGE"
  local source_sha wasm_sha wasm_size
  source_sha="$(build_source "$src" "$out")"
  wasm_sha="$(sha256 "$out/$CONTRACT_WASM")"
  wasm_size="$(wc -c <"$out/$CONTRACT_WASM" | tr -d ' ')"

  local cli="$cli_version" opts=("$BUILD_OPT") release="{}"
  if [[ "$CONTRACT_RECIPE" == "release" ]]; then
    cli="$RELEASE_CLI_VERSION" opts=("${RELEASE_OPT[@]}")
    release="$(jq -n --arg repo "$SOURCE_REPO" --arg cli_sha "$RELEASE_CLI_SHA256" \
      '{source_repo: $repo, stellar_cli_sha256: $cli_sha}')"
  fi
  jq -n \
    --arg wasm "$CONTRACT_WASM" --arg wasm_sha "$wasm_sha" --argjson size "$wasm_size" \
    --arg crate "$(crate_field name "$src/Cargo.toml")" \
    --arg version "$(crate_field version "$src/Cargo.toml")" --arg source "$CONTRACT_CRATE" \
    --arg source_sha "$source_sha" --arg image "$BUILD_IMAGE" \
    --argjson opts "$(printf '%s\n' "${opts[@]}" | jq -R . | jq -s .)" \
    --arg cli "$cli" --arg rust "$BUILD_TOOLCHAIN" --argjson release "$release" \
    --arg sdk "$(sed -n 's/^soroban-sdk = "=\(.*\)"/\1/p' "$src/Cargo.toml" | head -1)" \
    '{
      crate: $crate,
      version: $version,
      wasm: $wasm,
      wasm_sha256: $wasm_sha,
      wasm_size: $size,
      source: $source,
      source_sha256: $source_sha,
      bldimg: $image,
      bldopt: $opts,
      stellar_cli: $cli,
      rust: $rust,
      soroban_sdk: $sdk
    } + $release' >"$out/provenance.json"

  printf '%-24s wasm          %s\n' "$CONTRACT_NAME" "$out/$CONTRACT_WASM"
  printf '%-24s wasm_sha256   %s\n' "$CONTRACT_NAME" "$wasm_sha"
  printf '%-24s source_sha256 %s\n' "$CONTRACT_NAME" "$source_sha"

  case "$mode" in
    update)
      cp "$out/$CONTRACT_WASM" "$FIXTURE_WASM"
      cp "$out/provenance.json" "$FIXTURE_PROVENANCE"
      say "updated $FIXTURE_WASM and $FIXTURE_PROVENANCE"
      ;;
    check)
      [[ -f "$FIXTURE_WASM" && -f "$FIXTURE_PROVENANCE" ]] || fail "the committed fixture $FIXTURE_WASM is missing"
      local fixture_sha recorded_sha
      fixture_sha="$(sha256 "$FIXTURE_WASM")"
      recorded_sha="$(jq -r .wasm_sha256 "$FIXTURE_PROVENANCE")"
      [[ "$fixture_sha" == "$recorded_sha" ]] ||
        fail "$FIXTURE_WASM ($fixture_sha) does not match its provenance record ($recorded_sha)"
      diff <(jq -S . "$FIXTURE_PROVENANCE") <(jq -S . "$out/provenance.json") >&2 ||
        fail "the provenance record of $CONTRACT_NAME differs from this build"
      [[ "$wasm_sha" == "$fixture_sha" ]] ||
        fail "built $CONTRACT_NAME wasm $wasm_sha differs from the committed fixture $fixture_sha: run scripts/contracts/build.sh --contract $CONTRACT_NAME --update-fixture"
      say "the build reproduces the committed fixture $FIXTURE_WASM ($wasm_sha)"
      ;;
  esac
}

for name in "${selected[@]}"; do
  build_one "$name"
done
