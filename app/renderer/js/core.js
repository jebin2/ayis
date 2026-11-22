'use strict';
// The view's core: jobs and the header, dialogs, toasts and notes, the log, questions asked mid-run, and the formatters.
// One of the renderer's scripts, loaded in order by index.html into one shared scope
// (docs/architecture.md, "The app").

// The view. It knows which ayis command fills which panel, and renders the fields
// ayis hands it - no AWS, no prices of its own, and no parsing of the human
// tables that arrive inside a report event.

const $ = id => document.getElementById(id);

// Several runs can be in flight: reading status, the watcher and the archive
// index are independent, so they go together. Each job remembers which screen
// started it and what to do with its answer.
const jobs = new Map();          // id -> { cmd, view, json, panel, collect, age, out, resolve }

// What a run is called, so a button can say what it stops rather than "Stop".
// A command is more than its first word. `ayis library list` reads an index;
// `ayis library push` spends ten minutes uploading your games - and this table
// used to be keyed on `library` alone, TWICE, so the second one won and a
// mirror to S3 was called a refresh: "running: ayis refresh" in the header and
// "Stop refresh" on the button that would abandon it.
//
// Longest match first, and flags are not part of the name.
const byCommand = (table, cmd) => {
  const words = cmd.filter(a => !a.startsWith('-'));
  for (let n = Math.min(3, words.length); n > 0; n--) {
    const hit = table[words.slice(0, n).join(' ')];
    if (hit !== undefined) return hit;
  }
  return undefined;
};

// The header groups runs rather than listing them: `ayis status` and `ayis watcher`
// are two commands and one refresh to whoever clicked it.
const RUN_NAME = {
  init: 'the build', destroy: 'deleting', open: 'the session', check: 'the check',
  status: 'the refresh', watcher: 'the refresh', 'library list': 'the refresh',
  cost: 'loading the bill', 'host list': 'the refresh', 'host status': 'the refresh',
  'library push': 'the games change', 'library pull': 'the games change',
  'library clean': 'the games change', 'library forget': 'the games change',
  'library move': 'the games change', 'library reset': 'the games change',
  'library keep-for': 'the games change', 'library account': 'the login change',
  'disk add': 'adding space',
  'clip send': 'copying to the game PC', 'clip get': 'copying from the game PC',
};
const runName = cmd => byCommand(RUN_NAME, cmd) || cmd[0];

