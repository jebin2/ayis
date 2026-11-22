# 0017. Notifications are never load-bearing

- **Status:** Accepted
- **Date:** 2026-09-15

## Context

Phone alerts are useful, but a guard that waits on one, or fails because one failed, is a guard that does not guard.

## Decision

ntfy is optional. A send that fails is logged and ignored, and no decision depends on one. "The box is gone" comes from EC2's own state-change events, since the box cannot report its own end. The topic is treated as a secret ([ADR-0004](0004-public-ntfy-topic-by-default.md)).

## Consequences

Alerts can be turned off without weakening anything. A missed alert is possible and accepted.
