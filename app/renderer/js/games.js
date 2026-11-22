'use strict';
// Games: saved games, what is on the machine, and the Steam login.
// One of the renderer's scripts, loaded in order by index.html into one shared scope
// (docs/architecture.md, "The app").

// Games ayis saved in a region the machine is no longer built in. They bill like
// any others; they are rows of the one Games table, with their place beside them.
let elsewhereNow = null;
function paintElsewhere(d) {
  elsewhereNow = d;
  paintLibraryPage();
  paintDash();
  if (costNow) paintCostPage();
}
// The places worth a line: anything holding something, or that could not be read.
const elsewherePlaces = () => ((elsewhereNow && elsewhereNow.places) || []).filter(p => p.bytes || p.error);

function paintLibrary(d) {
  libNow = d;                 // first: Home lists these names as it redraws
  if (d.last_seen) noteMachineRan(d.last_seen);
  paintPicker(d);
  paintArchiveCard(d);
  // ayis says which it is; the app must never turn "I could not look" into
  // "there is nothing there".
  paintLogin(d.login);
  paintLibraryPage();
}
let libNow = null;   // the last `ayis library list`, for repainting when status lands

// ── On your game PC ──────────────────────────────────────────────────────────
// What the machine has right now and how far each download has got, on the Games
// page. Read from the machine itself (ayis games --json --box: no look at S3, so it
// costs AWS nothing), every 15 s while something downloads and every minute while
// nothing does, and only while that page is open and the machine runs. A read that
// fails keeps the last answer on the screen, with the time it was given.
// This is the app's one read on a timer: it asks the machine over SSH, never AWS,
// so it bills nothing, and it stops when the page is left.
const BOX_GAMES_FAST = 15000, BOX_GAMES_IDLE = 60000;
const gbWords = bytes => `${(bytes / 1073741824).toFixed(bytes < 10737418240 ? 1 : 0)} GB`;
const minutesWords = m => m < 1 ? 'less than a minute'
  : m < 60 ? `${Math.round(m)} min`
  : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
