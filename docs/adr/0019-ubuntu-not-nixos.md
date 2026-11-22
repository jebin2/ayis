# 0019. The box runs Ubuntu, not NixOS

- **Status:** Accepted
- **Date:** 2026-09-09

## Context

NixOS was evaluated for the box. Of the nine build failures documented then, it would have prevented about four (a package URL, unit naming, install ordering, half-built state); the other five were AWS-level (quotas, account plan, alarm arming, latency) and unaffected by the OS. NixOS images exist in the regions used.

## Decision

Stay on Ubuntu 24.04 with the bootstrap modules in `lib/bootstrap.d`. Headless X would still need a hand-written `AllowEmptyInitialConfiguration` section under NixOS.

## Consequences

The build works and is tested. Revisit only if rebuilding from scratch becomes frequent, if the machine definition needs versioning, or if half-built-state failures return.
