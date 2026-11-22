# 0004. A public ntfy topic by default, with a warning and an optional token

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Phone alerts go through ntfy. On the public server, ntfy.sh, a topic is readable by anyone who
knows its name. Since the hard limits (2026-11-20) the alerts carry costs - "This month: about
₹1,230 of your ₹5,000 budget" - so a leaked topic now leaks spending, not just "your game PC is
off". The options were: keep public topics with a warning; require an ntfy account and access
token; or require a self-hosted server.

## Decision

Keep a long random public topic as the default, and:

- support an **access token** (`GAME_NTFY_TOKEN`) for a protected topic on ntfy.sh or on your own
  server - sent by every sender and reader (the watchdog, the box, the in-game popup, the laptop);
- **warn on the Safety page** when the topic is a public ntfy.sh one with no token.

## Consequences

- Alerts still work with no sign-up, which is what makes people turn them on at all.
- Someone who learns the topic name can read alerts until a token is added. The name is random
  and is kept out of logs and `ayis config` output; `tests/secrets-guard.sh` blocks one in the repo.
- ₹0 either way. Revisit if alerts start carrying anything more sensitive than costs, or if ayis is
  used by people who would not read the warning.