// What each command IS, in a person's words. One table, because these words are
// said in three places - the opening popup, the dashboard's activity list, and
// the refusal when something else holds the lock - and three tables of the same
// facts is how `library` came to mean two things.
//
//   name  what it is called, as a NOUN, so it can be the subject of a sentence:
//         "the build is still running", "the mirror to S3 finished".
const AYIS_WORDS = {
  deps: { name: 'the tool check' },
  creds: { name: 'the AWS key check' },
  'creds tailscale': { name: 'the Tailscale check' },
  config: { name: 'reading your settings' },
  status: { name: 'the machine check' },
  watcher: { name: 'the auto-stop check' },
  'library list': { name: 'reading your saved games' },
  'library elsewhere': { name: 'looking for games in other locations' },
  machines: { name: 'reading machine prices' },
  sweep: { name: 'checking all locations' },
  cost:              { name: 'loading the bill' },
  check:             { name: 'the laptop check' },
  'watchdog logs':   { name: 'loading the auto-stop history' },
  'config set':      { name: 'saving a setting' },
  // Everything ayis says runs alone - see `ayis --contract`, and the test that
  // holds this list to it. These are the ones whose name ends up on a Stop
  // button, so none of them may read as something cheap.
  init:                      { name: 'the build' },
  destroy:                   { name: 'deleting the machine' },
  open:                      { name: 'the game session' },
  stop:                      { name: 'stopping the machine' },
  'library push':            { name: 'saving your games' },
  'library pull':            { name: 'downloading your games' },
  'library forget':          { name: 'deleting a game' },
  'library clean':           { name: 'cleaning up leftover files' },
  'library move':            { name: 'moving a game' },
  'library reset':           { name: 'keeping a game' },
  'library keep-for':        { name: 'changing how long games are kept' },
  'library account':         { name: 'changing the Steam login' },
  'disk add':                { name: 'adding space for your games' },
  'clip send':               { name: 'copying to the game PC' },
  'clip get':                { name: 'copying from the game PC' },
  'creds set':               { name: 'saving your AWS key' },
  // Longer than 'creds set', which is the AWS key: without this, saving a
  // Tailscale token was announced as saving an AWS one.
  'creds set tailscale':     { name: 'saving the Tailscale token' },
  'creds tailscale signin':  { name: 'signing in to Tailscale' },
  'creds tailscale authkey': { name: 'saving the auth key' },
  'deps install':            { name: 'installing tools' },
  'host list':               { name: 'reading your machines' },
  'host status':             { name: 'checking your machine' },
  'host add':                { name: 'adding a machine' },
  'host remove':             { name: 'removing a machine' },
  'host setup':              { name: 'setting up your machine' },
  'host open':               { name: 'the game session on your machine' },
};
const ayisWords = cmd => byCommand(AYIS_WORDS, cmd) || {};
// Falls back to the command itself: a name nobody wrote down is better said in
// ayis's words than guessed at.
const ayisName = cmd => ayisWords(cmd).name || 'a background task';
// The same, to start a sentence with.
const AyisName = cmd => { const s = ayisName(cmd); return s.charAt(0).toUpperCase() + s.slice(1); };
// Runs long enough to be worth going back to.
const WATCHABLE = new Set(['init', 'destroy', 'open']);
const LONG_LIBRARY = new Set(['push', 'pull', 'clean']);
const watchable = cmd => WATCHABLE.has(cmd[0]) || (cmd[0] === 'library' && LONG_LIBRARY.has(cmd[1]));
const jobsHere = () => [...jobs.values()].filter(j => j.view === view);

// A screen's button answers for that screen. The one real dependency is that a
// build or a destroy runs alone - ayis refuses anything else while one is in
// flight - so those disable the rest. Reads never block each other.
//
// WHICH commands those are is not written down here any more. It used to be,
// in two places - this file and the main process - and the two disagreed three
// times, silently, because a command that is never started looks exactly like
// one that returned nothing. ayis publishes the rule (ayis --contract), the main
// process applies it, and the answer comes back with the job as job.write.
const writing = () => [...jobs.values()].some(j => j.write);
// Why a read was refused: the run ayis is doing alone, by name.
const busyWhy = () => {
  const alone = [...jobs.values()].find(j => j.write);
  return alone ? `waits for ${ayisName(alone.cmd)} to finish.` : 'another task is running.';
};
const jobsFor = cmd => [...jobs.values()].some(j => j.cmd[0] === cmd);
// The AWS machine's game session (or its start), as [id, job] pairs.
const openJobs = () => [...jobs].filter(([, j]) => j.cmd[0] === 'open');
// A machine of yours waits while ayis runs something alone - an AWS build, a
// delete, a session: ayis refuses its setup or stream at the start, and pressed
// anyway, the step read as failed with "Waiting for the build to finish."
// Greyed instead, saying what it waits for, and back the moment that ends.
// dataset.off is what the card itself decided; this only adds the wait.
function lockHostButtons() {
  const alone = [...jobs.values()].find(j => j.write);
  const why = alone ? `Waits for ${ayisName(alone.cmd)} to finish` : '';
  for (const b of document.querySelectorAll('[data-host] button[data-f=play], [data-host] button[data-f=setup]')) {
    b.disabled = b.dataset.off === '1' || !!alone;
    if (alone) b.title = why;
    else if (b.title.startsWith('Waits for ')) b.title = '';
  }
}
// Setting up or streaming from a machine of yours: minutes to hours, and
// nothing to do with AWS, so they are not reads to cancel or wait out. They
// have their own Stop, on the machine's card.
const hostRun = j => j.cmd[0] === 'host' && (j.cmd[1] === 'setup' || j.cmd[1] === 'open');
// What the header's Stop leaves alone: a machine of yours and an AWS session (the
// card has Stop session) and a build (its card has Cancel).
const headerSpares = j => hostRun(j) || j.cmd[0] === 'init' || j.cmd[0] === 'open';
// Woken each time a job ends - see readsSettled.
const jobEnded = [];
// Until the reads in flight have landed. A step's own command runs alone (ayis
// --contract), so it is refused while anything else runs - and a step's button
// is offered the moment its own read lands, with the rest still landing: the
// Tailscale sign-in after an install was refused that way, every time, by the
// reads the install had set off. Waits on the jobs ending, never on a timer.
// A machine of yours setting up or streaming is not waited for: it can take
// hours, and the refusal then says so.
async function readsSettled() {
  while ([...jobs.values()].some(j => !hostRun(j))) await new Promise(r => jobEnded.push(r));
}

