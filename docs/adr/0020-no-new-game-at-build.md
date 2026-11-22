# 0020. No new game at build time

- **Status:** Accepted
- **Date:** 2026-10-18

## Context

A design let a person sign in to Steam in the app, list owned games and install a new one during the build. A Steam website sign-in can list owned games, but cannot sign in the Steam app on the machine - Steam issues different tokens to each - so a first build would still need a QR scan or a sign-in over the stream.

## Decision

Dropped after several design rounds; nothing was built. Games are chosen from the archive at Play, and a new game is installed in Steam on the running machine.

## Consequences

Less to build and nothing that holds a Steam credential in the app. Start from the facts above if it comes back.
