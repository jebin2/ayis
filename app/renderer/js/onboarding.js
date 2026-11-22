'use strict';
// First run: what is missing, and putting it right step by step.
// One of the renderer's scripts, loaded in order by index.html into one shared scope
// (docs/architecture.md, "The app").

// ── The first-run pipeline ────────────────────────────────────────────────────
//
// The dashboard, on a laptop that is not ready. Six stages in the order they
// have to be met, one of them active, the pane beside it carrying ayis's own
// words. When the last one is met it collapses to a line and the dashboard
// cards take over.
//
// It replaces three attempts at this: a banner that named one problem at a
// time with no sense of how many there were, a modal popup over a window you
// could not use yet, and that popup moved into a corner so it would stop
// blocking. All three were ways of avoiding the fact that a new laptop has no
// screen of its own.
//
// What is on each stage comes from prereqs(). What ayis is doing comes from ayis.

// Which of three things the dashboard is doing:
//   setup      something is unmet, or not yet known - the pipeline is the screen
//   handover   all six are met, and the finished pipeline is held on screen for
//              a beat so you see it finish rather than having it vanish
//   dashboard  the cards
//
// It only ever moves forwards: dropping back into a setup flow out from under
// someone who is using the app would be worse than the problem. A prerequisite
// that breaks later is not announced - setup made sure of it once, and a strip
// above every page for a rare breakage was judged not worth its place.
// How many sets of the reads behind the gate are in flight. The pipeline's
// stages are judged on the fast ones, so it used to finish and hand over while
// the box, the archive and the guards were still being read - and the first
// thing on the new dashboard was "Stop refresh" and three empty cards. The
// handover waits for this to reach zero instead: the dashboard arrives filled.
let readingBehindGate = 0;
let onbHandover = null;
const ONB_HANDOVER_MS = 900;
// The dialog's last step is done: a beat, so the tick is seen landing, then
// `then` - closing it, for AWS and for a server set up alike.
function onbHandOver(then) {
  onbHandover = afterBeat(() => { onbHandover = null; then(); });
}
// The one delay in the app: a finished thing is held on screen for a beat, so
// it is seen to finish - or a dialog for the length of its closing motion -
// then `then`. It starts no command.
function afterBeat(then, ms = ONB_HANDOVER_MS) { return setTimeout(then, ms); }

// The stage that is running something, and the job it started - so it can be
// stopped, which matters: a sign-in waits on a browser that may never answer.
let onbRunning = null;
let onbJob = null;
// A sentence about the last attempt at the active stage - why it failed - and
// whether the run in flight is now waiting on a browser rather than working.
let onbNote = '';
let onbTone = '';
let onbWaiting = false;
// The step whose command just succeeded, until the read that judges it comes
// back. Without it the step fell back to exactly what it showed before - red
// marks and "Install them" - for as long as the re-read took, which looked like
// the install had not happened.
let onbVerifying = null;
// Waiting for the reads before the step's command: nothing of its own is
// running yet, so there is nothing for Stop to stop.
let onbQueued = false;
// Steps whose command is a write to .env on this laptop, done in a blink:
// a Stop there would only ever be pressed after it was over.
const ONB_NO_STOP = new Set(['where']);
// Every read that has to answer before that step is judged again - for Tools,
// both the tool list and the AWS CLI check - and the tools that were missing
// when the install started, which show "…" until then rather than ✗ or ✓.
let onbPending = new Set();
let onbWasMissing = new Set();
const ONB_REREAD = { tools: ['deps', 'creds'], cli: ['deps', 'creds'], tailnet: ['tskey'],
                     where: ['config', 'machines'] };
const ONB_VERIFY = { tools: 'Installed. Checking\u2026', cli: 'Installed. Checking\u2026',
                     tailnet: 'Signed in. Checking\u2026', where: 'Saved. Checking\u2026' };

// Called by watchForSignInLink when the sign-in prints its link: the command
// is not stuck, it is waiting for you, and the stage says that instead.
function onbStatus() {
  onbWaiting = true;
  // Nothing is being worked on now, so no sweep and no "current line": the
  // step's own sentence says what is being waited for, and the link is there.
  if (onbRunning) {
    $('onb-live-' + onbRunning).hidden = true;
    $('onb-prog-' + onbRunning).hidden = true;
  }
  paintOnboard();
}

