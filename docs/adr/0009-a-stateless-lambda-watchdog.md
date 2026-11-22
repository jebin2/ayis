# 0009. The cloud watchdog is a stateless Lambda

- **Status:** Accepted
- **Date:** 2026-09 (recorded 2026-11-22)

## Context

A guard outside the box is needed because the on-host one dies with it. The first was a watchdog on an always-on VPS, which needed a long-lived AWS key and a second machine to keep alive.

## Decision

An AWS Lambda run every 5 minutes on an IAM role. Its idle decision keeps no state: every run reads the last 30 minutes of metrics instead of counting checks, so a missed or repeated run cannot corrupt a counter and a dry run (`ayis watchdog check`) changes nothing. What it must remember - the archive's last-seen mark, notices already sent, its last good run - is a free SSM parameter or an instance tag. Since P4 it is a Python package with its own tests; since P9 a deploy can be rolled back.

## Consequences

No key to leak and no machine to keep up; it costs nothing inside the free tier. Its log text is what `ayis watchdog` and the app read. Revisit if a decision ever needs history the metrics cannot give.