// The time of the answer, not how long ago: nothing ticks to keep an age true.
const clockWords = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function paintBoxGames() {
  const card = $('lib-pc');
  if (!card) return;
  const box = liveBox();
  card.hidden = !box;
  if (!box) return;
  const note = $('lib-pc-note'), rows = $('lib-pc-rows');
  rows.textContent = '';
  $('lib-pc-space').textContent = '';
  $('lib-pc-need').hidden = true;
  $('lib-pc-age').textContent = '';
  const say = words => { note.textContent = words; note.hidden = !words; };
  if (box.state !== 'running') {
    say('Your game PC is not running. Downloads continue when it is.');
    return;
  }
  if (!pcNow) {
    say(pcFailed ? 'Could not read your game PC just now.' : 'Reading your game PC…');
    return;
  }
  say(pcFailed ? 'Could not read your game PC just now. This is the last answer it gave.' : '');
  $('lib-pc-age').textContent = `updated ${clockWords(pcAt)}`;
  const all = (pcNow.games || []).filter(g => g.state !== 'in S3 only');
  // Steam fetches Proton, its runtime and its redistributables beside every game.
  // They are not games: one quiet line says so, instead of a row each.
  const isTool = g => /^(Proton|Steam Linux Runtime|Steamworks Common Redistributables)/i.test(g.name || '');
  const games = all.filter(g => !isTool(g));
  // Which disk a game is installed on, as the box reported it; an older box says nothing.
  const diskWords = d => ({ nvme: 'on the fast drive', extra: 'on the games disk', root: 'on the root disk' })[d] || '';
  const toolsBusy = all.some(g => isTool(g) && g.state === 'downloading');
  if (!games.length) say(pcFailed ? note.textContent : toolsBusy ? '' : 'No games on your game PC yet.');
  for (const g of games) {
    const row = el('div', 'flex flex-col gap-space-xs');
    const head = el('div', 'flex items-baseline justify-between gap-space-md');
    head.append(el('span', 'font-body-md text-body-md text-on-surface truncate', g.name),
                el('span', 'font-body-sm text-body-sm ' + (g.state === 'downloading' ? 'text-primary' : 'text-outline'), g.state));
    row.append(head);
    if (g.state === 'downloading' && g.percent != null) {
      const track = el('div', 'h-2 w-full rounded-full bg-surface overflow-hidden');
      const fill = el('div', 'h-full bg-primary');
      fill.style.width = `${Math.min(100, g.percent)}%`;
      track.append(fill);
      const done = g.total_bytes ? gbWords(g.total_bytes - (g.left_bytes || 0)) + ' of ' + gbWords(g.total_bytes) : '';
      const speed = pcNow.inbound_bytes_per_sec > 1e6 ? `${(pcNow.inbound_bytes_per_sec / 1e6).toFixed(0)} MB/s` : '';
      const left = g.minutes_left ? `about ${minutesWords(g.minutes_left)} left` : '';
      row.append(track, el('span', 'font-body-sm text-body-sm text-on-surface-variant',
        [`${Math.round(g.percent)}%`, done, speed, left, diskWords(g.disk)].filter(Boolean).join(' · ')));
    } else if (g.incomplete) {
      row.append(el('span', 'font-body-sm text-body-sm text-tertiary', g.note));
    } else if (g.bytes) {
      const sz = el('span', 'font-body-sm text-body-sm text-outline', [gbWords(g.bytes), diskWords(g.disk)].filter(Boolean).join(' · '));
      sz.dataset.f = 'size';
      row.append(sz);
    }
    rows.append(row);
  }
  if (toolsBusy) rows.append(el('span', 'font-body-sm text-body-sm text-outline', 'Steam is also fetching its own tools (Proton and the game runtime).'));
  const disk = pcNow.disk;
  if (disk) {
    $('lib-pc-space').textContent = `Space: ${gbWords(disk.used_bytes)} used · ${gbWords(disk.free_bytes)} free`;
    // The room the downloads still need, against the room there is.
    const need = all.reduce((n, g) => n + (g.state === 'downloading' ? g.room_bytes ?? g.left_bytes ?? 0 : 0), 0);
    if (need > disk.free_bytes) {
      $('lib-pc-need-text').textContent = `The downloads need ${gbWords(need)} more and ${gbWords(disk.free_bytes)} is free.`;
      $('lib-pc-need').hidden = false;
    }
  }
}
$('lib-pc-adddisk').onclick = () => openAddDisk();

async function readBoxGames() {
  const box = liveBox();
  if (view !== 'library' || !box || box.state !== 'running' || pcReading) return paintBoxGames();
  pcReading = true;
  let d = null;
  // Turned away because something else runs alone is not a read that failed: the
  // last answer stays, and it is asked again on the next beat.
  let turnedAway = false;
  try {
    const raw = await runAyis(['games', '--json', '--box'], { capture: true });
    if (raw === undefined) turnedAway = true; else d = JSON.parse(raw);
  } catch { /* said below */ }
  pcReading = false;
  if (d && Array.isArray(d.games)) { pcNow = d; pcAt = Date.now(); pcFailed = false; } else if (!turnedAway) pcFailed = true;
  paintBoxGames();
  scheduleBoxGames();
}
function scheduleBoxGames() {
  clearTimeout(pcTimer);
  pcTimer = null;
  const box = liveBox();
  if (view !== 'library' || !box || box.state !== 'running') return;
  const downloading = pcNow && (pcNow.games || []).some(g => g.state === 'downloading');
  pcTimer = setTimeout(() => { pcTimer = null; readBoxGames(); }, downloading ? BOX_GAMES_FAST : BOX_GAMES_IDLE);
}
// Idempotent: the Games page starts it whenever it paints, and leaving the page
// stops it.
function boxGamesStart() {
  paintBoxGames();
  if (view === 'library' && !pcTimer && !pcReading) readBoxGames();
}

