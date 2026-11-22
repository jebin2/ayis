'use strict';
// Going between pages, and the actions: choose, scan, add a disk, Play, stop, keep and delete.
// One of the renderer's scripts, loaded in order by index.html into one shared scope
// (docs/architecture.md, "The app").

// What Stop costs depends on what is running, so say it before doing it.
const STOP_WARNING = {
  init: 'The machine may already be running and billing. Delete it from Home, '
      + 'or auto-stop ends it after 30 idle minutes.',
  destroy: 'Games are being saved. Stopping may lose changes since the last save '
         + 'and leave the machine running.',
  open: 'Ends the session only. The machine keeps running.',
};
// Settings is a long screen, and arriving on it is not the same as finding the
// thing you came for: the first instance-type picker went unnoticed entirely
// because it was below the fold. So anything that sends you to a setting
// scrolls to it and flashes it, and that is the ONLY way a key is set - one
// place per thing, the same rule the machine chooser follows.
function openMachines() {
  paintChooser();
  if (!$('machdlg').open) $('machdlg').showModal();
}
$('machdlg-close').onclick = () => { if (!machBusy()) $('machdlg').close(); };
// Esc closes it, except mid-scan or mid-save. Both, because Chromium honours a
// prevented cancel only once per user activation; a prevented keydown never
// becomes a close request at all.
$('machdlg').oncancel = e => { if (machBusy()) e.preventDefault(); };
$('machdlg').addEventListener('keydown', e => { if (e.key === 'Escape' && machBusy()) e.preventDefault(); });

function goSetting(el) {
  // The page the row is on: a setting has one home, and it is not always here.
  const sec = el && el.closest('section[data-view]');
  goView(sec ? sec.dataset.view : 'settings');
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // Restarting a running animation needs the class off, a reflow, then on.
  el.classList.remove('flash-attn');
  void el.offsetWidth;
  // The animation says when it is finished, so nothing here runs on a timer.
  el.addEventListener('animationend', () => el.classList.remove('flash-attn'), { once: true });
  el.classList.add('flash-attn');
}
// A settings row, by the key ayis calls it.
const settingEl = key => document.querySelector(`.row[data-key="${key}"]`);

function goView(v) {
  const link = document.querySelector(`.nav-item[data-view="${v}"]`);
  if (link && view !== v) link.click();
}
$('goto').onclick = () => {
  const target = $('goto').dataset.view;
  if (target) goView(target);
};
$('cancel').onclick = async () => {
  const mine = jobsHere().filter(j => !headerSpares(j));
  if (!mine.length) return;
  const names = mine.map(j => 'ayis ' + j.cmd.join(' ')).join(', ');
  const ok = await askConfirm({
    title: `Stop ${names}?`,
    body: mine.map(j => STOP_WARNING[j.cmd[0]]).find(Boolean)
       || (mine.some(j => j.write) ? 'It stops part-way. What it has done so far stays done.'
                                   : 'Read-only. Stopping them changes nothing.'),
    yes: 'Stop', danger: true,
  });
  if (!ok) return;
  for (const [id, j] of jobs) if (j.view === view && !headerSpares(j)) window.ayis.cancel(id);
};
mountMachineCard($('d-hero'), 'd');
mountMachineCard($('b-machine'), 'b');
$('d-fix').onclick = $('b-fix').onclick = () => openAdd('aws');
$('d-build').onclick = goAws;
$('d-watch').onclick = goAws;
$('d-ts-signin').onclick = signInTailscale;
$('d-library').onclick = () => goView('library');
applyLogFilter('steps');         // the default is shown as chosen, not just in force
restoreBill();                   // the last bill on this laptop, until a new check
for (const b of document.querySelectorAll('[data-filter]')) {
  b.onclick = () => applyLogFilter(b.dataset.filter);
}
$('log-files').onclick = async () => {
  try { const dir = await window.ayis.openLogs(); $('log-count').textContent = dir; }
  catch { $('log-count').textContent = 'Could not open the log folder'; }
};
$('log-clear').onclick = () => {
  $('log').textContent = '';
  logCount = 0;
  $('log-count').textContent = '0';
};
$('log-copy').onclick = async () => {
  const text = [...$('log').children].filter(r => !r.hidden)
    .map(r => [...r.children].map(c => c.textContent).join('  ')).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    $('log-count').textContent = 'Copied';
  } catch { $('log-count').textContent = 'Could not copy'; }
};
// Reading CloudWatch logs is free; it is manual only because it is rarely the
// thing you want, not because it costs anything.
$('log-cloud').onclick = async () => {
  const btn = $('log-cloud');
  btn.disabled = true;
  $('log-cloud-label').textContent = 'Loading…';
  $('log-cloud-out').textContent = 'Loading…';
  const out = await runAyis(['watchdog', 'logs'], { capture: true });
  btn.disabled = false;
  $('log-cloud-label').textContent = 'Load';
  // Refused - something runs alone - is not "nothing happened".
  $('log-cloud-out').textContent = out === undefined ? `Not loaded: ${busyWhy()}`
    : watchdogDigest(out) || 'Nothing in the last 3 hours.';
};
// The watchdog writes a line every 5 minutes, so three hours is ~40 copies of
// "nothing to do" around the three hourly lines that say anything. A line seen
// more than twice is said once, with how often and over what span; the rest
// are kept as written. Times are this laptop's, not UTC.
function watchdogDigest(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\S*\s+(?:ayis-watchdog:\s*)?(.*)$/);
    if (m) rows.push({ at: new Date(m[1] + 'Z'), msg: m[2] });
    else if (line.trim()) rows.push({ at: null, msg: line.trim() });
  }
  const hm = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const seen = new Map();
  for (const r of rows) seen.set(r.msg, (seen.get(r.msg) || []).concat(r));
  const out = [], done = new Set();
  for (const r of rows) {
    const all = seen.get(r.msg);
    if (all.length > 2) {
      if (done.has(r.msg)) continue;
      done.add(r.msg);
      const first = all[0].at, last = all[all.length - 1].at;
      out.push({ at: last, text: `${first && last ? `${hm(first)}–${hm(last)}` : ''}  ${r.msg}  (${all.length} checks)` });
    } else {
      out.push({ at: r.at, text: `${r.at ? hm(r.at) : ''}  ${r.msg}` });
    }
  }
  return out.map(o => o.text.trim()).join('\n');
}
// Both of these delete things in S3 for good. The app asks once, then ayis asks
// for the word typed out - CLEAN, FORGET - which the ask dialog renders.
// Keep for: the one rule for every saved game, saved and applied in one go
// (ayis library keep-for), so the dates in the table are the ones AWS acts on.
async function keepFor(n) {
  await libraryRun(['library', 'keep-for', String(n)],
                   n ? `Retention set to ${n} days` : 'Retention set to forever');
}
$('lib-clean').onclick = async () => {
  const ok = await askConfirm({
    title: 'Delete leftover files?',
    body: 'Files from an incomplete save. No game uses them.\n\n'
        + 'Saved games are not affected.',
    yes: 'Clean up', danger: true, word: 'CLEAN',
  });
  if (ok) await libraryRun(['library', 'clean'], 'Deleting leftover files', 'clean-orphans', 'CLEAN');
};
// Changing the machine is a `config set` - .env is where ayis keeps it, and the
// next build reads it from there. Re-read afterwards rather than assuming the
// write landed: the note and the chip both describe the new choice.
// Picking a price in the chooser sets THREE settings, because it is one
// decision. Region last on purpose: it is the one that invalidates the other
// two - a type that exists in Mumbai may not exist where you came from - so the
// type and model are already correct by the time the region moves to match.
async function chooseMachine(row, spot) {
  const cur = currentPick();
  if (row.region === cur.region && row.type === cur.type && spot === cur.spot) return;
  const price = spot ? row.spot : row.od;
  const moving = row.region !== cur.region;
  // Short lines in the words the table uses: what it is, what it costs, the
  // one catch. A move always says what it leaves behind: saved games belong to
  // a location, and a machine elsewhere cannot reach them.
  const body = [
    [row.type, row.gpu && gpuName(row.gpu, row.vram), row.store != null && `${row.store} GB fast drive`].filter(Boolean).join(' · '),
    `${spot ? 'Spot' : 'On-demand'}${price != null
      ? ` · ${hourText(perHour(price), spot && row.spotMax != null ? perHour(row.spotMax) : null)} an hour while it runs` : ''}`,
    spot ? 'Cheaper; can be reclaimed mid-session.' : 'Not reclaimed.',
    spot && row.score != null && row.score <= 2
      ? `Low spot capacity (${row.score}/10). A spot launch will likely fail.` : '',
    moving
      ? `Games saved in ${cur.region ? placeName(cur.region) : 'other regions'} are not available in `
        + `${placeName(row.region)}. Move them on the Games page, or Steam re-downloads them.` : '',
    boxNow ? 'Applies to the next build. The running machine is not changed.' : '',
  ].filter(Boolean).join('\n\n');
  const ok = await askConfirm({
    title: `Use ${row.type} in ${placeName(row.region)}?`,
    body, yes: moving ? 'Move' : 'Use it', danger: moving,
  });
  if (!ok) { paintChooser(); return; }            // put the old choice back
  choosing = true;
  paintChooser();
  const pop = busyPopup('Saving',
    `${row.type}, ${spot ? 'spot' : 'on-demand'}, ${placeName(row.region)}. Applies to the next build.`,
    'Saving');
  let saved = false;
  try {
  // Type and model first, then the region. A half-applied change is possible
  // whatever the order, so the order is chosen to leave the least wrong state:
  // the wrong type in the right region is a refused launch with a clear reason,
  // while the right type in the wrong region silently builds the wrong box.
  await runAyis(['config', 'set', 'GAME_INSTANCE_TYPE', row.type]);
  await runAyis(['config', 'set', 'GAME_SPOT', spot ? '1' : '0']);
  if (moving) await runAyis(['config', 'set', 'GAME_REGION', row.region]);
  // machines is per-region, so a move makes the old answer wrong; and the
  // games that fit depend on the machine's disk, so the library is read again.
  // Both halves of it: the library is a bucket per region, so after a move the
  // bucket that was "somewhere else" is the machine's own, and a stale list of
  // other places drew the same game twice, with a second login, until Refresh.
  await Promise.all([runAyis(['config', '--json'], { json: 'config' }),
                     runAyis(['machines', '--json'], { json: 'machines' }),
                     runAyis(['status', '--json'], { json: 'status' }),
                     runAyis(['library', 'list', '--json'], { json: 'library' }),
                     runAyis(['library', 'elsewhere', '--json'], { json: 'elsewhere' })]);
  saved = currentPick().type === row.type && currentPick().region === row.region;
  } finally {
    choosing = false;
    paintChooser();
    saved ? pop.done() : pop.fail('Not saved. See Activity for details.');
  }
}

