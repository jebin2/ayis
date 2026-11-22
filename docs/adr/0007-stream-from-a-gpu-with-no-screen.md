# 0007. Stream from a GPU that has no screen

- **Status:** Accepted
- **Date:** 2026-09 (recorded 2026-11-22)

## Context

The L4 has no display outputs, NvFBC capture failed after the first session on this box, switching the X mode at runtime left capture broken for every later session, and Tailscale's 1280 MTU fragments Sunshine's default packets into stutter.

## Decision

X starts with `AllowEmptyInitialConfiguration` and a virtual `DFP-0` fixed at 1920x1080; LightDM logs in so there is a desktop. The resolution never changes - Moonlight scales. Capture is X11 (CPU, about one core at 1080p60) with NVENC encoding. Sunshine runs with `packet_size = 1024` and `csrf_allowed_origins` set for the tailnet.

## Consequences

Streams start reliably every session, at the cost of a CPU core for capture and no native resolutions other than 1080p. Revisit if NvFBC becomes reliable on this driver, or if a type with display outputs is used. Details: [streaming.md](../streaming.md).
