'use strict';
// What each page reads from ayis, and refreshing it.
// One of the renderer's scripts, loaded in order by index.html into one shared scope
// (docs/architecture.md, "The app").

// Refresh means "this screen", and the reads behind it are independent, so
// they run together rather than one after another.
const NEEDS = {
  dashboard: [[['status', '--json'], 'status'], [['watcher', '--json'], 'guards'], HOSTS_READ],
  // machines too: the instance-type row is a picker, and its options are
  // whatever this region rents - see editSetting.
  settings:  [[['config', '--json'], 'config'], [['machines', '--json'], 'machines'],
              [['sweep', '--cached', '--json'], 'sweep'], [['creds', '--json'], 'creds'],
              [['creds', 'tailscale', '--json'], 'tskey']],
  // Build reads status too: if a box is already up there is nothing to build,
  // and its own Refresh must be able to find that out.
  build:     [[['library', 'list', '--json'], 'library'], [['status', '--json'], 'status'],
              [['machines', '--json'], 'machines'], [['sweep', '--cached', '--json'], 'sweep'],
              HOSTS_READ],
  library:   [[['library', 'list', '--json'], 'library'], [['status', '--json'], 'status'],
              [['library', 'elsewhere', '--json'], 'elsewhere']],
  // config too: the settings card is edited here, and a save has to come back
  // as the new value - the watcher alone left the old one showing.
  guards:    [[['watcher', '--json'], 'guards'], [['config', '--json'], 'config'],
              [['limits', '--json'], 'limits']],
};
const loaded = new Set();

// What a screen reads when it refreshes. Cost is not in NEEDS, so opening that
// tab fetches nothing: it bills, and only its Refresh asks.
// Home and Machine also read each machine of yours; a laptop with no AWS reads
// nothing that asks AWS.
const readsFor = v => forMode(v === 'cost' ? [[['cost', '--json'], 'cost']]
  : NEEDS[v] && [...NEEDS[v], ...(v === 'dashboard' || v === 'build' ? hostReads() : [])]);
async function refresh(each, need = readsFor(view)) {
  if (!need) return;               // logs need nothing
  if (view !== 'cost') loaded.add(view);
  await Promise.all(need.map(([args, json]) =>
    runAyis(args, view === 'cost' ? { json } : { json, group: 'refresh' }).then(() => each && each(json))));
}