// Scanning every region takes about 90 seconds, so nothing waits on it: the
// window opens on the remembered scan and this runs in the background, either
// from the button or - once, on a laptop that has never scanned - by itself.
// Every call it makes is free.
async function scanRegions(btn) {
  const was = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Checking all regions…'; }
  sweeping = true;
  paintChooser();                 // the table says what it is waiting for
  repaintWhereTo();
  const pop = $('machdlg').open
    ? busyPopup('Checking all regions', 'Measuring latency and prices (~90 s, free).',
                'Checking all regions')
    : null;
  try {
    await runAyis(['sweep', '--json'], { json: 'sweep' });
  } finally {
    sweeping = false;
    if (btn) btn.textContent = was;
    paintChooser();
    repaintWhereTo();
    if (pop) readFailures.has('sweep') ? pop.fail(readFailures.get('sweep')) : pop.done();
  }
}
const sweepBtn = $('s-sweep');
if (sweepBtn) sweepBtn.onclick = () => scanRegions(sweepBtn);

// Build's "Change": the chooser opens over the page you are on, so the choice
// is made where the build is - it used to send you to the top of Settings.
$('b-login-choice').onchange = async ev => {
  ev.target.disabled = true;
  await runAyis(['config', 'set', 'GAME_STEAM_LOGIN', ev.target.value]);
  await runAyis(['config', '--json'], { json: 'config' });
  ev.target.disabled = false;
};

// Add disk, on the running machine. ayis says what it will do (second) and how
// much room there is to add (max_add_gb); this only asks how much, says the
// price, and runs it.
const DISK_SIZES_GB = [50, 100, 200, 500];
// A second disk has to be added in Steam's own storage settings. The window stays
// until the person says they did (Done), and Done asks the machine whether Steam
// lists it: not Esc, not Cancel, and a Steam that is slow to write its list or a
// machine that cannot be reached never leaves the window stuck (Close anyway).
const diskdlgSteam = (on) => {
  const dlg = $('diskdlg');
  dlg.dataset.step = on ? 'steam' : '';
  for (const id of ['diskdlg-now', 'diskdlg-sizes', 'diskdlg-price', 'diskdlg-warn', 'diskdlg-no', 'diskdlg-yes']) $(id).hidden = on;
  $('diskdlg-steam').hidden = !on;
  $('diskdlg-done').hidden = !on;
  $('diskdlg-anyway').hidden = true;
  $('diskdlg-steam-msg').textContent = '';
  $('diskdlg-done').disabled = false;
};
// Esc is stopped at the key, as for the add and run windows: a cancel event the
// dialog has already been sent is not reliably stoppable.
$('diskdlg').addEventListener('keydown', e => { if (e.key === 'Escape' && $('diskdlg').dataset.step === 'steam') e.preventDefault(); });
$('diskdlg').addEventListener('cancel', e => { if ($('diskdlg').dataset.step === 'steam') e.preventDefault(); });
const diskdlgFinish = (words) => {
  diskdlgSteam(false);
  closeDialog($('diskdlg'));
  if (words) note(words, 'text-primary');
};
$('diskdlg-anyway').onclick = () => diskdlgFinish('Disk added. Add it in Steam > Settings > Storage when you want games on it');
$('diskdlg-done').onclick = async () => {
  const done = $('diskdlg-done'), msg = $('diskdlg-steam-msg');
  done.disabled = true;
  msg.textContent = 'Checking Steam…';
  let st = null;
  try { st = JSON.parse(await runAyis(['disk', '--json'], { capture: true })); } catch { /* said below */ }
  if (st && st.extra_in_steam) return diskdlgFinish('Steam is using the new disk');
  msg.textContent = st ? 'Steam does not list the drive yet. Add it in Settings > Storage, then press Done again.'
    : 'Could not check Steam on your game PC. If you added the drive, you can close this.';
  $('diskdlg-anyway').hidden = false;
  done.disabled = false;
};
async function openAddDisk() {
  const dlg = $('diskdlg'), yes = $('diskdlg-yes');
  const sizes = $('diskdlg-sizes');
  diskdlgSteam(false);
  $('diskdlg-title').textContent = 'Add disk';
  sizes.textContent = '';
  yes.disabled = true;
  yes.onclick = null;
  $('diskdlg-price').textContent = '';
  $('diskdlg-warn').textContent = '';
  $('diskdlg-now').textContent = 'Looking at your game PC…';
  if (!dlg.open) dlg.showModal();
  let st = null;
  try { st = JSON.parse(await runAyis(['disk', '--json'], { capture: true })); } catch { /* said below */ }
  if (!st || !st.running) {
    // Turned away because something else runs alone is not the same as not
    // being able to reach the game PC, and the person can wait for it.
    $('diskdlg-now').textContent = st ? 'Your game PC is not running, so its disk cannot be changed.'
      : writing() ? `Add disk ${busyWhy()} Try again then.`
      : 'Could not look at your game PC. Check that it is running and try again.';
    return;
  }
  const left = Math.round(st.free_gb), total = Math.round(st.total_gb);
  $('diskdlg-now').textContent = st.total_gb
    ? `Game space: ${Math.round(st.used_gb)} of ${total} GB used, ${left} GB free.` : 'Game space on your game PC.';
  if (st.max_add_gb < st.step_gb) {
    $('diskdlg-warn').textContent = 'Your game PC already has the most game space it can hold.';
    return;
  }
  const options = DISK_SIZES_GB.filter(n => n <= st.max_add_gb);
  let picked = options.includes(100) ? 100 : options[options.length - 1];
  const per = diskInrPerGbHour();
  const show = () => {
    yes.disabled = !(picked >= 1 && picked <= st.max_add_gb);
    yes.textContent = picked >= 1 ? `Add ${picked} GB` : 'Add disk';
    $('diskdlg-price').textContent = picked >= 1 && per != null
      ? `+${rsh(picked * per)} an hour while the machine exists` : 'Billed by the hour while the machine exists.';
    $('diskdlg-warn').textContent = [
      st.second ? 'A games disk is added beside the machine\'s fast drive. Your games stay where they are and nothing closes. When it is added, you add it in Steam\'s storage settings: the next window shows how.'
                : 'Takes about a minute. Your game keeps running. If Steam does not show the new space, close it and open it again.',
      st.second ? '' : 'AWS lets a disk be made bigger once every 6 hours.',
      'The disk is deleted with the machine.',
    ].filter(Boolean).join('\n');
  };
  for (const n of options) {
    const row = document.createElement('label');
    row.className = 'flex items-center gap-space-sm font-body-md text-body-md';
    const r = Object.assign(document.createElement('input'), { type: 'radio', name: 'diskdlg-size', value: String(n), checked: n === picked });
    r.className = 'accent-primary';
    r.onchange = () => { picked = n; other.value = ''; show(); };
    row.append(r, `${n} GB`);
    sizes.append(row);
  }
  const otherRow = document.createElement('label');
  otherRow.className = 'flex items-center gap-space-sm font-body-md text-body-md';
  const other = Object.assign(document.createElement('input'), { type: 'number', min: '1', max: String(st.max_add_gb), placeholder: 'Other' });
  other.className = 'field w-28';
  other.oninput = () => {
    picked = Math.ceil(Number(other.value) / st.step_gb) * st.step_gb || 0;
    for (const r of sizes.querySelectorAll('input[type=radio]')) r.checked = false;
    show();
  };
  otherRow.append(other, 'GB');
  sizes.append(otherRow);
  show();
  // The button closes the dialog itself (it is a form's); this runs first.
  yes.onclick = async () => {
    const gb = picked;
    if (!gb) return;
    const done = await libraryRun(['disk', 'add', String(gb)], 'Adding space', null, null, () => 'Your games were not touched.');
    if (done) {
      $('refdlg').close();
      if (st.second) {
        // Steam still has to be told about the new drive: stay until it is.
        diskdlgSteam(true);
        $('diskdlg-title').textContent = `Disk added: ${gb} GB`;
        $('diskdlg').showModal();
      } else {
        note(`Added ${gb} GB for your games`, 'text-primary');
      }
    }
  };
}