// A read that failed, keyed by the read, so a later success for the same read
// clears it. The screens show their own unknowns; this is what the pipeline
// reads to say WHY something is unknown.
const readFailures = new Map();

function updateHeader() {
  const mine = jobsHere();
  const busy = writing();
  // The dashboard's refresh is two commands - status and the watcher - but one
  // action to you, so count what they are called, not how many there are.
  // Stop is for what changes something - a build, a delete, a session, an
  // install. A read finishes in seconds and says so where it was asked (the
  // Refresh popup, a Fetch button); a Stop appearing for it was noise.
  lockHostButtons();
  // A build is not stopped here: its card has Cancel, which also deletes the
  // machine. A second button beside it that stopped ayis and left the machine
  // billing was the same click with a worse ending.
  const stoppable = mine.filter(j => j.write && !headerSpares(j));
  const hereNames = [...new Set(stoppable.map(j => j.group || runName(j.cmd)))];
  $('cancel').hidden = !stoppable.length;
  if (stoppable.length) $('cancel-label').textContent =
    hereNames.length === 1 ? `Stop ${hereNames[0]}` : `Stop ${hereNames.length} runs`;

  // Point at a run only when it is worth watching: a build or a destroy takes
  // minutes and has its own screen. A refresh finishes in seconds and paints
  // itself, so sending you to another tab for it is noise.
  const elsewhere = [...jobs.values()].find(j => watchable(j.cmd) && j.view !== view);
  $('goto').hidden = !elsewhere;
  if (elsewhere) {
    // Named in full here, not grouped: this points at one run, and what it is
    // decides whether you want to go and watch it.
    $('goto-label').textContent = `${AyisName(elsewhere.cmd)} is running · show it`;
    $('goto').dataset.view = elsewhere.view;
  }

  // Cost has a Refresh like every screen, but it carries its price: one Cost
  // Explorer call, $0.01. It is never fetched automatically - only this click.
  $('refresh').hidden = (!NEEDS[view] && view !== 'cost') || mine.some(j => !hostRun(j));
  $('refresh').disabled = busy;                    // only a build or destroy blocks a read
  $('refresh-cost').hidden = view !== 'cost' || !$('refresh-cost').textContent;
  if ($('refresh-age')) $('refresh-age').hidden = view !== 'cost' || !costNowAt;
  // These change something, so they wait for whatever else is running.
  // Only a run that changes something takes them away. A read - the one Refresh
  // or Play itself makes - used to, and the button vanished and came back.
  for (const b of ['b-build', 'b-open', 'b-destroy', 'd-open', 'd-destroy', 'd-build'])
    $(b).disabled = writing();
  for (const b of ['b-open', 'd-open']) if (sessionNow) $(b).disabled = true;

  // A build starting or finishing is the dashboard's news too.
  paintDash();
}

