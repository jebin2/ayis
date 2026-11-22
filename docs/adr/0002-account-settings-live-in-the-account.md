# 0002. Account settings live in the account

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Every setting lived in each computer's `.env`. But several settings describe things there is
only one of - the AWS account's budget, its hard limits, its alert topic, its watchdog - and the
watchdog was deployed from whichever computer last ran `ayis config set` or `ayis watchdog
install`. On 2026-11-22 a laptop showed a 6-hour session limit and phone alerts off while the
deployed watchdog had a 1-hour limit and a topic: saving any setting on the laptop would have
silently switched the phone alerts off.

## Decision

Settings are split in `internal/config/scope.go`:

- **Account settings** (budget, hour limits, ntfy topic, alert emails, idle and watchdog
  timings, archive expiry, machine type, purchase model, disk sizes, Steam sign-in) are kept in
  the account, as SSM standard parameters under `/ayis/<host>/config/<KEY>` in the settings'
  region. The account is the truth; `.env` keeps a copy.
- **Local settings** (the region - read before AWS can be asked anything - the stream's
  resolution, fps, bitrate and clipboard, and the Tailscale API token) stay on the computer.

Commands that read account settings (`init`, `open`, `stop`, `destroy`, `status`, `config`,
`watchdog`, `watcher`, `limits`, `library`, `disk`) sync first: values in the account come down;
values only this computer has go up (the first run moves `.env` into the account); a value
changed while AWS was unreachable is kept as pending (`AYIS_PENDING_SHARE` in `.env`) and goes up
at the next sync instead of being overwritten. `ayis config set` writes to the account first.

## Consequences

- Two computers can no longer deploy different watchdogs or build different boxes.
- Cost: none. Standard parameters and their API calls are free; a sync is one
  `GetParametersByPath` call, about 0.1–0.3 s, and is skipped when AWS cannot be reached.
- The first computer to sync a setting wins it; later ones adopt it and say so.
- Tests must never reach a real account: `tests/run-all.sh` sets `AYIS_NO_ACCOUNT_SYNC=1`.
- Revisit if settings ever need to differ per computer on purpose - that would be a local
  setting, not an exception to this rule.