// ── Each step's own log ──────────────────────────────────────────────────────
//
// One log per step rather than one pane for all of them: when step three fails
// you want step three's output, not whatever ran last. Each is a small unit -
// the line ayis is on now, a progress sweep, the sign-in link when there is one,
// and the full output folded behind "Details" - built once and kept in
// #onb-logs between paints, because the steps are redrawn every time a read
// lands and an install's half-written log must survive that.
const onbLogId = key => 'onb-log-' + key;
function onbUnit(key) {
  let u = document.getElementById('onb-unit-' + key);
  if (u) return u;
  u = document.createElement('div');
  u.id = 'onb-unit-' + key;
  u.className = 'mt-space-sm';
  u.dataset.open = 'no';

  const live = document.createElement('div');
  live.id = 'onb-live-' + key;
  live.className = 'font-code-sm text-code-sm text-on-surface-variant truncate';
  live.hidden = true;
  const prog = document.createElement('div');
  prog.id = 'onb-prog-' + key;
  prog.className = 'onb-progress mt-space-xs';
  prog.hidden = true;
  prog.append(document.createElement('i'));
  // A sign-in prints a link and then waits: it has to be reachable while the
  // command is still running, and the browser it opened may be behind this.
  const link = document.createElement('button');
  link.id = 'onb-link-' + key;
  link.className = 'btn mt-space-sm';
  link.textContent = 'Open the sign-in page again';
  link.hidden = true;

  const bar = document.createElement('div');
  bar.className = 'flex items-center gap-space-sm mt-space-xs';
  bar.id = 'onb-bar-' + key;
  bar.hidden = true;
  const tog = document.createElement('button');
  tog.id = 'onb-tog-' + key;
  tog.className = 'font-code-sm text-code-sm text-outline hover:text-on-surface';
  const copy = document.createElement('button');
  copy.className = 'font-code-sm text-code-sm text-outline hover:text-on-surface ml-auto';
  copy.textContent = 'Copy';
  copy.hidden = true;
  bar.append(tog, copy);

  const pre = document.createElement('pre');
  pre.id = onbLogId(key);
  pre.className = 'font-code-sm text-code-sm text-on-surface-variant whitespace-pre-wrap break-words '
    + 'overflow-auto max-h-[32vh] mt-space-xs p-space-sm rounded bg-surface-container-lowest '
    + 'border border-surface-variant';
  pre.hidden = true;
  pre.dataset.n = '0';

  tog.onclick = () => onbLogOpen(key, u.dataset.open !== 'yes');
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(pre.textContent); copy.textContent = 'Copied'; }
    catch { copy.textContent = 'Could not copy'; }
  };
  u.append(live, prog, link, bar, pre);
  $('onb-logs').append(u);
  onbLogCount(key);
  return u;
}
function onbLogCount(key) {
  const u = onbUnit(key), pre = $(onbLogId(key)), n = Number(pre.dataset.n || 0);
  $('onb-bar-' + key).hidden = n === 0;
  $('onb-tog-' + key).textContent = `${u.dataset.open === 'yes' ? '▾' : '▸'} Details · `
    + `${n} line${n === 1 ? '' : 's'}`;
}
function onbLogOpen(key, open) {
  const u = onbUnit(key), pre = $(onbLogId(key));
  u.dataset.open = open ? 'yes' : 'no';
  pre.hidden = !open;
  u.querySelector('#onb-bar-' + key + ' button:last-child').hidden = !open;
  // Opened at the end, which is where the news is.
  if (open) pre.scrollTop = pre.scrollHeight;
  onbLogCount(key);
}
// A fresh attempt at a step: its old output stays on screen until the new run
// says something, then is replaced - the collect handler's "fresh" rule.
function onbLogFresh(key) {
  onbUnit(key);
  const pre = $(onbLogId(key));
  pre.dataset.fresh = 'yes';
  pre.dataset.freshCount = 'yes';
  return onbLogId(key);
}
// Every line that reaches a step's log: count it, and show it as the line the
// step is on. Called from the shared collect handler.
function onbLogGrew(box, text) {
  const key = box.id.slice('onb-log-'.length);
  if (box.dataset.freshCount === 'yes') { box.dataset.n = '0'; delete box.dataset.freshCount; }
  box.dataset.n = String(Number(box.dataset.n || 0) + 1);
  const said = (text || '').trim();
  if (said) $('onb-live-' + key).textContent = said;
  onbLogCount(key);
}

