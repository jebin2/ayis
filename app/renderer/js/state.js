'use strict';
// The state the pages share: every top-level variable that more than one script
// writes is declared here, and only here, so who may change it is never a guess.
// tests/renderer-names.sh fails on a variable written outside the script that
// declares it, unless it is declared in this one. Loaded first.
// (docs/architecture.md, "The app").

// What ayis last said (build.js)
// The picker mirrors ayis's own arithmetic so the button can be refused early;
// the box enforces it again at boot, which is where it must be enforced.
let archive = { games: [], selectable_gb: null };
let boxSeenAt = 0;   // when it was read
let boxNow = null;   // the box `ayis status` last reported, or null
let sessionNow = null; // a `ayis open` streaming from this laptop, per ayis status
let config = [];     // the settings registry, as `ayis config --json` last gave it
let watcher = null;  // `ayis watcher --json`, for the guard strip and the Guards screen
let statusBudget = null;
let costNow = null;  // the last paid cost fetch, if one was made in this window
let costNowAt = null;
let statusNow = null; // `ayis status --json`, as last read
let statusAt = null;   // when it was
// `ayis ping --json` - direct or relayed, and the latency - asked only while the
// machine is online, and at most once a minute: it is a local tailscale ping,
// free, but it takes a few seconds and means nothing with no machine.
let pingNow = null, pingAt = 0, pingBusy = false;
const activity = [];  // what ayis has done in this window, newest first

// The machine chooser and a run in flight (build.js)
// A scan in flight. The table shows one region until it lands, and saying why
// is the difference between "still working" and "the other regions are gone".
let sweeping = false;
// A picked price being saved: three settings written, then read back.
let choosing = false;
// Numbered steps, the way ayis reports them: the one running is marked, the ones
// before it carry how long they took. No timer - each event repaints.
let buildStarted = 0;
let buildSteps = 0;

// The page and the log (core.js)
let view = 'dashboard';
let logCount = 0;
let stoppedDisk = null, stoppedDiskFor = '';

// Games (games.js)
let pcNow = null, pcAt = 0, pcFailed = false, pcReading = false, pcTimer = null;
// The word typed in the app's own dialog, handed to ayis when it asks for it.
let typedPending = null;

// Adding a machine (hosts.js)
let adding = null;                // 'aws' | 'host' while the add dialog is open
let addedHost = null;             // the machine that dialog has just added

// First run (onboarding.js)
let onbHandover = null;
// A sentence about the last attempt at the active stage - why it failed - and
// whether the run in flight is now waiting on a browser rather than working.
let onbNote = '';
let onbTone = '';
// The step whose command just succeeded, until the read that judges it comes
// back. Without it the step fell back to exactly what it showed before - red
// marks and "Install them" - for as long as the re-read took, which looked like
// the install had not happened.
let onbVerifying = null;
// On open: ask what this laptop can do, and only then ask AWS anything.
//
// It used to fire all nine reads at once. On a laptop with no AWS CLI that is
// six reads that cannot work, a screen of unknowns, and the actual problem - a
// missing tool - somewhere in the middle of it.
//
// When the gate stays shut, it has to open again by itself once the last
// blocking stage is fixed - and not every fix is a write that comes back
// through here. The billing address is a `ayis config set`, which ayis does not
// list as running alone, so the window re-reads only the setting: the stage
// ticked, and "where it runs" sat on "checking…" for ever, waiting on a
// `ayis machines` that nothing was ever going to ask for. So `gateShut` remembers
// that the reads behind the gate were skipped, and ANY gate read that lands
// with nothing blocking left - from a dialog, from Settings, from anywhere -
// asks them. Cleared at the start of this function, so the gate reads it
// makes itself never open it a second time underneath it.
let gateShut = false;

// Where a run's words go: set by settings.js as it loads, moved by onboarding.js
let runSurface = null;
