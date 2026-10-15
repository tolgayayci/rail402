# Shared settings and helpers for the contract build scripts. Sourced, not executed.
#
# Two build recipes, both run inside the digest-pinned stellar-cli image below (only Docker is
# needed on the host):
#   sep58    the test contracts: the image's own CLI builds the wasm and embeds the build image,
#            the build options and the SHA-256 of the source archive in its contractmetav0 section.
#   release  the upto settlement contract: the same build as stellar.expert's release workflow
#            (stellar-expert/soroban-build-workflow), `stellar contract build --optimize` with the
#            SEP-55 `source_repo` metadata, by the official stellar-cli release binary on the image's
#            Rust toolchain. A tagged release on GitHub produces the same bytes and attests them.

# stellar-cli 28.0.0 on rust 1.98.0, linux/amd64 (a single-architecture manifest, as SEP-58 requires).
BUILD_IMAGE="docker.io/stellar/stellar-cli:28.0.0-rust1.98.0-slim-trixie-amd64-0@sha256:3901802ef2324ff9563a50995279818ca4b98938b45e1dab0e1e7c5d69adb5a9"
# Every run names the image's platform, so an arm64 host runs it under emulation (slower, same bytes)
# instead of failing to find a matching manifest.
BUILD_PLATFORM="linux/amd64"
BUILD_TOOLCHAIN="1.98.0"
BUILD_OPT="--locked"

# The release recipe: the stellar-cli version stellar.expert's release workflow installs, the
# SHA-256 of its linux x86_64 release archive, and the repository the release workflow runs in.
RELEASE_CLI_VERSION="28.1.0"
RELEASE_CLI_SHA256="c1680deee94301d33ada7a17f98411e642a4248c727afbd2e43050d345746462"
RELEASE_CLI_URL="https://github.com/stellar/stellar-cli/releases/download/v$RELEASE_CLI_VERSION/stellar-cli-$RELEASE_CLI_VERSION-x86_64-unknown-linux-gnu.tar.gz"
# `--optimize` is what the release workflow passes; `--locked` only refuses a stale lockfile.
RELEASE_OPT=(--locked --optimize)
SOURCE_REPO="github:tolgayayci/rail402"

FIXTURES="packages/testkit/fixtures"
# The contracts built from this repository, by name. Each crate directory is its own Cargo
# project (manifest, lockfile, toolchain file) and the complete build input of its wasm.
CONTRACTS=(upto test-token approve-spending-limit)

# select_contract <name>: sets CONTRACT_NAME, CONTRACT_CRATE (crate directory), CONTRACT_RECIPE
# (sep58 or release), CONTRACT_WASM (the file cargo writes), FIXTURE_WASM and FIXTURE_PROVENANCE for
# one of CONTRACTS.
select_contract() {
  local fixture
  CONTRACT_RECIPE="sep58"
  case "$1" in
    upto) CONTRACT_CRATE="contracts/stellar/upto" fixture="x402_upto_stellar" CONTRACT_RECIPE="release" ;;
    test-token) CONTRACT_CRATE="contracts/testing/test-token" fixture="test_token" ;;
    approve-spending-limit)
      CONTRACT_CRATE="contracts/testing/approve-spending-limit" fixture="approve_spending_limit"
      ;;
    *) fail "unknown contract: $1 (known: ${CONTRACTS[*]})" ;;
  esac
  CONTRACT_NAME="$1"
  CONTRACT_WASM="$(crate_field name "$CONTRACT_CRATE/Cargo.toml" | tr - _).wasm"
  FIXTURE_WASM="$FIXTURES/$fixture.wasm"
  FIXTURE_PROVENANCE="$FIXTURES/$fixture.provenance.json"
}

# crate_field <key> <Cargo.toml>: the first `key = "value"` of the manifest (the [package] table).
crate_field() { sed -n "s/^$1 = \"\(.*\)\"/\1/p" "$2" | head -1; }
# Crate downloads shared between builds (inside the git-ignored target/ directory).
CARGO_CACHE="${CARGO_CACHE:-target/contracts/cargo-home}"

