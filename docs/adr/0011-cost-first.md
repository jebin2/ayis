# 0011. Cost first: design out what would bill

- **Status:** Accepted
- **Date:** 2026-09-15

## Context

ayis spends the person's own money. Small charges added "because they are small" add up, and surprise the person who did not ask for them.

## Decision

Everything around the box fits inside AWS's free allowances, and anything that would bill is designed out rather than accepted: archive marks are free SSM parameters, not bucket tags; the archive's size comes from S3's free daily metric, not a request. With no box, the S3 archive is the only charge ayis means to leave; `ayis cost` names any leftover with its monthly cost. Every new feature that touches AWS comes with its cost - even "$0" - before it is built.

## Consequences

Some designs are less direct than they could be. The rule is checked by habit and by the cost section of every plan.
