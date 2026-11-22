// ESLint for the desktop app (docs/plans/production-readiness.md, P0).
// Report-only in CI until today's findings are fixed; then it blocks.
import globals from 'globals';

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
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser } },
    rules,
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
