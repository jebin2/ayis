# The renderer's scripts, for the suites that read or load them. Sourced, not run.
#
# The order is index.html's own <script src="js/..."> list - the one place it is
# written - so a test reads the code exactly as the window loads it.
#
#   renderer_files     prints app/renderer/js/*.js in load order
#   renderer_all       prints a file holding all of them joined, in that order
#                      (made once per run; tests grep it as they grepped app.js)
#   renderer_stub_html <index.html> <stub.js>   rewrites a copy of index.html so
#                      the stub loads before the renderer's first script
renderer_files() {
  local root=${1:-app/renderer}
  grep -oE '<script src="js/[a-z0-9-]+\.js"' "$root/index.html" | sed -E 's#<script src="(js/[^"]+)"#'"$root"'/\1#'
}

renderer_all() {
  if [[ -z ${RENDERER_ALL:-} || ! -s $RENDERER_ALL ]]; then
    # Named by its content, so every call in a run - and the next run, if the code
    # has not changed - shares one file instead of leaving one per call.
    local sum
    # shellcheck disable=SC2046
    sum=$(cat $(renderer_files) | sha256sum | cut -c1-16)
    RENDERER_ALL="${TMPDIR:-/tmp}/ayis-renderer-$sum.js"
    # shellcheck disable=SC2046
    [[ -s $RENDERER_ALL ]] || cat $(renderer_files) > "$RENDERER_ALL"
    export RENDERER_ALL
  fi
  printf '%s\n' "$RENDERER_ALL"
}

# Made now, in the sourcing shell, so $(renderer_all) in a subshell finds it.
renderer_all >/dev/null