// A stage's command, run inside the stage itself. Same shape as runInDialog;
// the difference is where the words go.
async function runInPipeline(key, args, status, started) {
  onbUnit(key);
  const pre = $(onbLogId(key));
  pre.dataset.fresh = 'yes';
  pre.dataset.freshCount = 'yes';
  runSurface = { link: 'onb-link-' + key, log: onbLogId(key), status: onbStatus };
  $('onb-link-' + key).hidden = true;
  $('onb-live-' + key).textContent = status || 'Starting…';
  $('onb-live-' + key).hidden = false;
  $('onb-prog-' + key).hidden = false;
  onbRunning = key;
  onbWaiting = false;
  onbNote = '';
  onbTone = '';
  paintOnboard();
  if ([...jobs.values()].some(j => !hostRun(j))) {
    $('onb-live-' + key).textContent = 'Waiting for the last checks to finish…';
    onbQueued = true;
    paintOnboard();
    await readsSettled();
    onbQueued = false;
    $('onb-live-' + key).textContent = status || 'Starting…';
  }
  const { rc, err } = await runAyis(args, { collect: onbLogId(key), wantRc: true,
                                          onStart: id => { onbJob = id; if (started) started(); } });
  onbJob = null;
  onbRunning = null;
  onbWaiting = false;
  $('onb-link-' + key).hidden = true;
  $('onb-live-' + key).hidden = true;
  // Done, not yet judged: the sweep keeps going until the re-read lands.
  if (rc === 0) {
    onbVerifying = key;
    onbPending = new Set(ONB_REREAD[key] || []);
  }
  else $('onb-prog-' + key).hidden = true;
  if (rc !== 0) {
    onbNote = rc === null ? (err || 'Another task is running.')
      : rc === 130 ? 'Stopped.'
      : (ONB_FAIL[key] || 'Failed. See details below.');
    onbTone = 'bad';
    // The reason is in ayis's words, and nobody should have to find the toggle
    // to read why the thing they just pressed did not work.
    if (rc !== 130) onbLogOpen(key, true);
  }
  // A write re-reads everything behind it, which repaints this - but only on
  // success does the stage move on, so say so either way.
  paintOnboard();
  return rc === 0;
}
const ONB_FAIL = {
  tools: 'Install failed. See details below.',
  cli: 'AWS CLI install failed. See details below.',
  tailnet: 'Sign-in failed. See details below.',
  where: 'Could not save the region. See details below.',
};

// Installing the tools runs here rather than opening something: it needs no
// answer from you beyond the password your OS asks for.
function onbInstall() {
  // What THIS machine needs: a server of yours never needs the AWS CLI, and
  // the button used to install it anyway.
  const missing = depsNow ? neededTools().filter(x => !x.present).map(x => x.tool) : [];
  onbWasMissing = new Set(missing);
  return runInPipeline('tools', ['deps', 'install', ...missing], 'Waiting for password…');
}
function onbInstallCli() {
  return runInPipeline('cli', ['deps', 'install', 'aws'], 'Waiting for password…');
}
function onbSignIn() {
  return runInPipeline('tailnet', ['creds', 'tailscale', 'signin'], 'Opening your browser…');
}

// What each step is called, in the words of someone who has never used AWS.
// prereqs() keeps short sentences of its own; these are for the first run, and
// nothing in them names a command, a flag or an AWS service without saying
// what it is.
//
//   name  the step, short - what the dim list of steps still to come shows
//   done  what is now true, said once it is
//   body  why it matters, and what pressing the button will do
const missingTools = () => depsNow
  ? neededTools().filter(x => !x.present).map(x => x.label) : [];
// Short and plain: what is needed and what it is for, in one or two sentences.
// The Tools step has no sentence at all - it shows the tools themselves.
// The AWS CLI is installed - ayis deps found it - but does not run: ayis creds
// says there is no CLI. Shown on its own chip, not as a second Tools row.
function cliBroken() {
  if (kindNow() !== 'aws' || !depsNow || !credsNow || credsNow.cli !== false) return false;
  const aws = (depsNow.tools || []).find(t => t.tool === 'aws');
  return !!(aws && aws.present);
}

// Every read behind a just-done step has answered: it shows what they say.
// Still unmet after an install that exited cleanly means something did not
// take, and that is said, with the log open - not the step silently going back
// to what it showed before.
function onbVerified() {
  const key = onbVerifying;
  onbVerifying = null;
  onbWasMissing = new Set();
  const prog = document.getElementById('onb-prog-' + key);
  if (prog) prog.hidden = true;
  const rung = prereqs().find(x => x.key === key);
  if (rung && rung.ok === false) {
    const still = key === 'tools' || key === 'cli'
      ? [...missingTools(), ...(cliBroken() ? ['the AWS CLI (installed, but not working)'] : [])]
      : [];
    onbNote = still.length ? `Still missing: ${still.join(', ')}. See details below.`
      : (ONB_FAIL[key] || 'Failed. See details below.');
    onbTone = 'bad';
    onbLogOpen(key, true);
  }
  paintOnboardSoon();
}

