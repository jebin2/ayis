'use strict';
// The AWS machine: its status, the machine card on Home and the Machine page, and the session countdown.
// One of the renderer's scripts, loaded in order by index.html into one shared scope
// (docs/architecture.md, "The app").

function paintStatus(s) {
  statusAt = new Date().toISOString();
  const wasUp = statusNow && statusNow.box && statusNow.box.state === 'running';
  const isUp = s.box && ['running', 'pending'].includes(s.box.state);
  if (isUp) noteMachineRan();
  // Ended outside the app - auto-stop, or the console - with no delete here.
  const justDeleted = billChanges().some(c => c.what === 'you deleted the machine'
                                         && Date.now() - Date.parse(c.at) < 15 * 60000);
  if (wasUp && !isUp && !jobsFor('destroy') && !justDeleted) noteBillChange('the machine stopped');
  paintSpec(s);
  statusNow = s;
  resumeBuild(s);
  askPing(s);
  paintOnboardSoon();
  statusBudget = s.budget || null;
  // What the app may do with the box that exists. A stream can be running that
  // this window never started - closing the app does not end it - so Play asks
  // ayis rather than remembering, and refuses to start a second Moonlight.
  sessionNow = s.session || null;
  paintSession();
  paintDash();
  readStoppedDisk(s);
}

// ── The dashboard ───────────────────────────────────────────────────────────
//
// Three questions, in order: can I play right now, what is it costing, and are
// my games and my money safe. Drawn whole from what ayis has already said -
// status, the machines, the archive, the guards - and redrawn when any of them
// lands. Money is in rupees only; every price is ayis's (status carries the
// table), and the rate for a machine is `ayis machines`'s.

// Rupees, with paise only where they matter.
const rs = n => n == null || !isFinite(n) ? '—'
  : '₹' + (n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString('en-IN'));
// An hourly figure keeps its paise when it has any: ₹20 + ₹0.44 has to read as
// ₹20.44, or the total does not add up to the lines above it.
const rsh = n => n != null && isFinite(n) && n < 100 && Math.round(n * 100) % 100 ? '₹' + n.toFixed(2) : rs(n);
// NaN, not 0, when ayis sent no price table (an older ayis): every figure then reads
// "—", which is true, instead of ₹0, which is not.
const inrRate = () => (statusNow && statusNow.rates && statusNow.rates.inr_per_usd) || NaN;

// What a machine of this type costs an hour, bought this way, in rupees: in
// the cheapest zone, or with `dearest`, the dearest - spot only.
function hourlyInr(type, spot, dearest) {
  const m = machinesNow && (machinesNow.machines || []).find(x => x.type === type);
  if (!m) return null;
  if (spot && dearest) return inrNow(m.usd_hour_spot_max, m.inr_hour_spot_max);
  return spot ? inrNow(m.usd_hour_spot, m.inr_hour_spot) : inrNow(m.usd_hour_ondemand, m.inr_hour_ondemand);
}

// The machine card, drawn the same on Home and the Machine page: what is
// running if something is, otherwise what Build would start. Each page puts its
// own buttons under it.
// A GPU as every screen says it: "NVIDIA T4, 16 GB".
const gpuName = (gpu, vram) => `NVIDIA ${gpu}${vram ? `, ${vram} GB` : ''}`;
// How far a place is, in a word, with the measurement beside it.
const distance = ms => `${ms <= 30 ? 'Close' : ms <= 60 ? 'OK' : 'Far'} (${Math.round(ms)} ms)`;