// Each read, in the words the page uses for what it shows.
const READ_NAME = {
  status: 'Machine and billing', guards: 'Safeguards', library: 'Saved games',
  elsewhere: 'Games in other regions',
  machines: 'Machine types and prices', sweep: 'Regions', config: 'Settings',
  creds: 'AWS key', tskey: 'Tailscale', deps: 'Local tools', cost: 'Exact cost this month',
  hosts: 'Servers', limits: 'Hard limits',
};
const readName = json => (json.startsWith('host:') ? json.slice(5) : READ_NAME[json] || json);
// The top Refresh, as a popup: what is being read, each ticking as it lands,
// closed once the page has been redrawn. A read that failed keeps it open with
// the reason, because a popup that vanished would say it all worked.
async function refreshShown(reads = readsFor(view), read = each => refresh(each, reads)) {
  if (!reads) return;
  const dlg = $('refdlg');
  const state = new Map(reads.map(([, json]) => [json, 'reading']));
  $('refdlg-title').textContent = `Refreshing ${$('view-title').textContent.trim()}`;
  const price = $('d-cost-price').textContent;
  $('refdlg-sub').textContent = view === 'cost'
    ? `Loading this month\'s bill${price ? `, ${price}` : ''}.`
    : 'Loading latest status.';
  $('refdlg-menu').hidden = true;
  const paint = () => {
    const list = $('refdlg-list');
    list.textContent = '';
    for (const [json, st] of state) {
      const row = document.createElement('div');
      row.className = 'flex items-start gap-space-sm font-body-md text-body-md';
      row.dataset.read = json;
      row.dataset.state = st;
      row.append(st === 'reading'
        ? Object.assign(document.createElement('span'), { className: 'spinner mt-0.5' })
        : Object.assign(document.createElement('span'), {
            className: 'w-4 text-center font-code-md text-code-md ' + (st === 'done' ? 'text-primary' : 'text-error'),
            textContent: st === 'done' ? '✓' : '✗' }));
      const text = document.createElement('div');
      text.className = 'min-w-0';
      text.append(Object.assign(document.createElement('div'), { textContent: readName(json) }));
      if (st === 'failed') text.append(Object.assign(document.createElement('div'), {
        className: 'font-code-sm text-code-sm text-on-surface-variant break-words',
        textContent: readFailures.get(json) || 'could not be read' }));
      row.append(text);
      list.append(row);
    }
  };
  paint();
  if (!dlg.open) dlg.showModal();
  await read(json => { state.set(json, readFailures.has(json) ? 'failed' : 'done'); paint(); });
  // A read the gate held back was never asked: it is not news either way.
  for (const [json, st] of state) if (st === 'reading') state.delete(json);
  paint();
  if ([...state.values()].every(s => s === 'done')) { dlg.close(); return; }
  $('refdlg-sub').textContent = 'Some of it could not be read. The page shows what was.';
  $('refdlg-menu').hidden = false;
  $('refdlg-close').focus();
}
// A build, a delete, a session or an archive change alters what the page shows,
// so the page you are on is read again with the popup up - "Stream ended"
// visibly becoming "Ready to play" - and every other screen quietly behind it.
// Not a settings save: those happen a field at a time.
const SHOWN_AFTER = new Set(['init', 'destroy', 'open', 'library']);
// One round of reads, all of them, with the popup up until the last has landed -
// not the page's reads under the popup and then the rest after it had gone.
function afterWrite(job, rc) {
  // A cancelled build goes straight on to its delete; the read waits for that.
  // A refused change to the saved games keeps its own popup, saying why.
  if (!SHOWN_AFTER.has(job.cmd[0]) || (run && run.cancelling) || flowBusy
      || (job.cmd[0] === 'library' && rc !== 0)) return refreshAll();
  // A change to the saved games touches the saved games, and nothing else -
  // not the tools on this laptop, the keys or the locations, which it used to
  // read all over again. Keep for also rewrites a setting and the watchdog.
  if (job.cmd[0] === 'library')
    return refreshShown(job.cmd[1] === 'keep-for' ? KEEP_FOR_READS : LIBRARY_READS);
  return refreshShown(forMode([...GATE_READS, ...ALL_READS]), each => refreshAll(each));
}
const LIBRARY_READS = [[['library', 'list', '--json'], 'library'],
                       [['library', 'elsewhere', '--json'], 'elsewhere']];
const KEEP_FOR_READS = [...LIBRARY_READS, [['config', '--json'], 'config'], [['watcher', '--json'], 'guards']];
$('refdlg-close').onclick = e => { e.preventDefault(); $('refdlg').close(); };
// Esc does not close it: it closes itself when the page is redrawn, and a
// failure is closed with its button. Both, because Chromium honours a
// prevented cancel only once per user activation - a second Esc would close it
// anyway - while a prevented keydown never becomes a close request at all.
$('refdlg').oncancel = e => e.preventDefault();
$('refdlg').addEventListener('keydown', e => { if (e.key === 'Escape') e.preventDefault(); });

// On open, every free read goes at once and each screen paints when its own
// answer lands - they share nothing. ayis cost is not among them: it is $0.01 a
// call, so it waits for its button.
// Asked FIRST, and alone, because they decide whether anything else is worth
// asking. Six `command -v` checks, a file read, and two free calls - nothing
// here needs AWS to work, which is the point: these are the reads that still
// answer on a laptop where nothing else can.
const GATE_READS = [
  [['deps', '--json'], 'deps'],
  [['creds', '--json'], 'creds'],
  [['creds', 'tailscale', '--json'], 'tskey'],
  // Reads .env and nothing else, and carries the alert address a build needs.
  [['config', '--json'], 'config'],
  // A file on this laptop: the machines of yours it knows.
  [['host', 'list', '--json'], 'hosts'],
];
// The rest. Every one of them needs AWS, a tailnet, or both, so on a laptop
// that is not ready yet they would all come back unknown and the screen would
// fill with question marks instead of the one thing to do about it.
const ALL_READS = [
  [['status', '--json'], 'status'],
  [['watcher', '--json'], 'guards'],
  [['library', 'list', '--json'], 'library'],
  // Its own read: finding ayis's other buckets takes seconds, and the archive
  // in use must not wait for it.
  [['library', 'elsewhere', '--json'], 'elsewhere'],
  [['machines', '--json'], 'machines'],
  // The REMEMBERED scan, never a fresh one: a scan takes 90 seconds and an
  // opening window must not wait on it. Rescanning is a button.
  [['sweep', '--cached', '--json'], 'sweep'],
];

