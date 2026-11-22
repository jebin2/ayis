#!/usr/bin/env bash
# Lists the repository's shell scripts for ShellCheck: every tracked file whose
# first line is a bash or sh shebang, plus the bootstrap fragments, which have
# none because the build joins them into one script.
set -euo pipefail
cd "$(dirname "$0")/../.."
git ls-files -z | while IFS= read -r -d '' f; do
  case $f in app/node_modules/*|*.md) continue ;; esac
  [[ -f $f ]] || continue
  if [[ $f == lib/bootstrap.d/*.sh ]] || head -n 1 "$f" | grep -qE '^#!.*\b(bash|sh)\b'; then
    printf '%s\n' "$f"
  fi
done