say() { printf '==> %s\n' "$*" >&2; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

sha256() { sha256sum "$1" | cut -d' ' -f1; }

# export_source <git-rev|""> <dest>: copies the crate's build inputs into <dest>. With a revision,
# the committed files are exported; without one, the working tree's tracked and untracked
# (non-ignored) files. File modes are normalised so the source archive does not depend on umask.
export_source() {
  local rev="$1" dest="$2"
  mkdir -p "$dest"
  if [[ -n "$rev" ]]; then
    local depth
    depth="$(awk -F/ '{ print NF }' <<<"$CONTRACT_CRATE")"
    git archive --format=tar "$rev" "$CONTRACT_CRATE" | tar -x -C "$dest" --strip-components="$depth"
  else
    git ls-files -z --cached --others --exclude-standard -- "$CONTRACT_CRATE" |
      while IFS= read -r -d '' file; do
        [[ -f "$file" ]] || continue
        local rel="${file#"$CONTRACT_CRATE"/}"
        mkdir -p "$dest/$(dirname "$rel")"
        cp "$file" "$dest/$rel"
      done
  fi
  find "$dest" -type d -exec chmod 755 {} +
  find "$dest" -type f -exec chmod 644 {} +
}

# in_image <source-dir> [docker options...] -- <args...>: runs the image's stellar CLI (or another
# entrypoint given in the docker options) with <source-dir> mounted at /source, the way
# `stellar contract build --image` does, with the toolchain pinned to the image default.
# Cargo's home is a cache directory mounted at a fixed path and HOME is /tmp: the image's own home is
# private to its default user (git dependencies fail to fetch under any other uid), and the build
# must work for any host uid (no host path reaches the wasm).
in_image() {
  local src="$1" options=()
  shift
  while [[ $# -gt 0 && "$1" != "--" ]]; do
    options+=("$1")
    shift
  done
  [[ "${1:-}" == "--" ]] && shift
  mkdir -p "$CARGO_CACHE"
  docker run --rm --platform "$BUILD_PLATFORM" \
    --user "$(id -u):$(id -g)" \
    --volume "$src:/source" \
    --volume "$(cd "$CARGO_CACHE" && pwd):/cargo" \
    --workdir /source \
    --env CARGO_HOME=/cargo \
    --env HOME=/tmp \
    --env CARGO_TARGET_DIR=/source/target \
    --env RUSTUP_TOOLCHAIN="$BUILD_TOOLCHAIN" \
    "${options[@]}" "$BUILD_IMAGE" "$@"
}

# archive_source <source-dir> <archive>: writes the SEP-58 source archive: a gzipped tar with one
# top-level directory, `source/`, created by the build image's tar and gzip with fixed ordering,
# timestamps and ownership, so the same files always give the same bytes.
archive_source() {
  local src="$1" archive="$2" dir
  dir="$(cd "$(dirname "$archive")" && pwd)"
  docker run --rm --platform "$BUILD_PLATFORM" --user "$(id -u):$(id -g)" \
    --volume "$src:/work/source:ro" --volume "$dir:/archive" --workdir /work \
    --entrypoint sh "$BUILD_IMAGE" -c '
      set -eu
      tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=posix \
        --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
        --exclude=source/target --exclude=source/test_snapshots \
        -cf - source | gzip -9 -n > "/archive/$1"' sh "$(basename "$archive")"
}

# release_cli: downloads the release recipe's stellar-cli archive once (into the git-ignored
# target/ directory), checks its SHA-256 and prints the path of the extracted `stellar` binary.
release_cli() {
  local dir="target/contracts/stellar-cli-$RELEASE_CLI_VERSION"
  local archive="$dir/stellar-cli.tar.gz"
  mkdir -p "$dir"
  if [[ ! -f "$archive" ]]; then
    command -v curl >/dev/null || fail "curl is not installed"
    curl -fsSL --retry 3 -o "$archive.partial" "$RELEASE_CLI_URL" || fail "cannot download $RELEASE_CLI_URL"
    mv "$archive.partial" "$archive"
  fi
  [[ "$(sha256 "$archive")" == "$RELEASE_CLI_SHA256" ]] ||
    fail "$archive is not stellar-cli $RELEASE_CLI_VERSION (SHA-256 mismatch); delete it and retry"
  tar -xzf "$archive" -C "$dir" stellar
  printf '%s\n' "$(cd "$dir" && pwd)/stellar"
}

# build_source <source-dir> <out-dir>: archives <source-dir>, builds it with the contract's recipe and
# writes <out-dir>/$CONTRACT_WASM and <out-dir>/source.tar.gz. Prints the archive's SHA-256.
build_source() {
  local src="$1" out="$2" source_sha
  mkdir -p "$out"
  archive_source "$src" "$out/source.tar.gz"
  source_sha="$(sha256 "$out/source.tar.gz")"
  if [[ "$CONTRACT_RECIPE" == "release" ]]; then
    local cli
    cli="$(release_cli)"
    in_image "$src" --volume "$cli:/opt/release/stellar:ro" --entrypoint /opt/release/stellar -- \
      contract build "${RELEASE_OPT[@]}" --package "$(crate_field name "$src/Cargo.toml")" \
      --meta "source_repo=$SOURCE_REPO" >&2
  else
    in_image "$src" -- contract build "$BUILD_OPT" \
      --meta "bldimg=$BUILD_IMAGE" \
      --meta "bldopt=$BUILD_OPT" \
      --meta "source_sha256=$source_sha" >&2
  fi
  cp "$src/target/wasm32v1-none/release/$CONTRACT_WASM" "$out/$CONTRACT_WASM"
  printf '%s\n' "$source_sha"
}