// The dashboard's activity list: what ayis did in this window. The app keeps no
// history beyond it - the durable record is the watchdog's own log, shown on
// the Guards screen.
// A dialog leaves the way it came in - sinking a little and fading, the room
// brightening behind it - then closes. With less motion asked for, at once.
// Opened again meanwhile (keepOpen), it stays.
const closing = new WeakMap();
function closeDialog(dlg, rv) {
  if (!dlg.open || closing.has(dlg)) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !dlg.animate) { dlg.close(rv); return; }
  const opts = { duration: 160, easing: 'ease-in', fill: 'forwards' };
  const anims = [dlg.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(4px) scale(.98)' }], opts)];
  try { anims.push(dlg.animate([{ opacity: 1 }, { opacity: 0 }], { ...opts, pseudoElement: '::backdrop' })); } catch { /* no backdrop animation here */ }
  const job = { kept: false };
  closing.set(dlg, job);
  // Closed when the motion's time is up, not on its finished promise: an
  // animation the compositor never runs would leave the dialog open for good.
  afterBeat(() => {
    if (job.kept) return;
    closing.delete(dlg);
    if (dlg.open) dlg.close(rv);
    for (const a of anims) a.cancel();
  }, opts.duration);
}
function keepOpen(dlg) {
  const job = closing.get(dlg);
  if (!job) return;
  job.kept = true;
  closing.delete(dlg);
  for (const a of dlg.getAnimations()) a.cancel();
}

// toast(text, tone) - a word that outlasts the dialog it came from, until it
// is dismissed.
function toast(text, tone) {
  const t = el('div', 'toast flex items-start gap-space-sm p-space-md rounded-lg bg-surface-container-high border '
    + (tone === 'warn' ? 'border-tertiary' : tone === 'bad' ? 'border-error' : 'border-surface-variant'));
  t.append(el('span', 'font-body-sm text-body-sm text-on-surface flex-1', text));
  const x = el('button', 'btn shrink-0', '\u00d7');
  x.title = 'Dismiss';
  x.onclick = () => t.remove();
  t.append(x);
  $('toasts').append(t);
  return t;
}

function note(text, tone) {
  activity.unshift({ at: new Date(), text, tone });
  activity.length = Math.min(activity.length, 8);
  const wrap = $('d-activity');
  if (!wrap) return;
  wrap.textContent = '';
  if (!activity.length) {
    const el = document.createElement('span');
    el.className = 'text-outline';
    el.textContent = 'Nothing yet';
    wrap.append(el);
    return;
  }
  for (const a of activity) {
    const row = document.createElement('div');
    row.className = 'flex gap-space-sm';
    const t = document.createElement('span');
    t.className = 'text-outline shrink-0';
    t.textContent = a.at.toLocaleTimeString();
    const b = document.createElement('span');
    b.className = a.tone || 'text-on-surface-variant';
    b.textContent = a.text;
    row.append(t, b);
    wrap.append(row);
  }
}

// The event stream, filtered. Rows carry their kind so a filter can hide them
// without the app keeping a second copy of the log.
let logFilter = 'steps';

function logKind(event) {
  if (event.t === 'error' || event.kind === 'fail') return 'problems';
  if (event.t === 'step' || event.t === 'step_end') return 'steps';
  return 'other';
}

// What a row is, in a word.
const LOG_WORD = { step: 'Step', error: 'Problem', fail: 'Problem', warn: 'Note', ask: 'Question',
                   ok: 'Done', wait: 'Waiting', raw: 'Data' };