// The Library page: in rupees, in the words the rest of the app uses, and with
// where the games are kept and for how long - which come from `ayis status`, so
// this repaints when either answer lands.
function paintLibraryPage() {
  paintLoginTable();        // its other places arrive with the games' read
  boxGamesStart();
  const d = libNow;
  if (!d || !$('lib-rows')) return;
  const e = elsewhereNow || {};
  // ayis's own rate and place ride in these answers, so this never waits for
  // another read - it did, and drew "another place" and "— a month".
  const inr = d.inr_per_usd || e.inr_per_usd || inrRate();
  const r = usd => (usd == null || !isFinite(inr) ? '—' : rs(usd * inr));
  const here = d.region || e.region || (statusNow && statusNow.region) || null;
  const rows = $('lib-rows'), foot = $('lib-foot');
  rows.textContent = ''; foot.textContent = '';
  $('lib-error').hidden = !d.error;
  if (d.error) {
    $('lib-error').textContent = `Could not read saved games: ${d.error}`;
    $('lib-keep').textContent = '';
    $('lib-keepfor-row').hidden = true;
    $('lib-orphan-box').hidden = true;
    return;
  }
  // Every game, wherever it is kept: the machine's place first, then the rest.
  const games = (d.games || []).map(g => ({ ...g, region: here, bucket: null }));
  for (const p of e.places || []) {
    if (p.error) continue;
    for (const g of p.games || []) games.push({ ...g, region: p.region, bucket: p.bucket });
  }
  games.sort((a, b) => (a.bucket ? 1 : 0) - (b.bucket ? 1 : 0) || (b.bytes || 0) - (a.bytes || 0));

  const days = d.expiry_days ?? e.expiry_days;
  const seen = d.last_seen || e.last_seen || null;
  const marks = d.marks_read !== false;
  const say = (text, cls) => rows.append(el('p', `font-body-sm text-body-sm ${cls}`, text));
  if (!games.length) say('No saved games yet.', 'text-outline');
  // A card each: its name; where it is, its size and what it costs; when it
  // goes; and what can be done to it. Each field is marked, so it reads the
  // same to anything that checks it as the table's cells did.
  for (const g of games) {
    const card = el('div', 'p-space-lg rounded-xl bg-surface-container-low flex flex-col gap-space-xs');
    card.dataset.game = g.appid || g.installdir || '';
    const f = (tag, cls, text, name) => { const x = el(tag, cls, text); x.dataset.f = name; return x; };
    card.append(f('p', 'font-headline-md text-headline-md', g.name || g.installdir || g.appid, 'name'));
    const meta = el('p', 'font-body-sm text-body-sm text-on-surface-variant');
    meta.append(f('span', '', g.region ? placeName(g.region) : '—', 'place'), ' · ',
                f('span', 'figure', GB(g.bytes), 'size'), ' · ',
                f('span', 'figure', `${r(g.usd_month)} a month`, 'cost'));
    card.append(meta);
    card.append(f('p', 'font-body-sm text-body-sm text-outline', deleteWords(deleteOn(g, days, seen, marks)), 'del'));
    // Kept where no machine will look: said, beside the Move that fixes it.
    if (g.bucket && here) card.append(el('p', 'font-body-sm text-body-sm text-tertiary',
      `Not where your machine builds (${placeName(here)}). A build there will not have it.`));
    const acts = f('div', 'flex flex-wrap gap-space-sm mt-space-sm', '', 'acts');
    // A game found only by its folder has no id, and ayis acts on ids.
    if (g.appid) {
      const btn = (label, cls, fn) => { const b = el('button', cls, label); b.onclick = fn; acts.append(b); };
      if (g.bucket) btn(`Move to ${here ? placeName(here) : 'the machine region'}`, 'btn btn-primary', () => moveGame(g, here, inr));
      if (days) btn('Keep', 'btn', () => resetGame(g));
      btn('Delete', 'btn btn-danger', () => forgetGame(g));
    }
    card.append(acts);
    rows.append(card);
  }
  for (const p of e.places || []) {
    if (p.error) say(`Could not read saved games in ${p.region ? placeName(p.region) : 'another region'}: ${p.error}`, 'text-error');
  }
  if (games.length) {
    const usd = games.reduce((a, g) => a + (g.usd_month || 0), 0);
    foot.textContent = `${games.length} game${games.length === 1 ? '' : 's'} · `
      + `${GB(games.reduce((a, g) => a + (g.bytes || 0), 0))} · ${r(usd)} a month`;
  }

  // How long: one setting, chosen here and applied at once (ayis library keep-for),
  // a pill per choice. The one in force does nothing when pressed again.
  const pills = $('lib-keepfor');
  $('lib-keepfor-row').hidden = days == null;
  if (days != null) {
    const opts = [7, 14, 30, 60, 0];
    if (!opts.includes(days)) opts.splice(-1, 0, days);
    pills.textContent = '';
    for (const n of opts) {
      const b = el('button', 'seg-item justify-center rounded-lg', n ? `${n} days` : 'Forever');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(n === days));
      b.dataset.value = String(n);
      b.onclick = () => { if (n !== days) keepFor(n); };
      pills.append(b);
    }
  }
  // The same days decide a machine left stopped - its disk bills while it is.
  $('lib-keep').textContent = !days ? 'Kept until you delete them. A stopped machine is kept too.'
    : `Deleted ${days} days after last played. Keep restarts the timer for one game. `
      + `A machine left stopped is deleted after ${days} days; its games stay here.`;

  $('lib-orphan-box').hidden = !d.orphan_bytes;
  if (d.orphan_bytes) {
    $('lib-orphans').textContent =
      `${(d.orphan_bytes / 1073741824).toFixed(1)} GB of files from an incomplete save`
      + ` · ${r(d.orphan_usd_month)}/month, unused.`;
  }
}