// What a box needs before it can be built, in the order it has to be met, each
// with the one button that meets it.
//
// This used to be a ladder of `if`s that returned the first problem and nothing
// else. On a fresh laptop that means finding out about four jobs one at a time,
// each after finishing the last. So the list is a list, with a verdict for
// every rung, and setup shows the whole thing.
//
// `ok` is three-valued. true met, false not met, and null NOT KNOWN - the read
// behind it has not come back, or came back broken, or the rung above it has to
// be dealt with before this one can be judged at all. A rung whose read failed
// must never read as met.
//
// One sentence each. An old warning strip ran to three - ayis's own sentence, then "Your
// games are in S3; nothing here can see them until this is fixed", then where
// the button was - which is a paragraph to say "the key does not work".
// What is wrong with the key, which is ayis's answer and not a guess from an
// error string: a laptop with no network was told "AWS rejected this access
// key", which is a lie about a call that never arrived, and sent people to
// replace a key that was fine. See creds_json in lib/laptop.sh.
//
// An older ayis sends no reason at all, and a rejection is what this said before
// and what nearly all of them are, so that is where it falls back to.
function keyProblem() {
  switch (credsNow && credsNow.reason) {
    case 'unreachable':
      return { title: 'Cannot reach AWS',
               body: 'Network error. The key was not rejected.',
               label: 'Try again', go: retryReads };
    case 'no-key':
      return { title: 'No AWS access key',
               body: 'Required to continue.',
               label: 'Add key', go: () => goSetting($('s-creds-card')) };
    default:
      return { title: 'AWS rejected this access key',
               body: 'Required to continue.',
               label: 'Add key', go: () => goSetting($('s-creds-card')) };
  }
}

// The done line for the region stage, which names the place rather than the
// setting: "ap-south-2" means nothing to someone who has not read .env.
function whereDone() {
  if (!machinesNow) return 'Region';
  const city = ((sweepNow && sweepNow.regions) || [])
    .find(r => r.region === machinesNow.region);
  return city && city.city ? `Runs in ${shortCity(city.city)}` : `Runs in ${machinesNow.region}`;
}

// Whether a region is written in .env - chosen - as against ayis's default.
const regionChosen = () => {
  const r = (config || []).find(x => x.key === 'GAME_REGION');
  return !!(r && r.is_set);
};