function logShown(row) {
  return logFilter === 'all' || row.dataset.group === logFilter;
}
// A wait is an event every few seconds; the log keeps the first and the last of
// each, and the live line shows the rest.
let lastWaitLogged = '';
function logLine(event) {
  if (event.t === 'part') return;
  if (event.t === 'wait') {
    if (event.state === 'waiting' && lastWaitLogged === event.id) return;
    lastWaitLogged = event.state === 'waiting' ? event.id : '';
  }
  const kind = event.kind || event.t;
  const row = document.createElement('div');
  row.dataset.group = logKind(event);
  row.className = 'log-row';
  row.hidden = !logShown(row);
  row.innerHTML = '<time></time><span class="k"></span><span class="t"></span>';
  row.querySelector('time').textContent = (event.at || '').slice(11, 19)
    || new Date().toLocaleTimeString();
  row.querySelector('.k').textContent = event.t === 'exit' ? (event.rc === 0 ? 'Done' : 'Stopped')
    : LOG_WORD[event.t === 'line' ? event.kind : event.t] || '';
  row.querySelector('.k').className = 'k ' + (event.t === 'exit' ? (event.rc === 0 ? 'ok' : 'fail') : kind);
  row.querySelector('.t').textContent =
    (event.t === 'wait' ? `${event.text}${event.state === 'waiting' ? '' : ' - ' + event.state} (${event.secs} s)` : event.text)
    || event.prompt || (event.t === 'exit' ? (event.rc === 0 ? 'Finished' : 'Did not finish') : '');
  const log = $('log');
  log.append(row);
  // A long build is thousands of lines; the window keeps the last 2000.
  while (log.children.length > 2000) log.firstChild.remove();
  logCount += 1;
  $('log-count').textContent = `${logCount} event${logCount === 1 ? '' : 's'}`;
  if ($('log-follow').checked) log.scrollTop = log.scrollHeight;
}

function applyLogFilter(which) {
  logFilter = which;
  for (const row of $('log').children) row.hidden = !logShown(row);
  for (const b of document.querySelectorAll('[data-filter]')) {
    b.classList.toggle('btn-primary', b.dataset.filter === which);
  }
}

// The app's own confirmation. window.confirm draws a native alert box that
// belongs to no design and says the app's name in its title bar.
// word: what cannot be undone asks for a word typed out; Yes waits for it.
function askConfirm({ title, body, yes = 'Continue', no = 'Cancel', danger = false, word = null }) {
  return new Promise(resolve => {
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    // No Cancel when there is nothing to decline - a dialog that only informs.
    $('confirm-no').hidden = no === null;
    $('confirm-no').textContent = no || '';
    const btn = $('confirm-yes');
    btn.textContent = yes;
    btn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    const input = $('confirm-word');
    $('confirm-word-row').hidden = !word;
    input.value = '';
    btn.disabled = !!word;
    if (word) {
      $('confirm-word-label').textContent = `Type ${word} to confirm`;
      input.oninput = () => { btn.disabled = input.value.trim() !== word; };
      // Enter would submit the form's first button, which is Cancel.
      input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); if (!btn.disabled) btn.click(); } };
    }
    const dlg = $('confirm');
    dlg.onclose = () => resolve(dlg.returnValue === 'yes');
    dlg.showModal();
    if (word) input.focus();
  });
}

