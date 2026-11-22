# 0021. The box is found by its tag, not by `.env`

- **Status:** Accepted
- **Date:** 2026-11 (recorded 2026-11-22)

## Context

`.env` can be out of date: written on another computer, lost when a build was stopped, or edited by hand. A command that trusted its instance id could launch a second billing machine, or delete the wrong one.

## Decision

Everything ayis makes carries the `ayis:host=<host>` tag, and every command finds its machines, images, snapshots and disks by that tag (`internal/ec2find`), never by a Name alone and never by `.env` alone. `.env`'s instance id is a hint.

## Consequences

A build stopped part way is finished by the next one with no second machine (tested in P5); a destroy finds leftovers another computer made. Anything created by hand without the tag is left alone - and said.
