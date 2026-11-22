# Production readiness plan

Status: **proposed** - nothing here is started. Branch: `production-plan`.

This plan takes Ayis from "works well for its author" to a codebase that strangers can install,
trust with an AWS account, and that other people can change safely. It is not a rewrite and not
a reshuffle of folders: every phase fixes a measured weakness, ships on its own, and ends with a
check that can be run, not a feeling.

---

## 1. What "production-ready" means for Ayis

Ayis is not a web service. It is three programs that run in three places and must agree:

| Part | Where it runs | Size today |
|---|---|---|
| `ayis` CLI (Go) | the user's laptop | ~30,300 lines + ~16,000 lines of tests, 57 packages |
| Desktop app (Electron) | the user's laptop | `app/renderer/app.js` is **one file of 8,678 lines**, 290 functions |
| Cloud watchdog (Python Lambda) | the user's AWS account | `lambda/cloud_watchdog.py`, **one file of 1,312 lines** (P4: a package of twelve files) |
| Box scripts (Bash) | the rented GPU machine | `host/` and `lib/bootstrap.d/`, ~40 scripts |

So each of the twelve goals is defined here in terms that fit a single-user desktop tool that
spends real money in someone else's AWS account. "Metrics" does not mean Prometheus; "tracing"
does not mean Jaeger. Section 4 maps each goal to a check that proves it.

**Non-goals.** No server of our own, no multi-tenant backend, no Kubernetes, no rewrite into a
new framework, and no new paid AWS service unless its cost is discussed and agreed first.

## 2. Baseline (measured 2026-11-22)

Strengths to keep - these are already production-grade and the plan must not regress them:

- The CLI is the single source of truth; the app only runs `ayis ... --json` and draws it.
- A frozen JSON contract (`testdata/contract/contract.json`) between CLI and app.
- Electron is hardened: `contextIsolation`, `sandbox`, no `nodeIntegration`, a CSP, navigation
  and new windows denied.
- Cost guards in four layers, now with hard limits; every AWS feature had its cost discussed.
- 47 shell suites + Go tests run in CI on every push to main and every PR; `govulncheck` and
  `npm audit` weekly; Dependabot on.
- A settings registry (`internal/config/registry.go`) with defaults, bounds and labels.

Weaknesses, with evidence:

| # | Finding | Evidence |
|---|---|---|
| W1 | **Settings live per laptop, but the watchdog is shared.** Two laptops deploy the same Lambda with different values; the last to save wins. | Found live on 2026-11-22: laptop said 6 h and "phone alerts off", the deployed watchdog had 1 h and a topic. |
| W2 | The renderer is one 8,678-line file. | `wc -l app/renderer/app.js` |
| W3 | App tests mostly assert that text exists in the source, not behaviour. | `tests/app.sh`: 424 `grep`-style checks; DOM suites run only in CI. |
| W4 | AWS access is re-implemented per command. | `DescribeInstances(` in 16 non-test files; 35 hand-written client interfaces. |
| W5 | Uneven test coverage. | Total 65.2%; `cmd/ayis` 0%, `internal/box` 3.6%, `limitscmd` 3.6%, `laptop` 9.2%, `commands/watchdog` 16.4%. |
| W6 | No linters for any language. | No golangci-lint, ESLint or Ruff config; only `gofmt`/`go vet`. |
| W7 | CI does not run on branch pushes. | `test.yml` triggers: main, pull_request, manual. A branch was pushed red twice today. |
| W8 | Nobody is told if the watchdog itself fails. | Lambda errors appear only in `ayis watchdog`; the CloudWatch alarm was removed on purpose. |
| W9 | No way to follow one action across laptop → CLI → box → Lambda. | Logs are per program, with no shared id. |
| W10 | Secrets at rest are plain text, and the ntfy topic is a bearer secret that now carries cost figures. | `.env`; `ntfy.sh/<topic>` readable by anyone who knows the topic. |
| W11 | macOS and Windows builds are unsigned. | Release notes say so. |
| W12 | Decisions are buried in prose; old plans sit next to live docs. | `docs/architecture.md` "Key decisions"; `go-plan.md`, `rename-ayis-plan.md`, `own-machine-plan.md` are finished work. |
| W13 | The Lambda's tests are Python embedded in Bash heredocs. | `tests/hard-limits.sh`, `tests/lambda-watchdog.sh`. **Fixed in P4.** |
| W14 | Repository clutter. | `stitch_design/` (mock-ups) and `ayis.md` tracked at the root. |

