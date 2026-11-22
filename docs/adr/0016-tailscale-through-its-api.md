# 0016. Tailscale through its API

- **Status:** Accepted
- **Date:** 2026-09 (recorded 2026-11-22)

## Context

Every new box joins the tailnet under the host's name. Offline nodes of earlier boxes held that name, and node keys expiring after 180 days dropped a machine off the tailnet.

## Decision

With `TAILSCALE_API_KEY`, `ayis init` prunes offline nodes of earlier boxes before a launch and turns off key expiry on the new one. The new box is recognised by its node key, not its name. A rejected token turns both into manual steps rather than stopping the build.

## Consequences

Builds end with the box on the tailnet under its own name. The token is optional; without it a person removes old nodes by hand. See [Flow 1](../architecture.md#flow-1---ayis-init-build-a-box).
