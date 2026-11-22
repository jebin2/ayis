# Performance

What ayis costs in waiting and in disk, measured, with the budget each is held to. A budget is
today's number with a little room; it only goes down. **Enforced** ones are checked on every push,
because they are deterministic - against fakes, or a count of bytes. The others are measured by
hand when something changes, because they depend on the network or the machine.

Measured 2026-11-22 on the dev server (Linux, India, AWS ap-south-1).

## Budgets

| What | Measured | Budget | How it is checked |
|---|---|---|---|
| `ayis status`: rounds of AWS calls made one after another | 3 (20 calls) | ≤ 4 rounds, ≤ 25 calls | **Enforced** - `internal/commands/status/speed_test.go`: every fake call takes 100 ms, the time counts the rounds |
| `ayis watcher`: rounds of AWS calls | **8 → 4** (16 calls) | ≤ 4 rounds | **Enforced** - `internal/commands/watcher/speed_test.go` |
| The app's first paint (headless browser, virtual clock, stubbed ayis) | 52-56 ms | ≤ 300 ms | **Enforced** - `tests/home-boot-dom.sh` |
| The renderer as shipped (scripts, styles, page, fonts) | 844 KB | ≤ 1,000,000 bytes | **Enforced** - `tests/app.sh` |
| The Linux AppImage | **123.7 → 112.2 MB** | ≤ 120 MB | **Enforced** in the release build (`desktop-release.yml`) |
| `ayis status --json` against AWS | 1.3 s warm, 2.8 s cold | - | by hand |
| `ayis watcher --json` against AWS | **2.9 → 1.8 s** | - | by hand |
| `ayis doctor --json` against AWS | 1.6 s | - | by hand |
| A first build, launch to playable | 10-20 min, mostly the NVIDIA driver and the game restore | - | `ayis init` measures and prints each stage |

A round is a set of calls made at the same time; the wait is the rounds times one call's time
(here 100-300 ms each), so rounds are what the code controls.

## What changed in P8

- **The watcher asks at once.** The machine, the cloud watchdog and the budget are independent; it
  used to read them one after another. 8 rounds became 4, and the Safety page's read 2.9 s became
  1.8 s against AWS.
- **English only for Electron's own words** (`electronLanguages`), the menus and dialogs Chromium
  draws: the app's own words are English. 44 MB of other languages left the package; the AppImage
  went from 123.7 MB to 112.2 MB.
- **The stylesheet's source** (`renderer/src.css`) no longer ships beside the built one.

## Not measured yet

- **The app's memory after an hour** - needs a person and a desktop; worth doing when a report
  says the app gets slow.
- **Restarting a stopped machine to playable** - `ayis open` measures it; no number is written down yet.

## What would cost time, and was left

- Caching AWS answers between refreshes: every read already runs in parallel and the slow part
  is AWS itself; a cache would show stale machine states, which is worse than a second's wait.
- The Electron binary itself (191 MB unpacked) and the bundled `ayis` (23.7 MB, already stripped)
  are most of the package and cannot shrink without dropping features.
