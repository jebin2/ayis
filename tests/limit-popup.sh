#!/usr/bin/env bash
# host/limit-popup.sh: the watchdog's limit messages, read back from the ntfy
# topic and shown on the streamed desktop - those only, each once.
set -uo pipefail
cd "$(dirname "$0")/.."
pass=0; fail=0
check() { if [[ $2 == "$3" ]]; then echo "  ok   $1"; pass=$((pass+1));
          else echo "  FAIL $1: got '$2' want '$3'"; fail=$((fail+1)); fi; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cat > "$T/fetch" <<'F'
#!/usr/bin/env bash
echo "$*" >> "$(dirname "$0")/asked"
cat "$(dirname "$0")/topic"
F
cat > "$T/show" <<'F'
#!/usr/bin/env bash
printf '%s | %s\n' "$1" "$2" >> "$(dirname "$0")/shown"
F
chmod +x "$T/fetch" "$T/show"
run() { AYIS_NTFY_URL=https://ntfy.example/t LIMIT_POPUP_STATE="$T/state" LIMIT_POPUP_FETCH="$T/fetch" \
        LIMIT_POPUP_CMD="$T/show" bash host/limit-popup.sh; }
cat > "$T/topic" <<'J'
{"id":"a1","event":"open"}
{"id":"m1","event":"message","title":"ayis: Gam finished downloading","message":"x","tags":["video_game"]}
{"id":"m2","event":"message","title":"Game PC switches off in 30 minutes","message":"This session reaches its time limit. This session: about ₹40 so far.","tags":["hourglass"]}
{"id":"m3","event":"message","title":"Session time limit reached","message":"Switching off.","tags":["stop_sign"]}
J
run
check "the limit messages, and only them" "$(cat "$T/shown")" $'Game PC switches off in 30 minutes | This session reaches its time limit. This session: about ₹40 so far.\nSession time limit reached | Switching off.'
check "the first look is 2 minutes back" "$(head -1 "$T/asked")" "https://ntfy.example/t/json?poll=1&since=2m"
check "remembers the last message" "$(cat "$T/state")" "m3"
: > "$T/topic"; : > "$T/shown"
run
check "the next look starts after it" "$(tail -1 "$T/asked")" "https://ntfy.example/t/json?poll=1&since=m3"
check "nothing new, nothing shown" "$(cat "$T/shown")" ""
check "  and the place is kept" "$(cat "$T/state")" "m3"
: > "$T/asked"
AYIS_NTFY_URL= LIMIT_POPUP_FETCH="$T/fetch" bash host/limit-popup.sh
check "no topic: off" "$(cat "$T/asked")" ""
check "the installer puts the timer on" "$(grep -c 'enable --now limit-popup.timer' host/install-watchdog.sh)" "1"
check "  and the service loads the notify settings" "$(grep -c 'EnvironmentFile=-/etc/ayis-notify.conf' host/limit-popup.service)" "1"
echo "limit-popup: $pass passed, $fail failed"; [[ $fail -eq 0 ]]
