#!/usr/bin/env bash
# The cloud watchdog (lambda/ayis_watchdog), under pytest: every decision it
# makes against fake AWS clients - lambda/tests. This wrapper is how run-all.sh
# and CI run it: one "  ok" line per test, then the count.
#
# Needs pytest (pip install pytest==9.1.1); boto3 is not needed - the tests pass
# fakes, and the handler imports boto3 only inside the Lambda runtime.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
if ! python3 -c 'import pytest' 2>/dev/null; then
  echo "  FAIL pytest is not installed: pip install pytest==9.1.1"; exit 1
fi
# No __pycache__ left in lambda/ - it is a source directory, not a build one.
out=$(PYTHONDONTWRITEBYTECODE=1 python3 -m pytest lambda -v -o console_output_style=classic 2>&1)
rc=$?
sed -nE 's/^lambda\/tests\/(.+) PASSED.*/  ok   \1/p; s/^lambda\/tests\/(.+) FAILED.*/  FAIL \1/p' <<<"$out"
(( rc == 0 )) || printf '%s\n' "$out" | sed -n '/= FAILURES =/,$p'
pass=$(grep -c ' PASSED' <<<"$out"); fail=$(grep -c ' FAILED' <<<"$out")
echo; echo "passed $pass, failed $fail"
exit $rc
