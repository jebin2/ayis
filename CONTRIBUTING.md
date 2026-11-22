# Contributing

ayis is a Go program (`cmd/ayis`, `internal/`), an Electron app that runs it (`app/`), a Python
Lambda it deploys (`lambda/ayis_watchdog`), and the scripts it sends to the machine (`host/`,
`lib/bootstrap.d`). How they fit: [docs/architecture.md](docs/architecture.md). Why they are the
way they are: [docs/adr](docs/adr/README.md).

## Set up

| Tool | Version | For |
|---|---|---|
| Go | as `go.mod` says (1.27) | `ayis` and its tests |
| Node.js | 20 or later | the app, ESLint |
| Python | 3.10 or later, with `pip install pytest==9.1.1` | the watchdog's tests (the Lambda runs 3.13) |
| A headless Chromium | `tools/dev/install-browser.sh` (Playwright's, ~150 MB, once) | the app's browser suites |
| Linters | `golangci-lint` v2.15.0, `ruff` 0.17.6, `mypy` 2.4.1, `shellcheck-py` 0.11.0.1 | as CI runs them (`.github/workflows/lint.yml`) |

    go build -o ayis ./cmd/ayis          # the CLI
    cd app && npm ci && npm start        # the app (builds ayis and the stylesheet first)

## Test

    bash tests/run-all.sh                # everything CI runs: go test, every suite, browser ones included

It builds `ayis`, runs `go test ./...`, then every `tests/*.sh` suite in parallel, and exits non-zero
if any fails. Nothing touches AWS: the suites use fakes, and set `AYIS_NO_ACCOUNT_SYNC=1` and
`AYIS_NO_KEYCHAIN=1` so no test reaches a real account or the system keychain. One part at a time:

    go test ./internal/...               # the Go packages
    bash tests/watchdog.sh               # the cloud watchdog (pytest)
    bash tests/guards-dom.sh             # one browser suite
    bash tests/docs.sh                   # links, and every key decision has its ADR

What a test may and may not do is in [docs/testing.md](docs/testing.md). The budgets the tests hold
the code to - AWS round trips, package size - are in [docs/performance.md](docs/performance.md).

## Lint

    golangci-lint run ./...  &&  (cd app && npx eslint .)  &&  ruff check  &&  mypy --strict --ignore-missing-imports lambda/ayis_watchdog

Python is clean and blocks CI; Go, JavaScript and shell report their findings while the old ones are
fixed - new code should add none.

## Change

- **Work on a branch.** Every push to any branch runs the tests, the linters and gitleaks. `main`
  moves by fast-forward to a branch whose CI passed.
- **Commits** say what changed and why, in plain words: a short subject, then a body for anything
  a later reader would ask about. A fix names the failure it fixes.
- **A decision** - something someone might reasonably want to undo - gets an ADR in `docs/adr/`
  ([how](docs/adr/0001-record-decisions.md)).
- **Anything that touches AWS** comes with what it costs, even "$0" ([ADR-0011](docs/adr/0011-cost-first.md)).
- **Never commit a secret or a personal detail.** gitleaks scans every push's history;
  `tests/secrets-guard.sh` checks key shapes, and the owner's own identifiers through the
  `GUARD_EXTRA` repository secret. Tests use the fake values listed in `.gitleaks.toml`.

## Release

[docs/runbooks/release.md](docs/runbooks/release.md): push a `v*` tag; CI builds, checks and drafts
the release; you press Publish.

## Report a security problem

Privately - see [SECURITY.md](SECURITY.md).
