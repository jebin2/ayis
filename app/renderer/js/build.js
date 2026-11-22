'use strict';
// Building a machine: the chooser, and a run's progress, steps and failures.
// One of the renderer's scripts, loaded in order by index.html into one shared scope
// (docs/architecture.md, "The app").

// --- Build -------------------------------------------------------------------

// The saved games, kept for the Play popup. The Build page no longer lists them:
// nothing is put on a machine when it is built.
function paintPicker(d) {
  archive = d;
  paintFit();
}

// The games disk is sized in steps of 10 GB, up to 1000 GB - the same as
// provision.ExtraDiskGB. planPlay (actions.js) sizes it for the Play popup.
const EXTRA_DISK_STEP_GB = 10, MAX_EXTRA_DISK_GB = 1000;
// What a GB of added disk costs an hour, in rupees, from ayis's rates; null when
// they are not read yet.
function diskInrPerGbHour() {
  const r = (statusNow && statusNow.rates) || {};
  return r.inr_per_usd && r.ebs_gb_month && r.month_hours ? r.ebs_gb_month * r.inr_per_usd / r.month_hours : null;
}

// Where each ticked game goes: on the machine's own drive when it still fits there,
// on the added disk when it does not. Largest first, the same rule as
// provision.PlaceGames, so the disk priced here is the disk the build makes.
// driveGb null (not known): nothing is moved off the drive on a guess.
function placeGames(games, driveGb) {
  const sorted = [...games].sort((a, b) => b.gb - a.gb || (a.id < b.id ? -1 : 1));
  const onDrive = [], onExtra = [];
  let left = driveGb;
  for (const g of sorted) {
    if (driveGb == null || g.gb <= left) { onDrive.push(g); left -= g.gb; } else onExtra.push(g);
  }
  return { onDrive, onExtra };
}
// Nothing but the button is left to settle on the Build page: a build is refused
// while another job runs.
function paintFit() {
  $('b-build').disabled = jobs.size > 0;
}

// The machine strip: the type you asked for, and what AWS says that type is.
// Every number here comes from `ayis status --json`; nothing is hardcoded.
// The instance-type picker. Everything shown - the types, their GPUs, their
// prices - is `ayis machines --json`; nothing about any machine is written down
// in this file. Choosing one writes GAME_INSTANCE_TYPE through `ayis config set`,
// so .env stays the single source of truth and the next build agrees with the
// picker without being told.
// The machine chooser: ONE table, rendered into both the Build and the Settings
// screen, replacing three separate dropdowns for region, instance type and
// purchase model. Those were not three decisions - the whole question is which
// COMBINATION to run, and a dropdown per axis hid exactly the comparison that
// matters. Picking a price picks all three.
//
// Rows come from `ayis sweep`, which is free but takes about 90 seconds, so the
// app reads the remembered scan (`ayis sweep --cached`, instant) and rescans only
// when asked. With no scan yet there is still a table: the current region's
// machines, from `ayis machines`, with a line saying what a scan would add.
let sweepNow = null;
// While either runs, the chooser is locked - nothing in it can be picked,
// pressed or closed until the answer is in, or a choice could land on a table
// that is about to change under it.
const machBusy = () => sweeping || choosing;
let sweepAnswered = false;
function paintSweep(d) { sweepNow = d; sweepAnswered = true; paintChooser(); paintOnboardSoon(); paintDash(); paintLibraryPage(); }

// The settings rows defer to the table - but they are painted by whichever read
// lands first, and `ayis config` usually beats `ayis machines` and `ayis sweep`. So
// they default to deferring, and only get their own editor back once BOTH
// answers are in AND neither produced a row, which means AWS is unreadable and
// the table can offer nothing.
function chooserDead() {
  return sweepAnswered && machinesAnswered && chooserRows().rows.length === 0;
}

// ONE mount. The table was on Build too, and two copies of a control that
// writes the same three settings is the original confusion in a new shape.
// Build states what will be built and sends you here to change it.
const MOUNTS = [
  { table: 's-chooser', note: 's-type-note', age: 's-sweep-age',
    legend: 's-chooser-legend', name: 'mach-s' },
];

// What is in force, read from ayis's own answer rather than remembered here.
// GAME_SPOT 'auto' means spot wherever the quota allows, so it reads as spot -
// the same rule the old picker used.
function cfgVal(key) {
  const r = (config || []).find(x => x.key === key);
  return r ? (r.effective || r.value || r.default || null) : null;
}
function currentPick() {
  return {
    region: cfgVal('GAME_REGION') || (machinesNow && machinesNow.region) || null,
    type: cfgVal('GAME_INSTANCE_TYPE') || (machinesNow && machinesNow.configured) || null,
    spot: (cfgVal('GAME_SPOT') || 'auto') !== '0',
  };
}

function shortCity(city) {
  if (!city) return '';
  const m = /\(([^)]+)\)/.exec(city);
  return m ? m[1] : city;
}

// One flat list of (region, type) rows, whether the data came from a sweep or
// from the current region alone. Everything downstream reads only this shape,
// so the two sources cannot drift apart.
// How many of this region's machines were left out because no quota can launch
// them. Only meaningful for the un-swept view, which is one region; a sweep
// shows every region and the question "how many are hidden" has no one answer.
function hiddenByQuota() {
  if (sweepNow && sweepNow.regions && sweepNow.regions.length) return 0;
  if (!machinesNow || machinesNow.error || !machinesNow.machines) return 0;
  return machinesNow.machines.filter(m => !m.fits_spot && !m.fits_ondemand).length;
}

function chooserRows() {
  if (sweepNow && sweepNow.regions && sweepNow.regions.length) {
    const out = [];
    for (const r of sweepNow.regions) {
      for (const m of r.machines) {
        out.push({
          region: r.region, city: shortCity(r.city), rtt: r.rtt_ms, enabled: r.enabled,
          type: m.type, gpu: m.gpu, vram: m.vram_gib, score: m.score, store: m.store_gb ?? null,
          spot: inrNow(m.usd_hour_spot, m.inr_hour_spot), spotMax: inrNow(m.usd_hour_spot_max, m.inr_hour_spot_max),
          od: inrNow(m.usd_hour_ondemand, m.inr_hour_ondemand),
          fitsSpot: m.fits_spot, fitsOd: m.fits_ondemand,
        });
      }
    }
    return { rows: out, swept: true };
  }
  // No scan yet. The current region is still worth showing, and comes from a
  // read the app already does.
  if (machinesNow && !machinesNow.error && machinesNow.machines) {
    return {
      rows: machinesNow.machines
        .filter(m => m.fits_spot || m.fits_ondemand)
        .map(m => ({
          region: machinesNow.region, city: '', rtt: null, enabled: true,
          type: m.type, gpu: m.gpu, vram: m.vram_gib, score: null, store: m.store_gb ?? null,
          // No rate from ayis, no rupee figure. The app holds no exchange rate.
          spot: inrNow(m.usd_hour_spot, m.inr_hour_spot),
          spotMax: inrNow(m.usd_hour_spot_max, m.inr_hour_spot_max),
          od: inrNow(m.usd_hour_ondemand, m.inr_hour_ondemand),
          fitsSpot: m.fits_spot, fitsOd: m.fits_ondemand,
        })),
      swept: false,
    };
  }
  return { rows: [], swept: false };
}