function machineFacts() {
  const s = statusNow || {};
  const box = s.box && s.box.state !== 'terminated' ? s.box : null;
  const cur = currentPick();
  const region = box ? s.region || cur.region : cur.region;
  const type = box ? box.type : cur.type || s.instance_type;
  const spot = box ? box.lifecycle === 'spot' : cur.spot;
  const rows = chooserRows().rows;
  const hit = rows.find(r => r.region === region && r.type === type);
  const spec = s.spec || {};
  const gpu = hit && hit.gpu ? hit.gpu : spec.gpu;
  const vram = hit && hit.vram;
  // Nothing pins the zone, and spot prices differ by zone. A machine that runs
  // is priced in its own zone; one not built yet is the spread across zones.
  const disk = box ? box.disk_gb : (s.config || {}).disk_gb;
  let lo = null, hi = null;
  if (box && spot && box.az && machinesNow && machinesNow.region === region) {
    const m = (machinesNow.machines || []).find(x => x.type === type);
    const usd = m && m.spot_usd_by_az && m.spot_usd_by_az[box.az];
    if (usd != null) lo = hi = inrNow(usd);
  }
  if (lo == null) {
    lo = (hit && (spot ? hit.spot : hit.od)) ?? hourlyInr(type, spot);
    hi = spot ? (hit ? hit.spotMax : hourlyInr(type, true, true)) ?? lo : lo;
  }
  const price = perHour(lo, disk), priceMax = perHour(hi, disk);
  const priceText = hourText(price, priceMax);
  // Room for games, in the same number the Build page's meter uses: ayis's
  // figure for this machine type, less the space kept free. Before that is
  // read, the type's disk as AWS sizes it.
  const lib = libNow || {};
  const store = hit ? hit.store
    : ((machinesNow && (machinesNow.machines || []).find(m => m.type === type)) || {}).store_gb;
  const room = lib.disk_type === type && lib.selectable_gb != null ? `${lib.selectable_gb} GB for games`
    : store != null ? `${store} GB disk` : null;
  return { s, box, cur, rows, hit, region, type, spot, price, priceMax, priceText, room,
           what: [type, gpu ? gpuName(gpu, vram) : null, room].filter(Boolean).join(' · ') || '—',
           where: [region ? placeName(region) : null,
                   box || cfgVal('GAME_SPOT') === '1' ? (spot ? 'Spot' : 'On-demand')
                     : cfgVal('GAME_SPOT') === '0' ? 'On-demand' : 'Spot, else on-demand',
                   // A stopped machine is not charged by the hour; only its disk is.
                   priceText ? `${priceText}/hour${box && box.state === 'stopped' ? ' when running' : ''}` : null].filter(Boolean).join(' · ') };
}