const ONB_COPY = {
  open: { name: 'Loading', done: () => 'Ready', body: () => '' },
  server: { name: 'The server',
    done: () => { const s = hostStatus.get(addedHost) || {};
                  return [addedHost, s.os_name, s.gpu].filter(Boolean).join(' · ') || 'The server'; },
    body: () => 'Connect over SSH.' },
  setup: { name: 'Setup', done: () => 'Set up',
    body: () => 'Installs Tailscale, Sunshine and Steam if missing, and pairs Moonlight. '
              + 'Requires sudo. Can also be run later from the machine card.' },
  tools: { name: 'Tools', done: () => 'Tools installed', body: () => '' },
  cli: { name: 'Tools', done: () => 'Tools installed',
    body: () => 'AWS CLI not installed.' },
  key: { name: 'AWS account', done: () => 'AWS account connected',
    body: () => ({
      unreachable: 'Cannot reach AWS. The key was not verified.',
      'no-key': 'An AWS access key is used to launch and stop machines.',
    }[credsNow && credsNow.reason]
      || 'The saved access key was rejected. Add a new one.') },
  tailnet: { name: 'Tailscale', done: () => 'Tailscale signed in',
    body: () => 'Sign in to Tailscale. Machines are reachable only over your tailnet.' },
  // Done only with a working access token, said as what the key is: one in
  // the settings, or one ayis will make from the token when a machine needs it.
  authkey: { name: 'Access token',
    done: () => (tskeyNow && tskeyNow.auth_key_stored ? 'Auth key saved, checked before each build'
                                                      : 'Generated from your access token at build time'),
    body: () => 'New machines join your tailnet with an auth key. Each build checks it with your Tailscale access token first.' },
  email: { name: 'Budget alert',
    done: () => { const e = cfgVal('EMAIL_ALERTS'); return e ? `Alerts to ${e}` : 'Alerts on'; },
    body: () => 'Email address for budget alerts.' },
  where: { name: 'Region', done: () => whereDone(),
    body: () => regionChosen() && machinesNow
      ? `${placeName(machinesNow.region)} has no GPU quota for this machine. Choose another region.`
      : 'Choose a region. Lower latency is better.' },
};
// The city, when the scan knows it; the code otherwise.
function placeName(region) {
  const r = ((sweepNow && sweepNow.regions) || []).find(x => x.region === region);
  return r && r.city ? shortCity(r.city) : region;
}

// The one button a step offers, in the same words. Each opens its dialog right
// here or runs right here: nothing in the first run sends you to another screen.
const ONB_ACTION = {
  server:  () => [serverPwAsk ? { label: 'Continue', go: connectServer }
                             : { label: connecting ? 'Connecting…' : 'Connect', go: connectServer, busy: connecting }],
  // Only after a setup that failed or was stopped: it starts by itself.
  setup:   () => [{ label: 'Set up', go: onbSetupHost },
                  { label: 'Later', go: closeAdd, plain: true }],
  // Installed but will not run is not something installing fixes - ayis deps
  // install skips a tool it can find - so that case offers a fresh look.
  tools:   () => [!missingTools().length && cliBroken()
                    ? { label: 'Check again', go: retryReads }
                    : { label: 'Install', go: onbInstall }],
  cli:     () => [{ label: 'Install', go: onbInstallCli }],
  tailnet: () => [{ label: 'Sign in to Tailscale', go: onbSignIn }],
  // A read that never reached AWS is not a request for a key, so it keeps the
  // rung's own Try again rather than opening the key form.
  key: r => r.problem.go === retryReads
    ? [{ label: 'Try again', go: retryReads }]
    : [{ label: credsNow && credsNow.reason === 'no-key' ? 'Connect AWS' : 'Connect again',
         go: () => openAwsKey(onbLogFresh('key')) }],
  // The token, not a key: a pasted key with no token to check it is what the
  // build refuses, so this button saving one left the step unticked.
  authkey: () => [{ label: tskeyNow && tskeyNow.present ? 'Update access token' : 'Add access token',
                    go: () => openTskey(onbLogFresh('authkey')) }],
  email:   () => [{ label: 'Add email', go: () => openAlertEmail(onbLogFresh('email')) }],
  where:   () => [{ label: 'Choose region', go: openWhereTo }],
};
const onbActions = r =>
  (ONB_ACTION[r.key] || (x => [{ label: x.problem.label, go: x.problem.go }]))(r);

