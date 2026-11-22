# 0022. Hard limits are enforced by the cloud watchdog

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

Idle guards end a machine nobody uses. Cost also needs a ceiling for a machine somebody *is* using - a session left running overnight, a month that ran long - that does not depend on anybody remembering to stop.

## Decision

The cloud watchdog enforces three limits on a running machine, busy or not: the month's hours (`GAME_MAX_HOURS_MONTH`), one session's length (`GAME_MAX_SESSION_HOURS`), and a spent AWS budget (its deny policy attached). It warns 30 minutes before, with what the session and month have cost, and ends the machine the same graceful way ([ADR-0010](0010-every-guard-ends-in-one-graceful-shutdown.md)). Extending is a person's choice from the app.

## Consequences

The bill has a ceiling even when the laptop is closed. A limit can end a game in progress - which is the point, and why it warns first. See [cost-guards.md](../cost-guards.md#hard-limits).