function renderMachineCard(card) {
  if (!card || !statusNow) return;
  const f = machineFacts();
  const { s, box, cur, hit, rows, price } = f;
  const credErr = s.error && s.error.credentials;
  const building = jobsFor('init') || unfinished(box);
  const running = !!(box && box.state === 'running');
  const upHours = box && box.launched ? (Date.now() - new Date(box.launched)) / 3600000 : 0;
  const idleGuard = ((watcher && watcher.guards) || []).find(g => g.layer === 2);
  const idleAfter = idleGuard && idleGuard.idle_min != null ? `${idleGuard.idle_min} min` : null;
  let title, sub = '', note = '';
  if (credErr) {
    title = 'Status unknown';
    sub = 'AWS is unreachable.';
  } else if (building) {
    title = 'Building';
    // How long the last build took, as ayis measured it; no number until one has.
    const took = (s.build || {}).last_min;
    const last = took != null ? `last build took ${took} min` : '';
    sub = box && box.launched ? [`Started ${uptime(box.launched)} ago`, last].filter(Boolean).join(' · ')
                              : (last ? last[0].toUpperCase() + last.slice(1) : 'Starting');
  } else if (running) {
    title = sessionNow ? 'Playing' : 'Ready to play';
    sub = `Up ${uptime(box.launched)} · ${rs(price != null ? price * upHours : null)} so far`;
    note = sessionNow ? 'Closing Moonlight ends the session. The machine keeps running until auto-stop or Delete.'
                      : idleAfter ? `Auto-stops after ${idleAfter} idle.`
                                  : 'Auto-stops when idle.';
  } else if (box) {
    title = box.state === 'stopped' ? 'Machine stopped' : `Machine ${box.state}`;
    sub = box.state === 'pending' ? 'Starting.' : box.state === 'stopping'
      ? 'Saving and shutting down. Billing by the hour ends once it has stopped; Refresh to see it.'
      : box.state === 'shutting-down' ? 'Being deleted.'
      : box.state === 'stopped' ? (keepDone && keepDone.id === box.id && keepDone.kind === 'stop' && keepDone.text
          ? `Stopped: ${keepDone.text}. ` : '') + 'Your setup is kept; games come back from Saved games on start. Only the disk is billed.' : 'Not running.';
  } else {
    title = 'No machine running';
  }
  // What stands in the way of the choice, said where the choice is shown.
  const warn = [];
  if (box && (cur.type !== f.type || cur.region !== f.region))
    warn.push('Changes apply to the next build.');
  else if (!box && hit && cur.spot && hit.score != null && hit.score <= 2)
    warn.push(`Low spot capacity for ${cur.type} here (${hit.score}/10). A spot launch will likely fail.`);
  else if (!box && hit && cur.spot && hit.fitsSpot === false)
    warn.push('Spot quota here is 0.');
  else if (!box && !hit && rows.length)
    warn.push('This machine type is not offered in this region.');
  if (sessionNow && !running)
    warn.push('A session is already open in Moonlight. Only one can run at a time.');

  card.textContent = '';
  // The Machine page's panel, as a machine of yours's: the state in a word
  // above a large title. Home's tile keeps its pill.
  const page = card.id === 'b-machine-card';
  const top = el('div', 'flex items-start justify-between gap-space-md');
  const head = el('div', 'min-w-0');
  if (page) {
    const [tone, word] = credErr ? ['text-error', 'Needs you'] : building ? ['text-primary', 'Building']
      : running ? ['text-primary', sessionNow ? 'Streaming' : 'Online'] : box ? ['text-tertiary', box.state === 'stopped' ? 'Stopped' : 'Not running']
      : ['text-outline', 'Not built'];
    const w = el('span', `font-label-caps text-label-caps uppercase ${tone}`, word); w.dataset.f = 'word';
    head.append(w);
  } else {
    // Named above its state, as a machine of yours's tile is.
    head.append(el('p', 'font-body-sm text-body-sm font-medium text-on-surface-variant', 'AWS'));
  }
  const t = el('p', page ? 'font-headline-xl text-headline-xl mt-space-sm' : 'font-headline-lg text-headline-lg mt-space-xs', title); t.dataset.f = 'title';
  head.append(t);
  if (sub) { const p = el('p', 'font-body-md text-body-md text-on-surface-variant mt-space-xs', sub); p.dataset.f = 'sub'; head.append(p); }
  top.append(head);
  if (!page && (running || building)) {
    // The words a machine of yours's tile uses.
    const tag = el('span', 'pill shrink-0 pill-ok', building ? 'building' : sessionNow ? 'streaming' : 'ready');
    tag.dataset.f = 'tag';
    top.append(tag);
  }
  const mid = el('div', 'flex flex-wrap items-end justify-between gap-space-md mt-space-lg');
  const lines = el('div', 'min-w-0');
  const what = el('p', 'font-code-md text-code-md', f.what); what.dataset.f = 'what';
  const where = el('p', 'font-code-sm text-code-sm text-outline mt-0.5', f.where); where.dataset.f = 'where';
  lines.append(what, where);
  mid.append(lines);
  card.append(top, mid);
  if (warn.length) { const w = el('p', 'font-code-sm text-code-sm text-tertiary mt-space-sm', warn.join(' · ')); w.dataset.f = 'warn'; card.append(w); }
  // A stopped machine: what it still costs, and when it goes if left alone.
  if (box && box.state === 'stopped' && stoppedDisk) {
    const lines = [];
    if (stoppedDisk.extra_gb > 0) {
      const inr = diskMonthInr(stoppedDisk.extra_gb);
      lines.push(`Games disk ${stoppedDisk.extra_gb} GB${inr != null ? `, about ${rs(inr)} a month` : ''}.`);
    }
    if (stoppedDisk.stopped_at && stoppedDisk.expiry_days > 0) {
      const gone = new Date(Date.parse(stoppedDisk.stopped_at) + stoppedDisk.expiry_days * 86400000);
      lines.push(`Deleted automatically on ${gone.toLocaleDateString([], { day: 'numeric', month: 'short' })} unless you start it.`);
    }
    if (lines.length) { const n = el('p', 'font-code-sm text-code-sm text-on-surface-variant mt-space-sm', lines.join(' ')); n.dataset.f = 'stopnote'; card.append(n); }
  }
  if (note) { const n = el('p', 'font-code-sm text-code-sm text-outline mt-space-sm', note); n.dataset.f = 'note'; card.append(n); }
  // The session limit, counting down: the cloud watchdog switches the machine
  // off at this time even mid-game, so it is shown where you play from.
  if (running && box.session_ends) {
    const row = el('div', 'flex flex-wrap items-center justify-between gap-space-sm mt-space-sm');
    const left = el('p', 'font-code-sm text-code-sm'); left.dataset.f = 'session';
    left.dataset.ends = box.session_ends;
    left.dataset.launched = box.launched || '';
    left.dataset.rate = price != null ? String(price) : '';
    const more = el('button', 'btn', '+1 hour'); more.dataset.f = 'session-more';
    more.onclick = async () => {
      more.disabled = true;
      await limitRun(['extend-session', '1'], 'Session extended by 1 hour');
      more.disabled = false;
      refresh();
    };
    row.append(left, more);
    card.append(row);
    tickSessions();
  }
  return f;
}

