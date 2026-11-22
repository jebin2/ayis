# 0014. The archive expires, and errs towards keeping

- **Status:** Accepted
- **Date:** 2026-09 (recorded 2026-11-22)

## Context

With no machine, the S3 archive is the only charge left, and a forgotten one bills for ever. Deleting it is the one irreversible thing ayis does on its own.

## Decision

After `GAME_ARCHIVE_EXPIRY_DAYS` (14) with no machine, the cloud watchdog deletes the archive - only when two independent records agree it is unused (its last-seen mark and CloudTrail's launch history), and any error, gap or unreadable answer keeps it. A day before, it warns. 0 turns it off. Games kept with "Reset" are expired one by one.

## Consequences

A forgotten account stops billing on its own. After a long AWS outage the last-seen mark must be moved before the watchdog returns ([runbook](../runbooks/aws-account-suspended.md)). See [Flow 5](../architecture.md#flow-5---nobody-plays-for-two-weeks).
