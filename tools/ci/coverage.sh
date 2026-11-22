#!/usr/bin/env bash
# Go test coverage, with a floor it may not drop below
# (docs/plans/production-readiness.md, P0). The floor only ever goes up.
#
#   tools/ci/coverage.sh            prints the total and the weakest packages
#   COVERAGE_FLOOR=70 tools/ci/...  fails below 70%
# In GitHub Actions the table also goes to the job summary.
set -euo pipefail
cd "$(dirname "$0")/../.."
FLOOR="${COVERAGE_FLOOR:-65}"
out=$(mktemp); trap 'rm -f "$out" "$out.pkgs"' EXIT
# Our packages only: app/node_modules carries a Go package of its own (flatted).
pkgs=$(go list ./... | grep -v /node_modules/)
# shellcheck disable=SC2086
go test -coverprofile="$out" $pkgs > "$out.pkgs"
total=$(go tool cover -func="$out" | awk '/^total:/ {sub("%","",$3); print $3}')
# "ok <pkg> <time> coverage: N%" for a tested package, "<pkg> coverage: N%" otherwise.
weakest=$(awk '/coverage:/ {pkg = ($1 == "ok") ? $2 : $1
  for (i=1;i<=NF;i++) if ($i == "coverage:") {p=$(i+1); sub("%","",p); print p, pkg}}' "$out.pkgs" | sort -n | head -10)
report() {
  echo "### Go coverage: ${total}% (floor ${FLOOR}%)"
  echo
  echo "| Coverage | Weakest packages |"
  echo "|---:|---|"
  while read -r pct pkg; do echo "| ${pct}% | \`${pkg#github.com/jebin2/ayis/}\` |"; done <<< "$weakest"
}
report
[[ -n ${GITHUB_STEP_SUMMARY:-} ]] && report >> "$GITHUB_STEP_SUMMARY"
if awk -v t="$total" -v f="$FLOOR" 'BEGIN { exit !(t < f) }'; then
  echo "coverage ${total}% is below the floor of ${FLOOR}%" >&2
  exit 1
fi