function cell(tr, text, cls) {
  const td = tr.insertCell();
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

// A price cell IS the control. Disabled for a reason the cell itself states,
// because "why can I not pick this" was the other half of the confusion.
function priceCell(tr, mount, row, spot, inr, cur) {
  const td = tr.insertCell();
  td.className = 'num';
  const fits = spot ? row.fitsSpot : row.fitsOd;
  let why = null;
  if (inr == null) why = spot ? 'no spot market' : 'no price';
  else if (!row.enabled) why = 'needs opt-in';
  else if (fits === false) why = 'no quota';
  if (why === 'no quota' && Array.isArray(mount.shortOfQuota)
      && !mount.shortOfQuota.includes(row.region)) mount.shortOfQuota.push(row.region);

  const label = document.createElement('label');
  const usable = !why && !boxNow;
  label.className = 'pick ' + (usable ? '' : 'off');
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = mount.name;
  radio.value = `${row.region}|${row.type}|${spot ? '1' : '0'}`;
  radio.disabled = !usable || machBusy();
  radio.checked = row.region === cur.region && row.type === cur.type && spot === cur.spot;
  if (radio.checked) label.classList.add('on');
  radio.onchange = () => { if (radio.checked) chooseMachine(row, spot); };
  label.append(radio);

  // The cheapest zone, and nothing pins the zone: show the spread when the
  // zones disagree, because the cheap number alone is a promise ayis cannot keep.
  // The same price the machine card shows: the address and the disk included.
  const range = hourText(perHour(inr), spot && row.spotMax != null ? perHour(row.spotMax) : null);
  const amount = document.createElement('span');
  amount.className = 'amount';
  amount.textContent = range == null ? 'none' : range;
  label.append(amount);

  // Why, on hover: a mark in the cell, the words in the tooltip and once
  // under the table, so the prices stay readable down the column.
  if (why) {
    const tag = document.createElement('span');
    tag.className = 'reason';
    tag.textContent = 'ⓘ';
    tag.title = `${REASON_LABEL[why] || why}: ${PICK_WHY[why] || why}`;
    label.append(tag);
    label.title = `${REASON_LABEL[why] || why}: ${PICK_WHY[why] || why}`;
  }
  td.append(label);
  return { td, usable, why };
}

// Said once, under the table, instead of a sentence in every cell.
// How a reason reads on screen; the keys stay the code's.
const REASON_LABEL = { 'no quota': 'Over GPU quota', 'needs opt-in': 'Region not enabled',
                       'no spot market': 'No spot price', 'no price': 'No price' };
const PICK_WHY = {
  'no quota': 'GPU quota here is too low for this machine. Increases are free to request.',
  'needs opt-in': 'this region is not enabled for your account. Enabling is free.',
  'no spot market': 'no spot market for this type here. On-demand may be available.',
  'no price': 'no price from AWS for this type here.',
};

let lastDead = null;
let repainting = false;
function paintChooser() {
  const { rows, swept } = chooserRows();
  const cur = currentPick();

  // The settings rows were painted before this had data, so their choice of
  // editor-or-pointer may now be wrong. Repaint them once, when the verdict
  // actually changes, and never from inside their own paint.
  const dead = chooserDead();
  if (!repainting && dead !== lastDead && config.length && $('s-groups').children.length) {
    lastDead = dead;
    repainting = true;
    try { paintConfig(config); } finally { repainting = false; }
  } else {
    lastDead = dead;
  }

  for (const mount of MOUNTS) {
    const table = $(mount.table);
    if (!table) continue;
    table.textContent = '';
    const reasons = new Set();
    // Collected as the cells are drawn, and reset each pass: priceCell is the
    // only place that knows a row is enabled and short, and the button under
    // the table is the only place that can do anything about it.
    const shortOfQuota = [];
    mount.shortOfQuota = shortOfQuota;
    if (!rows.length) {
      const td = table.insertRow().insertCell();
      td.colSpan = 8;
      td.className = 'why';
      td.textContent = !machinesAnswered ? 'Reading prices…'
        : machinesNow && machinesNow.error ? machinesNow.error
        : 'No machine type fits your GPU quota here. Check all regions to compare.';
    } else {
      const head = table.createTHead().insertRow();
      // The price headers do NOT get text-right: the cells under them lead with
      // a radio at the cell's left edge, so a right-aligned header sat over
      // nothing. capacity is the only genuinely right-aligned column.
      for (const [label, cls] of [['Region', ''], ['Latency', ''], ['Machine', ''], ['GPU', ''],
                                  ['Fast drive', 'num'], ['Spot availability', 'num'],
                                  ['Spot/hour', ''], ['On-demand/hour', '']]) {
        const th = document.createElement('th');
        th.textContent = label; th.className = cls;
        head.append(th);
      }
      const body = table.createTBody();
      let lastRegion = null;
      for (const row of rows) {
        const tr = body.insertRow();
        const first = row.region !== lastRegion;
        if (first && lastRegion !== null) tr.classList.add('group');
        if (row.region === cur.region) tr.classList.add('here');

        // The location by its city; AWS's code for it on hover.
        const place = cell(tr, first ? row.city || placeName(row.region) : '', 'region');
        if (first) place.title = row.region;
        cell(tr, first && row.rtt != null ? distance(row.rtt) : '', 'ms');
        cell(tr, row.type, '');
        cell(tr, row.gpu ? gpuName(row.gpu, row.vram) : '', 'city');
        // The fast disk games go on differs by machine - 125 GB to 250 GB here -
        // and decides which games fit; AWS's own figure for the type.
        cell(tr, row.store != null ? `${row.store} GB` : '', 'num');

        const sc = tr.insertCell();
        sc.className = 'num';
        if (row.score == null) { sc.textContent = ''; sc.classList.add('why'); }
        else {
          const s = document.createElement('span');
          s.className = 'score ' + (row.score >= 7 ? 'good' : row.score <= 2 ? 'bad' : '');
          s.textContent = `${row.score}/10`;
          sc.append(s);
        }
        const a = priceCell(tr, mount, row, true, row.spot, cur);
        const b = priceCell(tr, mount, row, false, row.od, cur);
        // A row with nothing pickable should recede, not look broken.
        if (!a.usable && !b.usable) tr.classList.add('dim');
        for (const r of [a.why, b.why]) if (r) reasons.add(r);
        lastRegion = row.region;
      }
    }

    // What the table cannot show on its own: how old it is, and what is missing.
    const parts = [];
    if (boxNow) parts.push('Delete the running machine before changing type.');
    else if (sweeping) parts.push('Checking all regions (~90 s)');
    else if (!swept && rows.length) parts.push('Showing this region only.');
    if (swept) {
      // Two numbers in a spot cell are the cheapest and dearest zone, and the
      // zone is not pinned, so the bill can be either.
      if (rows.some(r => r.spotMax != null && r.spot != null && r.spotMax > r.spot))
        parts.push('Spot ranges show the lowest and highest zone price');
      const far = (sweepNow.too_far || []).length;
      if (far) parts.push(`${far} region${far === 1 ? '' : 's'} hidden (${sweepNow.max_ms != null ? `over ${sweepNow.max_ms} ms` : 'too slow'})`);
    }
    $(mount.note).textContent = parts.join(' · ');

    // The legend. Only the reasons actually on screen, in plain words, so a
    // greyed-out half of a column reads as deliberate rather than broken.
    const legend = $(mount.legend);
    if (legend) {
      legend.textContent = '';
      // Nothing at all fits the quota: asking for more is the way on, and it was
      // offered only beside a greyed-out price - so an empty table, where it is
      // needed most, had no button.
      if (!rows.length && machinesAnswered && !(machinesNow && machinesNow.error)) {
        const b = document.createElement('button');
        b.className = 'btn mt-space-xs';
        b.textContent = 'Request quota increase';
        b.onclick = () => openQuota(null, machinesNow ? machinesNow.region : undefined);
        legend.append(b);
      }
      // Why the table is short. Rows that no quota can launch are left out -
      // picking one would only fail at launch - but a region offering sixteen
      // machines and showing two looks broken without a word about it.
      // And why it is one region. The scan is remembered per laptop, so a
      // window that has never run one shows the region .env names and nothing
      // else - which looks like the other regions have gone missing.
      // A scan in flight says so here as well as on its button: the button is
      // at the top of a long screen, and the question is asked at the table.
      if (sweeping && rows.length) {
        const line = document.createElement('div');
        line.textContent = 'Checking all regions (~90 s). Showing '
          + `${machinesNow ? placeName(machinesNow.region) : 'one region'} until then.`;
        legend.append(line);
      } else if (!swept && rows.length) {
        const line = document.createElement('div');
        line.textContent = `Showing ${machinesNow ? placeName(machinesNow.region) : 'one region'} only. `
          + 'Checking all regions takes ~90 s. No charge.';
        legend.append(line);
        // The button, here, rather than the name of a button elsewhere: this
        // line is where the question gets asked, and the answer was two
        // scrolls away at the top of the screen.
        const b = document.createElement('button');
        b.className = 'btn mt-space-xs';
        b.textContent = 'Check all regions';
        b.onclick = () => scanRegions($('s-sweep'));
        legend.append(b);
      }
      const hidden = hiddenByQuota();
      if (hidden) {
        const line = document.createElement('div');
        line.textContent = `${hidden} more GPU type${hidden === 1 ? '' : 's'} here exceed${hidden === 1 ? 's' : ''} your quota.`;
        legend.append(line);
      }
      if (rows.length) {
        const line = document.createElement('div');
        // What each price holds, so it can be checked against the bill.
        const tax = ((statusNow && statusNow.rates) || {}).tax_pct;
        line.textContent = 'Spot is cheaper but can be reclaimed mid-session. On-demand is not. '
          + 'Prices include the IP address and disk'
          + (tax ? `, and ${tax}% GST.` : '.');
        legend.append(line);
      }
      if (reasons.size) {
        const intro = document.createElement('div');
        intro.className = 'mt-space-sm';
        intro.textContent = 'Greyed prices would be refused at launch:';
        legend.append(intro);
        // Each reason on one line, with the button that fixes it beside it.
        const FIX = {
          'no quota': ['Ask AWS for more', () => openQuota(null, shortOfQuota[0])],
          'needs opt-in': ['Switch it on', () => openOptin()],
        };
        for (const r of ['no quota', 'needs opt-in', 'no spot market', 'no price']) {
          if (!reasons.has(r)) continue;
          const line = document.createElement('div');
          line.className = 'flex flex-wrap items-center gap-space-sm mt-space-xs';
          const b = document.createElement('b');
          b.textContent = `${REASON_LABEL[r] || r}:`;
          const text = document.createElement('span');
          text.textContent = PICK_WHY[r];
          // Together, so the gap before the button is not also before the colon.
          const words = document.createElement('span');
          words.append(b, ' ', text);
          line.append(words);
          if (FIX[r]) {
            const btn = document.createElement('button');
            btn.className = 'btn';
            btn.textContent = FIX[r][0];
            btn.onclick = FIX[r][1];
            line.append(btn);
          }
          legend.append(line);
        }
      }
    }
    const ageEl = $(mount.age);
    if (ageEl) ageEl.textContent = sweepNow && sweepNow.cached && sweepNow.age_seconds != null
      ? `Checked ${ago(sweepNow.age_seconds)}` : '';
  }
  paintBuildPick();
  lockMachines();
}

// What the chooser is waiting for, said in a popup over it - the same one
// Refresh uses: a backdrop over everything, Esc does nothing, it closes itself
// when done and stays with the reason and a Close when not. Without it the
// table under a scan looked live, and Esc closed the chooser mid-scan.
function busyPopup(title, sub, step) {
  const dlg = $('refdlg');
  $('refdlg-title').textContent = title;
  $('refdlg-sub').textContent = sub;
  $('refdlg-menu').hidden = true;
  const list = $('refdlg-list');
  list.textContent = '';
  const row = document.createElement('div');
  row.className = 'flex items-start gap-space-sm font-body-md text-body-md';
  row.dataset.step = step;
  row.append(Object.assign(document.createElement('span'), { className: 'spinner mt-0.5' }),
             Object.assign(document.createElement('div'), { textContent: step }));
  list.append(row);
  if (!dlg.open) dlg.showModal();
  return {
    done() { dlg.close(); },
    fail(why) {
      $('refdlg-title').textContent = `${title} - not done`;
      list.textContent = '';
      const bad = document.createElement('div');
      bad.className = 'flex items-start gap-space-sm font-body-md text-body-md';
      bad.dataset.state = 'failed';
      bad.append(Object.assign(document.createElement('span'), { className: 'w-4 text-center text-error', textContent: '✗' }),
                 Object.assign(document.createElement('div'), { className: 'font-code-sm text-code-sm text-on-surface-variant break-words', textContent: why }));
      list.append(bad);
      $('refdlg-menu').hidden = false;
      $('refdlg-close').focus();
    },
  };
}

// Every button in the popup, the legend's included - they are redrawn each
// paint, so this runs after it.
function lockMachines() {
  const dlg = $('machdlg');
  if (!dlg) return;
  const busy = machBusy();
  for (const b of dlg.querySelectorAll('button')) b.disabled = busy;
  $('s-chooser').classList.toggle('busy', busy);
  $('machdlg-close').textContent = choosing ? 'Saving…' : 'Done';
}

// The choice changed, so the machine card says the new one, on both pages.
function paintBuildPick() { paintMachineCards(); }

let machinesNow = null;
// Just the store now. `ayis machines` is still read - it is the only answer for
// the region in force, and the table falls back to it before any sweep - but
// the single <select> it used to fill is gone, replaced by the chooser table.
let machinesAnswered = false;
function paintMachines(d) { machinesNow = d; machinesAnswered = true; paintChooser(); paintOnboardSoon(); paintDash(); paintFit(); }

function paintSpec(s) {
  const spec = s.spec || {};
  boxNow = s.box || null;
  boxSeenAt = Date.now();
  // The reads land in whatever order they finish, and whether a pick is allowed
  // at all depends on this one - so repaint the chooser once a box is known, or
  // a table that arrived first would stay selectable beside a running box.
  paintChooser();
  paintFit();
  paintRun();
  paintLibraryPage();       // where the games are kept, and for how long
}

// How long a run is expected to take, in minutes, so the bar means something.
// Only `init` has a published estimate - the others finish when they finish, and
// a bar invented for them would be a number nobody measured.
const RUN_EXPECT = { init: 20 };

// ── A run, as steps ─────────────────────────────────────────────────────────
//
// ayis reports about twelve steps for a build, in its own words, and the box adds
// a dozen more of its own ("installing nvidia driver", "configuring headless X").
// Someone building a games machine needs eight, in plain words - so each step
// ayis announces is placed in one of these, and only ever moves the run forwards.
// A step ayis announces that matches none of them belongs to the one in progress,
// and shows as its current line. A delete or a session has no such list: each
// of ayis's steps is its own row.
const BUILD_STEPS = [
  { doing: 'Checking your setup', done: 'Checked your setup', ids: ['preflight', 'init.watchdog'] },
  { doing: 'Setting the budget alert', done: 'Budget alert set', ids: ['init.budget'] },
  { doing: 'Launching the machine', done: 'Machine launched', bills: true, ids: ['init.launch'] },
  { doing: 'Connecting to Tailscale', done: 'Connected to Tailscale', ids: ['init.tailnet'] },
  { doing: 'Installing the software', done: 'Software installed', parts: true, ids: ['init.build'] },
  { doing: 'Restoring games', done: 'Games restored', games: true, part: 'finishing' },
  { doing: 'Connecting Moonlight', done: 'Moonlight connected', ids: ['init.host-watchdog', 'init.sunshine-account', 'init.pair'] },
  { doing: 'Starting Steam', done: 'Steam started', ids: ['init.steam'] },
];
// A session, as steps. ayis announces each by id (open.start ... open.play), and
// open.ended once Moonlight has closed.
const OPEN_STEPS = [
  { doing: 'Starting the machine', done: 'Machine started', id: 'open.start' },
  { doing: 'Connecting over Tailscale', done: 'Connected over Tailscale', id: 'open.tailscale' },
  { doing: 'Bringing your games back', done: 'Games are back', id: 'open.restore' },
  { doing: 'Starting the game stream', done: 'Game stream ready', id: 'open.sunshine' },
  { doing: 'Playing', done: 'Played', id: 'open.play', stream: true,
    note: 'Close Moonlight to end the session. The machine keeps running until auto-stop or Delete.' },
];
// A session on a machine of yours: nothing to start and nothing billed, so two
// steps - ayis host open announces each - where the AWS machine has four.
const HOST_OPEN_STEPS = [
  { doing: 'Checking the machine', done: 'Machine ready', id: 'host.check' },
  { doing: 'Playing', done: 'Played', id: 'host.play', stream: true,
    note: 'Close Moonlight to end the session.' },
];
const openSteps = r => (r && r.host ? HOST_OPEN_STEPS : OPEN_STEPS.filter(d => d.id !== 'open.restore' || (r && r.restore)));
// What the machine installs, in the order it does it, each matched to the
// progress line the box prints when it starts that piece (lib/bootstrap.d).
// Shown as chips inside "Installing the software", ticked as the box moves on:
// the step installs far more than a driver, and said so in three words.
const BUILD_PARTS = [
  ['Base system', 'base'],
  ['Fast drive', 'disk'],
  ['Auto-stop', 'idle-watchdog'],
  ['Tailscale', 'tailscale'],
  ['Game library', 'library'],
  ['Desktop', 'desktop'],
  ['NVIDIA driver', 'nvidia'],
  ['Display', 'display'],
  ['Autologin', 'autologin'],
  ['Steam', 'steam'],
  ['Steam client', 'steam-update'],
  ['Firefox', 'firefox'],
  ['Audio', 'audio'],
  ['Sunshine', 'sunshine'],
];
// Each part: not started, started (the latest one to start is in progress), or
// done - because a later one has started, or the whole step has finished. ayis
// names each piece as the box starts it (a "part" event); `seen` is those ids in
// the order they came.
function partStates(seen, stepDone, finished = null) {
  const at = BUILD_PARTS.map(([, id]) => seen.indexOf(id));
  // A supervised build says when each piece is done, and pieces run together: a
  // piece that started and is not done is running, however many there are.
  if (finished && finished.size) {
    return BUILD_PARTS.map(([name, id], k) => [name,
      stepDone || finished.has(id) ? 'done' : at[k] < 0 ? 'waiting' : 'running']);
  }
  const latest = at.reduce((best, i, k) => (i > (best < 0 ? -1 : at[best]) ? k : best), -1);
  return BUILD_PARTS.map(([name], k) => [name,
    stepDone ? 'done' : at[k] < 0 ? 'waiting' : k === latest ? 'running' : 'done']);
}

// The run on screen: which kind, when it began, its steps and their lines, and
// how it ended. null while the Build screen is choosing what to build.
let run = null;
let builtOpen = false;
// The build that made the machine, and its full log: a session or a refused
// delete replaces the run, and afterwards the machine is still that build -
// "How it was built" and its log come back with it.
let lastBuild = null, lastBuildLog = '';   // whether "How it was built" is unfolded
const runRow = text => ({ name: text, start: Date.now(), end: null, lines: [], failed: false });
function runBegin(kind, opts = {}) {
  run = { kind, start: Date.now(), billFrom: null, state: 'running', idx: -1, steps: [],
          games: opts.games || 0, gamesGb: opts.gamesGb || 0, apps: opts.apps || 'none', parts: [], wait: null, restore: !!opts.restore,
          rate: kind === 'init' ? buildRate() : null };
  if (kind === 'init') run.steps = BUILD_STEPS.map(() => null);
  if (kind === 'open') {
    // A machine of yours: its name, and no bill - it is not rented.
    if (opts.host) run.host = opts.host;
    run.steps = openSteps(run).map(() => null);
    run.steps[0] = runRow('');
    run.idx = 0;
    if (!run.host) {
      // The machine has been billing since it launched, not since Play.
      // A stopped machine bills from this start, not from the launch it had days ago.
      const box = liveBox();
      run.billFrom = box && box.state !== 'running' ? Date.now()
        : box && box.launched ? new Date(box.launched).getTime() : null;
      run.rate = buildRate();
    }
  }
}
// Moving to a step: the ones before it are over, it is the one in progress. Only
// ever forwards - a stage ayis names twice (init.launch, then init.launch.reused)
// does not move the run back.
function runEnter(defs, at) {
  if (at <= run.idx) return false;
  const now = Date.now();
  for (let i = 0; i < at; i++) {
    if (!run.steps[i]) run.steps[i] = { ...runRow(''), start: now };
    if (!run.steps[i].end) run.steps[i].end = now;
  }
  run.steps[at] = runRow('');
  run.idx = at;
  run.wait = null;
  // The machine was stopped when the page last looked. Once Play has started it,
  // look again - once, not on a timer - so the card and the checks say running.
  if (run.kind === 'open' && !run.host && defs[at] && defs[at].id === 'open.sunshine' && !run.reread) {
    run.reread = true;
    readFresh(['status', '--json'], 'status').catch(() => {});
  }
  return true;
}
// ayis names a stage by id; a screen follows the id and never the words.
const idIs = (got, want) => got === want || (got || '').startsWith(want + '.');
// A step ayis announced: move to the step it belongs to, closing the ones before.
function runStep(text, id) {
  if (!run) return;
  const now = Date.now();
  if (run.kind === 'open') {
    // The stream is over once Moonlight has closed: the session itself is not.
    if (id === 'open.ended') { run.streamEnded = true; return; }
    const at = openSteps(run).findIndex(d => d.id === id);
    if (at < 0 || !runEnter(openSteps(run), at)) runLine(text);
    return;
  }
  // A machine that was there before this build: not its to delete on failure.
  if (run.kind === 'init' && idIs(id, 'init.launch.reused')) run.reused = true;
  if (run.kind !== 'init') {
    if (run.idx >= 0) run.steps[run.idx].end = now;
    run.steps.push(runRow(text));
    run.idx = run.steps.length - 1;
    return;
  }
  const at = BUILD_STEPS.findIndex(d => (d.ids || []).some(x => idIs(id, x)));
  if (at > run.idx) {
    runEnter(BUILD_STEPS, at);
    // A step that was passed did not fail; whatever it said that sounded like
    // failure is not the headline of a later one.
    if (buildFailures.length) buildFailClear();
    // Billing starts with a machine that exists: when the renting step has
    // finished, counted from when it began. A rental that fails bills nothing.
    const rent = BUILD_STEPS.findIndex(d => d.bills);
    if (!run.billFrom && at > rent && run.steps[rent]) run.billFrom = run.steps[rent].start;
  }
  if (run.idx >= 0) run.steps[run.idx].lines.push(text);
}
// The box started a piece of the machine (ayis names it). The last piece, finishing
// up, is the games step of its own.
function runPartDone(id) {
  if (!run || run.kind !== 'init' || !id) return;
  if (!run.finished) run.finished = new Set();
  run.finished.add(id);
  if (!run.parts.includes(id)) run.parts.push(id);
}
function runPart(id) {
  if (!run || run.kind !== 'init' || !id) return;
  if (!run.parts.includes(id)) run.parts.push(id);
  const games = BUILD_STEPS.findIndex(d => d.part === id);
  if (games >= 0 && runEnter(BUILD_STEPS, games)) {
    const rent = BUILD_STEPS.findIndex(d => d.bills);
    if (!run.billFrom && run.steps[rent]) run.billFrom = run.steps[rent].start;
  }
}
// A wait that is going on, or how it ended. Only the latest is kept: the screen
// shows one live line, and the log gets the first and the last of each wait.
function runWait(e) {
  if (!run) return;
  run.wait = e.state === 'waiting' ? { id: e.id, text: e.text, secs: e.secs, of: e.of, at: Date.now() } : null;
}
const waitSecs = n => (n < 60 ? `${n} s` : `${Math.floor(n / 60)} min ${n % 60 ? (n % 60) + ' s' : ''}`.trim());
const waitWords = w => `${w.text} · ${waitSecs(w.secs)}${w.of > 0 && w.of <= 600 ? ` of ${waitSecs(w.of)}` : ''}`;
function runLine(text) {
  if (!run || run.idx < 0 || !text) return;
  const lines = run.steps[run.idx].lines;
  lines.push(text);
  if (lines.length > 400) lines.splice(0, lines.length - 400);
}
function runEnd(rc) {
  if (!run) return;
  const now = Date.now();
  run.state = rc === 0 ? 'done' : 'failed';
  run.ended = now;
  run.rc = rc;
  if (rc === 0) {
    run.steps = run.steps.map(x => x ? { ...x, end: x.end || now } : { ...runRow(''), start: now, end: now });
  } else if (run.idx >= 0) {
    run.steps[run.idx].failed = true;
    run.steps[run.idx].end = now;
  }
}

const mins = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 1 ? 'under a minute' : `${m} min`; };
const took = (a, b) => { const s = Math.round((b - a) / 1000); return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`; };

const RUN_HEAD = {
  init: { running: 'Building', done: 'Ready to play', failed: 'Build failed' },
  destroy: { running: 'Deleting the machine', done: 'Machine deleted', failed: 'Delete failed' },
  open: { running: 'Starting session', done: 'Session ended', failed: 'Session failed' },
  library: { running: 'Updating saved games', done: 'Saved games updated', failed: 'Update failed' },
};

// Which card the Build screen shows is decided by the machine, never by where
// you have been: the plan only when there is no machine, a run while one goes,
// and otherwise the machine itself. It used to be whatever `run` held, and
// "Back to dashboard" cleared that - so leaving and coming back swapped a
// finished build for the plan of a machine that already existed.
const liveBox = () => boxNow && boxNow.state !== 'terminated' ? boxNow : null;
// What a failed build left billing - asked of the machine, not of which step
// it stopped at: a build can stop after the launch, inside the launching step,
// and it said "Nothing was billed" over a machine running at Rs 20 an hour.
// Nothing is claimed until a status read after the failure has answered (the
// painter repaints this as it lands).
function failedBill() {
  if (run && run.deleting) return 'Deleting the machine\u2026';
  if (run && run.deleted) return 'Machine deleted, so nothing more is billed';
  const box = liveBox();
  if (box) return `A machine is ${box.state} - delete it to stop billing`;
  // A status read after the run ended, and no machine in it.
  return run && run.ended && boxSeenAt > run.ended ? 'Nothing was billed' : null;
}

// A finished run that the machine has moved past gives way to it.
function settleRun() {
  settleRunOnly();
  // Back to the machine: if this window built it, it is that build again.
  if (!run && lastBuild && liveBox()) {
    run = lastBuild;
    $('b-log').innerHTML = lastBuildLog;
    $('b-log-title').textContent = 'Build log';
  }
}
function settleRunOnly() {
  // A session you stopped is not a failure: it ends where any session does.
  if (run && run.kind === 'open' && run.rc === 130) { run = null; return; }
  if (!run || run.state !== 'done') return;
  if (run.kind === 'destroy') {
    lastBuild = null;
    // ayis said the machine is gone; the status read that confirms it is still
    // on its way, and the plan should not wait for it.
    run = null;
    boxNow = null;
    paintFit();
  } else if (run.kind !== 'init') {
    run = null;                               // a stream ended: back to the machine
  } else if (!liveBox() && boxSeenAt > (run.ended || Infinity)) {
    // Built, and gone since (idle, reclaimed) - by a read taken after the
    // build ended, not one from before the machine existed.
    run = null;
    lastBuild = null;
  }
}

// The machine, when no run is in memory - the app was reopened, or a stream
// has ended. A machine that exists is shown as one, never as a plan.
function machineCard() {
  const box = liveBox();
  if (!box) return null;
  const t = box.launched ? new Date(box.launched).getTime() : null;
  return { kind: 'machine', state: 'done', start: t || Date.now(), billFrom: t, steps: [], idx: -1,
           rate: buildRate(), games: 0, gamesGb: 0, apps: 'none' };
}

// What a machine is doing, as the heading of its card.
function machineTitle() {
  const box = liveBox();
  if (sessionNow) return 'Playing';
  if (!box || box.state === 'running') return 'Ready to play';
  if (box.state === 'pending') return 'Starting up';
  return `Machine ${box.state}`;
}

// The run the Machine page shows: the AWS machine's on its tab, a machine of
// yours' on its own - never one on the other's page.
function shownRun() {
  if (machineTab !== 'aws') return run && run.host === machineTab ? run : null;
  return (run && !run.host ? run : null) || machineCard();
}
function paintBuildMode() {
  settleRun();
  const awsRun = run && !run.host ? run : null;
  $('b-plan').hidden = !!(awsRun || liveBox());
  // The panel above says what the machine is and holds its buttons; this card
  // is the run under it - a build, a session, a delete - or how the machine
  // was built. A machine with no run behind it here has nothing to add. It
  // sits under the machine it is about: the AWS one, or the card of yours.
  const strip = $('b-strip');
  const own = machineTab !== 'aws';
  if (own && strip.parentElement !== $('b-own')) $('b-own').append(strip);
  if (!own && strip.parentElement !== $('b-aws')) $('b-aws').insertBefore(strip, $('b-plan'));
  strip.hidden = !(own ? run && run.host === machineTab : awsRun);
}

// Cancel a build: stop ayis, then delete whatever it rented. The delete runs
// even when no machine has been seen yet - the launch may have gone through
// before the status caught up, and a delete with nothing to delete is quick
// and free. --no-push: a half-built machine holds nothing worth saving.
async function cancelBuild() {
  const ok = await askConfirm({
    title: 'Cancel the build?',
    body: 'The machine is deleted and billing stops. Saved games are not affected.',
    yes: 'Cancel build', no: 'Keep building', danger: true,
  });
  if (!ok || !run || run.kind !== 'init' || run.state !== 'running') return;
  run.cancelling = true;
  paintRun();
  for (const [id, j] of jobs) if (j.cmd[0] === 'init') window.ayis.cancel(id);
}

// A step's name as the run shows it: restoring games says how much, or is the
// restart when there are none; the launch says when billing began.
function runStepName(r, def, state) {
  let name = state === 'done' ? def.done : def.doing;
  if (def.games) {
    name = !r.games ? (state === 'done' ? 'Restarted into the desktop' : 'Restarting into the desktop')
      : state === 'done' ? name : `${name} · ${r.gamesGb.toFixed(1)} GB`;
  }
  if (def.bills && state === 'done' && r.billFrom) {
    name += ` · billing from ${new Date(r.billFrom).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return name;
}

function paintRun() {
  paintBuildMode();
  const r = shownRun();
  if (!r) return;
  const head = RUN_HEAD[r.kind] || { running: 'Running', done: 'Done', failed: 'Stopped' };
  const machine = r.state === 'done' && (r.kind === 'init' || r.kind === 'machine');
  const now = r.state === 'running' ? Date.now() : (r.steps.reduce((t, x) => Math.max(t, x && x.end || 0), 0) || Date.now());
  const title = $('b-strip-title');
  title.textContent = r.cancelling ? 'Cancelling' : machine ? (r.kind === 'init' ? 'How it was built' : machineTitle())
    : r.kind === 'open' && r.state === 'running' && openSteps(r)[r.idx] && openSteps(r)[r.idx].stream
      ? (r.streamEnded ? 'Session ended' : 'Playing') : head[r.state];
  title.className = 'font-headline-lg text-headline-lg ' + (r.state === 'failed' ? 'text-error' : '');
  // The bill, in the heading, from the moment the machine is rented - unless a
  // session is over and the machine with it: "₹38 so far, ₹26.58 an hour"
  // under a failed session read as a machine still billing that was gone.
  const billing = r.billFrom && r.rate != null && !(r.kind === 'open' && r.state !== 'running' && !liveBox());
  const so = billing ? r.rate * ((machine ? Date.now() : now) - r.billFrom) / 3600000 : null;
  $('b-strip-meta').textContent = [
    r.state === 'running' ? mins(now - r.start) : r.kind === 'machine' ? `up ${mins(now - r.start)}`
      : r.state === 'done' && r.kind === 'init' ? `built in ${mins(now - r.start)}` : null,
    so != null ? `${rs(so)} so far` : null,
    // What a failed build left billing, beside what it cost: being deleted,
    // deleted, or nothing ever rented.
    r.kind === 'init' && r.state === 'failed' ? failedBill() : null,
    billing ? `${rsh(r.rate)} an hour` : null,
  ].filter(Boolean).join(' · ');
  const s = statusNow || {};
  const hs = r.host ? hostStatus.get(r.host) || {} : null;
  $('b-run-sum').textContent = r.host ? [r.host, hs.gpu, 'Your machine'].filter(Boolean).join(' · ')
    : r.kind === 'init' || r.kind === 'machine' || r.kind === 'open'
    ? [r.kind !== 'init' && liveBox() ? liveBox().type : s.instance_type, s.region ? placeName(s.region) : null,
       (r.kind !== 'init' && liveBox() ? liveBox().lifecycle !== 'spot' : (s.config || {}).spot === '0') ? 'On-demand' : 'Spot',
       r.kind !== 'init' ? null
         : r.games ? `${r.games} game${r.games === 1 ? '' : 's'}, ${r.gamesGb.toFixed(1)} GB` : 'no games']
        .filter(Boolean).join(' · ')
    : '';
  $('b-run-sum').hidden = !$('b-run-sum').textContent;
  // While a build or a session gets going, the step it is on is the heading,
  // and what the run is - building, where, on what - sits above it, small.
  // Not once Playing: that heading is the session, and the step says the rest.
  const defs = r.kind === 'init' ? BUILD_STEPS : r.kind === 'open' ? openSteps(r) : null;
  const going = defs && r.state === 'running' && !r.cancelling;
  const at = going ? Math.max(0, r.steps.findIndex(x => x && !x.end)) : -1;
  const headed = at >= 0 && !defs[at].stream;
  $('b-run-head').hidden = !headed;
  $('b-run-kicker').hidden = !headed;
  title.hidden = headed;
  if (headed) {
    $('b-run-kicker').textContent = [title.textContent, $('b-run-sum').textContent].filter(Boolean).join(' · ');
    $('b-run-sum').hidden = true;
    $('b-run-now').textContent = runStepName(r, defs[at], 'running');
    $('b-run-step').textContent = `Step ${at + 1} of ${defs.length}.`
      + (r.kind === 'init' ? ' You can leave this screen; the build carries on.' : '');
  }
  // A build's time and bill as two tiles: the time against the last build ayis
  // measured, the bill from the moment the machine was rented.
  const lastMin = ((statusNow || {}).build || {}).last_min;
  const tiles = headed && r.kind === 'init';
  $('b-run-tiles').hidden = !tiles;
  $('b-strip-meta').hidden = tiles;
  if (tiles) {
    $('b-tile-time').textContent = mins(now - r.start);
    $('b-tile-time-sub').textContent = lastMin != null ? `Last build took ${lastMin} min`
      : `Usually about ${RUN_EXPECT.init} min`;
    $('b-tile-cost').textContent = rs(so != null ? so : 0);
    $('b-tile-cost-sub').textContent = [
      r.billFrom ? `Billing since ${new Date(r.billFrom).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : 'Starts when the machine launches',
      r.rate != null ? `${rsh(r.rate)} an hour` : null,
    ].filter(Boolean).join(' · ');
  }
  // Time against the last build, else the usual length, and only while it runs.
  const expect = r.kind === 'init' && lastMin || RUN_EXPECT[r.kind];
  $('b-bar-track').hidden = !(r.state === 'running' && expect);
  if (expect) $('b-prog').style.width = `${Math.min(95, ((now - r.start) / 60000 / expect) * 100).toFixed(1)}%`;

  const wrap = $('b-steps');
  // The failure panel is drawn into the failed step; park it before the rows go.
  const fail = $('b-fail');
  $('b-strip').insertBefore(fail, $('b-run-acts'));
  // A machine found already running has no run behind it, so no log either.
  $('b-logbox').hidden = r.kind === 'machine';
  if (r.state === 'running' || machine || r.cancelling) fail.classList.add('hidden');
  else if (buildFailures.length) fail.classList.remove('hidden');
  wrap.textContent = '';
  const rows = defs
    ? defs.map((d, i) => ({ def: d, st: r.steps[i] }))
    : r.steps.map(st => ({ def: null, st }));
  rows.forEach(({ def, st }, i) => {
    const state = !st ? (r.state === 'running' ? 'locked' : 'skipped')
      : st.failed ? 'failed' : st.end ? 'done' : 'running';
    const row = document.createElement('div');
    row.className = 'flex gap-space-md items-stretch';
    row.dataset.step = def ? String(i) : st.name;
    row.dataset.state = state;
    const rail = document.createElement('div');
    rail.className = 'flex flex-col items-center shrink-0 w-5';
    const [mark, cls] = { done: ['✓', 'text-primary'], running: ['●', 'text-tertiary animate-pulse'],
                          failed: ['✗', 'text-error'], locked: ['○', 'text-outline-variant'],
                          skipped: ['○', 'text-outline-variant'] }[state];
    rail.append(Object.assign(document.createElement('span'),
      { className: 'font-code-md text-code-md leading-6 ' + cls, textContent: mark }));
    if (i < rows.length - 1) {
      rail.append(Object.assign(document.createElement('div'), {
        className: 'w-px flex-1 min-h-[12px] my-1 ' + (state === 'done' ? 'bg-primary/70' : 'bg-surface-variant') }));
    }
    const body = document.createElement('div');
    body.className = 'min-w-0 flex-1 ' + (state === 'running' || state === 'failed' ? 'pb-space-lg' : 'pb-space-sm');
    const top = document.createElement('div');
    top.className = 'flex items-baseline justify-between gap-space-sm';
    const name = def ? runStepName(r, def, state) : st.name;
    top.append(Object.assign(document.createElement('span'), {
      className: 'leading-6 font-body-md text-body-md ' + (state === 'done' ? 'text-on-surface-variant'
        : state === 'locked' || state === 'skipped' ? 'text-outline'
        : state === 'failed' ? 'text-error font-medium' : 'text-on-surface font-medium'),
      textContent: name }));
    const meta = state === 'done' && st.start && st.end ? took(st.start, st.end)
      : state === 'running' ? took(st.start, Date.now()) : state === 'failed' ? 'failed' : '';
    if (meta) top.append(Object.assign(document.createElement('span'), {
      className: 'font-code-sm text-code-sm shrink-0 ' + (state === 'failed' ? 'text-error' : 'text-outline'),
      textContent: meta }));
    body.append(top);
    if (def && def.note && state === 'running') {
      body.append(Object.assign(document.createElement('p'), {
        className: 'font-code-sm text-code-sm text-outline mt-0.5', textContent: def.note }));
    }
    if (def && def.parts && st && (state === 'running' || state === 'failed')) {
      const chips = document.createElement('div');
      chips.className = 'flex flex-wrap gap-space-xs mt-space-sm';
      chips.id = 'b-parts';
      for (const [part, ps] of partStates(r.parts || [], false, r.finished)) {
        chips.append(Object.assign(document.createElement('span'), {
          className: 'pill ' + (ps === 'done' ? 'pill-ok' : ps === 'running' ? 'pill-warn' : ''),
          textContent: ({ done: '\u2713 ', running: '\u25cf ', waiting: '\u2026 ' })[ps] + part }));
        chips.lastChild.dataset.part = part;
        chips.lastChild.dataset.state = ps;
      }
      body.append(chips);
    }
    // Playing is not a wait: no progress sweep, and no echo of ayis's last line.
    if (state === 'running' && !(def && def.stream)) {
      // A wait ayis is reporting says how long it has gone, and against what limit;
      // otherwise the step's last line.
      const w = r.wait;
      const last = w ? waitWords(w) : [...st.lines].reverse().find(Boolean);
      if (last) body.append(Object.assign(document.createElement('p'),
        { className: 'font-code-sm text-code-sm text-on-surface-variant truncate mt-0.5', textContent: last }));
      const sweep = document.createElement('div');
      sweep.className = 'onb-progress mt-space-xs';
      sweep.append(document.createElement('i'));
      // A short limit is a real measure (the wait gives up there); a long one is
      // only a ceiling, and a bar filling towards it would promise too much.
      if (w && w.of > 0 && w.of <= 600) {
        sweep.classList.add('determinate');
        sweep.firstChild.style.width = `${Math.min(100, (w.secs / w.of) * 100).toFixed(0)}%`;
      }
      body.append(sweep);
    }
    if (state === 'failed') body.append(fail);
    // A failed step shows ayis's words once, in the failure above - not again here.
    if (st && st.lines.length && state !== 'locked' && state !== 'failed') {
      // This step's own lines, folded - opened by itself when it failed.
      const det = document.createElement('details');
      det.className = 'mt-space-xs';
      det.open = st.open != null ? st.open : state === 'failed';
      det.ontoggle = () => { st.open = det.open; };
      det.append(Object.assign(document.createElement('summary'), {
        className: 'font-code-sm text-code-sm text-outline cursor-pointer',
        textContent: `Details · ${st.lines.length} line${st.lines.length === 1 ? '' : 's'}` }));
      const pre = document.createElement('pre');
      pre.className = 'font-code-sm text-code-sm text-on-surface-variant whitespace-pre-wrap break-words '
        + 'max-h-[32vh] overflow-auto mt-space-xs p-space-sm rounded bg-surface-container-lowest '
        + 'border border-surface-variant';
      pre.textContent = st.lines.join('\n');
      det.append(pre);
      body.append(det);
      if (det.open) pre.scrollTop = pre.scrollHeight;
    }
    row.append(rail, body);
    wrap.append(row);
  });
  // A finished build is the machine now; how it was built folds away under it.
  if (r.kind === 'init' && r.state === 'done') {
    const det = document.createElement('details');
    det.open = builtOpen;
    det.ontoggle = () => { builtOpen = det.open; };
    det.append(Object.assign(document.createElement('summary'), {
      className: 'font-code-sm text-code-sm text-outline cursor-pointer mb-space-sm',
      textContent: `Build details · ${mins(now - r.start)}` }), ...wrap.children);
    wrap.append(det);
  }

  // What to do now, by how it ended.
  const acts = $('b-run-acts');
  acts.textContent = '';
  const btn = (label, go, primary) => {
    const b = document.createElement('button');
    b.className = 'btn' + (primary ? ' btn-primary' : '');
    b.textContent = label;
    b.onclick = go;
    acts.append(b);
  };
  if (r.state === 'running' && r.kind === 'init') {
    btn(r.cancelling ? 'Cancelling…' : 'Cancel', cancelBuild);
    acts.lastChild.disabled = !!r.cancelling;
  } else if (machine) {
    // Play and Delete are the panel's, above.
  } else if (r.state === 'failed' && r.kind === 'init') {
    btn('Try again', () => retryBuild(), true);
    // Not while its machine is being deleted: a new build would find it.
    acts.lastChild.disabled = !!r.deleting;
    btn('Close', () => { run = null; paintRun(); });
  } else if (r.state !== 'running') {
    btn('Done', () => { run = null; paintRun(); });
  }
}

// The durations and the bill move with ayis's own lines - a build reports at
// least every ten seconds - so nothing here runs on a timer.

// The live line and step heading for runs, now that the strip has no line of
// its own: kept as functions because the event handler calls them.
const buildLogged = () => !!(run && run.kind === 'init');
function buildStep(text, id) {
  const log = $('b-log');
  if (!buildLogged()) { $('b-prog-step').textContent = text; runStep(text, id); paintRun(); return; }
  if (log.dataset.fresh !== 'no') { log.textContent = ''; log.dataset.fresh = 'no'; buildStarted = Date.now(); }
  buildSteps += 1;
  const head = document.createElement('div');
  head.className = 'step flex items-baseline gap-space-sm pt-space-sm first:pt-0';
  const label = document.createElement('span');
  label.className = 'text-on-surface';
  label.textContent = text;
  const meta = document.createElement('span');
  meta.className = 'meta ml-auto pl-space-sm text-outline shrink-0';
  head.append(label, meta);
  log.append(head);
  $('b-prog-step').textContent = text;
  runStep(text, id);
  paintRun();
  if ($('b-follow').checked) log.scrollTop = log.scrollHeight;
}

// ayis times every step; the transcript keeps how long each took.
function buildStepEnd(event) {
  if (!buildLogged()) return;
  const heads = $('b-log').querySelectorAll('.step');
  const last = heads[heads.length - 1];
  if (!last) return;
  const meta = last.querySelector('.meta');
  const ok = !event.rc;
  meta.textContent = event.secs != null ? `${Math.round(event.secs)}s` : (ok ? 'ok' : `exit ${event.rc}`);
  if (!ok) meta.classList.add('text-error');
}

function buildProgressDone(rc) {
  const cancelled = run && run.kind === 'init' && run.cancelling;
  runEnd(rc);
  if (run && run.kind === 'init' && run.state === 'done') { lastBuild = run; lastBuildLog = $('b-log').innerHTML; }
  paintRun();
  // After the exit has been handled, so the init job is gone when the delete starts.
  if (cancelled) Promise.resolve().then(() => startRun(['destroy', '--no-push']));
  // A build that failed once its machine was rented deletes it too, as Cancel
  // does - left, it billed until the cloud watchdog ended it, near an hour on.
  // Only a machine this build launched: one it picked up again may hold games
  // restored over an hour, and a passing failure is no reason to lose them.
  else if (run && run.kind === 'init' && run.state === 'failed' && run.billFrom && !run.reused)
    Promise.resolve().then(deleteFailedBuild);
}
// Under the failed build, not in place of it: why it failed stays on screen
// while its machine goes. --no-push: a half-built machine holds nothing worth
// saving.
async function deleteFailedBuild() {
  const r = run;
  r.deleting = true;
  paintRun();
  const { rc } = await runAyis(['destroy', '--no-push'], { wantRc: true, aside: true });
  r.deleting = false;
  r.deleted = rc === 0;
  await readFresh(['status', '--json'], 'status');
  if (run === r) paintRun();
}

// Every line ayis marked as a failure, plus whatever `error` event ended the run.
// Kept out of the log on purpose: the log holds 200 lines and auto-scrolls, so by
// the time a run ends the line that said why is usually gone.
let buildFailures = [];
// The `problem` event of this failure, if ayis sent one: the words and the kind to pick
// buttons by. Without one (an older ayis, or a failure with no event yet) the panel
// falls back to reading ayis's lines, as it always did.
let buildProblem = null;
// ayis marks only the HEADLINE of a failure report as `fail`; the AWS message and
// the remedy underneath it are ordinary continuation lines. A relayed script
// exits straight after printing one, so once a failure starts, everything until
// the next step belongs to it - which is how the panel gets the whole report
// rather than just its title.
let buildFailing = false;
// What to DO about a failure, keyed by the AWS error code ayis prints. The code
// is the stable part: the prose around it is written for a terminal, where the
// answer is a command to type, and in here a command to type is a worse button.
//
// Nothing is invented: every action here is one ayis already offers somewhere
// else, reached from the moment it is relevant.
const FAIL_ACTS = {
  // Spot ran out. Full price, another location and another machine were all
  // offered here, and three ways out of one failure was more confusing than
  // helpful: the machine picker shows price and place together, so it is the
  // one choice. Try again sits beside it, for capacity that comes back.
  InsufficientInstanceCapacity: () => [['Pick another machine', () => openMachines()]],
  SpotMaxPriceTooLow: (spot) => FAIL_ACTS.InsufficientInstanceCapacity(spot),
  // Try again is already beside the step; nothing more to offer.
  MaxSpotInstanceCountExceeded: () => [],
  VcpuLimitExceeded: () => [['Ask AWS for a higher GPU limit', () => openQuota()]],
  InstanceLimitExceeded: () => [['Ask AWS for a higher GPU limit', () => openQuota()]],
  'InvalidKeyPair.NotFound': () => [
    ['Fix it', () => runAyis(['check', '--fix'])],
  ],
  // The region is not switched on for this account: another location is the
  // answer, and it is picked where the machine is.
  OptInRequired: () => [['Choose another location', () => openMachines()]],
  AuthFailure: () => [['Connect AWS again', () => openAwsKey()]],
  UnauthorizedOperation: () => [['Connect AWS again', () => openAwsKey()]],
};
// The same buttons by the problem's kind, which is what ayis promises to keep
// stable (docs/commands.md). A kind with no entry has nothing to offer beyond
// Try again, which is already beside the step.
FAIL_ACTS.no_capacity = FAIL_ACTS.InsufficientInstanceCapacity;
FAIL_ACTS.limit = FAIL_ACTS.VcpuLimitExceeded;
FAIL_ACTS.key_missing = FAIL_ACTS['InvalidKeyPair.NotFound'];
FAIL_ACTS.not_allowed = FAIL_ACTS.UnauthorizedOperation;
FAIL_ACTS.sign_in_refused = FAIL_ACTS.AuthFailure;
FAIL_ACTS.not_enabled = FAIL_ACTS.OptInRequired;

// What the panel says under the headline for a problem: whether money is still
// being spent first, then what to do.
function problemWhy(p) {
  const charge = p.charging === 'other'
    ? 'Nothing was started by this build, but a game PC from before is still charging.'
    : 'Nothing was started. No charge.';
  return [charge, p.text].filter(Boolean).join('  ');
}

// ayis's own words, read back: the marked line is the headline, and the two
// lines under it are the facts worth keeping above the fold.
function failSummary(text) {
  const lines = text.split('\n');
  const head = (lines.find(l => l.trim() && !l.startsWith(' ')) || '').trim();
  const code = (/error code:\s*([A-Za-z0-9.]+)/.exec(text) || [])[1] || '';
  const said = (/AWS said:\s*(.+)/.exec(text) || [])[1] || '';
  // ayis's two sentences, apart: a refused launch charges nothing, unless what
  // refused it is another machine, still billing.
  const safe = /nothing was launched, and nothing is billing/.test(text);
  const other = /nothing was launched by this build - but the machine above is still billing/.test(text);
  return { head, code, said, safe, other };
}

function buildFailActions(code) {
  const acts = $('b-fail-acts');
  acts.textContent = '';
  const spot = (() => {
    const r = (config || []).find(x => x.key === 'GAME_SPOT');
    const v = r && (r.value || r.default);
    return v !== '0';
  })();
  const make = FAIL_ACTS[code];
  if (!make) return;
  for (const [label, go] of make(spot)) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = label;
    b.onclick = go;
    acts.append(b);
  }
}

function buildFail(text) {
  if (!text) return;
  const line = text.replace(/\s+$/, '');
  if (!line && !buildFailures.length) return;
  if (buildFailures[buildFailures.length - 1] === line) return;
  buildFailures.push(line);
  // The title names the phase, not the failure: a fixed "launch failed" above
  // ayis's own "launch failed: InsufficientInstanceCapacity" read as the same
  // thing said twice.
  // The strip's own heading carries the state, rather than a second heading
  // under it: "Provisioning" above "Provisioning stopped" was the same words
  // twice, and ayis's first line says what failed anyway.
  // Noted, not believed: a step is failed only when the run ends in failure.
  // ayis reads "cannot" in a line as a failure, and the box's own healthy
  // progress said "NvFBC cannot capture" - the driver step went red while the
  // build carried on installing Steam.
  paintFail();
}

// The panel from what has been collected so far. Its own function because the
// problem event can arrive AFTER the lines it explains: a note printed before the
// refusal (the archive being in another region) was the first line, so it became
// the headline, and AWS's real answer sat underneath it. Painted again when the
// problem arrives, the title is the problem's.
function paintFail() {
  const whole = buildFailures.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  $('b-error').textContent = whole;
  // The headline above the fold, the detail behind a disclosure, and the two or
  // three things worth doing as buttons - because "ayis config set GAME_SPOT 0"
  // is a command to type at someone who is looking at a window.
  const { head, code, said, safe, other } = failSummary(whole);
  if (buildProblem) {
    $('b-fail-head').textContent = buildProblem.title;
    $('b-fail-why').textContent = problemWhy(buildProblem);
    buildFailActions(buildProblem.kind);
    $('b-fail').classList.remove('hidden');
    $('b-bar-track').hidden = true;
    paintRun();
    return;
  }
  $('b-fail-head').textContent = head || 'the build stopped';
  $('b-fail-why').textContent = [safe ? 'Nothing was launched. No charges.' : '',
                                 other ? 'Nothing was launched by this build, but that machine is still billing.' : '',
                                 said ? `AWS said: ${said}` : '',
                                 code ? `(${code})` : ''].filter(Boolean).join('  ');
  buildFailActions(code);
  $('b-fail').classList.remove('hidden');
  // The failure takes the bar's place. A bar frozen at 35% beside the reason it
  // froze is two things saying the same moment, and the useful one is smaller.
  $('b-bar-track').hidden = true;
  paintRun();
}

function buildFailClear() {
  buildFailures = [];
  buildProblem = null;
  buildFailing = false;
  $('b-fail').classList.add('hidden');
  $('b-fail-head').textContent = '';
  $('b-fail-why').textContent = '';
  $('b-fail-acts').textContent = '';
  $('b-error').textContent = '';
  $('b-error').classList.add('hidden');
  $('b-bar-track').hidden = false;
}

function buildLine(event) {
  const log = $('b-log');
  if (!buildLogged()) {
    if (event.text && event.kind !== 'fail') $('b-prog-step').textContent = event.text;
    runLine(event.text);
    paintRun();
    return;
  }
  const row = document.createElement('div');
  row.className = event.kind === 'fail' ? 'text-error'
                : event.kind === 'ok' ? 'text-primary' : 'text-on-surface-variant';
  row.textContent = event.text || '';
  log.append(row);
  // The strip carries the live line, so the one place to look while a step runs
  // is the same place that says which step it is.
  if (event.text && event.kind !== 'fail') $('b-prog-step').textContent = event.text;
  while (log.children.length > 200) log.firstChild.remove();
  if ($('b-follow').checked) log.scrollTop = log.scrollHeight;
  runLine(event.text);
  paintRun();
}

window.ayis.onEvent(({ id, event }) => {
  const job = jobs.get(id);
  if (!job) return;
  // An error comes with what to do about it (internal/fault): said after its
  // words, as the CLI says it on the next line.
  if (event.t === 'error' && event.text && event.hint) event = { ...event, text: event.text + ' ' + event.hint };
  logLine(event);
  if (job.cmd[0] === 'open') restoreOnEvent(event);
  if (event.t === 'save') saveOnEvent(event);
  if ((event.t === 'wait' || event.t === 'line') && keepUi.mode === 'run' && $('keepdlg').open) keepLive(event);
  // The Build card's run: a build, a delete, a session. A change to the saved
  // games is reported by its own popup, on its own page.
  // A session on a machine of yours is not a write - it runs beside reads -
  // but it is a session, and reads as one.
  const ownSession = job.cmd[0] === 'host' && job.cmd[1] === 'open';
  if ((job.write && job.cmd[0] !== 'library' && !job.aside) || ownSession) {
    if (event.t === 'step') buildStep(event.text, event.id);
    if (event.t === 'part') { event.state === 'done' ? runPartDone(event.id) : runPart(event.id); paintRun(); }
    if (event.t === 'wait') { runWait(event); paintRun(); }
    if (event.t === 'step_end') buildStepEnd(event);
    if (event.t === 'line' || (event.t === 'raw' && event.stream === 'stdout')) buildLine(event);
    if (event.kind === 'fail') { buildFailing = true; buildFail(event.text); }
    else if (buildFailing && event.t === 'line') buildFail(event.text);
    if (event.t === 'step') buildFailing = false;
    if (event.t === 'problem') { buildProblem = event; if (buildFailures.length) paintFail(); }
    if (event.t === 'error') buildFail(event.text);
    if (event.t === 'exit') {
      buildProgressDone(event.rc);
      // A nonzero exit with nothing marked is still a failure, and saying so
      // beats a bare status label the eye slides over.
      if (event.rc !== 0 && !buildFailures.length && !(run && run.cancelling)
          && !((job.cmd[0] === 'open' || ownSession) && event.rc === 130))
        buildFail(`${AyisName(job.cmd)} exited without an error message. See the log above.`);
    }
  }
  if (event.t === 'step' && job.onStep) job.onStep(event.text);
  if (event.t === 'ask') {
    // The key dialog asked already: ayis's two questions are answered from what
    // is in it, rather than putting two more modals on top of the one the
    // person is looking at.
    const pre = awsKeyAnswer(event.id) ?? oneFieldAnswer(event.id) ?? typedAnswer(event.id);
    if (pre !== null) window.ayis.answer(id, pre);
    else if (!serverPwAnswer(id, event.id) && !sudoAnswer(id, event.id)) ask(id, event);
  }
  // JSON comes back on stdout as the command's own data; reports arrive as events.
  if (event.t === 'raw' && event.stream === 'stdout' && (job.json || job.capture)) job.out.push(event.text);
  if (event.t === 'report' && job.panel) $(job.panel).textContent = event.text;
  if (event.t === 'error' && event.text) job.err = event.text;
  if (job.wantRc && (event.t === 'line' || event.t === 'error') && event.text)
    job.collected += event.text + '\n';
  if (job.collect === runSurface.log && event.text) watchForSignInLink(event.text);
  if (job.collect && (event.t === 'line' || event.t === 'step' || event.t === 'error'
                      || event.t === 'raw')) {
    const box = $(job.collect);
    if (box.textContent === 'running…' || box.dataset.fresh === 'yes') {
      box.textContent = '';
      delete box.dataset.fresh;
    }
    // Measured BEFORE the line is added, because appending to a box that is
    // already scrolled to the bottom moves the bottom away from you.
    //
    // Only if that is where you already were: an install prints for minutes,
    // and yanking the view back down while someone is reading up the log is
    // worse than not following at all. The build's transcript has a checkbox
    // for the same decision - this is the small version of it.
    const following = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    box.textContent += (event.t === 'step' ? '\n' + event.text : '  ' + (event.text || '')) + '\n';
    if (following) box.scrollTop = box.scrollHeight;
    if (box.id.startsWith('onb-log-')) onbLogGrew(box, event.text);
  }
  if (event.t === 'exit') {
    // Why the reason is KEPT rather than printed somewhere here: it used to be
    // written to a line in the header that updateHeader() rewrites a few lines
    // below, in the same tick - so a failing painter was completely silent, the
    // screen stayed empty, and the only clue was that nothing ever appeared.
    // Now it is held in readFailures and the screens read it from there.
    let failure = null, painted = null;
    if (job.json && job.out.length) {
      try {
        const data = JSON.parse(job.out.join('\n'));
        painted = data;
        const paint = { cost: paintCost, library: paintLibrary, guards: paintGuards,
                        config: paintConfig, status: paintStatus, machines: paintMachines,
                        sweep: paintSweep, creds: paintCreds, deps: paintDeps,
                        tskey: paintTskey, ping: paintPing, elsewhere: paintElsewhere,
                        hosts: paintHosts, limits: paintLimits }[job.json]
          || (job.json.startsWith('host:') && (d => paintHostStatus(job.json.slice(5), d)));
        if (!paint) throw new Error(`no painter for ${job.json}`);
        paint(data);
      } catch (err) {
        failure = `Could not show ${ayisName(job.cmd)}: ${err && err.message ? err.message : err}`;
      }
    }
    if (job.age) $(job.age).textContent = new Date().toLocaleTimeString();
    jobs.delete(id);
    for (const wake of jobEnded.splice(0)) wake();
    updateHeader();
    // A FAILED read used to be silent: note() and the follow-up refresh are
    // behind job.write, so a read that could not run at all left the screen empty
    // and the header busy with nothing anywhere saying why - which is exactly
    // what a packaged app pointed at the wrong directory looked like. This runs
    // AFTER updateHeader because updateHeader rewrites the same line.
    if (job.json) {
      if (event.rc !== 0 || failure) {
        readFailures.set(job.json, failure ? failure
          : job.err ? `${AyisName(job.cmd)} could not run: ${job.err}`
          // A read that answered WITH its reason has already said it on the
          // screen it belongs to; repeating "exit 1" in the header adds a
          // number and takes away the reason.
          : painted && painted.error ? painted.error
          : `${AyisName(job.cmd)} did not finish.`);
      } else {
        readFailures.delete(job.json);       // it worked this time
      }
      updateHeader();
    }
    // Not every painter repaints the pipeline, and the opening list is a line
    // per read: it ticks as each one lands, not all at once at the end.
    if (job.json && readingBehindGate) paintOnboardSoon();
    // A machine's check that failed: its card leaves the loading state to say so.
    if (job.json && job.json.startsWith('host:') && readFailures.has(job.json)) paintHostCards();
    // The AWS card on Home and Machine says why it has no answer, instead of staying a skeleton.
    if (job.json === 'status' && readFailures.has('status')) paintMachineCards();
    // The Hard limits card too: it stayed on "Checking..." when its read failed.
    if (job.json === 'limits' && readFailures.has('limits') && $('g-limit-rows'))
      $('g-limit-rows').replaceChildren(limitRow('Hard limits: could not be read', readFailures.get('limits'), 'bad', []));
    // The read that judges a step that has just been done: it has answered, so
    // the step shows what it says - ticked, or back to what is still missing.
    if (onbVerifying && job.json && onbPending.has(job.json)) {
      onbPending.delete(job.json);
      if (!onbPending.size) onbVerified();
    }
    // A gate read that has just cleared the last blocking stage - see gateShut.
    if (gateShut && GATE_READS.some(([, j]) => j === job.json)) gateMayOpen();
    // A build, a destroy or a session changes what every free screen shows -
    // the box, the archive, the guards - so read them again once it is over.
    if (job.write) {
      note(`${AyisName(job.cmd)} ${event.rc === 0 ? 'finished' : 'stopped'}`,
           event.rc === 0 ? 'text-primary' : 'text-error');
      // Even one that stopped part-way may have rented or deleted something.
      const change = byCommand(BILL_CHANGE, job.cmd);
      if (change && !(job.cmd[0] === 'library' && event.rc !== 0)) noteBillChange(change);
      afterWrite(job, event.rc);
    }
    if (job.resolve) job.resolve(job.wantRc ? { rc: event.rc, err: job.collected || '' }
                                 : job.capture ? job.out.join('\n') : undefined);
  }
});

// `group` names a run by what started it rather than by what it is: one click on
// Refresh is several reads, and naming them each made the Build screen offer to
// "Stop 2 runs" for a click that was one.
// `aside`: a write that is not the run on the Machine page - its events stay
// out of that card, which keeps showing the run it is about.
function runAyis(args, { panel, age, json, env, collect, capture, wantRc, onStart, onStep, group, aside } = {}) {
  return new Promise(async resolve => {
    const res = await window.ayis.run(args, env);
    if (!res.ok) {
      const why = `Waiting for ${ayisName(res.args)} to finish.`;
      if (collect) $(collect).textContent = why + '\n';
      if (panel) $(panel).textContent = why;
      // A step's read-back that never ran must not hold the step - and the
      // add dialog's Close with it - waiting for it for good.
      if (json && onbVerifying && onbPending.delete(json) && !onbPending.size) onbVerified();
      // A READ that was turned away is not an answer: nothing records it as
      // failed, so its row sat on "checking..." for ever. It is asked again the
      // moment the task in its way ends.
      if (json && !wantRc && jobs.size) {
        await new Promise(wake => jobEnded.push(wake));
        return resolve(runAyis(args, { panel, age, json, env, collect, capture, wantRc, onStart, onStep, group, aside }));
      }
      if (json && !wantRc) { readFailures.set(json, why); updateHeader(); }   // never a silent "checking"
      return resolve(wantRc ? { rc: null, err: why } : undefined);
    }
    jobs.set(res.id, { cmd: args, view, panel, age, json, collect, capture, wantRc, onStep, group, aside,
                      // ayis's verdict, not a second guess at it.
                      write: !!res.write,
                      out: [], collected: '', resolve });
    if (onStart) onStart(res.id);
    if (res.write) note(`${ayisName(args)} started`, 'text-primary');
    updateHeader();
    if (panel) $(panel).textContent = 'Running…';
  });
}