function ask(id, event) {
  // A question the app knows is asked in its own words; ayis's prompt is written
  // for a terminal ("[d] destroy  [n] leave it running:").
  $('ask-prompt').textContent = ASK_QUESTION[event.id] || event.prompt || event.id;
  const input = $('ask-input');
  const box = $('ask-choices');
  // ayis states the answers it accepts. When it does, this is a CHOICE, and a
  // free-text field is the wrong control for one: the build sat on a dialog
  // reading "choice [1]:" with no sign of what the choices were, because the
  // options ayis had printed went to the log pane behind the modal.
  const choices = (event.choices || '').split(',').map(c => c.trim()).filter(Boolean);
  box.textContent = '';
  box.hidden = choices.length === 0;
  input.hidden = choices.length > 0;
  if (choices.length) {
    // Radios, not a <select>: two or three options are worth showing at once,
    // and the default has to be visibly the default.
    for (const c of choices) {
      const row = document.createElement('label');
      row.className = 'row font-code-md text-code-md cursor-pointer';
      const r = document.createElement('input');
      r.type = 'radio'; r.name = 'ask-choice'; r.value = c;
      r.className = 'accent-primary w-4 h-4 cursor-pointer';     // the app's green, not the browser's blue
      r.checked = c === (event.default || choices[0]);
      const txt = document.createElement('span');
      txt.textContent = ASK_CHOICE_LABEL[`${event.id}:${c}`] || c;
      row.append(r, txt);
      box.append(row);
    }
  } else {
    input.value = event.default || '';
    input.type = event.secret ? 'password' : 'text';
  }
  $('ask').showModal();
  if (choices.length) box.querySelector('input:checked')?.focus(); else input.focus();
  $('ask').onclose = () => {
    const picked = choices.length
      ? (box.querySelector('input:checked')?.value ?? event.default ?? '')
      : input.value;
    window.ayis.answer(id, picked);
  };
}

// A bare "1" or "2" in a dialog says nothing. ayis prints the meaning to the log,
// which is behind the modal, so the words are repeated here for the prompts
// where the answer is a number. Anything not listed falls back to the raw
// value, so a new prompt is terse rather than broken.
// Keyed <ask id>:<answer>. Distinct from CHOICE_LABEL further down, which maps
// a SETTING to labels for its values - same idea, different shape, and sharing
// one name for both silently shadowed the other.
// The ask ids this window knows by name: the ones it answers from a dialog it
// has already shown, and the one whose answers it spells out below. ayis owns
// these ids; they are written here only to be matched, and checkAsks() holds
// the two lists against each other at startup so a rename in ayis is loud.
const ASK = {
  awsId:      'aws-access-key-id',
  awsSecret:  'aws-secret-access-key',
  tsToken:    'tailscale-api-token',
  tsAuthKey:  'tailscale-auth-key',
  hostSudo:   'host-sudo',
  hostSshPw:  'host-ssh-password',
  awsDisconnect: 'aws-disconnect',
};
const ASK_QUESTION = {
  [ASK.hostSudo]: 'Sudo password for this machine. Used once for setup. Not stored.',
  [ASK.hostSshPw]: 'SSH password. Used once to install a key. Not stored.',
};
// A choice ayis offers, in plain words, by "<ask>:<answer>". None at present:
// the one there was - keep or delete the machine when a session ended - is
// no longer asked; closing Moonlight just ends the session.
const ASK_CHOICE_LABEL = {};
// Any id the window pre-answers but ayis no longer asks under is a modal waiting
// to appear in the middle of a build - which is exactly what this replaced.
async function checkAsks() {
  let asks;
  try { asks = await window.ayis.asks(); } catch { return; }
  if (!Array.isArray(asks) || !asks.length) return;   // ayis could not be asked
  const gone = Object.values(ASK).filter(id => !asks.includes(id));
  if (gone.length) {
    console.error('This app and its scripts are different versions. The scripts no longer ask: ' + gone.join(', ')
                  + ' - the app cannot answer it.');
    note(`Version mismatch: the scripts no longer ask for ${gone.join(', ')}. `
         + 'Update the app and the scripts together.', 'text-error');
  }
}

