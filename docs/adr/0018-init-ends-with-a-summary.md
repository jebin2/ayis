# 0018. `ayis init` ends with a summary, not chores

- **Status:** Accepted
- **Date:** 2026-10 (recorded 2026-11-22)

## Context

Early builds ended with a list of steps for the person - pair Moonlight, turn off key expiry, check the login - most of which a program could do.

## Decision

Pairing and key expiry happen on their own. The build ends with what the box has - the Steam login and the games, checked on the box itself - and lists a step only when one is genuinely left. The Sunshine password is never printed.

## Consequences

A build is done when it says so. Anything still manual is named, not buried in a list.