// When the cloud watchdog deletes a game: N days after the later of the last
// machine and the game's own Reset. A machine that exists keeps everything.
function deleteOn(g, days, seen, marks) {
  if (days === 0) return 'never';
  if (days == null || !marks) return '—';
  if (boxNow) return 'Kept while running';
  if (!seen) return '—';
  const from = Math.max(Date.parse(seen), g.kept ? Date.parse(g.kept) : 0);
  const when = new Date(from + days * 86400000);
  return when <= new Date() ? 'today'
    : when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// deleteOn's answer, as the line under a game says it.
function deleteWords(when) {
  if (when === 'never') return 'Kept until you delete it';
  if (when === '—') return 'Deletion date not known';
  if (when === 'Kept while running') return 'Kept while the machine runs';
  if (when === 'today') return 'Deleted today unless you keep it';
  return `Deleted on ${when} unless you play it or keep it`;
}

// --from names the place for a game kept outside the machine's own; ayis checks
// it is one of this rig's before it touches anything.
const fromArgs = g => (g.bucket ? ['--from', g.bucket] : []);

async function resetGame(g) {
  const name = g.name || g.appid;
  await libraryRun(['library', 'reset', String(g.appid), ...fromArgs(g)], `Resetting timer for ${name}`);
}

async function moveGame(g, here, inr) {
  const name = g.name || g.appid;
  const to = here ? placeName(here) : 'the machine region';
  // Billed where the bytes leave, at that place's own price; inside one
  // location a copy has no transfer charge at all.
  const place = elsewherePlaces().find(p => p.bucket === g.bucket) || {};
  const same = here && g.region === here;
  const rate = place.xregion_usd_gb;
  const cost = !same && rate && isFinite(inr) ? rs((g.bytes / 1073741824) * rate * inr) : null;
  const ok = await askConfirm({
    title: `Move ${name} to ${to}?`,
    body: `${GB(g.bytes)} is copied from ${placeName(g.region)} to ${to}, verified, then removed from ${placeName(g.region)}.\n\n`
        + (same ? 'Same region: no transfer charge. '
           : cost ? `One-time transfer: about ${cost}. ` : '')
        + 'Storage cost is unchanged.',
    yes: 'Move',
  });
  if (ok) await libraryRun(['library', 'move', String(g.appid), ...fromArgs(g)], `Moving ${name} to ${to}`, 'move-game', 'MOVE');
}

const ago = s => s == null ? '' : s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago`
  : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;

// Rendered from `ayis watcher --json`: one card per layer, in the order they fire.
// The guard strip on the dashboard: one card per layer, in the order they fire,
// said the way ayis says it. Nothing here is invented - a layer the app does not
// hear about is a layer it does not draw.
// The dashboard's archive card lists what is actually in there, biggest first.
// One game, deleted from the archive for good. ayis does the asking - it prints
// what it costs to re-download and demands the word FORGET - so the app's own
// dialog only has to be honest about which game is going.
async function forgetGame(g) {
  const name = g.name || g.appid;
  const ok = await askConfirm({
    title: `Delete ${name}?`,
    body: `Permanently deletes the ${GB(g.bytes)} saved copy.\n\n`
        + 'Steam will re-download it next time.',
    yes: 'Delete', danger: true, word: 'DELETE',
  });
  // ayis asks for FORGET; the word typed here is the app's own, and the answer
  // handed to ayis is ayis's.
  if (ok) await libraryRun(['library', 'forget', String(g.appid), ...fromArgs(g)], `Deleting ${name}`, 'forget-game', 'FORGET');
}

const typedAnswer = askId => (typedPending && typedPending.askId === askId ? typedPending.word : null);

// A change to the saved games, run where you asked for it. The popup says what
// is happening; when ayis is done the same popup reads everything again and
// closes (afterWrite), and you are still on Library. Only a refusal keeps it
// open, with ayis's reason.
// What a failed change left behind, from ayis's own words. Most of them fail
// before they touch anything - reset, delete, clean up and the Steam login
// each stop at the first thing that goes wrong - so "nothing was changed" is
// true of them, unless AWS refused part of a delete, which ayis says. A move that
// stops part-way has copied some of the game already, and Keep saved games
// saves the setting before it updates auto-stop.
function libraryLeft(err) {
  // A delete AWS only half did - the rest is still there, billing.
  if (/^moved .* but part of it is still/m.test(err)) {
    return 'The game was moved, but part of it is still in its old region and billed there - delete it there to finish.';
  }
  if (/^moved .* but the list of saved games/m.test(err)) {
    return 'The game was moved; it may still be listed in its old region until that list is updated.';
  }
  if (/only part of .* was deleted/.test(err)) {
    return 'Part of the game was deleted; the rest still bills. Delete again finishes it.';
  }
  if (/but the list of saved games there could not be updated/.test(err)) {
    return 'The game was deleted, but may still be listed. Delete again tidies it.';
  }
  if (/could not delete \d+ of them/.test(err)) {
    return 'Some leftover files were deleted; the rest still bill. Clean up again finishes it.';
  }
  if (/the copy stopped|does not match|copied, but/.test(err)) {
    return 'The game is still where it was, untouched. Part of it may already be copied to '
         + 'your machine\'s region and billed there - Move again finishes the copy.';
  }
  if (/saved, but/.test(err)) return 'The setting was saved, but auto-stop still counts the old days.';
  return 'Nothing was changed.';
}
// opts.append: one of several commands in ONE popup (Stop machine, Delete
// machine): the title stays, the steps so far stay, and this command's steps are
// added below them - rather than each command wiping the popup and retitling it.
async function libraryRun(args, doing, askId, word, left = libraryLeft, opts = {}) {
  typedPending = askId ? { askId, word } : null;
  const dlg = $('refdlg');
  const append = !!opts.append && dlg.open;
  if (!append) $('refdlg-title').textContent = doing;
  $('refdlg-sub').textContent = '';
  $('refdlg-menu').hidden = true;
  // Under the title, what ayis is doing - its own steps as they arrive, each
  // ticked when the next begins. It used to repeat the title, word for word.
  const list = $('refdlg-list');
  // Appending: the step in progress (still spinning) is the one this command
  // carries on from, and is ticked when its first step arrives.
  let current = append ? [...list.children].filter(r => r.dataset && r.dataset.step).pop() || null : null;
  if (!append) list.textContent = '';
  const step = text => {
    if (current) current.firstChild.replaceWith(Object.assign(document.createElement('span'),
      { className: 'w-4 text-center font-code-md text-code-md text-primary', textContent: '✓' }));
    current = document.createElement('div');
    current.className = 'flex items-start gap-space-sm font-body-md text-body-md';
    current.dataset.step = text;
    current.append(Object.assign(document.createElement('span'), { className: 'spinner mt-0.5' }),
                   Object.assign(document.createElement('div'), { textContent: text }));
    list.append(current);
  };
  if (!append) step('Working…');
  $('refdlg-save')?.remove();
  let first = !append;
  const onStep = text => {
    const plain = text.replace(/\b(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-\d\b/g, code => placeName(code));
    const said = plain.charAt(0).toUpperCase() + plain.slice(1);
    $('refdlg-save')?.remove();   // a new step: the save's bar belonged to the one before
    // The placeholder gives way to ayis's first real step rather than being ticked.
    if (first) { first = false; list.textContent = ''; current = null; }
    step(said);
  };
  if (!dlg.open) dlg.showModal();
  const { rc, err } = await runAyis(args, { wantRc: true, onStep, aside: args[0] !== 'library' });
  typedPending = null;
  if (rc === 0) return true;
  const why = (err || '').trim().split('\n').filter(Boolean).slice(-2).join(' ')
    || `ayis ${args.join(' ')} stopped (exit ${rc})`;
  $('refdlg-title').textContent = `${append ? $('refdlg-title').textContent : doing} - not done`;
  $('refdlg-sub').textContent = left(err || '');
  // Appending, the steps that did finish stay on screen; the one that failed is crossed.
  if (append) {
    $('refdlg-save')?.remove();
    if (current && current.firstChild && current.firstChild.classList.contains('spinner'))
      current.firstChild.replaceWith(Object.assign(document.createElement('span'), { className: 'w-4 text-center text-error', textContent: '✗' }));
  } else list.textContent = '';
  const bad = document.createElement('div');
  bad.className = 'flex items-start gap-space-sm font-body-md text-body-md';
  bad.dataset.state = 'failed';
  bad.append(Object.assign(document.createElement('span'), { className: 'w-4 text-center text-error', textContent: '✗' }),
             Object.assign(document.createElement('div'), { className: 'font-code-sm text-code-sm text-on-surface-variant break-words', textContent: why }));
  list.append(bad);
  $('refdlg-menu').hidden = false;
  if (!dlg.open) dlg.showModal();
  $('refdlg-close').focus();
  return false;
}

// The archived Steam login. Three states, and the third is the one that matters:
// null is "could not look", which must never be painted as "none archived" -
// that would invite someone to rebuild expecting a fresh login prompt and get
// a box signed in as an account they thought they had deleted.
// What the build will do about Steam. The machine is half of what a build
// decides; the other half is whether it comes up already signed in, and as
// whom - which lives in two places (the archive, and GAME_STEAM_LOGIN) and was
// visible on neither of the screens where a build is started.
let loginNow = null;
function paintBuildLogin() {
  const line = $('b-login'), note = $('b-login-note');
  if (!line) return;
  const choice = (config || []).find(r => r.key === 'GAME_STEAM_LOGIN');
  const fresh = choice && (choice.value || choice.default) === 'fresh';
  if (loginNow === null) {
    line.textContent = 'Reading…';
    note.textContent = '';
    return;
  }
  // The choice is only worth offering when there is a saved login to use.
  const sel = $('b-login-choice');
  sel.hidden = !loginNow.present;
  if (loginNow.present) {
    const acct = ((loginNow.accounts || []).find(a => a.most_recent) || (loginNow.accounts || [])[0]);
    const name = acct ? (acct.account || acct.steamid) : 'the saved account';
    sel.textContent = '';
    sel.append(Object.assign(document.createElement('option'), { value: 'use', textContent: `Sign in as ${name}` }),
               Object.assign(document.createElement('option'), { value: 'fresh', textContent: 'Ask me to sign in' }));
    sel.value = fresh ? 'fresh' : 'use';
  }
  if (fresh) {
    line.textContent = 'You sign in on the machine';
    note.textContent = loginNow.present
      ? 'Saved login kept, not used.'
      : 'No saved login.';
    return;
  }
  if (!loginNow.present) {
    line.textContent = 'You sign in on the machine';
    note.textContent = 'No saved login. Saved when a machine shuts down.';
    return;
  }
  // Which account, when the archive says: a key that signs in as someone you
  // did not expect is the thing worth catching before a build, not after it.
  const who = (loginNow.accounts || []).find(a => a.most_recent) || (loginNow.accounts || [])[0];
  line.textContent = who ? `Signs in as ${who.account || who.steamid}` : 'Signs in with your saved login';
  note.textContent = loginNow.accounts === null
    ? 'Uses the saved login (account name unavailable).'
    : 'Steam starts signed in.';
}

function paintLogin(l) {
  loginNow = l === undefined ? null : l;
  paintBuildLogin();
  paintLoginTable();
}

// One row per saved login: the one beside the machine, which a new machine
// signs in as, and any copy a region move left beside games elsewhere.
function paintLoginTable() {
  const rows = $('lib-login-rows'), note = $('lib-login-note');
  if (!rows) return;
  rows.textContent = '';
  note.textContent = '';
  const l = loginNow;
  const here = (libNow && libNow.region) || (elsewhereNow && elsewhereNow.region)
    || (statusNow && statusNow.region) || null;
  const saved = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toDateString() === new Date().toDateString() ? 'today'
      : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const who = a => (a === null || a === undefined ? 'Name unknown'
    : a.map(r => r.account || r.persona || r.steamid || '?').join(', '));
  const line = (detail, place, status, bucket) => {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-surface-variant/40';
    cell(tr, who(detail.accounts), 'py-space-sm pr-space-md text-on-surface');
    cell(tr, place ? placeName(place) : '—', 'px-space-md text-on-surface-variant');
    cell(tr, `${((detail.bytes || 0) / 1024).toFixed(1)} KB`, 'text-right px-space-md text-on-surface-variant whitespace-nowrap');
    cell(tr, saved(detail.modified), 'text-right px-space-md text-on-surface-variant whitespace-nowrap');
    cell(tr, status, 'px-space-md ' + (bucket ? 'text-outline' : 'text-primary'));
    const act = cell(tr, '', 'text-right pl-space-md');
    const b = document.createElement('button');
    // The one in use is red: forgetting it is what changes the next machine.
    b.className = bucket ? 'btn' : 'btn btn-danger';
    b.textContent = 'Remove';
    b.onclick = () => forgetLogin(detail, bucket, place);
    act.append(b);
    rows.append(tr);
  };
  const say = (text, cls) => {
    const tr = document.createElement('tr');
    cell(tr, text, 'py-space-sm ' + (cls || 'text-outline')).colSpan = 6;
    rows.append(tr);
  };
  if (!l) say('Could not read the saved login.', 'text-error');
  else if (!l.present) say('No saved Steam login. You sign in once on the next machine.');
  else line(l, here, 'In use', null);
  for (const p of (elsewhereNow && elsewhereNow.places) || []) {
    if (p.error || !p.login_detail || !p.login_detail.present) continue;
    line(p.login_detail, p.region, 'Old copy', p.bucket);
  }
  if (l && l.present) {
    const accts = l.accounts || [];
    const next = accts.find(r => r.most_recent) || accts[0];
    note.textContent = (next ? `A new machine signs in as ${next.account || next.persona || next.steamid}. ` : '')
      + 'Removing it does not reduce cost.'
      + (accts.length > 1 ? ` ${accts.length} accounts are saved together and come back together; to keep `
        + 'only one, sign in as it on the machine and it is saved when the machine shuts down.' : '');
  }
}

async function forgetLogin(l, bucket, place) {
  const rows = l.accounts || [];
  const who = rows.length ? rows.map(r => r.account || r.steamid || '?').join(', ') : 'the saved account';
  const where = place ? placeName(place) : '';
  const ok = await askConfirm(bucket ? {
    title: `Remove the old Steam login in ${where}?`,
    body: `An unused copy for ${who}. This cannot be undone.\n\n`
        + 'The active login and your games are not affected.',
    yes: 'Remove', word: 'REMOVE',
  } : {
    title: 'Remove the saved Steam login?',
    body: `Deletes the saved login for ${who}. This cannot be undone.\n\n`
        + 'Games are not affected. The next machine asks for your password and Steam Guard code.',
    yes: 'Remove', danger: true, word: 'REMOVE',
  });
  if (ok) await libraryRun(['library', 'account', 'forget', ...(bucket ? ['--from', bucket] : [])],
                          bucket ? `Removing the old Steam login in ${where}` : 'Removing the Steam login',
                          'forget-login', 'FORGET');
}

function paintArchiveCard() { paintDash(); }