$('d-guards').onclick = () => goView('guards');
$('d-bill-more').onclick = () => goView('cost');
$('c-egress-settings').onclick = () => goView('settings');
// The only button on the dashboard that spends money, and it says so.
// Exact cost is the Spending page's own check: go there and press its Refresh,
// so the bill is read once, behind the same popup, and you are looking at it.
$('d-cost').onclick = () => { goView('cost'); $('refresh').click(); };
// A build, a delete and a session all report the same way - steps, lines, an
// exit - so they all run on the Build screen as steps, and starting one goes
// there. Watching a delete in a panel that says nothing was the complaint.
let runKind = 'init';
function startRun(args, opts = {}) {
  runKind = args[0];
  // A build picked up again by itself does not take you off the page you are
  // on; the machine card says it is building, and Watch the build opens it.
  // A session on a machine of yours runs on that machine's page.
  if (opts.host) goHost(opts.host);
  else if (!opts.stay) goAws();
  // The log at the foot of the Machine page is the build's, and only the build's:
  // a session, a delete and everything else have their own window, and the
  // Activity page keeps all of it.
  if (args[0] === 'init') {
    $('b-log').dataset.fresh = 'yes';
    $('b-log').textContent = '';
    $('b-log-title').textContent = 'Build log';
  }
  buildSteps = 0;
  buildStarted = Date.now();
  $('b-prog').className = 'h-full bg-primary rounded-full';
  $('b-prog').style.width = '0%';
  $('b-prog-step').textContent = 'Starting…';
  buildFailClear();
  runBegin(opts.host ? 'open' : args[0], opts);
  paintRun();
  // A machine of yours: its card turns to Streaming, with its Stop, once it runs.
  return runAyis(args, { ...(opts.env ? { env: opts.env } : {}), ...(opts.host ? { onStart: paintHostCards } : {}) });
}

// A machine that runs but has not finished building. Closing the app in the
// middle of a build ends this laptop's half of it - waiting for the box, then
// pairing Moonlight - while the box carries on setting itself up; opened again,
// "running" read as ready and the card offered Play on a box with no desktop.
// ayis status says whether the box is set up (ready) and whether this laptop's
// half finished (built). Either missing, it is shown as building, and the build
// is picked up again once: `ayis init` finds the same instance and launches
// nothing new, so it costs nothing beyond the machine already running.
function unfinished(box) {
  return !!(box && box.state === 'running' && (box.ready === false || box.built === false));
}
let resumedFor = null;
function resumeBuild(s) {
  const box = s && s.box;
  // Reads run beside it freely; a build, a delete or a stream already going is
  // left alone.
  if (!unfinished(box) || resumedFor === box.id || ['init', 'destroy', 'open'].some(jobsFor)) return;
  resumedFor = box.id;
  // No GAME_APPS: the box was given its games when it launched, and ayis keeps
  // that choice in .env - passing "none" here overwrote it, and with it the
  // restore's "109 of 160 GB" progress line.
  startRun(['init'], { stay: true });
  // Not this run's machine: it may hold a restore an hour in, so a failure
  // here leaves it for you, not for the automatic delete.
  if (run) run.reused = true;
}

// A build, with the games ticked now. Try again uses the ones the failed build
// had, so a retry builds the same machine.
function buildWith(apps, games, gamesGb) {
  return startRun(['init'], { env: { GAME_APPS: apps, GAME_EXTRA_DISK_GB: '0' }, apps, games, gamesGb });
}
function retryBuild() {
  const r = run || {};
  return buildWith(r.apps || 'none', r.games || 0, r.gamesGb || 0);
}

async function removeGameDisk() {
  const d = stoppedDisk, id = statusNow && statusNow.box && statusNow.box.id;
  if (!d || !d.removable || !id) return;
  const inr = diskMonthInr(d.extra_gb);
  const ok = await askConfirm({
    title: 'Remove the games disk?',
    body: `The ${d.extra_gb} GB disk is deleted${inr != null ? `, which saves about ${rs(inr)} a month` : ''}.\n\n`
        + 'Your games stay in Saved games. The next time you play, you pick which games to bring back, and a new disk is made for them.\n\n'
        + 'The machine itself stays, so it still starts quickly.',
    yes: 'Remove disk', danger: true,
  });
  if (!ok) return;
  const done = await libraryRun(['disk', 'remove'], 'Removing the games disk', null, null, () => 'Nothing was deleted.');
  if (done) {
    $('refdlg').close();
    diskRemoved.set(id, true);
    stoppedDiskFor = '';
    boxGames.dropDisk(id);
    note('Games disk removed', 'text-primary');
    await readStoppedDisk(statusNow);
  }
}
// ── Play: which saved games go on the machine ───────────────────────────────
//
// Nothing is put on a machine when it is built. Pressing Play lists the saved
// games, you tick the ones you want, and they are copied before the stream opens.
// What does not fit the machine's own fast drive goes on an added disk, made for
// the purpose and sized here (and changeable) before anything is spent.
const PLAY_PICKS_KEY = 'ayis-play-picks';
const playPicks = {
  get() { try { return JSON.parse(localStorage.getItem(PLAY_PICKS_KEY) || 'null'); } catch { return null; } },
  set(ids) { try { localStorage.setItem(PLAY_PICKS_KEY, JSON.stringify(ids)); } catch { /* a convenience */ } },
};
const GIB = 1073741824;
const HEADROOM_MIN_GB = 30, HEADROOM_SHARE = 0.2;
// Room kept free for what is downloaded later: a fifth of the games, at least 30 GB.
const headroomGb = gamesGb => Math.max(HEADROOM_MIN_GB, Math.ceil(gamesGb * HEADROOM_SHARE));
// Where the ticked games go and what disk that takes. driveFree is the fast
// drive's free GB (null when not known); extraHave the added disk already there.
function planPlay(chosen, driveFree, extraHave) {
  const need = chosen.reduce((n, g) => n + g.gb, 0);
  const head = headroomGb(need);
  if (!chosen.length) return { need, head, onDrive: [], onExtra: [], neededDisk: 0 };
  if (driveFree == null) return { need, head, onDrive: chosen, onExtra: [], neededDisk: 0, unknown: true };
  const { onDrive, onExtra } = placeGames(chosen, Math.max(0, driveFree - head));
  const over = onExtra.reduce((n, g) => n + g.gb, 0);
  const neededDisk = !onExtra.length || extraHave > 0 ? 0 : Math.max(EXTRA_DISK_STEP_GB, Math.ceil((over + head) / EXTRA_DISK_STEP_GB) * EXTRA_DISK_STEP_GB);
  return { need, head, onDrive, onExtra, neededDisk, over };
}