// What each step looked like at the last paint, so the motion runs on the
// paint where a step CHANGED and not on every repaint after it.
const onbSeen = {};

const readOut = json => [...jobs.values()].some(j => j.json === json);

const ONB_MARK = {
  done:     ['\u2713', 'text-primary'],
  checking: ['\u2026', 'text-outline animate-pulse'],
  active:  ['\u25c9', 'text-tertiary'],
  loading: ['\u25cf', 'text-primary animate-pulse'],
  verifying: ['\u25cf', 'text-primary animate-pulse'],
  running: ['\u25cf', 'text-tertiary animate-pulse'],
  failed:  ['\u2717', 'text-error'],
  locked:  ['\u25cb', 'text-outline-variant'],
  unknown: ['?', 'text-outline'],
};

// Repainting the pipeline from inside a painter, without assuming the order the
// reads come back in: every one of them changes a stage's verdict, and the
// stage that is active depends on all of them.
function paintOnboardSoon() {
  if (paintOnboardSoon.queued) return;
  paintOnboardSoon.queued = true;
  Promise.resolve().then(() => { paintOnboardSoon.queued = false; paintOnboard(); });
}

function paintOnboard() {
  const wrap = $('onb-steps');
  if (!wrap) return;
  // Close waits while a step runs or its result is being read back: closed
  // then, the step carried on unseen and the dialog lost track of it. A long
  // step has its own Stop; stop it first, then close.
  const stepBusy = !!(onbRunning || onbVerifying);
  $('adddlg-close').disabled = stepBusy;
  $('adddlg-close').title = stepBusy ? 'Waits for this step to finish' : '';

  // No engine. Not a stage you can be talked through - every command fails
  // identically without ayis, and six broken reads is not what happened. One
  // thing did, and only the main process can see it.
  if (engineGone) {
    if (!$('adddlg').open) $('adddlg').showModal();
    $('onb-title').textContent = 'Scripts not found';
    $('onb-count').textContent = '';
    wrap.textContent = '';
    wrap.append(el('p', 'font-body-md text-body-md text-on-surface-variant mb-space-md',
      'Ayis requires its scripts, which are not installed.'));
    for (const [state, text, note] of [
      ['failed', `Expected at ${engineGone.ayis}`, ''],
      ['locked', 'Install them with:',
       'git clone https://github.com/jebin2/ayis ~/ayis'],
    ]) {
      const row = document.createElement('div');
      row.className = 'flex gap-space-sm items-start';
      row.dataset.stage = state === 'failed' ? 'engine' : 'engine-fix';
      row.dataset.state = state;
      const [mark, cls] = ONB_MARK[state];
      const dot = document.createElement('span');
      dot.className = 'font-code-md text-code-md shrink-0 w-6 ' + cls;
      dot.textContent = mark;
      const body = document.createElement('div');
      body.className = 'min-w-0 pb-space-md';
      const title = document.createElement('div');
      title.className = 'font-body-md text-body-md '
        + (state === 'failed' ? 'text-error' : 'text-on-surface');
      title.textContent = text;
      body.append(title);
      if (note) {
        const n = document.createElement('div');
        n.className = 'font-code-sm text-code-sm text-outline mt-0.5 break-all';
        n.textContent = note;
        body.append(n);
      }
      if (state === 'locked') {
        const b = document.createElement('button');
        b.className = 'btn mt-space-sm';
        b.textContent = 'Try again';
        b.onclick = retryReads;
        body.append(b);
      }
      row.append(dot, body);
      wrap.append(row);
    }
    return;
  }

  paintHome();
  if (!adding) return;
  // A rung that is the same fix as another is never a row of its own: the AWS
  // CLI is judged inside Tools.
  const rungs = prereqs().filter(r => !r.sameAs);
  const ready = rungs.every(r => r.ok === true);
  const firstOpen = rungs.findIndex(r => r.ok !== true);
  const done = rungs.filter(r => r.ok === true).length;
  // AWS is added once its last step is met: a beat first, so the ticks are seen
  // landing - six replaced in 200ms read as a glitch - then the dialog closes on
  // the new card. Reads that started meanwhile are waited for, so the card
  // arrives filled rather than reading.
  if (adding === 'aws' && ready && !readingBehindGate && !onbHandover) {
    onbHandOver(() => {
      if (adding !== 'aws') return;
      if (prereqs().every(x => x.ok === true) && !readingBehindGate) { note('AWS added', 'text-primary'); closeAdd(); }
      else paintOnboard();
    });
  }
  wrap.hidden = false;
  // The count is the only heading besides the title: the steps say the rest.
  $('onb-count').textContent = `${done} of ${rungs.length} done`;

  // The log units are kept, not rebuilt: park them before the rows go.
  for (const u of [...wrap.querySelectorAll('[id^="onb-unit-"]')]) {
    const pre = u.querySelector('pre');
    u.dataset.scroll = String(pre.scrollTop);
    u.dataset.follow = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24 ? 'yes' : 'no';
    $('onb-logs').append(u);
  }
  wrap.textContent = '';

  rungs.forEach((r, i) => {
    const copy = ONB_COPY[r.key] || { name: r.name, done: () => r.name, body: () => r.problem.body };
    const active = i === firstOpen;
    const blocked = rungs.slice(0, i).some(x => x.ok !== true);
    // A verdict of null has two causes that must not share a sentence: the read
    // behind it has not come back yet, or it came back broken.
    const waiting = r.ok === null && !readFailures.has(r.reads) && !blocked;
    const state = r.key === 'open' ? (r.ok ? 'done' : blocked ? 'locked' : 'loading')
      : onbVerifying === r.key ? 'verifying'
      : r.ok === true ? 'done'
      : r.ok === null ? (waiting ? 'checking' : 'unknown')
      : onbRunning === r.key ? 'running'
      : active ? (onbTone === 'bad' ? 'failed' : 'active')
      : 'locked';
    // When this step last changed, and from what. The steps are redrawn every
    // time a read lands, often mid-animation; a redrawn tick has to carry on
    // from where it was rather than start again, so each animation is given a
    // negative delay of however long ago the change happened. No timer: the
    // clock is only read, at paint.
    const now = performance.now();
    const seen = onbSeen[r.key];
    if (!seen || seen.state !== state) {
      onbSeen[r.key] = { state, from: seen ? seen.state : null, at: now };
    }
    const { from, at } = onbSeen[r.key];
    const since = now - at;
    const justDone = state === 'done' && from !== null && from !== 'done' && since < 600;
    const justOpened = state === 'active' && from !== null
                       && !['active', 'failed', 'running'].includes(from) && since < 900;
    const motion = (el, cls, delay) => {
      el.classList.add(cls);
      el.style.animationDelay = `${delay - since}ms`;
    };
    // Still to come, however it is judged: a name, dimmed, with nothing to press.
    const quiet = state === 'locked' || (state === 'unknown' && blocked);

    const row = document.createElement('div');
    row.className = 'flex gap-space-md items-stretch';
    row.dataset.stage = r.key;
    row.dataset.state = state;

    // The line down the left: what makes this a pipeline rather than a list,
    // and it goes green behind you.
    const rail = document.createElement('div');
    rail.className = 'flex flex-col items-center shrink-0 w-5';
    const [mark, cls] = quiet ? ONB_MARK.locked : ONB_MARK[state];
    const dot = document.createElement('span');
    dot.className = 'font-code-md text-code-md leading-6 ' + cls;
    if (justDone) motion(dot, 'onb-tick', 0);
    dot.textContent = mark;
    rail.append(dot);
    if (i < rungs.length - 1) {
      const line = document.createElement('div');
      line.className = 'w-px flex-1 min-h-[12px] my-1 '
        + (r.ok === true ? 'bg-primary/70' : 'bg-surface-variant');
      if (justDone) motion(line, 'onb-fill', 140);
      rail.append(line);
    }

    const body = document.createElement('div');
    body.className = 'min-w-0 flex-1 ' + (quiet || state === 'done' ? 'pb-space-sm' : 'pb-space-lg');
    const head = document.createElement('div');
    head.className = 'flex items-baseline justify-between gap-space-sm';
    const title = document.createElement('div');
    title.className = 'leading-6 ' + (state === 'done' ? 'font-body-md text-body-md text-on-surface-variant'
      : quiet ? 'font-body-md text-body-md text-outline'
      : state === 'failed' ? 'font-body-md text-body-md text-error font-medium'
      : 'font-body-md text-body-md text-on-surface font-medium');
    title.textContent = state === 'done' ? copy.done() : copy.name;
    head.append(title);
    const tag = { running: onbWaiting ? 'waiting for browser' : 'working', failed: 'failed',
                  verifying: 'checking\u2026', loading: 'loading\u2026',
                  checking: 'checking…' }[state];
    if (tag && !quiet) {
      const t = document.createElement('span');
      t.className = 'font-code-sm text-code-sm shrink-0 '
        + (state === 'failed' ? 'text-error' : state === 'checking' ? 'text-outline' : 'text-tertiary');
      t.textContent = tag;
      head.append(t);
    }
    body.append(head);

    const unit = document.getElementById('onb-unit-' + r.key);
    const hasLog = unit && Number($(onbLogId(r.key)).dataset.n || 0) > 0;
    const place = () => {
      if (!unit) return;
      body.append(unit);
      const pre = unit.querySelector('pre');
      pre.scrollTop = unit.dataset.follow === 'no' ? Number(unit.dataset.scroll || 0) : pre.scrollHeight;
    };

    if (quiet || state === 'checking') { row.append(rail, body); wrap.append(row); return; }
    if (state === 'done') {
      // What it did stays, folded: you can still look at what the install said.
      if (hasLog) place();
      row.append(rail, body); wrap.append(row); return;
    }
    if (state === 'unknown') {
      const why = document.createElement('div');
      why.className = 'font-body-sm text-body-sm text-on-surface-variant mt-0.5';
      why.textContent = 'Check failed.';
      body.append(why);
      const b = document.createElement('button');
      b.className = 'btn mt-space-sm';
      b.textContent = 'Try again';
      b.onclick = retryReads;
      body.append(b);
      row.append(rail, body); wrap.append(row); return;
    }

    // The open step: why it matters, what is happening, and the one thing to do.
    const inner = document.createElement('div');
    if (justOpened) motion(inner, 'onb-open', 260);
    const said = state === 'verifying' ? ONB_VERIFY[r.key] || 'Done. Checking\u2026'
      : state === 'running' && onbWaiting
      ? 'Complete sign-in in your browser. Setup continues automatically.'
      : copy.body();
    if (said) {
      const why = document.createElement('div');
      why.className = 'font-body-sm text-body-sm text-on-surface-variant mt-0.5';
      why.textContent = said;
      inner.append(why);
    }
    // The tools themselves, rather than a sentence about them: what is already
    // here in green, what is missing in red.
    if (r.key === 'tools' && depsNow) {
      const list = document.createElement('div');
      list.className = 'flex flex-wrap gap-space-xs mt-space-sm';
      list.id = 'onb-tools';
      for (const t of neededTools()) {
        const chip = document.createElement('span');
        const broken = t.tool === 'aws' && cliBroken();
        const recheck = state === 'verifying' && onbWasMissing.has(t.tool);
        const ok = t.present && !broken;
        chip.className = 'pill ' + (recheck ? '' : ok ? 'pill-ok' : 'pill-bad');
        chip.dataset.tool = t.tool;
        chip.dataset.present = recheck ? 'checking' : ok ? 'yes' : 'no';
        chip.textContent = (recheck ? '\u2026 ' : ok ? '\u2713 ' : '\u2717 ') + t.label
          + (broken && !recheck ? ' (installed, but not working)' : '');
        list.append(chip);
      }
      inner.append(list);
    }
    // The server: the form, kept across paints so nothing typed is lost.
    if (r.key === 'server') inner.append(serverForm);
    if (onbNote && state === 'failed') {
      const note = document.createElement('div');
      note.className = 'font-body-sm text-body-sm text-error mt-space-sm';
      note.textContent = onbNote;
      inner.append(note);
    }
    body.append(inner);
    if (state === 'running' || state === 'verifying' || hasLog) place();

    const bar = document.createElement('div');
    bar.className = 'flex flex-wrap items-center gap-space-sm mt-space-md';
    if (state === 'verifying') {
      // Nothing to press while the answer is on its way.
    } else if (state === 'running' && (onbQueued || ONB_NO_STOP.has(r.key))) {
      // Nothing to stop: the reads it waits on are the app's, and the write is instant.
    } else if (state === 'running') {
      // Stopping has to reach ayis: a sign-in is waiting on a browser that may
      // never answer, and a package manager can be sitting on a lock.
      const stop = document.createElement('button');
      stop.className = 'btn';
      stop.textContent = onbWaiting ? 'Stop waiting' : 'Stop';
      stop.onclick = () => { if (onbJob !== null) window.ayis.cancel(onbJob); };
      bar.append(stop);
    } else {
      for (const a of onbActions(r)) {
        const b = document.createElement('button');
        b.className = a.plain ? 'btn' : 'btn btn-primary';
        b.disabled = !!a.busy;
        b.textContent = state === 'failed' && a.go !== retryReads ? 'Try again' : a.label;
        b.onclick = () => { onbNote = ''; onbTone = ''; a.go(); };
        bar.append(b);
        if (a.note) {
          const n = document.createElement('span');
          n.className = 'font-code-sm text-code-sm text-outline';
          n.textContent = a.note;
          bar.append(n);
        }
      }
    }
    if (bar.childElementCount) body.append(bar);
    row.append(rail, body);
    wrap.append(row);
  });
}


