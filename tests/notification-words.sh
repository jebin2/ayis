#!/usr/bin/env bash
# The phone messages are for a person, not for a log: no instance ids, setting
# names, AWS service names or commands in what ntfy shows. The log lines beside
# each call keep all of that.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
BAD='S3|EC2|GAME_[A-Z_]+|instance|mirror|\bayis (init|destroy|check|open)|\bi-[0-9a-f]|OS shutdown|compute'

# The cloud watchdog's own messages are checked by lambda/tests/test_words.py
# (tests/watchdog.sh), against the same words.
echo "1. host scripts: every notify call"
for f in host/idle-watchdog.sh host/ayis-shutdown-push.sh; do
  if grep -E '^\s*(\[\[.*\|\| )?notify ' -A1 "$f" | grep -E "$BAD"; then
    echo "  FAIL $f"; fail=1
  else echo "  ok   $f"; fi
done
# The game-ready notice calls the notifier directly, not through notify().
if grep -E '"\$NOTIFY" ' host/game-notify.sh | grep -E "$BAD"; then
  echo "  FAIL host/game-notify.sh"; fail=1
else echo "  ok   host/game-notify.sh"; fi
exit $fail
