#!/usr/bin/env bash
# The documentation holds together: every key decision in docs/architecture.md
# links to its ADR, every ADR is in the index, and no relative link in the docs
# points at a file that is not there.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
pass=0; fail=0
ok()  { echo "  ok   $1"; pass=$((pass+1)); }
bad() { echo "  FAIL $1"; fail=$((fail+1)); }

echo "1. every key decision links to its ADR"
missing=$(sed -n '/^## Key decisions/,/^## Go deeper/p' docs/architecture.md | grep '^- \*\*' | grep -v 'adr/' || true)
n=$(sed -n '/^## Key decisions/,/^## Go deeper/p' docs/architecture.md | grep -c '^- \*\*')
if [[ -z $missing && $n -gt 10 ]]; then ok "all $n of them"; else bad "without an ADR: $missing"; fi

echo "2. every ADR is in the index, and the index names no missing one"
for f in docs/adr/[0-9]*.md; do
  b=$(basename "$f")
  if grep -q "($b)" docs/adr/README.md; then ok "$b"; else bad "$b is not in docs/adr/README.md"; fi
done

echo "3. no relative link in the docs is broken"
broken=$(python3 -I - <<'PY'
import pathlib, re
roots = [pathlib.Path(p) for p in ("README.md", "SECURITY.md", "CONTRIBUTING.md")] + list(pathlib.Path("docs").rglob("*.md"))
bad = []
for f in roots:
    if not f.exists() or "archive" in f.parts or "mockups" in f.parts or f.name == "template.md":
        continue
    text = re.sub(r"```.*?```", "", f.read_text(), flags=re.S)
    for target in re.findall(r"\]\(([^)\s]+)\)", text):
        if re.match(r"[a-z]+:", target) or target.startswith("#"):
            continue
        path = target.split("#", 1)[0]
        if path and not (f.parent / path).exists():
            bad.append(f"{f}: {target}")
print("\n".join(bad))
PY
)
if [[ -z $broken ]]; then ok "every link resolves"; else bad "broken links:"; printf '        %s\n' "$broken"; fi

echo; echo "docs: $pass passed, $fail failed"; [[ $fail -eq 0 ]]
