# The headless browser the DOM suites load the app in. Sourced, not run.
#
# find_browser prints the first that exists: $AYIS_CHROMIUM, a chromium or chrome
# on PATH (CI has one), then the headless shell tools/dev/install-browser.sh puts
# in Playwright's cache. Prints nothing when there is none.
find_browser() {
  if [[ -n ${AYIS_CHROMIUM:-} && -x $AYIS_CHROMIUM ]]; then printf '%s\n' "$AYIS_CHROMIUM"; return; fi
  local b
  for b in chromium chromium-browser google-chrome-stable google-chrome; do
    if command -v "$b" >/dev/null; then printf '%s\n' "$b"; return; fi
  done
  # The suites point HOME at a scratch folder, so the cache is found from the
  # account's real home.
  local home
  home=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)
  for b in "${PLAYWRIGHT_BROWSERS_PATH:-${home:-$HOME}/.cache/ms-playwright}"/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell; do
    if [[ -x $b ]]; then printf '%s\n' "$b"; return; fi
  done
}