const GB = bytes => (bytes / 1073741824).toFixed(1) + ' GB';
// What Build starts billing: the machine card's price, so the two never differ.
function buildRate() {
  return statusNow ? machineFacts().price : null;
}
// A machine's hourly price as billed: the machine, its public address and its
// disk, which all bill by the hour while it exists. Every rate is AWS's, read by
// ayis; the rupee rate has GST in it. A GB-month is the hours of this month, as
// ayis says them.
function perHour(h, diskGb) {
  const r = (statusNow && statusNow.rates) || {};
  if (h == null || !r.inr_per_usd) return h ?? null;
  const gb = diskGb ?? ((statusNow && statusNow.config) || {}).disk_gb;
  return h + (r.ipv4_hour ? r.ipv4_hour * r.inr_per_usd : 0)
           + (gb && r.ebs_gb_month && r.month_hours ? gb * r.ebs_gb_month / r.month_hours * r.inr_per_usd : 0);
}
// Dollars to rupees at ayis's rate today. A saved scan carries the rupees of
// the day it ran; the dollars are AWS's, so they are converted again.
function inrNow(usd, given) {
  const k = statusNow && statusNow.rates && statusNow.rates.inr_per_usd;
  return usd != null && k ? usd * k : given ?? null;
}
// One price, or the spread when the zones disagree.
const hourText = (lo, hi) => lo == null ? null
  : hi != null && Math.round(hi * 100) > Math.round(lo * 100) ? `${rsh(lo)}–${rsh(hi)}` : rsh(lo);
function uptime(iso) {
  if (!iso) return '—';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
// The vendored icon font is subset by name, and Google's subsetting drops the
// ligatures - so an icon is addressed by codepoint, not by writing its name.
const ICON = {"attach_money": "", "bolt": "", "build_circle": "", "check_circle": "", "dashboard": "", "delete": "", "error": "", "public": "", "refresh": "", "rocket_launch": "", "schedule": "", "settings": "", "shield": "", "sports_esports": "", "stadia_controller": "", "storage": "", "terminal": ""};

function pill(parent, text, tone, icon) {
  const el = document.createElement('span');
  el.className = 'pill ' + (tone ? 'pill-' + tone : '');
  if (icon) {
    const i = document.createElement('span');
    i.className = 'material-symbols-outlined text-[14px]';
    i.textContent = ICON[icon] || '';
    el.append(i);
  }
  el.append(document.createTextNode(text));
  parent.append(el);
}

// Everything below reads fields from `ayis status --json`. If a screen ever wants
// something that is not there, the fix is a field in ayis - never a regex here.
function paintPing(d) { pingNow = d; paintDash(); }
function askPing(s) {
  const online = !!(s.box && s.box.state === 'running' && s.tailnet && s.tailnet.online);
  if (!online) { pingNow = null; return; }
  if (pingBusy || Date.now() - pingAt < 60000) return;
  pingBusy = true;
  pingAt = Date.now();
  runAyis(['ping', '--json'], { json: 'ping', group: 'refresh' }).then(() => { pingBusy = false; });
}

// A stopped machine's added games disk, read once per machine: how big it is and
// whether Saved games has everything on it (so deleting it loses nothing).
// A disk's rupees a month, from the rate ayis read. null when it has not been read.
const diskMonthInr = gb => {
  const r = (statusNow && statusNow.rates) || {};
  return r.ebs_gb_month && r.inr_per_usd ? gb * r.ebs_gb_month * r.inr_per_usd : null;
};
async function readStoppedDisk(s) {
  const b = s.box;
  if (!b || b.state !== 'stopped') { stoppedDisk = null; stoppedDiskFor = ''; return; }
  if (stoppedDiskFor === b.id) return;
  stoppedDiskFor = b.id;
  try { stoppedDisk = JSON.parse(await runAyis(['disk', '--json'], { capture: true })); }
  catch { stoppedDisk = null; stoppedDiskFor = ''; }
  paintMachineCards();
}
// The machines whose games disk this app removed: playing one asks which games
// to bring back, because they are no longer on it.
const diskRemoved = {
  has(id) { try { return (JSON.parse(localStorage.getItem('ayis-disk-removed') || '{}'))[id] === 1; } catch { return false; } },
  set(id, on) {
    try {
      const m = JSON.parse(localStorage.getItem('ayis-disk-removed') || '{}');
      if (on) m[id] = 1; else delete m[id];
      localStorage.setItem('ayis-disk-removed', JSON.stringify(m));
    } catch { /* a convenience: playing without the question still works */ }
  },
};
