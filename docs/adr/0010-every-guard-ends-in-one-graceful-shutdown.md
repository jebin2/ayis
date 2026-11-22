# 0010. Every guard ends in the same graceful shutdown

- **Status:** Accepted
- **Date:** 2026-09 (recorded 2026-11-22)

## Context

Games live on instance storage that vanishes with the machine. Whatever ends the machine - a watchdog, a limit, a person - must give the box the chance to save them, and two saves at once once rewrote the archive's index from a stale copy.

## Decision

Every guard stops or terminates through the API, which gives the OS its shutdown; the shutdown service mirrors the games with up to 30 minutes (`TimeoutStopSec=1800`). A machine still going down an hour later is forced, whichever guard started it. `ayis-library push` takes a lock, so a second push waits and resumes from what the first landed. The limits that drive it are in the table under "Where the limits come from".

## Consequences

One path to test and to reason about. A shutdown can take up to an hour of billed time in the worst case - accepted, since a lost save costs a re-download measured in hours.