## 3. Principles for every phase

1. **Ship each phase on its own branch, green CI, then merge on request.** No big-bang branch.
2. **Behaviour first.** A refactor starts by adding the test that pins today's behaviour.
3. **Cost before code.** Any change to what runs in AWS states its monthly cost (even ₹0).
4. **Measure, then optimise.** Performance work starts from a recorded number.
5. **One owner per fact.** A setting, a price, an AWS lookup: defined once, imported everywhere.
6. **A decision gets an ADR** in `docs/adr/` the day it is made.

---

## 4. The twelve goals, and how we will know each is met

| Goal | Done when (each is checkable) | Phase |
|---|---|---|
| Well-defined architecture and structure | `docs/architecture.md` has a module map; an import-rule test fails the build if a package crosses a boundary (§P2) | P2, P10 |
| Clean, modular, reusable code | No source file over 1,500 lines (renderer and Lambda included); one AWS lookup per concern; duplicate-code check in lint | P2, P3, P4 |
| Separation of concerns, module boundaries | Layer rule enforced by test: `cmd` → `commands` → domain → `aws` adapters; domain never imports `commands`; renderer pages never call each other | P2, P3 |
| Scalability, maintainability, extensibility | Adding a new cloud action or app page touches one module plus its test; shown by doing it once (the config sync in P1) | P1–P3 |
| Error handling and resilience | Every AWS call has a deadline and the shared retry policy; errors are classified (yours to fix / try again / bug) and each class has a test; the watchdog's own failure reaches the user | P5 |
| Security best practices | Threat model written; secret scan in CI; least-privilege IAM policy generated and documented; secrets in the OS keychain; releases checksummed and attested | P6 |
| Testing and code-quality standards | Linters for Go, JS and Python block CI; coverage ≥ 75% overall and ≥ 60% for every package; renderer behaviour tested in a real DOM; DOM suites run locally too | P0, P3, P4 |
| Observability: logs, metrics, tracing, health | A run id joins app, CLI, box and Lambda logs; a local rotated log file; the watchdog records each run's outcome; `ayis doctor` is one health check the app shows | P7 |
| Performance and resource optimisation | Recorded budgets (e.g. `ayis status` p50 < 3 s, app first paint < 1 s, AppImage size) checked in CI | P8 |
| Centralised configuration | One registry; settings that affect AWS live in AWS (SSM, free) so every laptop agrees; no raw `os.Getenv` outside `config` | P1 |
| CI/CD and deployment readiness | CI on every branch push; release = tag → tests → build → checksums → provenance → draft; the watchdog version follows the app; a rollback runbook | P0, P9 |
| Documentation and decisions | ADRs for the 15+ standing decisions; CONTRIBUTING, SECURITY, runbooks; finished plans archived | P10 |

---

## 5. Phases

Order is by risk removed per effort. Sizes are rough: S ≈ a day, M ≈ 2–4 days, L ≈ a week+.

### P0 - Guardrails first (S)

So everything after is checked automatically.

