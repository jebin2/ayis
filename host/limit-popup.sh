#!/usr/bin/env bash
# Shows the cloud watchdog's hard-limit messages ON the streamed desktop, so a
# warning reaches someone mid-game who is not looking at a phone. Run every
# minute by limit-popup.timer.
#
# The watchdog already posts them to the ntfy topic (with the cost); this reads
# that topic back - no AWS access, nothing to keep in step. Only the watchdog's
# limit messages are shown: they are the ones tagged hourglass (a warning) or
# stop_sign (switching off). Off without AYIS_NTFY_URL, like every notification.
set -uo pipefail
[[ -n ${AYIS_NTFY_URL:-} ]] || exit 0
STATE="${LIMIT_POPUP_STATE:-/var/lib/ayis-limit-popup}"
SHOW="${LIMIT_POPUP_CMD:-}"
FETCH="${LIMIT_POPUP_FETCH:-curl -fsS -m 10}"

# Since the last message seen; the first run looks back 2 minutes, not at history.
since=$(cat "$STATE" 2>/dev/null || true)
[[ -n $since ]] || since=2m
# A protected topic is read with its token, as it is written with it.
auth=()
[[ -n ${AYIS_NTFY_TOKEN:-} ]] && auth=(-H "Authorization: Bearer $AYIS_NTFY_TOKEN")
# shellcheck disable=SC2086  # FETCH is a command line, split on purpose
body=$($FETCH "${auth[@]}" "${AYIS_NTFY_URL%/}/json?poll=1&since=$since" 2>/dev/null) || exit 0

# One line per message to show: id, title, message, all tab-separated.
msgs=$(printf '%s\n' "$body" | python3 -c '
import json, sys
for line in sys.stdin:
    try:
        m = json.loads(line)
    except ValueError:
        continue
    if m.get("event") != "message":
        continue
    tags = m.get("tags") or []
    show = "1" if ("hourglass" in tags or "stop_sign" in tags) else "0"
    clean = lambda s: (s or "").replace("\t", " ").replace("\n", " ")
    print("\t".join([m.get("id", ""), show, clean(m.get("title")), clean(m.get("message"))]))
' 2>/dev/null) || exit 0

last=""
while IFS=$'\t' read -r id show title message; do
  [[ -n $id ]] || continue
  last=$id
  [[ $show == 1 ]] || continue
  logger -t limit-popup "showing: $title" 2>/dev/null || true
  if [[ -n $SHOW ]]; then
    $SHOW "$title" "$message"
    continue
  fi
  uid=$(id -u ubuntu 2>/dev/null || echo "")
  [[ -n $uid ]] || continue
  sudo -u ubuntu DISPLAY=:0 DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
    notify-send -u critical -a "Ayis" "$title" "$message" 2>/dev/null || true
done <<< "$msgs"
[[ -z $last ]] || printf '%s\n' "$last" > "$STATE"
exit 0
