# 0015. Roles, not keys

- **Status:** Accepted
- **Date:** 2026-09 (recorded 2026-11-22)

## Context

The box and the watchdog both need AWS access. A key copied onto them could be read from their disks or their logs, and lives until someone rotates it.

## Decision

The box reads and writes its bucket through an instance role; the cloud watchdog runs on a Lambda role allowed only what it does - describe, tag, stop or terminate the instance tagged with the host, tag it only with its own keys, its own marks and the archive buckets. The person's key stays on their computer; `ayis aws policy` (P6) prints the least it needs.

## Consequences

No long-lived secret leaves the laptop. The watchdog's role is checked against its code by a test. See [cost-guards.md](../cost-guards.md).
