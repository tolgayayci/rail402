#!/usr/bin/env bash
# The error-code coverage step of the evidence run (run-evidence.sh), from the repository root:
#
#   bash tools/conformance/codes-coverage-step.sh           # both suites, then prints the coverage
#   bash tools/conformance/codes-coverage-step.sh --write   # renders the report first, records the coverage
#
# With --write it runs `pnpm report` before the suites: the unit suite checks the generated pages and the
# evidence manifest against the evidence on disk, which the evidence run has just rewritten. The
# integration suite shares one Postgres and one Stellar network across its files, so a failed test is
# retried once; the files that still fail are listed at the end. Test output goes to stderr.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1

WRITE=false
case "${1:-}" in
  --write) WRITE=true ;;
  "") ;;
  *)
    echo "codes-coverage-step: unknown argument $1" >&2
    exit 64
    ;;
esac

if $WRITE; then
  pnpm report >&2 || exit 1
fi
pnpm test >&2 || {
  echo "codes-coverage-step: the unit suite failed" >&2
  exit 1
}
RESULTS="$ROOT/.work/codes-coverage-integration.json"
rm -f "$RESULTS"
if ! pnpm test:integration --retry=1 --reporter=default --reporter=json --outputFile.json="$RESULTS" >&2; then
  echo "codes-coverage-step: the integration suite failed; failed files:" >&2
  if [[ -f "$RESULTS" ]]; then
    jq -r '.testResults[] | select(.status == "failed") | "  " + .name' "$RESULTS" >&2
  fi
  exit 1
fi
if $WRITE; then
  pnpm codes:coverage --write
else
  pnpm codes:coverage
fi
