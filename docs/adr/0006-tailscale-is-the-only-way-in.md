# 0006. Tailscale is the only way in

- **Status:** Accepted
- **Date:** before 2026-09 (recorded 2026-11-22)

## Context

A rented GPU box needs to be reached for SSH, the stream and Sunshine's web UI. Its public IP changes on every start, an Elastic IP bills, and every open port is something to defend.

## Decision

Every machine joins the person's tailnet and is reached at its `100.x` address. The security group's only inbound rule is UDP 41641, Tailscale's direct path; SSH, Sunshine and everything else answer on the tailnet only.

## Consequences

No Elastic IP to pay for and nothing on the box listening to the internet. Without the UDP rule Tailscale still works through a relay at 43-71 ms instead of 16 ms, and nothing errors - so `ayis status` lists the inbound rules and `ayis init` repairs a group missing it. Needs a Tailscale account; revisit if one stops being free for personal use.