// The watchdog warns this long before (limits.WarnMinutes).
const SESSION_WARN_MIN = 30;
// What a session and the month have cost, in the words a notification uses:
// the session from its hours and the hourly price, the month from the budget
// AWS keeps (updated a few times a day, so "about").
function sessionCost(n) {
  const out = [];
  const rate = parseFloat(n.dataset.rate), from = Date.parse(n.dataset.launched);
  if (isFinite(rate) && isFinite(from)) {
    const h = Math.max(0, (Date.now() - from) / 3600000);
    out.push(`This session: about ${rs(rate * h)} so far (${h.toFixed(1)} h at ${rs(rate)} an hour).`);
  }
  const b = statusNow && statusNow.budget, inr = inrRate();
  if (b && b.spent != null && isFinite(inr))
    out.push(`This month: about ${rs(b.spent * inr)}${b.limit ? ` of your ${rs(b.limit * inr)} budget` : ''}.`);
  return out.join(' ');
}
// Each warning once per deadline: an extension moves the deadline, and so warns again.
const sessionTold = new Set();
function tellSession(key, title, body) {
  if (sessionTold.has(key)) return;
  sessionTold.add(key);
  note(`${title}. ${body}`, 'text-error');
  try { new Notification(title, { body }); } catch { /* the note above still says it */ }
}

// Every countdown to a session's end, redrawn each 15 s between reads: the time
// it ends comes from `ayis status`, the minutes left from the clock here.
function tickSessions() {
  for (const n of document.querySelectorAll('[data-ends]')) {
    const ends = Date.parse(n.dataset.ends);
    if (!isFinite(ends)) continue;
    const left = Math.max(0, Math.floor((ends - Date.now()) / 60000));
    if (left === 0 && Date.now() - ends < 15 * 60000)
      tellSession(`${n.dataset.ends}:off`, 'Session time limit reached',
        `Your game PC is switching off and your games are being saved. ${sessionCost(n)}`.trim());
    else if (left > 0 && left <= SESSION_WARN_MIN)
      tellSession(`${n.dataset.ends}:warn`, `Game PC switches off in ${left} minutes`,
        `To keep playing, press +1 hour. ${sessionCost(n)}`.trim());
    const at = new Date(ends).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const span = left >= 60 ? `${Math.floor(left / 60)} h ${left % 60} min` : `${left} min`;
    n.textContent = left > 0 ? `Session limit: switches off at ${at} · ${span} left`
                             : `Session limit reached: switching off now`;
    n.className = 'font-code-sm text-code-sm ' + (left <= SESSION_WARN_MIN ? 'text-error' : 'text-on-surface-variant');
  }
  tickSessionsSoon();
}
// Not an interval: it re-arms only while a countdown is on screen, and asks
// nothing of AWS - the minutes come from the clock here.
let sessionTimer = null;
function tickSessionsSoon() {
  if (sessionTimer || !document.querySelector('[data-ends]')) return;
  sessionTimer = setTimeout(() => { sessionTimer = null; tickSessions(); }, 15000);
}

