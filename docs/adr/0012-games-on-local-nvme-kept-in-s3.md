# 0012. Games on local NVMe, kept in S3 - and Proton is not

- **Status:** Accepted
- **Date:** 2026-09-13

## Context

A persistent EBS volume for the games cost INR 1,284 a month and pinned the machine to one availability zone. The instance store is the fastest disk on the box and free, but empty at every start.

## Decision

Games are installed on the local NVMe and archived to S3 per game; a new machine restores them. Steam's compatibility tools (Proton, the Steam runtime) are **not** archived: re-downloading them was measured at under a minute.

## Consequences

Any zone will do, and storage costs only what S3 charges. A first launch waits for the restore. See [game-library.md](../game-library.md).
