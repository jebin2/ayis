# 0013. Spot machines terminate; on-demand ones stop

- **Status:** Accepted
- **Date:** 2026-09 (recorded 2026-11-22)

## Context

With the games in S3 there is nothing on a spot box worth keeping, and a stopped one-time spot box can never start again while its disk bills forever. An on-demand box stopped by mistake can simply be started.

## Decision

Spot (the default) is a one-time request whose shutdown is `terminate`; on demand (`GAME_SPOT=0`) shuts down to `stop`, and an on-demand box left stopped is deleted after the days games are kept.

## Consequences

Nothing is left billing after a spot session. A misfiring guard costs a rebuild on spot, a restart on demand.