// The whole card, buttons too, built once per page from one recipe, so the
// two cannot be laid out differently. Ids keep the page's prefix: d- on Home,
// b- on the Machine page. What Build does differs (Home sends you to pick
// games), what the card looks like does not.
function mountMachineCard(box, p) {
  const body = el('div'); body.id = `${p}-machine-card`;
  const busy = el('div', 'onb-progress mt-space-md'); busy.id = `${p}-busy`; busy.hidden = true;
  busy.append(el('i'));
  // Laid out as a machine of yours is, on both pages. Home's tile: the main
  // button and Details, at the bottom. The Machine page's panel: the main
  // button across it, everything else in a grid beneath - deleting the machine
  // and disconnecting AWS among them, as removing a machine of yours is there.
  const home = p === 'd';
  const row = el('div', home ? 'flex flex-wrap items-center gap-space-sm mt-auto pt-space-lg'
                             : 'flex flex-col gap-space-sm mt-auto pt-space-md');
  const more = el('div', 'grid grid-cols-2 xl:grid-cols-3 gap-space-sm');
  const btn = (id, cls, icon, glyph, label) => {
    const main = cls.includes('btn-primary');
    const b = el('button', cls + (main ? ' btn-lg' + (home ? '' : ' w-full') : '')); b.id = `${p}-${id}`;
    if (icon) {
      const i = el('span', 'material-symbols-outlined text-[16px]', glyph);
      i.dataset.icon = icon;
      b.append(i);
    }
    b.append(document.createTextNode(label));
    (main || home ? row : more).append(b);
    return b;
  };
  btn('fix', 'btn btn-primary', null, null, 'Finish setting up').hidden = true;
  btn('build', 'btn btn-primary', 'rocket_launch', '\ueb9b', 'Build machine');
  btn('open', 'btn btn-primary', 'stadia_controller', '\uf135', 'Play').hidden = true;
  // While a session runs these stand where Play was: ending it, or stopping the machine.
  btn('stopsession', 'btn btn-primary', null, null, 'Stop session').hidden = true;
  btn('stopmachine', 'btn', null, null, 'Stop machine').hidden = true;
  btn('watch', 'btn', null, null, 'Watch the build').hidden = true;
  if (!home) {
    btn('change', 'btn', null, null, 'Change machine').onclick = () => openMachines();
    const q = btn('quality', 'btn', null, null, 'Stream quality');
    q.onclick = () => goSetting(settingEl('GAME_RES'));
    btn('adddisk', 'btn', null, null, 'Add disk').onclick = () => openAddDisk();
    const rm = btn('removedisk', 'btn', null, null, 'Remove games disk');
    rm.hidden = true;
    rm.onclick = () => removeGameDisk();
  }
  // Home never shows it - Details does, as a machine of yours's tile does - but
  // its handler is the one every delete button calls.
  btn('destroy', 'btn btn-danger', null, null, 'Delete machine').hidden = true;
  if (home) {
    const g = btn('details', 'btn ml-auto', null, null, '');
    g.title = 'Details';
    g.onclick = goAws;
    g.append(Object.assign(el('span', 'material-symbols-outlined text-[16px]', ICON.settings), { ariaHidden: 'true' }),
             document.createTextNode('Details'));
  } else {
    more.append($('b-aws-remove'));
    row.append(more);
  }
  // A Stop machine or Delete machine that never finished - the app was closed,
  // the laptop slept - left the machine running. Said here, with the way to finish.
  const unf = el('div', 'mt-space-md p-space-md rounded bg-error-container text-on-error-container flex flex-col gap-space-sm');
  unf.id = `${p}-unfinished`; unf.hidden = true;
  const unfText = el('p', 'font-body-md text-body-md'); unfText.dataset.f = 'unfinished';
  const unfGo = el('button', 'btn btn-danger self-start'); unfGo.id = `${p}-unfinished-go`;
  unfGo.onclick = () => { const f = flowPending.get(); if (f) finishFlow(f); };
  unf.append(unfText, unfGo);
  box.append(body, unf, busy, row);
}