// Which games, and the disk. Resolves to {games, extraGb, extraIds}, or null on
// Cancel. `ctx` is what the machine told: drive free GB, the added disk it
// has (GB), and the games already on it.
function askPlayGames(ctx) {
  const all = ((libNow && !libNow.error && libNow.games) || []).slice().sort((a, b) => b.bytes - a.bytes);
  const onBox = ctx.onBox || new Set();
  const dlg = $('playdlg'), list = $('playdlg-games');
  const id = g => String(g.appid);
  // First time: the games that fit the fast drive, so nothing is bought unasked.
  // After that: what you ticked last time.
  const last = playPicks.get();
  const picked = new Set(onBox);
  if (last) { for (const g of all) if (last.includes(id(g))) picked.add(id(g)); }
  else {
    const fit = placeGames(all.filter(g => !onBox.has(id(g))).map(g => ({ id: id(g), gb: g.bytes / GIB })), ctx.driveFree == null ? null : Math.max(0, ctx.driveFree - HEADROOM_MIN_GB)).onDrive;
    for (const f of fit) picked.add(f.id);
  }
  // The added disk: 0 unless you ask for one, and never less than the ticked games
  // need. Ticking a game that does not fit what is free raises it; you can raise it
  // further, but not below what the games need.
  let diskGb = 0, want = 0;
  const chosen = () => all.filter(g => picked.has(id(g)) && !onBox.has(id(g))).map(g => ({ id: id(g), gb: g.bytes / GIB }));
  const plan = () => planPlay(chosen(), ctx.driveFree, ctx.extraHave);
  for (const x of ['playdlg-sub', 'playdlg-total', 'playdlg-price']) $(x).hidden = true;
  const paint = () => {
    const p = plan();
    const have = ctx.extraHave > 0;
    diskGb = have ? ctx.extraHave : Math.max(want, p.neededDisk);
    const maxed = !have && (diskGb > MAX_EXTRA_DISK_GB || p.neededDisk > MAX_EXTRA_DISK_GB);
    const note = $('playdlg-disk-note');
    $('playdlg-disk').hidden = false;
    $('playdlg-gb').value = String(diskGb);
    $('playdlg-gb').min = String(have ? diskGb : p.neededDisk);
    $('playdlg-gb').disabled = $('playdlg-plus').disabled = have;
    $('playdlg-minus').disabled = have || diskGb <= p.neededDisk;
    if (have) {
      $('playdlg-disk-text').textContent = `Games disk (already on this machine)`;
      note.textContent = p.onExtra.length && p.over > ctx.extraHave - 20
        ? 'The games may not all fit on it; any that do not are skipped and named. Remove the disk first to make a bigger one.'
        : '';
    } else {
      const month = diskGb ? diskMonthInr(diskGb) : null;
      $('playdlg-disk-text').textContent = 'Add disk';
      note.textContent = (p.onExtra.length
        ? `The ticked games need ${p.over.toFixed(1)} GB more than the machine has free, so at least ${p.neededDisk} GB.`
        : '') + (diskGb && month != null ? `${p.onExtra.length ? ' ' : ''}About ${rs(month)} a month.` : '');
    }
    const warn = $('playdlg-warn');
    warn.hidden = !maxed;
    warn.textContent = maxed ? `That is more than a game PC here can hold (${MAX_EXTRA_DISK_GB} GB of games disk). Untick a game.` : '';
    $('playdlg-yes').disabled = maxed;
  };
  list.textContent = '';
  if (!all.length) list.append(el('p', 'font-body-md text-body-md text-outline',
    libNow && libNow.error ? 'Saved games could not be read just now, so none can be brought back. Play still starts the machine.'
      : 'No saved games yet. Install games from Steam once you are in; Stop machine saves them.'));
  for (const g of all) {
    const row = el('label', 'flex items-center gap-space-sm font-body-md text-body-md');
    const cb = el('input', 'accent-primary'); cb.type = 'checkbox'; cb.checked = picked.has(id(g));
    const here = onBox.has(id(g));
    if (here) cb.disabled = true;
    cb.onchange = () => { if (cb.checked) picked.add(id(g)); else picked.delete(id(g)); paint(); };
    row.append(cb, el('span', 'grow', g.name || id(g)),
      el('span', 'font-code-sm text-code-sm text-outline', here
        ? `already on the machine${({ root: ' · root disk', extra: ' · games disk', nvme: ' · fast drive' })[ctx.where && ctx.where.get(id(g))] || ''}`
        : GB(g.bytes)));
    list.append(row);
  }
  const step = by => { want = Math.max(0, Math.min(MAX_EXTRA_DISK_GB, Math.round((diskGb + by) / EXTRA_DISK_STEP_GB) * EXTRA_DISK_STEP_GB)); paint(); };
  $('playdlg-minus').onclick = () => step(-EXTRA_DISK_STEP_GB);
  $('playdlg-plus').onclick = () => step(EXTRA_DISK_STEP_GB);
  $('playdlg-gb').oninput = null;
  $('playdlg-gb').onchange = () => { want = Math.max(0, Math.min(MAX_EXTRA_DISK_GB, Math.ceil((Number($('playdlg-gb').value) || 0) / EXTRA_DISK_STEP_GB) * EXTRA_DISK_STEP_GB)); paint(); };
  paint();
  return new Promise(resolve => {
    dlg.onclose = () => {
      if (dlg.returnValue !== 'yes') return resolve(null);
      const p = plan(), byId = new Map(all.map(g => [id(g), g]));
      playPicks.set([...picked]);
      const games = chosen().map(c => ({ appid: c.id, bytes: byId.get(c.id).bytes, name: byId.get(c.id).name || c.id }));
      const extraGb = ctx.extraHave > 0 ? ctx.extraHave : diskGb;
      resolve({ games, extraGb, extraIds: p.onExtra.map(g => g.id) });
    };
    dlg.returnValue = '';
    if (!dlg.open) dlg.showModal();
  });
}

// ── Play: the machine getting ready, and each game coming back ──────────────
let restoreUi = null;
function restoreShow(pick) {
  const dlg = $('restoredlg');
  $('restoredlg-title').textContent = 'Getting your machine ready';
  $('restoredlg-sub').textContent = pick.games.length ? 'Your games are being copied to the machine. This closes by itself when Moonlight opens.'
    : 'Connecting to your machine and starting the stream. This closes by itself when Moonlight opens.';
  $('restoredlg-steps').textContent = '';
  $('restoredlg-now').textContent = '';
  const box = $('restoredlg-games'); box.textContent = '';
  const rows = new Map();
  for (const g of pick.games) {
    const wrap = el('div', 'flex flex-col gap-0.5');
    const head = el('div', 'flex items-baseline justify-between gap-space-sm font-body-md text-body-md');
    const name = el('span', 'grow', g.name), info = el('span', 'font-code-sm text-code-sm text-outline', 'waiting…');
    head.append(name, info);
    const track = el('div', 'h-1.5 rounded-full bg-surface-container overflow-hidden');
    const bar = el('div', 'h-full bg-primary rounded-full'); bar.style.width = '0%';
    track.append(bar);
    wrap.append(head, track);
    wrap.dataset.game = g.appid;
    box.append(wrap);
    rows.set(String(g.appid), { info, bar, name, g, state: 'waiting' });
  }
  const rate = statusNow ? machineFacts().priceText : null;
  $('restoredlg-bill').textContent = pick.games.length ? `Billing ${rate ? `${rate}/hour` : 'by the hour'} while the games copy.` : '';
  for (const id of ['restoredlg-retry', 'restoredlg-close']) $(id).hidden = true;
  $('restoredlg-cancel').hidden = false;
  restoreUi = { rows, pick, current: null, failed: false, finished: false };
  dlg.oncancel = e => { if (restoreUi && !restoreUi.finished) e.preventDefault(); };
  if (!dlg.open) dlg.showModal();
}
// What the machine is doing right now, in its own words: the wait that is going on
// (how long so far), or the last thing the copy or the connection said. A step
// that goes on for minutes with only its name on screen looks like a hang.
function restoreNow(text) { if (restoreUi && text) $('restoredlg-now').textContent = text; }
// How long the step in progress has waited, on the step itself - not in the line
// below, where it used to overwrite every reason the wait gave.
function restoreWaited(e) {
  const row = restoreUi && restoreUi.current;
  if (!row) return;
  const label = row.lastChild;
  if (!label.dataset.base) label.dataset.base = label.textContent;
  label.textContent = e.state === 'waiting' ? `${label.dataset.base} · ${e.secs} s` : label.dataset.base;
}
function restoreStep(text) {
  if (!restoreUi || !text) return;
  const list = $('restoredlg-steps');
  if (restoreUi.current) restoreUi.current.firstChild.replaceWith(el('span', 'w-4 text-center font-code-md text-code-md text-primary', '✓'));
  const row = el('div', 'flex items-start gap-space-sm');
  row.append(el('span', 'spinner mt-0.5'), el('div', '', text.charAt(0).toUpperCase() + text.slice(1)));
  list.append(row);
  restoreUi.current = row;
}
function restoreGame(e) {
  const r = restoreUi && restoreUi.rows.get(String(e.id));
  if (!r) return;
  // "there": already installed on the machine (root disk, games disk) - not copied.
  r.state = e.state === 'there' ? 'done' : e.state;
  const whole = e.state === 'done' || e.state === 'there';
  const pct = e.of > 0 ? Math.min(100, Math.round(e.got * 100 / e.of)) : (whole ? 100 : 0);
  r.bar.style.width = (whole ? 100 : pct) + '%';
  r.bar.className = 'h-full rounded-full ' + (e.state === 'failed' ? 'bg-error' : 'bg-primary');
  r.info.className = 'font-code-sm text-code-sm ' + (e.state === 'failed' ? 'text-error' : 'text-outline');
  r.info.textContent = e.state === 'there' ? 'already on the machine ✓' : e.state === 'done' ? 'done ✓'
    : e.state === 'failed' ? 'did not come back whole'
    : e.state === 'waiting' ? 'waiting…'
    : e.of > 0 ? `${GB(e.got)} of ${GB(e.of)} · ${pct}%` : GB(e.got);
  if (e.state === 'failed') restoreUi.failed = true;
}
function restoreEnd(rc) {
  if (!restoreUi) return;
  const ui = restoreUi;
  ui.finished = true;
  if (rc === 0 && !ui.failed) { $('restoredlg').close(); restoreUi = null; return; }
  const failed = [...ui.rows.values()].filter(r => r.state !== 'done');
  $('restoredlg-title').textContent = ui.failed ? 'Some games did not come back' : 'Stopped';
  $('restoredlg-sub').textContent = ui.failed
    ? 'Nothing was removed and the machine is still running. Most often the disk had no room; Try again, or press Play and untick the game.'
    : 'The machine is still running and billing until auto-stop or Delete. Press Play to try again.';
  $('restoredlg-cancel').hidden = true;
  $('restoredlg-close').hidden = false;
  $('restoredlg-retry').hidden = !(ui.failed && failed.length);
  ui.retry = failed.map(r => r.g);
}
function restoreCancel() {
  for (const [id, j] of jobs) if (j.cmd[0] === 'open') window.ayis.cancel(id);
}
$('restoredlg-cancel').onclick = () => { restoreCancel(); if (restoreUi) restoreUi.finished = true; $('restoredlg').close(); restoreUi = null; };
$('restoredlg-close').onclick = () => { $('restoredlg').close(); restoreUi = null; };
$('restoredlg-retry').onclick = () => {
  const ui = restoreUi; if (!ui) return;
  $('restoredlg').close(); restoreUi = null;
  playWith({ ...ui.pick, games: ui.retry });
};
// A step ayis announces moves the dialog on; once the stream's own steps start the
// games are all back and it closes.
function restoreOnEvent(event) {
  if (!restoreUi) return;
  if (event.t === 'restore') restoreGame(event);
  else if (event.t === 'wait') restoreWaited(event);
  // A game's own progress line ("2863680: copying, 3.8GB of 12GB") is already its
  // row below, with its name; repeated here by number it only confused.
  else if (event.t === 'line' && event.text && event.kind !== 'fail' && !/^\d+: (waiting|copying|done|failed)\b/.test(event.text.trim())) restoreNow(event.text.trim());
  else if (event.t === 'step') {
    // Open until Moonlight is starting, so the wait for the stream is on screen too.
    if (event.id === 'open.play') { if (!restoreUi.failed) restoreEnd(0); }
    else restoreStep(event.text);
  } else if (event.t === 'exit') restoreEnd(event.rc);
}