// What ayis is doing, for the pipeline's log pane and for the refusal when
// something else holds the lock. The nine reads each have a sentence; see
// AYIS_WORDS.
//
// There used to be a popup here - three modes of it - which said the same
// things in front of the window instead of in it. The pipeline on the
// dashboard says them in place, so the popup and the header's
// "running: ayis machines, ayis refresh" are both gone.

// True when there is something to talk to. A main process too old to answer -
// or a test stub - says nothing, and is taken at its word: carry on, and let
// the reads report whatever they find.
let engineGone = null;
async function engineReady() {
  let e;
  try { e = await window.ayis.engine(); } catch { return true; }
  if (!e || e.found) { engineGone = null; return true; }
  engineGone = e;
  paintOnboard();
  return false;
}

// The reads are free, and a laptop that could not reach AWS a minute ago may be
// able to now. Cancelling first, which is the part that matters: reads do not
// block each other, so starting a second set leaves the stuck ones exactly
// where they were - in `jobs`, where a job in flight is what disables Build,
// Play and Destroy.
async function retryReads() {
  for (const [id, job] of [...jobs]) if (!job.write && !hostRun(job)) await window.ayis.cancel(id);
  if (!(await engineReady())) return;
  return refreshAll();
}

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
// each: told as each read lands, so a popup can tick them off.
async function refreshAll(each) {
  gateShut = false;
  await Promise.all(GATE_READS.map(([args, json]) =>
    runAyis(args, { json, group: 'refresh' }).then(() => each && each(json))));
  paintOnboardSoon();
  // A prerequisite is missing. The reads that need AWS or a tailnet would
  // every one come back unknown, and the pipeline is already showing the one
  // thing to do about it.
  if (gateBlocked()) { gateShut = true; return; }
  return readBehindGate(each);
}
// Only a stage judged on a gate read can keep the gate shut. "Where it runs"
// is judged on `ayis machines`, which is BEHIND the gate - letting it shut the
// gate would stop the very read that answers it, and leave the region popup
// with nothing to list.
const GATE_JSON = new Set(GATE_READS.map(([, json]) => json));
const gateBlocked = () => awsInPlay() && prereqs('aws').some(r => r.ok === false && GATE_JSON.has(r.reads));
function gateMayOpen() {
  if (gateBlocked()) return;
  gateShut = false;
  readBehindGate();
}
async function readBehindGate(each) {
  for (const v of Object.keys(NEEDS)) loaded.add(v);
  readingBehindGate++;
  // In parallel, because they share nothing and each screen paints when its own
  // answer lands. ayis cost is not among them: it bills.
  try {
    await Promise.all(forMode(ALL_READS).map(([args, json]) =>
      runAyis(args, { json, group: 'refresh' }).then(() => each && each(json))));
  } finally { readingBehindGate--; }
  paintOnboard();
  firstScan();             // not awaited: a first scan takes 90 seconds
}

// A laptop that has never scanned shows one region - the one .env names - and
// that reads as "where did the other regions go". The scan that fills the table
// is free, so it is started once, by itself, after the first set of reads. It
// is NOT awaited by anything: the window is usable throughout, and the table
// says what it is waiting for.
//
// Once only, and never when a scan is already remembered, however old: a
// remembered scan is what the button is for.
let scanOffered = false;
async function firstScan() {
  if (scanOffered || sweeping) return;
  // Locations are AWS's: with no AWS machine, there is nothing to measure.
  if (!awsInPlay()) return;
  if (sweepNow && (sweepNow.regions || []).length) return;
  // Something is running: a scan can wait, and ayis would refuse to start one
  // underneath a build anyway.
  if (jobs.size) return;
  scanOffered = true;
  return scanRegions($('s-sweep'));
}

$('refresh').onclick = () => refreshShown();
