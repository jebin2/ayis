// ESLint for the desktop app (docs/plans/production-readiness.md, P0).
// Report-only in CI until today's findings are fixed; then it blocks.
import fs from 'node:fs';
import * as espree from 'espree';
import globals from 'globals';

// The renderer is one scope split over the scripts index.html loads in order, so
// each script may use what the others declare at the top level. Those names are
// read from the scripts themselves - a typo is still an undefined name.
const order = [...fs.readFileSync(new URL('./renderer/index.html', import.meta.url), 'utf8')
  .matchAll(/<script src="(js\/[a-z0-9-]+\.js)"/g)].map(m => m[1]);
const shared = {};
for (const f of order) {
  const ast = espree.parse(fs.readFileSync(new URL('./renderer/' + f, import.meta.url), 'utf8'), { ecmaVersion: 2023 });
  for (const n of ast.body) {
    if (n.type === 'FunctionDeclaration') shared[n.id.name] = 'writable';
    if (n.type === 'VariableDeclaration') for (const d of n.declarations) if (d.id.type === 'Identifier') shared[d.id.name] = 'writable';
  }
}

const rules = {
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
  'no-undef': 'error',
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': 'warn',
  // Today's worst function sets the ceiling; it only goes down (goal: 25).
  complexity: ['warn', 60],
  'max-lines': ['warn', { max: 1500, skipBlankLines: true, skipComments: true }],
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'renderer/tailwind.css'] },
  {
    files: ['renderer/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser, ...shared } },
    // Declaring a shared name is what each script is for, not a redeclaration.
    // A top-level name is used by the other scripts, which ESLint cannot see one
    // file at a time: tests/renderer-names.sh checks those across the whole renderer.
    rules: { ...rules, 'no-redeclare': ['error', { builtinGlobals: false }],
      'no-unused-vars': ['warn', { vars: 'local', args: 'none', caughtErrors: 'none' }] },
  },
  {
    files: ['main/**/*.js', 'scripts/**/*.js', '*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules,
  },
  {
    files: ['test/**/*.mjs', '*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules,
  },
];
