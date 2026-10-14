#!/usr/bin/env bash
# Reproducible builds of the third-party contracts that tests load as wasm fixtures.
#
#   scripts/contracts/fixtures.sh                    build them into target/contracts/fixtures/
#   scripts/contracts/fixtures.sh --check            build and fail unless each result equals its
#                                                    committed fixture and provenance record
#   scripts/contracts/fixtures.sh --update-fixture   build and write the fixtures and provenance records
#
# The OpenZeppelin smart account and its ed25519 verifier (MIT) come from the example workspace of
# OpenZeppelin/stellar-contracts at one pinned commit, built with that workspace's Cargo.lock
# (`--locked`) in the same digest-pinned image and toolchain as the contracts of this repository.
# Needs Docker, git and jq, and network access to github.com and crates.io.
set -euo pipefail

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
# shellcheck source=scripts/contracts/common.sh
source scripts/contracts/common.sh

OZ_REPOSITORY="https://github.com/OpenZeppelin/stellar-contracts"
OZ_COMMIT="a5bd8cbd3d0bb8efbd5cf5e2edf9734f87e47640"
# <cargo package>:<fixture name>
OZ_FIXTURES=(
  "multisig-account-example:oz_smart_account"
  "multisig-ed25519-verifier-example:oz_ed25519_verifier"
)

mode="build"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) mode="check" && shift ;;
    --update-fixture) mode="update" && shift ;;
    -h | --help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

command -v docker >/dev/null || fail "docker is not installed"
command -v jq >/dev/null || fail "jq is not installed"

out="target/contracts/fixtures"
src="target/contracts/oz-stellar-contracts"
CARGO_CACHE="$(mkdir -p "$CARGO_CACHE" && cd "$CARGO_CACHE" && pwd)"
mkdir -p "$out"

say "fetching $OZ_REPOSITORY at $OZ_COMMIT"
if [[ ! -d "$src/.git" ]]; then
  git init --quiet "$src"
  git -C "$src" remote add origin "$OZ_REPOSITORY"
fi
git -C "$src" fetch --quiet --depth 1 origin "$OZ_COMMIT"
git -C "$src" checkout --quiet --force --detach "$OZ_COMMIT"
git -C "$src" clean --quiet -fdx --exclude=target
[[ "$(git -C "$src" rev-parse HEAD)" == "$OZ_COMMIT" ]] || fail "checkout of $OZ_COMMIT failed"
src="$(cd "$src" && pwd)"
cli_version="$(docker run --rm --platform "$BUILD_PLATFORM" "$BUILD_IMAGE" version --only-version 2>/dev/null || true)"

for entry in "${OZ_FIXTURES[@]}"; do
  package="${entry%%:*}"
  fixture="${entry#*:}"
  wasm="$(tr - _ <<<"$package").wasm"
  say "building $package in $BUILD_IMAGE"
  in_image "$src" -- contract build "$BUILD_OPT" --package "$package" >&2
  cp "$src/target/wasm32v1-none/release/$wasm" "$out/$fixture.wasm"
  wasm_sha="$(sha256 "$out/$fixture.wasm")"
  jq -n \
    --arg wasm "$fixture.wasm" --arg wasm_sha "$wasm_sha" \
    --argjson size "$(wc -c <"$out/$fixture.wasm" | tr -d ' ')" \
    --arg repository "$OZ_REPOSITORY" --arg commit "$OZ_COMMIT" --arg package "$package" \
    --arg image "$BUILD_IMAGE" --arg opt "$BUILD_OPT" --arg cli "$cli_version" \
    --arg rust "$BUILD_TOOLCHAIN" \
    '{
      wasm: $wasm,
      wasm_sha256: $wasm_sha,
      wasm_size: $size,
      repository: $repository,
      commit: $commit,
      package: $package,
      license: "MIT",
      bldimg: $image,
      bldopt: [$opt, "--package", $package],
      stellar_cli: $cli,
      rust: $rust
    }' >"$out/$fixture.provenance.json"
  printf '%-22s wasm_sha256 %s\n' "$fixture" "$wasm_sha"

  case "$mode" in
    update)
      cp "$out/$fixture.wasm" "$out/$fixture.provenance.json" "$FIXTURES/"
      say "updated $FIXTURES/$fixture.wasm and its provenance record"
      ;;
    check)
      [[ -f "$FIXTURES/$fixture.wasm" && -f "$FIXTURES/$fixture.provenance.json" ]] ||
        fail "the committed fixture $FIXTURES/$fixture.wasm is missing"
      committed="$(sha256 "$FIXTURES/$fixture.wasm")"
      [[ "$committed" == "$(jq -r .wasm_sha256 "$FIXTURES/$fixture.provenance.json")" ]] ||
        fail "$FIXTURES/$fixture.wasm does not match its provenance record"
      diff <(jq -S . "$FIXTURES/$fixture.provenance.json") <(jq -S . "$out/$fixture.provenance.json") >&2 ||
        fail "the provenance record of $fixture differs from this build"
      [[ "$wasm_sha" == "$committed" ]] ||
        fail "built $fixture $wasm_sha differs from the committed fixture $committed"
      say "the build reproduces the committed fixture $FIXTURES/$fixture.wasm"
      ;;
  esac
done
