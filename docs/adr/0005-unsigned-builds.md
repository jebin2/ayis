# 0005. macOS and Windows builds stay unsigned for now

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

Signing removes the "unknown developer" warning: an Apple Developer ID costs about $99 a year, a
Windows code-signing certificate roughly $200-400 a year. ayis is in beta and used by its owner;
the Linux AppImage, its main build, needs no signing.

## Decision

Stay unsigned. Every release says so, and instead carries `SHA256SUMS` and GitHub build provenance
attestations, which are free and let anyone check a file came from this repository's workflow.

## Consequences

- ₹0 a year. macOS (Gatekeeper) and Windows (SmartScreen) warn on first launch.
- Provenance proves where a file came from, not that the OS trusts it.
- Revisit before a release meant for people other than the owner.
