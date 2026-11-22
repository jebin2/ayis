#!/usr/bin/env bash
# The renderer's top-level names, across all of its scripts: one that nothing
# uses is dead code; one declared twice silently replaces the first; and a
# variable changed by a script other than its own is shared state, which lives
# in state.js. ESLint sees one file at a time, so this looks at them together.
set -uo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=tests/lib/renderer.sh
source tests/lib/renderer.sh
[[ -d app/node_modules/espree ]] || { echo "  (no app/node_modules - skipped)"; echo "renderer-names: 0 passed, 0 failed"; exit 0; }
out=$(node - "$PWD/app/node_modules/espree" app/renderer/index.html $(renderer_files) <<'JS'
const fs = require('fs');
const espree = require(process.argv[2]);
const html = fs.readFileSync(process.argv[3], 'utf8');
const files = process.argv.slice(4);
const declared = new Map(), used = new Map(), mutable = new Set(), written = [];
function walk(n, f) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) { n.forEach(x => walk(x, f)); return; }
  f(n);
  for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'range' && k !== 'parent') walk(n[k], f);
}
const twice = [];
for (const file of files) {
  const ast = espree.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 2023, loc: true });
  const top = new Set();
  for (const n of ast.body) {
    const names = n.type === 'FunctionDeclaration' ? [n.id] : n.type === 'VariableDeclaration' ? n.declarations.map(d => d.id).filter(i => i.type === 'Identifier') : [];
    if (n.type === 'VariableDeclaration' && n.kind !== 'const') names.forEach(id => mutable.add(id.name));
    for (const id of names) {
      if (declared.has(id.name)) twice.push(`${id.name} (${declared.get(id.name)} and ${file})`);
      declared.set(id.name, file); top.add(id);
    }
  }
  walk(ast, n => {
    const target = n.type === 'AssignmentExpression' ? n.left : n.type === 'UpdateExpression' ? n.argument : null;
    if (target && target.type === 'Identifier') written.push([target.name, file]);
    if (n.type === 'Identifier' && !top.has(n)) used.set(n.name, (used.get(n.name) || 0) + 1);
    if (n.type === 'MemberExpression' && !n.computed) n.property.__prop = true;
  });
}
const unused = [...declared.keys()].filter(k => !used.has(k) && !html.includes(k));
// A variable is changed only by the script that declares it - or it is shared
// state, and declared in state.js where every page can see who may change it.
const strays = [...new Set(written
  .filter(([name, file]) => mutable.has(name) && declared.get(name) !== file && !declared.get(name).endsWith('/state.js'))
  .map(([name, file]) => `${name} (${declared.get(name).split('/').pop()}, written by ${file.split('/').pop()})`))];
console.log(JSON.stringify({ declared: declared.size, twice, unused, strays }));
JS
)
pass=0; fail=0
check() { if [[ $2 == "$3" ]]; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1: got '$2' want '$3'"; fail=$((fail+1)); fi; }
n=$(node -pe "JSON.parse(process.argv[1]).declared" "$out")
check "the scripts declare the renderer's names (found $n)" "$((n > 300))" "1"
check "no name is declared by two scripts" "$(node -pe "JSON.parse(process.argv[1]).twice.join(', ')" "$out")" ""
check "every top-level name is used somewhere" "$(node -pe "JSON.parse(process.argv[1]).unused.join(', ')" "$out")" ""
check "shared state is declared in state.js" "$(node -pe "JSON.parse(process.argv[1]).strays.join(', ')" "$out")" ""
echo "renderer-names: $pass passed, $fail failed"; [[ $fail -eq 0 ]]