// A stop or delete begun on this laptop and not seen through: kept in this
// window's storage from the click until the run ends (well or not), so only one
// that was cut off - the app closed, the laptop slept - is still there next time.
const FLOW_KEY = 'ayis-flow-pending';
const flowPending = {
  get() { try { return JSON.parse(localStorage.getItem(FLOW_KEY) || 'null'); } catch { return null; } },
  set(v) { try { localStorage.setItem(FLOW_KEY, JSON.stringify(v)); } catch { /* a convenience */ } },
  clear() { try { localStorage.removeItem(FLOW_KEY); } catch { /* nothing to clear */ } },
};
function paintUnfinished(p, box) {
  const card = $(`${p}-unfinished`);
  if (!card) return;
  const f = flowPending.get();
  // Gone, or already stopped or going: whatever it was, it is not billing by the
  // hour any more, and there is nothing left to finish.
  if (f && (!box || box.id !== f.id || box.state !== 'running')) {
    if (!box || box.id !== f.id || ['stopped', 'stopping', 'shutting-down', 'terminated'].includes(box.state)) flowPending.clear();
    card.hidden = true;
    return;
  }
  const show = !!f && !flowBusy && !jobsFor('stop') && !jobsFor('destroy');
  card.hidden = !show;
  if (!show) return;
  const rate = statusNow ? machineFacts().priceText : null;
  const what = f.kind === 'delete' ? 'Delete machine' : 'Stop machine';
  card.querySelector('[data-f=unfinished]').textContent =
    `Your last ${what} did not finish, so the machine is still running and billing${rate ? ` ${rate}/hour` : ''}.`;
  $(`${p}-unfinished-go`).textContent = f.kind === 'delete' ? 'Delete machine now' : 'Stop machine now';
}
// Finishing it: the same list, with what was unticked last time unticked again.
function finishFlow(f) {
  return f.kind === 'delete' ? deleteMachine(f.skip || []) : stopMachine(f.skip || []);
}