// What the machine says about itself, read when Play is pressed: its fast drive's
// free room, the games disk it has, and the games already on it.
// Which games are on the disks a stop keeps - the root disk and the games disk -
// as the machine said last time it was asked (Play, Stop machine). A stopped
// machine cannot be asked, and these games are on it all the same.
const BOX_GAMES_KEY = 'ayis-box-games';
const boxGames = {
  get(id) { try { const v = JSON.parse(localStorage.getItem(BOX_GAMES_KEY) || 'null'); return v && v.id === id ? v.games || [] : []; } catch { return []; } },
  set(id, games) {
    const kept = (games || []).filter(g => (g.disk === 'root' || g.disk === 'extra') && /^(installed|running)$/i.test(g.state || '') && !g.incomplete)
      .map(g => ({ appid: String(g.appid), disk: g.disk }));
    try { localStorage.setItem(BOX_GAMES_KEY, JSON.stringify({ id, games: kept })); } catch { /* a convenience */ }
  },
  dropDisk(id) { this.set(id, this.get(id).filter(g => g.disk !== 'extra').map(g => ({ ...g, state: 'installed' }))); },
};
async function readPlayContext(b) {
  const ctx = { state: b.state, driveFree: null, extraHave: 0, onBox: new Set(), where: new Map() };
  const sel = libNow && libNow.selectable_gb;
  if (b.state === 'running') {
    try {
      const pc = JSON.parse(await runAyis(['games', '--json', '--box'], { capture: true }));
      for (const g of pc.games || []) if (/^(installed|running)$/i.test(g.state) && !g.incomplete) {
        ctx.onBox.add(String(g.appid));
        if (g.disk) ctx.where.set(String(g.appid), g.disk);
      }
      if (pc.disk && pc.disk.free_bytes != null) ctx.driveFree = pc.disk.free_bytes / GIB;
      boxGames.set(b.id, pc.games);
    } catch { /* unknown: nothing is locked, the copy skips what is whole */ }
  }
  if (ctx.driveFree == null && sel != null) ctx.driveFree = sel;   // a stopped machine's fast drive starts empty
  try { ctx.extraHave = (JSON.parse(await runAyis(['disk', '--json'], { capture: true })).extra_gb) || 0; } catch { /* none known */ }
  // Stopped: what the root disk and the games disk had when it was last asked.
  // The games disk's only while it still exists. ayis checks again once the machine
  // is up, so a list that is out of date costs nothing worse than a copy.
  if (b.state !== 'running') for (const g of boxGames.get(b.id)) {
    if (g.disk === 'extra' && !(ctx.extraHave > 0)) continue;
    ctx.onBox.add(g.appid); ctx.where.set(g.appid, g.disk);
  }
  return ctx;
}

function playWith(pick) {
  const args = ['open'];
  if (pick.extraGb > 0) args.push('--extra-gb', String(pick.extraGb));
  if (pick.extraIds && pick.extraIds.length) args.push('--extra-apps', pick.extraIds.join(','));
  if (pick.games.length) args.push('--games', pick.games.map(g => `${g.appid}:${g.bytes}`).join(','));
  const p = startRun(args, { restore: pick.games.length > 0 });
  if (!$('restoredlg').open) restoreShow(pick);
  return p;
}