- Run `test.yml` on every branch push (fixes W7). Cost: free runner minutes on a public repo.
- Add linters, starting in report-only mode, then blocking once clean (W6):
  - Go: `golangci-lint` with `errcheck`, `govet`, `staticcheck`, `ineffassign`, `gocritic`,
    `dupl`, `gocyclo` (threshold set from today's worst, lowered over time).
  - JS: ESLint (flat config, `no-unused-vars`, `no-undef`, `eqeqeq`, `complexity`).
  - Python: Ruff and `mypy --strict` on the Lambda.
  - Shell: ShellCheck on `host/`, `lib/`, `tests/`.
- Publish coverage in CI and set a floor at today's 65% that may only go up.
- Create `docs/adr/` with a template and ADR-0001 "Record decisions as ADRs".
- Move finished plans to `docs/archive/`; move `ayis.md` to `docs/cli.md`; move `stitch_design/`
  to `docs/design/mockups/` or drop it (W14).

**Exit:** CI runs on this branch; lint runs (report-only); coverage shows in the job summary.

**Done (branch `p0-guardrails`).** Baseline the linters found, to be driven to zero before each
job blocks:

| Linter | Findings | Notes |
|---|---|---|
| golangci-lint v2.15.0 | 72 | 37 unchecked errors, 13 staticcheck, 8 unused, 5 `nilerr` (an error swallowed as success), 5 gocritic, 4 over complexity 40 - worst is `cmd/ayis` `run()` at 113 |
| ESLint 10.15.0 | 33 | 23 unused names, 7 over complexity 60, 2 `var`, 1 file over 1,500 lines (`app.js`); **no undefined names** |
| Ruff 0.17.6 | 34 | after turning off %-formatting, which the watchdog uses on purpose |
| mypy 2.4.1 | 0 / 281 | clean as written; 281 under `--strict`, which needs type hints - 0 since P4, and blocking |
| ShellCheck 0.11.0 | 101 warnings, 1 error | across 83 scripts; most are `cd` without `|| exit` (SC2164) |
| Coverage | 65.2% | floor set at 65% in `tools/ci/coverage.sh` |

Two findings beyond the linters:

- `app/node_modules` holds a Go package (from the npm package `flatted`), so `go vet ./...` in
  CI was vetting third-party code. CI and the coverage script now list our packages only.
- `tests/secrets-guard.sh` already blocks tracked keys and, through the `GUARD_EXTRA` repository
  secret, the owner's own identifiers - the PII test planned for P6 exists; P6 extends it.

### P1 - One source of truth for settings (M) - fixes a live bug

W1 is the only item here that is a **user-visible bug today**, so it comes first.

- Split the registry into **local** settings (paths, this laptop's tools) and **account**
  settings (budget, hour limits, alert topic, idle times, region, machine type).
- Store account settings in SSM standard parameters under `/ayis/<host>/config/*` - free, already
  used for the hour count. `ayis config set` writes there; every laptop reads from there; `.env`
  keeps only local settings and a cache.
- The watchdog is deployed from the account settings only, so two laptops can no longer undo
  each other. One-time migration: on first run, push local values up if AWS has none, and say so.
- Replace the 13 direct `os.Getenv` calls with the registry.
- ADR: "Account settings live in the account".

**Cost:** ₹0 (SSM standard parameters and their API calls are free).
**Exit:** a test with two simulated laptops shows the second sees the first's change, and the
watchdog's environment equals the account settings after either one deploys.

**Done (branch `p1-account-settings`).** `internal/config/scope.go` splits the registry (a test
fails if a new setting is in neither list); `internal/accountcfg` syncs with
`/ayis/<host>/config/`; ADR-0002 records it. Tested with two simulated computers, an offline
change, and paging. Live on 2026-11-22: this server's first sync moved 8 settings into the
account, and a second sync moved nothing. The 13 direct `os.Getenv` calls are left for P2, where
the packages that hold them are reworked anyway.

### P2 - Architecture and module boundaries in the Go code (L)

- Write the layer rule down and enforce it with a Go test that walks imports:
  `cmd/ayis` → `internal/commands/*` → domain packages (`box`, `limits`, `library`, `provision`,
  `pricing`, …) → `internal/aws/*` adapters. Domain packages never import `commands`; nothing
  but adapters imports the AWS SDK service packages.
- Introduce `internal/aws/ec2box` (find the box by tag, describe, tag, start, stop) and replace
  the 16 copies (W4). Same for SSM marks, budgets and IAM reads. One fake per adapter in
  `internal/testfixture`, replacing per-package fakes.
- Split `internal/commands/boxcmd` (5,800 lines) by verb into `open`, `stop`, `destroy`, `disk`,
  `restore` packages sharing a small `boxcore`.
- Make `cmd/ayis/main.go` a table of commands built from `internal/contract`, tested, instead of
  a 445-line switch (0% coverage today).
- Raise the five weakest packages (W5) to ≥ 60% while touching them.

**Exit:** import-rule test passes; `grep DescribeInstances(` finds only the adapter; no Go file
over 1,500 lines; coverage ≥ 70%.

**Done (branch `p2-boundaries`), with three corrections to the plan above:**

- *Measured first, and two items were wrong.* No Go file is over 683 lines - `boxcmd`'s 5,800 lines
  are already one file per verb, so splitting it into packages would only move code. And the AWS SDK
  in 33 packages is deliberate: each declares the small client interface it needs and tests pass a
  fake. Moving every call behind adapters would be churn for no gain. What *was* duplicated is
  fixed: finding a host's machines was written seven times with different state lists, mostly
  reading one page - now `internal/ec2find`, every page (destroy's plan could have missed a
  machine past page one).
- *Enforced:* `internal/arch` tests that building blocks never import commands, that no new
  command-to-command coupling appears unlisted (21 today), that only `awscfg` configures AWS, that
  fakes stay in tests, that settings come from `config` (six process facts listed with reasons),
  and that no file passes 800 lines. Each rule was broken on purpose once to prove it fires.
- `cmd/ayis`: the 445-line `switch` (complexity 113, 0% covered) is one function per command in a
  table built from the contract; a test fails if the contract and the table disagree. Lint
  ceiling lowered from 115 to 65.
- `ask.FromEnv` replaces seven copies of `ask.New(out, os.Getenv("AYIS_YES") == "1")`.
- A bug found on the way: an archive index that exists but cannot be parsed read as an empty
  archive, against its own comment; it is now an error.
- Coverage 65.2% → 65.9%; `cmd/ayis` 0 → 22%, `limitscmd` 3.6 → 29%. The 70% target is **not**
  met: the rest of the weak packages (`box` 3.6%, `laptop` 9.2%, `commands/watchdog` 16%) run SSH
  and real processes, and need a fake-process seam first. That moves to P5, where those same
  paths get timeouts and fault injection.

### P3 - The desktop app as modules (L)

- Split `app.js` into ES modules, no framework and no bundler (Electron loads
  `<script type="module">`): `core/` (runner, state, format, dialogs), and one module per page:
  home, machine, games, safety, spending, settings, onboarding, logs.
- Pages talk only through `core/state` and events, never by calling each other.
- Replace source-grep tests (W3) with behaviour tests: feed recorded `ayis --json` outputs into
  the real DOM and assert what is drawn. Keep the handful of greps that guard a policy (e.g. "no
  interval timers that poll AWS").
- Make the DOM suites run locally: pin a headless Chromium via Playwright in `app/` dev
  dependencies, so they no longer need CI (today they hang under the local browser shim).
- ESLint blocking; no module over 1,500 lines.

**Exit:** `app.js` gone; every page has DOM tests that pass locally and in CI; the packaged
AppImage passes `tests/app-packaged.sh`.

**Part 1 done (branch `p3-app-modules`):** `app.js` is gone - fourteen scripts of 199 to 1,507
lines, one per page or concern, loaded in order. Before cutting, every statement that runs at
load was traced through the functions it calls: inside one script a function is usable before
its line, across scripts it is not, and only one stretch (Play, stop and keep, 1,266 lines) had to
stay whole. The pieces join back to the old file exactly, less the dead code below.

- `tests/renderer-names.sh` checks the scripts together: a name declared twice, or never used.
  It found **`cell` defined twice** - Home's copy had been silently replaced by Build's since it
  was written - and **eight unused names**, among them `extraDiskGb`, whose test claimed "the app and
  ayis size the disk alike" while the app sized the disk elsewhere. All removed.
- ESLint reads each script's top-level names, so a typo is still an undefined name; its errors are 0.
- The suites read the renderer through `tests/lib/renderer.sh`, in `index.html`'s order.

**Part 2 done:**

- **The browser suites run locally** (decision 4: yes). `tools/dev/install-browser.sh` installs
  Playwright's headless shell (126 MB, outside the app); `tests/lib/browser.sh` finds it, in
  place of sixteen copies of the lookup. All 48 suites now run here with nothing skipped.
- **Not ES modules - measured, then decided** ([ADR-0003](../adr/0003-renderer-scripts-not-modules.md)):
  514 cross-file imports, 28 variables assigned outside the script that declared them, and 731
  browser assertions that probe the page's globals. Instead the shared scope is checked: one
  owner per name, and shared state in `state.js` (loaded first) - a variable written by another
  script must be declared there. The 28 now are; the rule was broken on purpose once to prove it.
- ESLint: 0 errors, 13 warnings (from 33 before P0's baseline was split).

**Not done - carried forward:** of `tests/app.sh`'s 401 checks, **309 assert that an exact line of
source exists**. They fail on a harmless rename and pass when behaviour breaks. Each should become
a probe in a browser suite or be deleted where a suite already covers it. That is a few days'
careful work, best done page by page alongside the next change to each page.

### P4 - The watchdog as a package (M)

- Turn `lambda/cloud_watchdog.py` into `lambda/ayis_watchdog/` with modules `limits`, `idle`,
  `archive`, `notify`, `aws` and a thin `handler`; still deployed as one zip, so the
  fingerprint logic in `internal/watchdog` keeps working.
- Move tests from Bash heredocs to `pytest` with shared fakes (W13), keeping every existing case.
- Ruff and `mypy --strict` blocking.

**Cost:** ₹0 - same Lambda, same schedule.
**Exit:** all 238 existing Lambda checks pass under pytest; no module over 500 lines.

**Done (2026-11-22).** `lambda/ayis_watchdog/` is twelve files, the largest 270 lines: `handler`,
`limits`, `idle`, `stopped`, `archive`, `games`, `events`, `notify`, `aws`, `common`, `settings`
(the plan's five, plus the three checks it did not name and the two shared ones). Settings are read
as `settings.NAME` at call time, so a test changes one per case. `internal/watchdog.Zip` now packs
every `.py` file of the package, still byte-identical from the same source and still checked against
Python's own `zipfile`; the handler is `ayis_watchdog.handler.handler`.

- **Tests:** the 238 checks of `tests/lambda-watchdog.sh` and `tests/hard-limits.sh` are 184
  pytest tests in `lambda/tests/` running 242 assertions; `tests/watchdog.sh` runs them in the suite.
  Two of the old checks asserted nothing useful and were replaced, not copied: one compared
  `print(1)` with `1`, now it checks the kept bucket's Steam login really stays; one grepped the
  source for a call, now the scheduled run is shown deleting a stopped box. Breaking the
  threshold comparison or the hourly limit on "watchdog failing" fails a test, as it should.
- **Contracts across languages, now tested:** every tag the function writes is one its IAM policy
  allows (a tag missing from the policy is refused by AWS at the moment a shutdown is being
  recorded), and the limits' tag and warning time match the CLI's.
- **Lint:** Ruff (whole repo) and `mypy --strict` block in CI, on Python 3.13 as Lambda runs it.
  `tools/draw-wallpaper.py` was fixed to pass, and draws a byte-identical picture.
- **Deploying it:** the first `ayis watchdog install` (or any command that repairs the watchdog)
  after this uploads the new zip and handler - the function reads as "code changed" until then.
  ₹0: same function, same schedule.

### P5 - Errors and resilience (M)

- One retry and timeout policy in `internal/awscfg` (adaptive retries, per-call deadlines);
  no AWS call without a context deadline.
- Classify errors in one place - *yours to fix* (credentials, quota, settings), *try again*
  (throttling, capacity, network), *bug* - and render each the same way in CLI and app.
- Make every write resumable or idempotent, and test it by cancelling mid-way: `init`, `destroy`,
  `library` push/pull, `limits arm`.
- **Watchdog dead-man signal (W8):** the watchdog writes its last good run to SSM (free); the app
  and `ayis status` warn when it is older than 15 minutes, and the box's idle watchdog sends an
  ntfy message if it sees the same. No CloudWatch alarm (ADR: it was removed on purpose).

**Cost:** ₹0.
**Exit:** fault-injection tests for throttling, timeout and mid-write cancel pass; a disabled
watchdog shows a warning in the app within 15 minutes.

**Done (2026-11-22).**

- **One retry and timeout policy** (`internal/awscfg`): standard retries, 5 tries, backoff up to
  20 s; a call whose caller set no deadline gets 2 minutes, retries included - except `GetObject`,
  whose body is read after the call returns. *Changed from the plan:* not adaptive mode. Its
  client-side rate limiter starts from the rate it has measured, and after one throttle a CLI that
  had made two calls waited over 2 seconds for its third (found by the test). Fault-injection
  tests against a local fake: throttled then fine, always down, a mistake asked once, hung until
  the deadline, the caller's own deadline kept, a body still readable after the call.
- **Errors sorted in one place** (`internal/fault`): *yours to fix*, *try again*, *bug*, each with
  one sentence of advice. `Out.Fail(err)` prints it under the error; in events mode the error
  event carries `class` and `hint`, and the app shows the hint after the words. 65 commands that
  printed `err.Error()` use it.
- **Stopped part way, run again:** a test for each of the four.
  - `limits arm`: stopped at each of its 4 writes, with that write landing in AWS or not; the
    rerun arms exactly once. It already was safe; now it is tested.
  - `destroy`: stopped at each of 7 writes. **Found a real leak:** stopped (or refused) between
    deregistering an image and deleting its snapshots, the snapshots were left billing for good -
    the next destroy looked for images only. Destroy now also finds ayis's tagged snapshots
    that no image uses, says them in its plan, and deletes them.
  - `library` push: a push that was cut off is finished by the next one, manifest last.
  - `init`: stopped after the launch and before the box was written down, the rerun finds it
    by its tag and launches no second one.
- **Dead-man signal:** after every good run the watchdog writes `/ayis/<host>/watchdog/last-ok`
  (free; its role may write that one parameter). Over 15 minutes old, `ayis watcher --json` says
  `late`, the Safety page says so in red with the card "Not running", and `ayis watchdog` prints
  a failure line. Never written, or unreadable, is not late.
  *Not done:* the box's own watchdog repeating the warning. The box has no AWS access to read
  it, and giving it some belongs to P6's review of what each part may do.

### P6 - Security (M)

- Write `docs/security/threat-model.md`: assets (AWS keys, Tailscale keys, Steam login token,
  saved games, the ntfy topic), who can reach each, and the control for each.
- **Least privilege:** generate the exact IAM policy `ayis` needs (`ayis aws policy`), document
  creating a user with only that, and check it in CI against the actions the code calls.
- **Secrets at rest (W10):** keep secrets in the OS keychain (Secret Service on Linux, Keychain
  on macOS, Credential Manager on Windows), `.env` holds references only; migrate on first run.
- **ntfy:** support an access token or a self-hosted server; warn in the app that a public
  topic is readable by anyone who knows it. ADR on the default.
- CI: secret scanning (gitleaks) on every push, and a test that no tracked file contains a
  personal email or Steam id (the PII lesson of 2026-11-20).
- Releases: SHA-256 checksums and GitHub build provenance attestations (free).
- **Signing (W11)** is a cost decision for you: Apple Developer ID is about $99 a year; a
  Windows code-signing certificate roughly $200–400 a year. Until then, the README keeps saying
  "unsigned".
- `SECURITY.md` with how to report a vulnerability.

**Exit:** threat model reviewed; gitleaks and the PII test block CI; a fresh IAM user with only
the generated policy completes `init → open → destroy` in a live test.

**Done (2026-11-22), with the owner's two decisions:** stay unsigned ([ADR-0005](../adr/0005-unsigned-builds.md));
a public ntfy topic by default, with a warning and an optional token ([ADR-0004](../adr/0004-public-ntfy-topic-by-default.md)).

- **Threat model** in `docs/security/threat-model.md`; `SECURITY.md` says how to report privately.
- **Least privilege:** `ayis aws policy` prints the exact policy - 127 SDK operations as 116 IAM
  actions, plus `iam:PassRole` and the spot service-linked role. A test scans the source and fails
  when a call is missing from the list or the list names one nothing calls.
  `docs/aws-account-setup.md` says how to make a user with only that.
- **Secrets at rest (W10):** the four secrets in `.env` move to the OS store on the first run that
  has one (`.env` keeps `@keychain`); none, and they stay in `.env` as before. `AYIS_NO_KEYCHAIN=1`
  opts out (the test suites set it). Tested with a fake store; the real GNOME Keyring answered on
  the dev server.
- **ntfy token** (`GAME_NTFY_TOKEN`) sent by every sender and reader; the Safety page warns about
  a public ntfy.sh topic with no token.
- **CI:** gitleaks scans every push's whole history and blocks (all ten historic hits were fakes or
  a variable name). Releases carry `SHA256SUMS` and build provenance attestations.

**Still open - needs the owner:**

- The PII check runs on `GUARD_EXTRA`, a repository secret that **was never set** - so CI has
  checked key shapes but never the owner's own identifiers. It needs setting (`gh secret set
  GUARD_EXTRA`, a regex of the email and Steam name). Checked locally with the email: clean.
- GitHub's private vulnerability reporting is off; `SECURITY.md` points to it.
- The live test of a fresh IAM user with only the generated policy (`init → open → destroy`)
  spends a session's worth of money, so it waits for the owner.

### P7 - Observability (M)

What each term means here:

- **Logs:** CLI and app write a rotated local log (`~/.local/state/ayis/ayis.log`, 5 × 5 MB);
  the Lambda logs one JSON line per decision. A secret never reaches a log - tested.
- **Tracing:** every user action gets a run id. The app passes it to the CLI; the CLI to the box
  (tag and env) and to the Lambda (instance tag); every log line carries it. `ayis logs --run
  <id>` gathers one action's lines from all four places.
- **Metrics:** no paid metric service. The watchdog records each run's outcome, hours counted and
  decisions to SSM (free, overwritten); the app's Safety page shows "watchdog: last ran 2 min
  ago, ok". Build and boot times are already measured by `ayis init`; keep them.
- **Health checks:** `ayis doctor --json` combines `check`, `watchdog`, `limits`, credentials
  and the box's own health; the app's header shows its worst result.

**Cost:** ₹0 (CloudWatch Logs for the Lambda stays well inside the free 5 GB).
**Exit:** one run id followed end to end in a live test; `ayis doctor` red when the watchdog,
keys or Tailscale are broken (fault-injection tests).

**Done (2026-11-22).**

- **Logs:** every command's lines go to `~/.local/state/ayis/ayis.log` (5 MB x 5, 0600) with its
  time, run id and command (`internal/journal`). Redacted on the way in: every secret setting's
  value, the ntfy topic, and anything shaped like a key, token, bearer header or password; a
  secret being set (`config set KEY value`) is hidden too. Tested.
- **Tracing:** the app gives each command a run id (`AYIS_RUN_ID`); a machine launched or started
  carries it as the `ayis:run` tag; the watchdog's lines about that machine end in `run=<id>`.
  `ayis log --run <id>` gathers this computer's lines (which include what the box said while
  ayis watched it) and the watchdog's.
- **Health:** `ayis doctor [--json]` - the AWS key, Tailscale, the cloud watchdog (installed,
  scheduled, current, and its dead-man signal from P5), the budget's block, and the keychain -
  each ok, warn or fail with what to do. Fault-injection tests for each failure. The app reads it
  at start-up and on Home, and the header shows the worst: "All good" or "N problems", each named
  in the tooltip.
- **Metrics:** the watchdog's last good run (P5's heartbeat) and its last decision already show
  on the Safety page; build and boot times stay as `ayis init` measures them.

*Changed from the plan:*

- The Lambda still logs **text**, not JSON: `ayis watchdog`, the watcher and the app read those
  lines as they are, and every line now carries the machine's run. Worth doing only with a
  reader that needs structure.
- The box's own journal is not fetched by `ayis log --run`: what the box says during a build or a
  session reaches this computer's log through ayis, and outside one there is no run to match.

*Still open:* the exit asks for one run id followed end to end in a **live** test - it needs a
session on AWS, so it waits for the owner, with P6's least-privilege test.

### P8 - Performance and resources (S–M)

- Record today's numbers first: `ayis status` wall time, app cold start to first paint, memory
  of the app after an hour, AppImage size, box boot-to-playable time.
- Set budgets from those numbers and check the cheap ones in CI (CLI timings against fakes,
  bundle size).
- Likely work: cache read-only AWS answers per refresh, read fewer things at app start, prune
  the AppImage (123 MB today) of unused Electron locales.

**Exit:** a `docs/performance.md` table of budget vs. measured, with CI enforcing the
deterministic ones.

### P9 - CI/CD and deployment (S–M)

- Pipelines: branch push → lint + tests; PR → same plus DOM suites; tag → tests → builds for
  Linux, macOS and Windows → checksums → provenance → draft release.
- Generate release notes from commits since the last tag.
- The app checks that the deployed watchdog matches its version and offers to update it (the
  fingerprint already exists); a broken watchdog deploy can be rolled back with one command.
- `docs/runbooks/` for release, rollback, watchdog redeploy, and "AWS account suspended".

**Exit:** a release cut entirely by pushing a tag, with nothing done by hand but pressing
"Publish".

### P10 - Documentation and decisions (S, ongoing)

- Backfill ADRs for the standing decisions, among them: Ubuntu over NixOS; Proton not mirrored;
  CloudWatch alarm removed; new game at build dropped; the box found by tag, not by `.env`; hard
  limits enforced by the watchdog; account settings in SSM (P1).
- `docs/architecture.md` gains the module map and the layer rule from P2/P3, with one diagram.
- `CONTRIBUTING.md`: set-up, how to run every test locally, commit style, how to cut a release.
- README stays short and links to the rest.

**Exit:** every "Key decisions" bullet in `architecture.md` links to an ADR.

---

## 6. Sequence and milestones

| Milestone | Phases | What you can say afterwards |
|---|---|---|
| M1 - Safe to change | P0, P1 | Every push is checked; two laptops can no longer fight over the watchdog. |
| M2 - Clean structure | P2, P3, P4 | No giant files; boundaries enforced by tests; the app is tested by behaviour. |
| M3 - Trustworthy | P5, P6, P7 | Failures are classified and visible; least privilege; one action traceable end to end. |
| M4 - Releasable | P8, P9, P10 | Measured performance budgets; tag-to-draft release; decisions recorded. |

Reddit beta testers can start at any time; M1 should land before the beta grows past a few
people, because W1 will bite anyone with two computers.

## 7. Decisions needed from you before starting

1. **Account settings in SSM (P1).** Recommended; free. Changes where settings live.
2. **Code signing (P6).** About $99/yr (Apple) plus $200–400/yr (Windows), or stay unsigned.
3. **ntfy default (P6).** Keep public ntfy.sh with a warning, require a token, or self-host.
4. **Playwright's Chromium as a dev dependency (P3).** About 150 MB on developer machines; no
   effect on the shipped app.
5. **Strictness of the coverage floor.** Proposed: 75% overall, 60% per package by M2.

## 8. Risks

- **Refactors breaking a flow that only AWS exercises.** Mitigation: each phase ends with the
  live `init → open → destroy` run (one session, about ₹20–60), stated before it is spent.
- **Renderer split regressions.** Mitigation: DOM behaviour tests land *before* the split.
- **Settings migration (P1) losing a value.** Mitigation: migration is read-compare-write, prints
  what moved, and keeps `.env` as a fallback for one release.
