# 0001. Record decisions as ADRs

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Ayis's standing decisions - Ubuntu over NixOS, no CloudWatch alarm, Proton not mirrored, the
box found by its tag, hard limits enforced by the watchdog - live in prose inside
`docs/architecture.md`, in commit messages, and in memory. A new contributor, or a later us,
cannot tell what was decided on purpose from what just happened, and so re-proposes settled
questions.

## Decision

Every decision that shapes the code, the AWS footprint or the cost is recorded in
`docs/adr/NNNN-title.md` from the [template](template.md), the day it is made. Records are
append-only: a reversal is a new record that supersedes the old one.

## Consequences

- A settled question has a link to answer it with.
- `docs/architecture.md` explains how things work and links here for why.
- The existing decisions are back-filled in P10 of the
  [production readiness plan](../plans/production-readiness.md).
- Cost: none.