// Play reads the machine before it can ask which games: a second or more. The
// popup is up for that, saying so (playLoading), and a second click does nothing.
let playPreparing = false;
function playLoading() {
  $('playdlg-sub').textContent = 'Looking at your machine and your saved games…';
  $('playdlg-sub').hidden = false;
  const list = $('playdlg-games');
  list.textContent = '';
  const row = el('div', 'flex items-center gap-space-sm font-body-md text-body-md text-on-surface-variant');
  row.append(el('span', 'spinner'), el('span', '', 'Reading…'));
  list.append(row);
  for (const id of ['playdlg-total', 'playdlg-price']) $(id).textContent = '';
  $('playdlg-disk').hidden = true;
  $('playdlg-warn').hidden = true;
  $('playdlg-yes').disabled = true;
}
const play = async () => {
  if (sessionNow) return refresh();   // already streaming: re-check, start nothing
  if (playPreparing) return;
  const b = statusNow && statusNow.box;
  if (!b || !['running', 'stopped'].includes(b.state)) return startRun(['open']);
  let pick = null;
  // The popup opens the moment Play is pressed, saying what it is reading; the
  // games fill it once the machine and Saved games have answered. A click that
  // shows nothing for seconds reads as a click that did nothing.
  const dlg = $('playdlg');
  let gaveUp = false;
  playPreparing = true;
  playLoading();
  dlg.onclose = () => { gaveUp = true; };
  dlg.returnValue = '';
  dlg.showModal();
  try {
    if (!libNow) await runAyis(['library', 'list', '--json'], { json: 'library', group: 'refresh' }).catch(() => {});
    // Always the same popup, games or none: with nothing saved yet it says so, and
    // the disk can still be chosen - Play is one flow, whatever is in Saved games.
    if (!gaveUp) {
      const ctx = await readPlayContext(b);
      if (!gaveUp) pick = await askPlayGames(ctx);
    }
  } finally { playPreparing = false; }
  if (gaveUp && !pick) return;
  if (!pick) return;
  diskRemoved.set(b.id, false);
  stoppedDiskFor = '';
  // The progress window next, at once, whether or not there is anything to copy -
  // with nothing to copy, the connecting and the stream starting were a silent gap
  // until Moonlight appeared. The run starts when the reads in flight land.
  restoreShow(pick);
  await readsSettled();   // the machine's own command runs alone: not while a read is still landing
  return playWith(pick);
};
$('d-open').onclick = play;
async function stopSession() {
  if (!openJobs().length) return;
  const ok = await askConfirm(sessionNow ? {
    title: 'Stop the session?',
    body: 'Moonlight closes. The machine keeps running and billing; Stop machine stops it.',
    yes: 'Stop session', no: 'Keep playing', danger: true,
  } : {
    title: 'Stop starting the session?',
    body: 'The session does not open. The machine keeps running and billing; Stop machine stops it.',
    yes: 'Stop starting', no: 'Keep going', danger: true,
  });
  if (ok) for (const [id] of openJobs()) window.ayis.cancel(id);
}
// ── Stop machine and Delete machine: one window, start to finish ────────────
//
// The window opens at once, reading the machine. Then the games on it, grouped by
// what happens to them, all ticked: kept in Saved games (copied if new, updated if
// already there). Unticked: left out - not copied, and deleted from Saved games if
// it is there. A game still downloading cannot be saved and is said so. Steam's
// own tools are not listed: they are never saved. Then the SAME window shows the
// run: every step listed from the start (○ to come, ◌ now, ✓ done), the save's
// bar under its step, and on a failure what did finish, what did not, and Try
// again. It closes itself when it is all done, and the card says what was done.
const keepUi = { mode: 'choose' };
const savable = g => /^(installed|running)$/i.test(g.state || '') && !g.incomplete;
function keepMode(mode) {
  keepUi.mode = mode;
  $('keepdlg-choose').hidden = mode !== 'choose';
  $('keepdlg-run').hidden = mode === 'choose';
  $('keepdlg-no').hidden = mode !== 'choose';
  $('keepdlg-yes').hidden = mode !== 'choose';
  $('keepdlg-close').hidden = mode !== 'failed';
  $('keepdlg-retry').hidden = mode !== 'failed';
}
// Choosing. Resolves with the choice and leaves the window open for the run; null
// when cancelled (the window is closed).
async function askKeepGames(kind, untick = []) {
  const dlg = $('keepdlg'), list = $('keepdlg-games');
  const stop = kind === 'stop';
  const b = statusNow && statusNow.box;
  keepMode('choose');
  $('keepdlg-title').textContent = stop ? 'Stop the machine?' : 'Delete the machine?';
  $('keepdlg-sub').textContent = '';
  $('keepdlg-summary').textContent = '';
  $('keepdlg-after').textContent = '';
  list.textContent = '';
  const spin = el('div', 'flex items-center gap-space-sm font-body-md text-body-md text-on-surface-variant');
  spin.append(el('span', 'spinner'), el('span', '', 'Looking at the games on the machine…'));
  list.append(spin);
  const yes = $('keepdlg-yes');
  yes.disabled = true; yes.className = 'btn btn-primary';
  yes.textContent = stop ? 'Save and stop' : 'Save and delete machine';
  let answer = null;
  const settled = new Promise(r => { answer = r; });
  $('keepdlg-no').onclick = () => { dlg.close(); answer(null); };
  dlg.onclose = () => answer(null);
  if (!dlg.open) dlg.showModal();
  let games = null;
  try {
    if (!libNow) await runAyis(['library', 'list', '--json'], { json: 'library', group: 'refresh' }).catch(() => {});
    const pc = JSON.parse(await runAyis(['games', '--json', '--box'], { capture: true }));
    games = (pc.games || []).filter(g => g.state !== 'in S3 only' && !g.tool);
    if (b) boxGames.set(b.id, pc.games);
  } catch { games = null; }
  // The games disk, if the machine has one: Stop can delete it too.
  let diskGb = 0;
  if (stop && games !== null) {
    try { diskGb = (JSON.parse(await runAyis(['disk', '--json'], { capture: true })).extra_gb) || 0; } catch { diskGb = 0; }
  }
  if (!dlg.open) return null;
  const saved = new Set(((libNow && !libNow.error && libNow.games) || []).map(g => String(g.appid)));
  const id = g => String(g.appid);
  const name = g => g.name || id(g);
  const all = games || [];
  const ok = all.filter(savable), cannot = all.filter(g => !savable(g));
  const keep = new Set(ok.map(id).filter(x => !untick.includes(x)));
  const end = stop ? 'then it stops' : 'then the machine and its disk are deleted';
  $('keepdlg-sub').textContent = games === null
    ? `The games on the machine could not be read, so they cannot be chosen: all of them are saved, ${end}.`
    : !all.length ? `No games on this machine. Your Steam login is saved, ${end}.`
    : 'Ticked games are kept in Saved games.';
  list.textContent = '';
  const notes = new Map();
  const group = (title, rows) => {
    if (!rows.length) return;
    const box = el('div', 'flex flex-col gap-space-xs');
    box.append(el('p', 'section-label mb-0', title));
    for (const g of rows) {
      const wrap = el('div', 'flex flex-col');
      const row = el('label', 'flex items-center gap-space-sm font-body-md text-body-md');
      const cb = el('input', 'accent-primary'); cb.type = 'checkbox';
      const can = savable(g);
      cb.checked = can && keep.has(id(g));
      cb.disabled = !can;
      cb.onchange = () => { if (cb.checked) keep.add(id(g)); else keep.delete(id(g)); paint(); };
      // Where it is decides what a stop does to it: the fast drive is wiped, the
      // games disk and the root disk keep what is on them.
      const where = { nvme: 'fast drive', extra: 'games disk', root: 'root disk' }[g.disk] || '';
      const size = (can ? GB(g.bytes || 0)
        : `${GB(g.bytes || 0)} · ${g.percent != null ? `downloading ${Math.round(g.percent)}%` : String(g.state || 'not finished').toLowerCase()}`)
        + (where ? ` · ${where}` : '');
      row.append(cb, el('span', 'grow', name(g)), el('span', 'font-code-sm text-code-sm text-outline', size));
      const n = el('p', 'pl-[1.6rem] font-code-sm text-code-sm');
      wrap.append(row, n);
      notes.set(id(g), { n, g, can });
      box.append(wrap);
    }
    list.append(box);
  };
  group('In Saved games', ok.filter(g => saved.has(id(g))));
  group('New on this machine', ok.filter(g => !saved.has(id(g))));
  group('Not saved', cannot);
  // The games disk: deleted too if you tick it, and always when nothing on it is
  // kept - an empty or abandoned disk would only go on billing.
  const onDisk = all.filter(g => g.disk === 'extra');
  let wantDisk = false;
  const diskBox = diskGb > 0 ? el('div', 'flex flex-col gap-space-xs') : null;
  const diskCb = el('input', 'accent-primary'); diskCb.type = 'checkbox';
  const diskNote = el('p', 'pl-[1.6rem] font-code-sm text-code-sm text-on-surface-variant');
  const diskMonth = diskGb ? diskMonthInr(diskGb) : null;
  if (diskBox) {
    diskBox.append(el('p', 'section-label mb-0', `Games disk · ${diskGb} GB${diskMonth != null ? ` · about ${rs(diskMonth)} a month` : ''}`));
    const lab = el('label', 'flex items-center gap-space-sm font-body-md text-body-md');
    lab.append(diskCb, el('span', 'grow', 'Delete the games disk too'));
    diskBox.append(lab, diskNote);
    list.append(diskBox);
    diskCb.onchange = () => { wantDisk = diskCb.checked; paint(); };
  }
  const forcedDisk = () => diskGb > 0 && !onDisk.some(g => savable(g) && keep.has(id(g)));
  const dropDisk = () => diskGb > 0 && (forcedDisk() || wantDisk);
  const plan = () => {
    const kept = ok.filter(g => keep.has(id(g))), dropped = ok.filter(g => !keep.has(id(g)));
    return {
      saveNew: kept.filter(g => !saved.has(id(g))), update: kept.filter(g => saved.has(id(g))),
      forget: dropped.filter(g => saved.has(id(g))), skipNew: dropped.filter(g => !saved.has(id(g))),
    };
  };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const inr = b && b.disk_gb ? diskMonthInr(b.disk_gb) : null;
  const rate = statusNow ? machineFacts().priceText : null;
  const paint = () => {
    const p = plan();
    for (const { n, g, can } of notes.values()) {
      const goes = dropDisk() && g.disk === 'extra';
      if (!can && goes) {
        n.className = 'pl-[1.6rem] font-code-sm text-code-sm text-error';
        n.textContent = '⚠ Still downloading: not saved, and gone with the games disk.';
      } else if (goes && keep.has(id(g))) {
        n.className = 'pl-[1.6rem] font-code-sm text-code-sm text-on-surface-variant';
        n.textContent = 'Saved, then the disk is deleted.';
      } else if (goes && !saved.has(id(g))) {
        n.className = 'pl-[1.6rem] font-code-sm text-code-sm text-error';
        n.textContent = '⚠ Not saved. Gone with the games disk.';
      } else if (goes && saved.has(id(g))) {
        // Unticked, in Saved games, on a disk that goes: both copies go.
        n.className = 'pl-[1.6rem] font-code-sm text-code-sm text-error';
        n.textContent = '⚠ Deleted from Saved games, and gone with the games disk. Cannot be undone.';
      } else if (!can) {
        n.className = 'pl-[1.6rem] font-code-sm text-code-sm text-on-surface-variant';
        n.textContent = saved.has(id(g)) ? 'Still downloading: not saved. The copy in Saved games stays as it was.'
          : stop && (g.disk === 'extra' || g.disk === 'root') ? `Still downloading: not saved, but it stays on the ${g.disk === 'extra' ? 'games disk' : 'root disk'} and Steam carries on next time.`
          : 'Still downloading: not saved. Steam downloads it again next time.';
      } else if (keep.has(id(g))) { n.textContent = ''; }
      else if (saved.has(id(g))) { n.className = 'pl-[1.6rem] font-code-sm text-code-sm text-error'; n.textContent = 'Deleted from Saved games. Cannot be undone.'; }
      else {
        n.className = 'pl-[1.6rem] font-code-sm text-code-sm text-on-surface-variant';
        // A stop wipes only the fast drive; a delete takes every disk with it.
        const kept = stop && (g.disk === 'extra' || g.disk === 'root');
        n.textContent = kept ? `Not saved. It stays on the ${g.disk === 'extra' ? 'games disk' : 'root disk'}.`
          : `Not saved. Gone when the machine ${stop ? 'stops' : 'is deleted'}.`;
      }
      n.hidden = !n.textContent;
    }
    const newGb = p.saveNew.reduce((t, g) => t + (g.bytes || 0), 0);
    const parts = [];
    if (p.saveNew.length) parts.push(`Saves ${plural(p.saveNew.length, 'new game')} (${GB(newGb)})`);
    if (p.update.length) parts.push(`${parts.length ? 'updates' : 'Updates'} ${p.update.length}`);
    if (p.forget.length) parts.push(`${parts.length ? 'deletes' : 'Deletes'} ${plural(p.forget.length, 'saved game')}`);
    const disk = dropDisk();
    if (disk) parts.push(`${parts.length ? 'deletes' : 'Deletes'} the games disk`);
    $('keepdlg-summary').textContent = games === null || (!all.length && !disk) ? ''
      : parts.length ? parts.join(', ') + '.' : 'Saves no games.';
    if (diskBox) {
      const forced = forcedDisk();
      if (!forced && diskCb.disabled) wantDisk = false;   // a game on it ticked again: back to the choice
      diskCb.checked = disk;
      diskCb.disabled = forced;
      diskNote.textContent = forced ? (onDisk.length ? 'Nothing on it is kept, so it is deleted. Tick a game on it to keep the disk.'
                                                     : 'Nothing is on it, so it is deleted.')
        : disk ? `Saves${diskMonth != null ? ` about ${rs(diskMonth)}` : ''} a month. Play makes a new one when your games need it.` : '';
      diskNote.hidden = !diskNote.textContent;
    }
    const lost = p.forget.length || (disk && onDisk.some(g => !keep.has(id(g))));
    const kept = p.saveNew.length + p.update.length;
    const dg = p.forget.length ? `Delete ${plural(p.forget.length, 'game')}` : '';
    yes.textContent = !stop ? (dg ? `${dg} and delete machine` : 'Save and delete machine')
      : dg ? (disk ? `${dg}, stop and delete disk` : `${dg} and stop`)
      : kept ? (disk ? 'Save, stop and delete disk' : 'Save and stop')
      : (disk ? 'Stop and delete disk' : 'Stop');
    yes.className = lost || !stop ? 'btn btn-danger' : 'btn btn-primary';
    yes.disabled = false;
    $('keepdlg-after').textContent = stop
      ? `After it stops: ${rate ? `${rate}/hour` : 'the hourly charge'} ends. Still billed: the machine's disk${inr != null ? ` (about ${rs(inr)} a month)` : ''}${diskGb && !disk ? `${diskMonth != null ? ` and the games disk (about ${rs(diskMonth)} a month)` : ' and the games disk'}` : ''}.`
      : `${rate ? `${rate}/hour` : 'Billing'} ends when it is deleted. Your saved games stay.`;
  };
  paint();
  yes.onclick = () => {
    const p = plan();
    answer({
      skip: [...p.forget, ...p.skipNew].map(id),
      forget: p.forget.map(g => ({ id: id(g), name: name(g) })),
      summary: { saved: p.saveNew.length + p.update.length, deleted: p.forget.length, disk: dropDisk() },
      deleteDisk: dropDisk(),
      // Something on the disk that no save can hold (a download) goes with it: chosen.
      diskLoss: dropDisk() && onDisk.some(g => !savable(g)),
    });
  };
  return settled;
}