function paintMachineCards() {
  // AWS added but something it needs is missing - a key AWS rejects, a tool
  // gone: the card says what, with the button that reopens its steps. Never
  // over a machine that is there or being built: that one is shown as itself,
  // whatever the next build would need.
  const there = statusNow && statusNow.box && statusNow.box.state !== 'terminated';
  const stuck = awsAdded() && !there && !jobsFor('init') ? prereqs('aws').find(r => r.ok === false) : null;
  for (const p of ['d', 'b']) {
    if (!$(`${p}-build`)) continue;
    $(`${p}-fix`).hidden = !stuck;
    if (p === 'd') $('d-details').hidden = false;   // hidden below while the card is still a skeleton
    if (stuck) {
      const card = $(`${p}-machine-card`);
      card.textContent = '';
      const t = el('p', 'font-headline-lg text-headline-lg', 'AWS needs you'); t.dataset.f = 'title';
      card.append(t, el('p', 'font-body-md text-body-md text-on-surface-variant mt-space-xs', stuck.problem.title));
      for (const b of ['build', 'open', 'stopsession', 'stopmachine', 'watch', 'destroy', ...(p === 'b' ? ['change', 'adddisk', 'removedisk'] : [])]) $(`${p}-${b}`).hidden = true;
      $(`${p}-busy`).hidden = true;
      continue;
    }
    const { box, s } = renderMachineCard($(`${p}-machine-card`)) || {};
    if (!s) {
      const card = $(`${p}-machine-card`);
      // Still reading is a skeleton; a read that failed, or one that is waiting
      // for a task that runs alone, says so. A skeleton that never ends looks
      // exactly like one that is about to.
      const why = readFailures.has('status') ? `Could not check AWS: ${readFailures.get('status')} Refresh tries again.`
        : writing() ? `Waiting: ${busyWhy()}` : '';
      const state = why ? 'unread' : 'loading';
      if (card.dataset.state !== state || (why && card.dataset.why !== why)) {
        card.textContent = '';
        card.dataset.state = state;
        card.dataset.why = why;
        card.append(el('p', 'font-body-sm text-body-sm font-medium text-on-surface-variant', 'AWS'),
                    ...(why ? [el('p', 'font-body-md text-body-md text-on-surface-variant mt-space-xs', why)]
                            : [el('span', 'skel mt-space-xs h-9 w-48'), el('span', 'skel mt-space-sm h-4 w-72')]));
      }
      for (const b of ['build', 'open', 'stopsession', 'stopmachine', 'watch', 'destroy', ...(p === 'b' ? ['change', 'adddisk', 'removedisk'] : [])]) $(`${p}-${b}`).hidden = true;
      $(`${p}-busy`).hidden = !!why;
      // Nothing to look into yet: a Details button over a skeleton opens a page
      // that has nothing to say either. Once there is a reason, it is the way in.
      if (p === 'd') $('d-details').hidden = !why;
      continue;
    }
    const card = $(`${p}-machine-card`);
    if (card.dataset.state === 'loading' || card.dataset.state === 'unread') { delete card.dataset.state; delete card.dataset.why; card.classList.add('card-in'); }
    const building = jobsFor('init') || unfinished(box);
    const running = !!(box && box.state === 'running');
    $(`${p}-busy`).hidden = !building;
    $(`${p}-build`).hidden = !!box || building || !!(s.error && s.error.credentials);
    // A stopped machine is started by Play too: ayis open starts it first.
    const stopped = !!(box && box.state === 'stopped');
    // Playing, or starting to: Play gives way to Stop session and Stop machine.
    const sessionJob = openJobs().length > 0;
    $(`${p}-open`).hidden = !(running || stopped) || building || !!sessionNow || sessionJob;
    $(`${p}-stopsession`).hidden = !sessionJob;
    const ss = $(`${p}-stopsession`).lastChild;
    if (ss && ss.nodeType === 3) ss.textContent = sessionNow ? 'Stop session' : 'Cancel';
    // A spot machine cannot be stopped, only deleted; nothing else may be mid-run.
    $(`${p}-stopmachine`).hidden = !running || building || box.lifecycle === 'spot'
      || [...jobs.values()].some(j => j.cmd[0] !== 'open' && j.write);
    $(`${p}-open`).dataset.stopped = stopped ? 'yes' : '';
    const ob = $(`${p}-open`).lastChild;
    if (ob && ob.nodeType === 3) ob.textContent = sessionNow ? 'Streaming' : stopped ? 'Start and play' : 'Play';
    $(`${p}-watch`).hidden = !building || p === 'b';
    paintUnfinished(p, box);
    // Nothing to delete once AWS is already removing it.
    // Not while AWS is removing it, and not while it is stopping: the machine is
    // saving the games on its way down, and a delete then would cut that short.
    $(`${p}-destroy`).hidden = !box || building || p === 'd' || ['shutting-down', 'terminated', 'stopping'].includes(box.state);
    if (p === 'b') {
      $('b-change').hidden = !!box || building;
      // Always there while the machine is up: more room is wanted mid-game as
      // often as before the build.
      $('b-adddisk').hidden = !running || building;
      // Only a stopped machine has a disk that can go on its own; it waits for
      // the archive to say every game is saved, and says what it is waiting for.
      const rd = $('b-removedisk');
      rd.hidden = !(box && box.state === 'stopped' && stoppedDisk && stoppedDisk.extra_gb > 0) || building;
      rd.disabled = !(stoppedDisk && stoppedDisk.removable);
      rd.title = stoppedDisk && !stoppedDisk.removable ? stoppedDisk.why || '' : 'Delete the games disk; the games stay in Saved games';
      $('b-quality').disabled = !settingEl('GAME_RES');
      // Disconnecting deletes the machine too, but not from under a build.
      $('b-aws-remove').disabled = building;
    }
  }
  paintAwsChecks();
  // The Machine page's pills carry AWS's state as a dot.
  if (view === 'build') paintMachineTab();
}
