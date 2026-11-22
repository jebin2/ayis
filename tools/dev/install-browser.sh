#!/usr/bin/env bash
# Installs the headless Chromium the renderer's DOM suites (tests/*-dom.sh) load
# the app in, so they run on a developer's machine and not only in CI. About
# 150 MB, in Playwright's cache (~/.cache/ms-playwright); nothing goes into the app.
# tests/lib/browser.sh finds it there. A chromium already on PATH is used first.
set -euo pipefail
PLAYWRIGHT_VERSION=1.65.1
npx --yes "playwright@$PLAYWRIGHT_VERSION" install chromium-headless-shell