// The run, in the same window: every step listed up front, each matched to what
// ayis says as it goes. A step ayis never says (Steam was not open) is ticked when a
// later one begins.
function keepRun(title, steps) {
  keepMode('run');
  $('keepdlg-title').textContent = title;
  $('keepdlg-run-note').textContent = 'Keep the app open until this finishes.';
  const list = $('keepdlg-steps');
  list.textContent = '';
  const rows = steps.map(s => {
    const r = el('div', 'flex items-start gap-space-sm font-body-md text-body-md');
    r.dataset.step = s.label;
    r.append(el('span', 'w-4 text-center font-code-md text-code-md text-outline', '○'), el('div', 'min-w-0', s.label));
    list.append(r);
    return { ...s, r, state: 'todo' };
  });
  let at = -1;
  const mark = (i, state) => {
    const r = rows[i]; if (!r || r.state === state) return;
    r.state = state;
    r.r.firstChild.replaceWith(state === 'now' ? el('span', 'spinner mt-0.5')
      : el('span', 'w-4 text-center font-code-md text-code-md ' + (state === 'done' ? 'text-primary' : 'text-error'), state === 'done' ? '✓' : '✗'));
  };
  const go = i => {
    if (i <= at) return;
    for (let k = Math.max(0, at); k < i; k++) mark(k, 'done');
    at = i; mark(i, 'now');
    $('keepdlg-save')?.remove();
    $('keepdlg-live')?.remove(); keepUi.aws = ''; keepUi.said = '';
  };
  return {
    go,
    key: k => go(rows.findIndex((r, i) => i > at && r.key === k)),
    said(text) {   // ayis's own step: the planned row it belongs to, if any
      const i = rows.findIndex((r, j) => j > at && r.match && r.match.test(text));
      if (i >= 0) go(i);
    },
    current: () => rows[at] && rows[at].r,
    fail(why) {
      if (at >= 0) mark(at, 'fail');
      const w = el('p', 'pl-[1.6rem] font-code-sm text-code-sm text-on-surface-variant break-words', why);
      if (rows[at]) rows[at].r.after(w); else list.append(w);
      $('keepdlg-save')?.remove();
    },
    finish() { for (let k = Math.max(0, at); k < rows.length; k++) mark(k, 'done'); },
  };
}
// The save's bar, under its own step in the window (or in the plain popup).
function saveOnEvent(e) {
  const inKeep = $('keepdlg').open && keepUi.mode === 'run';
  const host = inKeep ? keepUi.run && keepUi.run.current() : null;
  const dlg = inKeep ? $('keepdlg') : $('refdlg'), list = inKeep ? $('keepdlg-steps') : $('refdlg-list');
  if (!dlg.open || !list) return;
  const bid = inKeep ? 'keepdlg-save' : 'refdlg-save';
  let row = $(bid);
  if (!row) {
    row = el('div', 'flex flex-col gap-space-xs pl-[1.6rem]'); row.id = bid;
    row.append(el('span', 'font-code-sm text-code-sm text-on-surface-variant'),
               Object.assign(el('div', 'onb-progress determinate'), { innerHTML: '<i style="width:0%"></i>' }));
  }
  const of = Number(e.of) || 0, got = Math.min(Number(e.got) || 0, of);
  row.firstChild.textContent = of ? `${e.text || 'Saving'} · ${GB(got)} of ${GB(of)}` : (e.text || 'Saving');
  // No size yet: the moving bar, which says "working" without a number.
  row.lastChild.classList.toggle('determinate', !!of);
  row.lastChild.firstChild.style.width = of ? `${Math.round(got * 100 / of)}%` : '';
  if (host) host.after(row); else list.append(row);
}
// What is happening right now, under the step in progress: AWS's own state while
// the stop waits for it ("stopping · 1 min 20 s"), and the latest thing the
// machine or ayis said. A step that takes minutes with nothing under it looks stuck.
function keepLive(e) {
  const host = keepUi.run && keepUi.run.current();
  if (!host) return;
  let text = '';
  if (e.t === 'wait' && /^box\./.test(e.id || '') && e.text) {
    text = `AWS says: ${e.text}${e.state === 'waiting' ? ` · ${waitSecs(e.secs)}` : ''}`;
    keepUi.aws = text;
  } else if (e.t === 'line' && e.text && e.kind !== 'fail') {
    const t = e.text.trim();
    // Not ayis's own echo of the state change - that is the AWS line already.
    if (/^(running|stopping|stopped|pending|still \w+ \(\d+s\)|\w+ after \d+s)$/.test(t)) return;
    keepUi.said = t.replace(/^machine:\s*/, 'Machine: ');
  } else return;
  let row = $('keepdlg-live');
  if (!row) { row = el('p', 'pl-[1.6rem] font-code-sm text-code-sm text-on-surface-variant break-words whitespace-pre-line'); row.id = 'keepdlg-live'; }
  if (row.previousElementSibling !== host) host.after(row);
  row.textContent = [keepUi.aws, keepUi.said].filter(Boolean).join('\n');
}
// One ayis command of the run: its steps feed the window; its failure is the reason.
async function keepCmd(run, args, ask) {
  typedPending = ask || null;
  const { rc, err } = await runAyis(args, { wantRc: true, onStep: t => run.said(t), aside: args[0] !== 'library' });
  typedPending = null;
  if (rc === 0) return null;
  return (err || '').trim().split('\n').filter(Boolean).slice(-2).join(' ') || `ayis ${args.join(' ')} stopped (exit ${rc})`;
}
// Stop machine and Delete machine, after the choice: the steps, then the run.
async function keepGo(kind, choice) {
  const stop = kind === 'stop';
  const steps = [
    { key: 'ready', label: openJobs().length ? 'Ending the session' : 'Getting ready' },
    ...choice.forget.map(g => ({ key: 'forget:' + g.id, label: `Deleting ${g.name} from Saved games` })),
    { key: 'steam', label: 'Closing Steam', match: /closing steam/i },
    ...(choice.skip.length ? [{ key: 'skip', label: 'Leaving out the games you unticked', match: /leaving out/i }] : []),
    { key: 'save', label: choice.summary.saved ? 'Saving your games and Steam login' : 'Saving your Steam login', match: /^saving your/i },
    stop ? { key: 'end', label: 'Stopping the machine at AWS', match: /stopping the machine at aws/i }
         : { key: 'end', label: 'Deleting the machine and its disk', match: /terminat|deregister|leftover volume|box deleted|ending the machine/i },
    ...(stop && choice.deleteDisk ? [{ key: 'disk', label: 'Deleting the games disk' }] : []),
  ];
  const run = keepUi.run = keepRun(stop ? 'Stopping the machine' : 'Deleting the machine', steps);
  keepUi.failedAt = '';
  run.key('ready');
  await endSessionJobs();
  await readsSettled();   // the commands below run alone: not while a read lands
  for (const g of choice.forget) {
    run.key('forget:' + g.id);
    const why = await keepCmd(run, ['library', 'forget', g.id], { askId: 'forget-game', word: 'FORGET' });
    if (why) return why;
  }
  run.key('steam');
  const args = stop ? ['stop', '--yes'] : ['destroy'];
  if (choice.skip.length) args.push('--skip', choice.skip.join(','));
  const why = await keepCmd(run, args);
  if (why) return why;
  // Only once the machine has stopped and the save is done: ayis disk remove itself
  // refuses unless Saved games has a complete save from this run.
  if (stop && choice.deleteDisk) {
    run.key('disk');
    keepUi.failedAt = 'disk';
    const dwhy = await keepCmd(run, ['disk', 'remove', ...(choice.diskLoss ? ['--unsaved-ok'] : [])]);
    if (dwhy) return dwhy;
  }
  run.finish();
  return null;
}
async function keepFlow(kind, untick) {
  const b = statusNow && statusNow.box;
  const choice = await askKeepGames(kind, Array.isArray(untick) ? untick : []);
  if (!choice) return;
  flowPending.set({ kind, id: b && b.id, skip: choice.skip, at: Date.now() });
  flowBusy = true;
  let why;
  try { why = await keepGo(kind, choice); }
  catch (e) { why = (e && e.message) || String(e); }
  finally { flowBusy = false; flowPending.clear(); }
  const stop = kind === 'stop';
  if (!why) {
    $('keepdlg').onclose = null;
    $('keepdlg').close();
    keepDone = { id: b && b.id, kind, text: [choice.summary.saved ? `saved ${choice.summary.saved} game${choice.summary.saved === 1 ? '' : 's'}` : '',
      choice.summary.deleted ? `deleted ${choice.summary.deleted}` : '',
      choice.summary.disk ? 'deleted the games disk' : ''].filter(Boolean).join(' · ') };
    if (choice.deleteDisk && b) { diskRemoved.set(b.id, true); stoppedDiskFor = ''; boxGames.dropDisk(b.id); }
    note(stop ? 'Machine stopped' : 'Machine deleted', 'text-primary');
  } else {
    keepUi.run.fail(why);
    $('keepdlg-title').textContent = `${stop ? 'Stopping' : 'Deleting'} the machine - not done`;
    // The reason is ayis's, above: most often Saved games has no complete save from
    // this run (a game still downloading anywhere makes the save incomplete), and
    // then Remove games disk would refuse just the same until there is one.
    $('keepdlg-run-note').textContent = keepUi.failedAt === 'disk'
      ? 'The machine is stopped; the games disk was kept, so nothing on it is lost. It still bills until it is removed; the reason it was kept is above.'
      : 'The machine is still running and billing. Anything already deleted from Saved games stays deleted.';
    keepMode('failed');
    $('keepdlg-close').onclick = () => { $('keepdlg').onclose = null; $('keepdlg').close(); };
    $('keepdlg-retry').onclick = () => { $('keepdlg').onclose = null; $('keepdlg').close(); keepFlow(kind, choice.skip); };
    $('keepdlg').onclose = null;
  }
  await refresh();
}
// What the last stop or delete did, for the card to say once it has stopped.
// eslint-disable-next-line no-var -- read by painters that run before this line: a var has no dead zone
var keepDone = null;
// Stop machine and Delete machine run several commands. Each command that changes
// something is normally followed by a refresh that puts its own popup up; mid-run
// those would cover the window. While a run goes on, they happen quietly.
// eslint-disable-next-line no-var -- the same: read before this line is reached
var flowBusy = false;
// Ends the session, giving it up to 20 seconds; then on regardless - what follows
// needs the machine reachable, not the session job gone, and a session that will
// not end must not leave the click doing nothing.
async function endSessionJobs() {
  for (const [id] of openJobs()) window.ayis.cancel(id);
  for (let i = 0; i < 80 && openJobs().length; i++) await new Promise(r => setTimeout(r, 250));
}
async function stopMachine(untick = []) {
  const b = statusNow && statusNow.box;
  if (!b || b.state !== 'running' || b.lifecycle === 'spot') return;
  return keepFlow('stop', untick);
}
$('d-stopsession').onclick = $('b-stopsession').onclick = stopSession;
$('d-stopmachine').onclick = $('b-stopmachine').onclick = () => stopMachine();
$('b-open').onclick = play;
$('b-destroy').onclick = () => $('d-destroy').onclick();
$('d-destroy').onclick = () => deleteMachine();
async function deleteMachine(untick = []) {
  // A running machine has games on it: the same window as Stop machine.
  if (statusNow && statusNow.box && statusNow.box.state === 'running') return keepFlow('delete', untick);
  const ok = await askConfirm({
    title: 'Delete the machine?',
    body: (sessionNow ? 'The current session is closed first.\n\n' : '')
        + 'Games are saved first; nothing is deleted if saving fails.\n\n'
        + 'The machine and its disk are deleted.'
        + (statusNow && statusNow.box && statusNow.box.state === 'stopped'
           ? '\n\nIt is only stopped: Start and play brings it back with your setup (games return from Saved games), and only the disk is billed meanwhile. Delete it to stop that charge too.' : '')
        + (((statusNow || {}).build || {}).last_min != null
           ? ` The last build took ${statusNow.build.last_min} min.` : ''),
    yes: 'Delete machine', danger: true,
  });
  if (!ok) return;
  await readsSettled();   // it runs alone: not while a read is still landing
  await startRun(['destroy']);
};
$('b-build').onclick = async () => {
  const rate = statusNow ? machineFacts().priceText : null;
  const ok = await askConfirm({
    title: 'Build the machine?',
    body: `Billed ${rate != null ? `${rate}/hour` : 'hourly'} from now until you stop or delete it.`,
    yes: 'Build',
  });
  if (!ok) return;
  await readsSettled();   // it runs alone: not while a read is still landing
  await buildWith('none', 0, 0);
};

for (const link of document.querySelectorAll('.nav-item')) {
  link.onclick = e => {
    e.preventDefault();
    document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('on', n === link));
    // The label only: the link's text also holds its icon's glyph, which came
    // out as an invisible character in "Refreshing <page>".
    $('view-title').textContent = link.querySelector('span:last-child').textContent.trim();
    view = link.dataset.view;
    // The picker shows on the Machine page alone; that page opens on the
    // machine picked last.
    paintMachineTab();
    for (const sec of document.querySelectorAll('main section[data-view]'))
      sec.hidden = sec.dataset.view !== view;
    markSettingsNav();
    updateHeader();
    // Reads run in parallel, so an open tab loads even while others are in flight.
    if (NEEDS[view] && !loaded.has(view)) refresh();
    // Leaving the Games page stops its reads of the machine; opening it asks again.
    if (view === 'library') boxGamesStart(); else { clearTimeout(pcTimer); pcTimer = null; }
  };
}
