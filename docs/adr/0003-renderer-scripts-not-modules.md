# 0003. The renderer stays ordered scripts, with its shared scope checked

- **Status:** Accepted
- **Date:** 2026-11-22

## Context

The renderer was one 8,678-line `app.js`. P3 of the production readiness plan split it into
fourteen scripts loaded in order into one shared scope, and planned to convert those to ES
modules next. Measured before converting:

- **514 cross-file names** would each need an `import`.
- **28 top-level variables** were declared in one script and assigned in another
  (`statusNow` declared in `build.js`, set in `machine-card.js`). An imported binding is
  read-only, so each would need a setter or a state object - a change to every reader.
- The 19 browser suites (731 assertions) probe the page through its globals; modules hide them,
  so every probe would need rewriting at the same time as the code it checks.

What modules would add over a checked shared scope is mostly that the language enforces the
boundaries; the boundaries themselves can be checked.

## Decision

Keep the renderer as ordered classic scripts, and check what modules would have guaranteed:

- **One owner per name.** `tests/renderer-names.sh` fails on a name declared by two scripts
  (the later silently replaces the earlier - it had happened to `cell`), and on a name nothing uses.
- **Shared state is declared in one place.** Every top-level variable that more than one script
  writes lives in `app/renderer/js/state.js`, loaded first; the same test fails on a variable
  written by a script other than its own, unless `state.js` declares it.
- **Load order is safe.** Code that runs while a script loads may use only what earlier scripts
  declared; the split was cut by tracing that, and the browser suites load the real order.
- **Undefined names are errors.** ESLint reads every script's top-level names, so a typo is
  still `no-undef`.

## Consequences

- No build step, no bundler, and the browser suites keep working unchanged.
- A new page is a new script in `index.html`'s list; shared state goes in `state.js`.
- Revisit when a script needs to be reused outside this window (modules would then pay for
  themselves), or when the probes in the browser suites are rewritten anyway.
- Cost: none.