function prereqs(kind = kindNow()) {
  const missing = depsNow ? neededTools(kind).filter(x => !x.present).map(x => x.label) : [];
  const email = (config || []).find(r => r.key === 'EMAIL_ALERTS');
  const all = [
    // Installed is not enough for the AWS CLI: it also has to run, which only
    // ayis creds can say. Both answers decide this one step - the pipeline used
    // to show the second as a row of its own, also called Tools, that came and
    // went as the two answers landed a second apart.
    { key: 'tools', reads: 'deps', name: 'Required tools installed',
      ok: depsNow ? !missing.length && !cliBroken() : null,
      problem: { blocking: true,
                 title: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not installed`,
                 body: 'Required to continue.',
                 ...toolAction(missing) } },
    { key: 'cli', reads: 'creds', name: 'AWS CLI installed',
      // Shown only when the tools stage is happy: when it is not, this is the
      // same missing package and the same button, one row further down.
      sameAs: 'tools',
      ok: credsNow ? !!credsNow.cli : null,
      problem: { blocking: true, title: 'The AWS CLI is not installed',
                 body: 'Required to continue.',
                 ...toolAction(['aws']) } },
    // Judged only once there is a CLI to ask with: "AWS rejected this key" is a
    // lie about a laptop that could not ask AWS anything.
    { key: 'key', reads: 'creds', name: 'AWS access key valid',
      ok: !credsNow ? null : credsNow.cli ? credsNow.valid === true : null,
      problem: { blocking: true, ...keyProblem() } },
    { key: 'tailnet', reads: 'tskey', name: 'Tailscale signed in',
      // Only a clear yes. ayis says null when it cannot tell - Tailscale is not
      // installed - and "not false" read that as signed in: an empty laptop
      // showed this step ticked before it had Tailscale at all.
      ok: tskeyNow ? tskeyNow.signed_in === true : null,
      problem: { blocking: true, title: 'Tailscale not signed in',
                 body: 'Machines are reachable only over Tailscale.',
                 label: 'Sign in', go: signInTailscale } },
    // A working access token, not just a saved key: every build asks Tailscale
    // whether the machine's key still works, and stops when it cannot ask. A
    // saved key was enough here once, and a key revoked along with its token
    // cost a build that never joined.
    { key: 'authkey', reads: 'tskey', name: 'Tailscale access token working',
      ok: tskeyNow ? tskeyNow.valid === true && !!(tskeyNow.auth_key_stored || tskeyNow.can_mint) : null,
      problem: { blocking: true,
                 title: !tskeyNow || !tskeyNow.present ? 'No Tailscale access token'
                   : tskeyNow.valid === false ? 'Tailscale refused the access token'
                   : 'Tailscale did not respond',
                 body: 'Each build checks the machine\'s auth key with it first, and makes a new key when one has stopped working.',
                 label: tskeyNow && tskeyNow.present ? 'Update access token' : 'Add access token', go: openTskey } },
    { key: 'email', reads: 'config', name: 'Alert email set',
      ok: email ? !!email.is_set : null,
      problem: { blocking: true, title: 'No alert email',
                 body: 'Required for the budget alert created at build time.',
                 label: 'Add email', go: () => goSetting(settingEl('EMAIL_ALERTS')) } },
    { key: 'where', reads: 'machines', name: whereDone(),
      // Not "did you click a button": whether the region .env names can rent
      // the machine it names. A laptop pointed at a region with no GPU quota
      // looks completely set up and cannot build - which is exactly how an
      // enabled-but-empty Malaysia read as a broken app.
      //
      // And not ayis's default either: a region nobody chose is not a choice.
      // On a fresh laptop .env names no region, ayis falls back to ap-south-2,
      // that happens to rent the machine - and the stage ticked itself, so the
      // pipeline finished and handed over without ever showing the list. The
      // popup IS this stage; it is skipped only once a region has been
      // written to .env, by it or by Settings.
      //
      // Still judged only once `ayis machines` has answered, never before: it is
      // one of the reads behind the gate, and a stage that could shut the gate
      // on the reads it needs would wait for ever.
      ok: !machinesNow ? null
        : regionChosen()
          && !machinesNow.error && (machinesNow.machines || []).some(m => m.fits_spot || m.fits_ondemand),
      problem: regionChosen()
        ? { blocking: true,
            title: machinesNow ? `${placeName(machinesNow.region)} cannot run this machine` : 'No region selected',
            body: 'No GPU quota there, or no supported machine type. '
                + 'Measure all regions to pick another (free).',
            label: 'Choose region', go: openWhereTo }
        : { blocking: true, title: 'Choose a region',
            body: 'Lower latency is better. Measuring all regions takes ~90 s (free).',
            label: 'Choose region', go: openWhereTo } },
  ];
  if (kind === 'aws') return all;
  // A server of yours: this laptop's steps, then the server, then setting it up.
  // No auth key step: a server already on the tailnet never needs one, and one
  // that is not is asked for it during its setup.
  return [...all.filter(r => !['cli', 'key', 'authkey', 'email', 'where'].includes(r.key)),
    { key: 'server', reads: null, name: 'The server', ok: !!addedHost,
      problem: { blocking: false, title: 'The server', body: '', label: 'Connect', go: connectServer } },
    { key: 'setup', reads: null, name: 'Setup', ok: setupDone,
      problem: { blocking: false, title: 'Setup', body: '', label: 'Set up', go: () => {} } }];
}

// Where it runs. A dialog, because changing it later is this same question
// asked again - and because it is a choice, which is what a dialog is for.
//
// Every number in it is ayis's: the latency it measured, the rupee rates it
// converted, and whether AWS will actually let you launch there. The app adds
// nothing but the radio buttons.
let whereToPick = null;
function openWhereTo() {
  whereToPick = machinesNow ? machinesNow.region : null;
  paintWhereTo();
  if (!$('whereto').open) $('whereto').showModal();
  // Nothing measured yet: measure, since the dialog is useless without it and
  // the measuring is free.
  if (!sweepNow || !(sweepNow.regions || []).length) whereToMeasure();
}
// The dialog follows every scan, whoever started it.
const repaintWhereTo = () => { if ($('whereto').open) paintWhereTo(); };

// The machine a region would build: the one already chosen when the region
// offers it under the chosen purchase model, else the cheapest it does offer.
// The dialog shows it and Use saves it - it used to save the region alone, so a
// g4dn.xlarge chosen for Mumbai went to Hyderabad, which has none, and the
// build stopped at its first step.
function whereToMachine(r) {
  const spot = cfgVal('GAME_SPOT') || 'auto';
  const fits = (r.machines || []).filter(m => spot === '1' ? m.fits_spot
    : spot === '0' ? m.fits_ondemand : m.fits_spot || m.fits_ondemand);
  const cur = fits.find(m => m.type === cfgVal('GAME_INSTANCE_TYPE'));
  const price = m => (spot === '0' ? m.inr_hour_ondemand : m.inr_hour_spot) || 1e9;
  return cur || fits.slice().sort((a, b) => price(a) - price(b))[0] || null;
}

function whereToRows() {
  const regions = (sweepNow && sweepNow.regions) || [];
  return regions.map(r => {
    const best = whereToMachine(r);
    return { region: r.region, city: shortCity(r.city), rtt: r.rtt_ms, enabled: r.enabled,
             spot: best ? best.inr_hour_spot : null, od: best ? best.inr_hour_ondemand : null,
             type: best ? best.type : null, usable: !!best };
  }).sort((a, b) => (a.rtt == null) - (b.rtt == null) || (a.rtt || 0) - (b.rtt || 0));
}

function paintWhereTo() {
  const table = $('whereto-table');
  table.textContent = '';
  const rows = whereToRows();
  const head = document.createElement('tr');
  for (const h of ['', 'Region', 'Latency', 'Machine', 'Spot/hour', 'On-demand/hour']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.append(th);
  }
  table.append(head);
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.dataset.region = r.region;
    tr.dataset.usable = r.usable ? 'yes' : 'no';
    if (!r.usable) tr.className = 'dim';
    const pick = document.createElement('td');
    const label = document.createElement('label');
    label.className = 'pick' + (r.usable ? (whereToPick === r.region ? ' on' : '') : ' off');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'whereto';
    radio.value = r.region;
    radio.checked = whereToPick === r.region;
    radio.disabled = !r.usable;
    radio.onchange = () => { whereToPick = r.region; paintWhereTo(); };
    label.append(radio);
    pick.append(label);
    const city = document.createElement('td');
    city.className = 'city';
    city.textContent = r.city || r.region;
    const ms = document.createElement('td');
    ms.className = 'ms num';
    ms.textContent = r.rtt != null ? distance(r.rtt) : '—';
    const type = document.createElement('td');
    type.className = 'region';
    // Why it cannot be used, where the machine would go: an enabled region
    // with no GPU quota is the one that reads as a broken app.
    type.textContent = r.type || (r.enabled ? 'No GPU limit here yet' : 'Not switched on yet');
    const spot = document.createElement('td');
    spot.className = 'num';
    spot.textContent = r.spot != null ? rsh(perHour(r.spot)) : '—';
    const od = document.createElement('td');
    od.className = 'num';
    od.textContent = r.od != null ? rsh(perHour(r.od)) : '—';
    tr.append(pick, city, ms, type, spot, od);
    table.append(tr);
  }
  const usable = rows.filter(r => r.usable).length;
  $('whereto-sub').textContent = rows.length
    ? `Measured from this device \u00b7 ${usable} of ${rows.length} available`
    : 'Lower latency is better.';
  $('whereto-note').textContent = rows.length && !usable
    ? 'None available. New regions start with no GPU quota; request one under Machine type.'
    : '';
  $('whereto-use').disabled = !whereToPick || !rows.some(r => r.region === whereToPick && r.usable);
  // The button names the place, so what it does is never in doubt.
  $('whereto-use').textContent = whereToPick ? `Use ${placeName(whereToPick)}` : 'Select';

  // Three ways for there to be nothing to list, and each says which it is:
  // still measuring, the measurement failed, or nothing answered.
  const failed = !sweeping && !rows.length && readFailures.has('sweep');
  // Measuring shows the spinner whether or not there is a table yet. Measuring
  // AGAIN used to change one grey line of text and nothing else, so pressing
  // the button looked like it had done nothing: the old table stays, faded and
  // out of reach, under a spinner, until the new numbers replace it.
  $('whereto-busy').hidden = !sweeping;
  $('whereto-busy-text').textContent = rows.length
    ? 'Measuring again (~90 s).'
    : 'Measuring all AWS regions (~90 s, free).';
  $('whereto-list').hidden = !rows.length;
  $('whereto-list').classList.toggle('stale', sweeping);
  $('whereto-err').hidden = sweeping || rows.length > 0;
  $('whereto-err').textContent = failed
    ? `Measurement failed: ${readFailures.get('sweep')}`
    : 'No AWS region responded. Check your connection.';
  if (sweeping) $('whereto-sub').textContent = 'Lower latency is better.';
  $('whereto-measure').hidden = sweeping;
  $('whereto-measure').textContent = rows.length ? 'Measure again' : 'Try again';
  $('whereto-use').hidden = !rows.length || sweeping;
}

// One measurement at a time: the app starts one by itself on a laptop that has
// never measured, and this used to start a second on top of it.
function whereToMeasure() {
  if (sweeping) return paintWhereTo();
  return scanRegions(null);
}
$('whereto-measure').onclick = e => { e.preventDefault(); whereToMeasure(); };
$('whereto-cancel').onclick = e => { e.preventDefault(); $('whereto').close(); };
$('whereto-use').onclick = async e => {
  e.preventDefault();
  const code = whereToPick;
  $('whereto').close();
  const row = ((sweepNow && sweepNow.regions) || []).find(r => r.region === code);
  const machine = row && whereToMachine(row);
  // The machine before the region, as the chooser does: the wrong type in the
  // right region is a refused launch, the reverse silently builds the wrong box.
  // Only over a type ayis reported: with none read, there is nothing to correct.
  // Checked, both ways: a type saved for a region that then was not is the
  // mismatch this exists to prevent, so it is put back.
  const was = cfgVal('GAME_INSTANCE_TYPE');
  const retype = !!(machine && was && machine.type !== was);
  if (retype && (await runAyis(['config', 'set', 'GAME_INSTANCE_TYPE', machine.type], { wantRc: true })).rc !== 0) {
    toast(`Could not save ${machine.type}. Nothing was changed.`, 'bad');
    return;
  }
  // ayis owns the setting and its rules - the app does not write .env.
  const ok = await runInPipeline('where', ['config', 'set', 'GAME_REGION', code],
                                 `Saving ${placeName(code)}\u2026`);
  if (!ok && retype) await runAyis(['config', 'set', 'GAME_INSTANCE_TYPE', was]);
  // `ayis config set` is not a write by ayis's contract, so nothing re-reads on its
  // own, and the stage sat on "Pick where it runs" after you had picked. The
  // setting, so the stage sees a region was chosen - and then everything behind
  // the gate, because all of it is per region: the machines it rents, the box,
  // the archive. Read before the choice, the dashboard would open on the old one.
  // Together, not one after the other: the setting lands first and ticks the
  // last step, and if the reads had not started by then the dashboard opened
  // on a box read for the old region, still loading.
  if (ok) await Promise.all([runAyis(['config', '--json'], { json: 'config' }), readBehindGate()]);
};
