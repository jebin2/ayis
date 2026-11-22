#!/usr/bin/env bash
# The release notes for a tag: the fixed text every release says
# (.github/release-body.md), then one line per commit since the previous tag -
# the subject only, newest first. This repository is worked on without pull
# requests, so GitHub's own notes (which list PRs) would be empty.
#
#   tools/ci/release-notes.sh v0.1.0-beta.4 > release.md
set -euo pipefail
cd "$(dirname "$0")/../.."
tag=${1:?usage: release-notes.sh <tag>}
cat .github/release-body.md
prev=$(git describe --tags --abbrev=0 "${tag}^" 2>/dev/null || true)
echo
if [[ -n $prev ]]; then
  echo "## Changes since $prev"
  range="$prev..$tag"
else
  echo "## Changes"
  range=$tag
fi
echo
git log --no-merges --format='- %s' "$range"
