'use strict';
// Machines of yours: their cards, checks and actions.
// One of the renderer's scripts, loaded in order by index.html into one shared scope
// (docs/architecture.md, "The app").

// --- Machines ------------------------------------------------------------------
// Home is the machines: the AWS one when this laptop plays on AWS, and each of
// yours (`ayis host`). Every fact on a card is ayis's - `ayis host list` for what is
// saved, `ayis host status <name>` for what each is ready for, over ssh and
// Tailscale - and every button is an ayis command. Setting a machine up is adding
// it: the add dialog walks the steps it needs (prereqs), and a machine that
// needs something afterwards says so on its own card.
// What Home showed last time, kept in this window's storage: which machines
// there are, what each is, and whether AWS is one - so Home opens in its final
// layout while the reads that confirm it are on their way. Never a status: a
// machine's state and its buttons appear only once a live check has answered.
const HOME_KEY = 'ayis.home';
const homeBoot = (() => {
  try { const v = JSON.parse(localStorage.getItem(HOME_KEY) || 'null'); return v && Array.isArray(v.hosts) ? v : null; }
  catch { return null; }
})();
const hostIdentity = (homeBoot && homeBoot.identity) || {};   // name -> { os_name, gpu }
function homeRemember() {
  try {
    localStorage.setItem(HOME_KEY, JSON.stringify({
      hosts: hostsNow || [], identity: hostIdentity,
      aws: config.length ? awsAdded() : !!(homeBoot && homeBoot.aws) }));
  } catch { /* this window only */ }
}
// Machines whose card has shown its loading state, so the answer fades in.
const hostWasLoading = new Set();
let hostsNow = homeBoot ? homeBoot.hosts : null;   // `ayis host list --json`, as last read
const hostStatus = new Map();     // name -> `ayis host status <name> --json`
const hostLogs = new Map();       // name -> its setup log <pre>, kept across paints
let machineTab = 'aws';           // what the Machine page shows: 'aws', or one of yours by name

// "An AWS machine" is a laptop set up to play on AWS: a region chosen, which is
// the last step of adding it. ayis aws forget takes it away again.
const awsAdded = () => regionChosen();
// AWS is asked something only when there is an AWS machine, or one is being added.
const awsInPlay = () => awsAdded() || adding === 'aws';
// What the steps are judged for: the machine being added, else the AWS one.
const kindNow = () => adding || (awsAdded() ? 'aws' : 'host');
// The reads that ask AWS. A laptop with no AWS machine never asks them: each
// would come back "no key", and the pages would fill with it.
const AWS_JSON = new Set(['status', 'guards', 'library', 'elsewhere', 'machines', 'sweep', 'cost', 'limits']);
const forMode = reads => (reads && !awsInPlay() ? reads.filter(([, j]) => !AWS_JSON.has(j)) : reads);
// The pages about the AWS machine alone, which leave the sidebar without one.
// The Machine page is every machine's, AWS or yours.
const AWS_VIEWS = ['library', 'guards', 'cost'];
// The tools this laptop needs - the AWS CLI only for AWS.
const neededTools = (kind = kindNow()) => ((depsNow && depsNow.tools) || []).filter(t => kind === 'aws' || t.for !== 'aws');

const HOSTS_READ = [['host', 'list', '--json'], 'hosts'];
const hostRead = name => [['host', 'status', name, '--json'], `host:${name}`];
const hostReads = () => (hostsNow || []).map(h => hostRead(h.name));
const hostJob = (name, sub) => [...jobs.values()].find(j => j.cmd[0] === 'host' && j.cmd[1] === sub && j.cmd[2] === name);

function paintHosts(list) {
  hostsNow = Array.isArray(list) ? list : [];
  for (const name of [...hostStatus.keys()]) if (!hostsNow.some(h => h.name === name)) hostStatus.delete(name);
  // Each one's status, once: ssh, a tailnet ping and a look at Sunshine -
  // seconds each - so it is asked for machines not already known or being
  // read, never again on every list.
  for (const h of hostsNow)
    if (!hostStatus.has(h.name) && !readOut(`host:${h.name}`)) {
      const [args, json] = hostRead(h.name);
      runAyis(args, { json, group: 'refresh' });
    }
  for (const name of Object.keys(hostIdentity)) if (!hostsNow.some(h => h.name === name)) delete hostIdentity[name];
  homeRemember();
  paintOnboardSoon();
  paintHostCards();
}
function paintHostStatus(name, d) {
  hostStatus.set(name, d);
  if (d && (d.os_name || d.gpu)) { hostIdentity[name] = { os_name: d.os_name || '', gpu: d.gpu || '' }; homeRemember(); }
  paintHostCards();
  // The add dialog's server step names what was found.
  if (name === addedHost) paintOnboardSoon();
}

// What a machine is ready for, in one line and a tone, from what ayis said.
function hostState(h) {
  const s = hostStatus.get(h.name);
  if (hostJob(h.name, 'setup')) return { title: 'Setting up', tone: 'run', sub: 'Installing missing components.' };
  if (hostJob(h.name, 'open')) return { title: 'Playing', tone: 'ok', sub: 'Close Moonlight to end the session.' };
  if (h.os === 'Windows') return { title: 'Windows not supported', tone: 'off', sub: 'Only Linux machines can be set up.' };
  if (!s) return { title: readFailures.has(`host:${h.name}`) ? 'Check failed' : 'Checking…', tone: 'off',
                   sub: (readFailures.get(`host:${h.name}`) || '').replace(/^.*? could not run: /, '') };
  if (!s.set_up) return { title: 'Not set up', tone: 'warn',
                          sub: s.reachable ? 'Run setup to enable streaming.' : 'No SSH response.' };
  if (!s.reachable && !s.online) return { title: 'Offline', tone: 'bad', sub: 'Powered off, asleep or disconnected.' };
  if (!s.sunshine) return { title: 'Not streaming', tone: 'bad', sub: 'Sunshine is not responding. Re-run setup to restart it.' };
  if (s.reachable && !s.desktop) return { title: 'No user session', tone: 'warn', sub: 'Sign in on the machine to start a desktop session.' };
  // Streaming needs only the tailnet and Sunshine, so it is ready - but what
  // the page says about it was read without SSH, and setup needs it back.
  if (!s.reachable) return { title: 'Ready to play', tone: 'ok',
    sub: 'The app cannot reach it over SSH, so these checks may be out of date. Re-run setup to let it back in.' };
  return { title: 'Ready to play', tone: 'ok', sub: '' };
}

// One machine's card. Home shows what it is ready for and its one next
// action; the Machine page adds the checks, the log, and removing it.
// A card before its first live answer: what the machine is, as remembered,
// and a loading line - no status, no buttons, nothing to press yet.
function hostCardLoading(h, full) {
  const id = hostIdentity[h.name] || {};
  const card = el('div', full ? 'p-space-xl rounded-xl bg-surface-container-low' : 'tile');
  card.dataset.host = h.name;
  card.dataset.state = 'loading';
  card.append(el('p', 'font-body-sm text-body-sm font-medium text-on-surface-variant', h.name));
  const t = el('span', 'skel mt-space-xs h-9 w-48'); t.dataset.f = 'title';
  card.append(t, el('span', 'skel mt-space-sm h-4 w-64'));
  const what = [id.os_name || h.os, id.gpu, full ? h.ssh : null].filter(Boolean).join(' · ');
  card.append(el('p', 'font-body-sm text-body-sm text-on-surface-variant mt-space-md', what || '\u00a0'));
  const bar = el('div', 'onb-progress mt-auto'); bar.append(el('i'));
  const line = el('p', 'font-code-sm text-code-sm text-outline mt-space-xs', `Connecting to ${h.name}…`);
  line.dataset.f = 'sub';
  card.append(bar, line);
  return card;
}
function hostCard(h, full) {
  const failed = readFailures.has(`host:${h.name}`);
  if (!hostStatus.has(h.name) && !failed && !hostJob(h.name, 'setup') && !hostJob(h.name, 'open')) {
    hostWasLoading.add(h.name);
    return hostCardLoading(h, full);
  }
  if (full) return hostDetail(h, failed);
  const s = hostStatus.get(h.name) || {};
  const st = hostState(h);
  const setting = !!hostJob(h.name, 'setup');
  const playing = !!hostJob(h.name, 'open');
  // Below here, Home's tile: a big card to play from.
  const card = el('div', 'tile');
  card.dataset.host = h.name;
  card.dataset.state = st.title;
  // The first answer after loading fades in where the loading state was.
  if (hostWasLoading.delete(h.name)) card.classList.add('card-in');
  const top = el('div', 'flex items-start justify-between gap-space-md');
  const head = el('div', 'min-w-0');
  head.append(el('p', 'font-body-sm text-body-sm font-medium text-on-surface-variant', h.name));
  const t = el('p', 'font-headline-lg text-headline-lg mt-space-xs', st.title);
  t.dataset.f = 'title';
  head.append(t);
  if (st.sub) { const p = el('p', 'font-body-md text-body-md text-on-surface-variant mt-space-xs', st.sub); p.dataset.f = 'sub'; head.append(p); }
  top.append(head);
  const tag = { ok: ['pill-ok', playing ? 'streaming' : 'ready'], run: ['pill-ok', 'setting up'],
                warn: ['pill-warn', 'needs you'], bad: ['pill-bad', 'offline'] }[st.tone];
  if (tag) top.append(el('span', `pill shrink-0 ${tag[0]}`, tag[1]));
  card.append(top);
  const what = [s.os_name || s.os || h.os, s.gpu].filter(Boolean).join(' · ');
  card.append(el('p', 'font-body-sm text-body-sm text-on-surface-variant mt-space-md', what));


  const row = el('div', 'flex flex-wrap items-center gap-space-sm mt-auto pt-space-lg');
  const btn = (label, cls, go, f) => { const b = el('button', cls, label); b.dataset.f = f; b.onclick = go; row.append(b); return b; };
  const linux = h.os !== 'Windows';
  // Not known: nothing it could do is offered - only asking again.
  const unknown = failed && !hostStatus.has(h.name);
  if (unknown) {
    btn('Try again', 'btn btn-primary', () => { readFailures.delete(`host:${h.name}`); refreshHosts(h.name); }, 'retry');
  }
  if (!unknown && s.set_up && linux) {
    const p = btn(playing ? 'Streaming' : 'Play', 'btn btn-primary btn-lg', () => playOn(h.name), 'play');
    p.disabled = playing || setting || !!sessionNow || !s.sunshine;
    p.dataset.off = p.disabled ? '1' : '';
    p.title = sessionNow ? 'a session is already open' : '';
  }
  // Not set up yet: that is the one thing to do from here. Setting it up again
  // is the Machine page's.
  if (!unknown && linux && !s.set_up) {
    const b = btn(setting ? 'Setting up…' : 'Set up', 'btn btn-primary btn-lg', () => setUpHost(h.name), 'setup');
    b.disabled = setting || playing;
    b.dataset.off = b.disabled ? '1' : '';
  }
  if (setting || playing) {
    // Ends it here; a setup stopped part-way carries on from there next time.
    btn(playing ? 'Stop session' : 'Stop setup', playing ? 'btn btn-primary btn-lg' : 'btn', () => {
      const j = [...jobs].find(([, x]) => hostRun(x) && x.cmd[2] === h.name);
      if (j) window.ayis.cancel(j[0]);
    }, 'stop');
  }
  // The gear: this machine's detail - checks, log, removing it.
  const g = btn('', 'btn ml-auto', () => goHost(h.name), 'details');
  g.title = 'Details';
  g.append(Object.assign(el('span', 'material-symbols-outlined text-[16px]', ICON.settings), { ariaHidden: 'true' }), document.createTextNode('Details'));
  card.append(row);

  return card;
}

// A machine of yours on the Machine page: what it is ready for and what to do
// with it on the left, everything ayis checked on the right, a row each with what
// it found - and the setup's own words under both.
// One row of "What is working", on either kind of machine: a tick or a cross,
// what was checked, and what was found.
// `ok` null: not yet, and nothing wrong - a thing the next build sets up.
function checkRow(ok, label, value) {
  const row = el('div', 'flex items-center gap-space-md px-space-lg py-space-md rounded-lg bg-surface-container-low');
  row.dataset.check = label;
  row.dataset.ok = ok == null ? 'later' : ok ? 'yes' : 'no';
  row.append(el('span', 'w-7 h-7 shrink-0 rounded-full flex items-center justify-center font-body-sm text-body-sm '
                      + (ok == null ? 'bg-surface-variant text-outline' : ok ? 'bg-primary/15 text-primary' : 'bg-error/15 text-error'),
                ok == null ? '○' : ok ? '✓' : '✗'),
             el('span', 'font-body-md text-body-md flex-1', label),
             el('span', 'font-body-sm text-body-sm text-on-surface-variant text-right', value));
  return row;
}

// The budget in rupees: the one you set, or AWS's - kept in dollars with the
// tax inside it, so it turns back at the plain exchange rate, not the one with
// GST added.
function budgetInr(s) {
  const b = (s && s.budget) || {};
  if (b.limit == null) return null;
  const set = Number(setting('GAME_BUDGET_INR', NaN));
  return isFinite(set) ? set : b.limit * ((s.rates && s.rates.fx_inr_per_usd) || NaN);
}

// The AWS machine's "What is working", as a machine of yours has: what this
// laptop needs to build one, and once there is one, the machine itself.
function paintAwsChecks() {
  const list = $('b-checks');
  if (!list) return;
  list.textContent = '';
  const s = statusNow;
  if (!s) { list.append(el('p', 'font-body-sm text-body-sm text-on-surface-variant', 'Not checked yet.')); return; }
  const m = s.box && s.box.state !== 'terminated' ? s.box : null;
  const tn = s.tailnet || {};
  const guards = (watcher && watcher.guards) || [];
  const g2 = guards.find(g => g.layer === 2), g3 = guards.find(g => g.layer === 3);
  const limit = budgetInr(s);
  const games = libNow && !libNow.error ? (libNow.games || []) : null;
  for (const r of [
    credsNow && credsNow.valid != null ? [credsNow.valid, 'AWS account', credsNow.valid ? 'connected' : 'key not accepted'] : null,
    tskeyNow ? [tskeyNow.valid === true, 'Tailscale access token',
                tskeyNow.valid ? 'working' : tskeyNow.valid === false ? 'refused'
                  : tskeyNow.present ? 'Tailscale did not respond' : 'not saved'] : null,
    // A machine that is not running is not on the tailnet, and that is not a fault.
    m ? (m.state !== 'running' && !tn.online ? [null, 'Tailscale', 'connects when the machine starts']
         : [!!tn.online, 'Tailscale', tn.online ? (tn.node || 'connected') : 'not connected']) : null,
    m ? [m.ready !== false, 'Set up', m.ready === false ? 'still building' : 'finished'] : null,
    m && g2 ? [g2.armed !== false, 'Auto-stop on the machine',
               g2.armed === false ? 'off' : g2.idle_min != null ? `after ${g2.idle_min} min idle` : 'on'] : null,
    // Both are set up by every build, before it launches anything - so with
    // no machine, missing is "not yet", not a fault. A machine without them is.
    g3 ? [g3.armed ? true : m ? false : null, 'Auto-stop in AWS',
          g3.armed ? 'checks every 5 min' : m ? 'off' : 'turns on when you build'] : null,
    [limit != null ? true : m ? false : null, 'Budget alert',
     limit != null ? (isFinite(limit) ? `${rs(limit)} a month` : 'set') : m ? 'not set' : 'set when you build'],
    games ? [true, 'Saved games', games.length ? `${games.length} ready to restore` : 'none yet'] : null,
  ]) if (r) list.append(checkRow(...r));
}

function hostDetail(h, failed) {
  const s = hostStatus.get(h.name) || {};
  const st = hostState(h);
  const setting = !!hostJob(h.name, 'setup');
  const playing = !!hostJob(h.name, 'open');
  const linux = h.os !== 'Windows';
  const unknown = failed && !hostStatus.has(h.name);
  const card = el('div', 'flex flex-col gap-gutter-desktop');
  card.dataset.host = h.name;
  card.dataset.state = st.title;
  if (hostWasLoading.delete(h.name)) card.classList.add('card-in');
  const panels = el('div', 'grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-gutter-desktop');

  // Left: the state, the machine, and what can be done.
  const left = el('section', 'p-space-xl rounded-xl bg-surface-container-low flex flex-col gap-space-md');
  const tone = { ok: 'text-primary', run: 'text-primary', warn: 'text-tertiary', bad: 'text-error' }[st.tone] || 'text-outline';
  const word = { ok: playing ? 'Streaming' : 'Online', run: 'Setting up', warn: 'Needs you', bad: 'Offline' }[st.tone];
  if (word) left.append(el('span', `font-label-caps text-label-caps uppercase ${tone}`, word));
  const t = el('p', 'font-headline-xl text-headline-xl', st.title); t.dataset.f = 'title';
  left.append(t);
  if (st.sub) { const p = el('p', 'font-body-md text-body-md text-on-surface-variant', st.sub); p.dataset.f = 'sub'; left.append(p); }
  const facts = el('div', 'flex flex-col gap-0.5 font-body-sm text-body-sm text-on-surface-variant');
  const what = [s.os_name || s.os || h.os, s.gpu].filter(Boolean).join(' · ');
  if (what) facts.append(el('span', '', what));
  facts.append(el('span', '', `Reached over SSH as ${h.ssh}`));
  left.append(facts);
  const acts = el('div', 'flex flex-col gap-space-sm mt-auto pt-space-md');
  const more = el('div', 'grid grid-cols-2 xl:grid-cols-3 gap-space-sm');
  const btn = (label, cls, go, f, into) => { const b = el('button', cls, label); b.dataset.f = f; b.onclick = go; into.append(b); return b; };
  if (unknown) {
    btn('Try again', 'btn btn-primary btn-lg', () => { readFailures.delete(`host:${h.name}`); refreshHosts(h.name); }, 'retry', acts);
  } else if (s.set_up && linux) {
    const p = btn(playing ? 'Streaming' : 'Play', 'btn btn-primary btn-lg w-full', () => playOn(h.name), 'play', acts);
    p.disabled = playing || setting || !!sessionNow || !s.sunshine;
    p.dataset.off = p.disabled ? '1' : '';
    p.title = sessionNow ? 'a session is already open' : '';
  }
  if (!unknown && linux) {
    const b = btn(setting ? 'Setting up…' : s.set_up ? 'Re-run setup' : 'Set up',
                  s.set_up ? 'btn' : 'btn btn-primary btn-lg w-full', () => setUpHost(h.name), 'setup', s.set_up ? more : acts);
    b.disabled = setting || playing;
    b.dataset.off = b.disabled ? '1' : '';
  }
  if (setting || playing) {
    // Ends it here; a setup stopped part-way carries on from there next time.
    btn(playing ? 'Stop session' : 'Stop setup', playing ? 'btn btn-primary btn-lg w-full' : 'btn', () => {
      const j = [...jobs].find(([, x]) => hostRun(x) && x.cmd[2] === h.name);
      if (j) window.ayis.cancel(j[0]);
    }, 'stop', playing ? acts : more);
  }
  const q = btn('Stream quality', 'btn', () => goSetting(settingEl('GAME_RES')), 'quality', more);
  q.disabled = !settingEl('GAME_RES');
  const r = btn('Remove', 'btn btn-danger', () => removeHost(h.name), 'remove', more);
  r.disabled = setting || playing;
  acts.append(more);
  left.append(acts);

  // Right: every check ayis made, each with what it found.
  const right = el('section', 'flex flex-col gap-space-sm');
  right.append(el('p', 'section-label mb-space-xs', 'What is working'));
  const checks = el('div', 'flex flex-col gap-space-sm');
  checks.dataset.f = 'checks';
  if (hostStatus.has(h.name)) {
    for (const [ok, label, value] of [
      [s.reachable, 'SSH', s.reachable ? h.ssh : 'not answering'],
      [s.online, 'Tailscale', s.online ? (s.tailnet_ip || 'on your tailnet') : 'not connected'],
      [s.sunshine, 'Sunshine', s.sunshine ? 'running' : 'not answering'],
      [s.login_ok, 'Sunshine login', s.login_ok ? 'verified' : 'not verified'],
      [s.paired, 'Moonlight', s.paired ? 'paired' : 'not paired'],
      [s.steam, 'Steam', s.steam ? 'installed' : 'not found'],
      [s.reachable ? !!s.desktop : null, 'Desktop', s.desktop ? `${s.desktop} · signed in` : 'nobody signed in'],
    ]) {
      if (ok != null) checks.append(checkRow(ok, label, value));
    }
  } else {
    checks.append(el('p', 'font-body-sm text-body-sm text-on-surface-variant', st.sub || 'Not checked yet.'));
  }
  right.append(checks);
  panels.append(left, right);
  card.append(panels);

  // The setup's own words, while it runs and after: folded once it is over.
  const log = hostLogs.get(h.name);
  if (log) {
    const box = el('details', 'p-space-lg rounded-xl bg-surface-container-low');
    box.open = setting || log.dataset.failed === 'yes';
    const session = log.dataset.kind === 'session';
    box.append(el('summary', 'font-body-sm text-body-sm text-on-surface-variant cursor-pointer',
                  setting ? 'Progress' : log.dataset.failed === 'yes' ? 'Error details'
                    : session ? 'Last session' : 'Setup log'));
    box.append(log);
    card.append(box);
  }
  return card;
}

function paintHostCards() {
  const list = hostsNow || [];
  // The logs go back to their parking place before the cards are rebuilt.
  for (const log of hostLogs.values()) $('h-logs').append(log);
  const home = $('d-hosts');
  home.textContent = '';
  for (const h of list) home.append(hostCard(h, false));
  const page = $('b-hosts');
  page.textContent = '';
  const open = list.find(h => h.name === machineTab);
  if (open) page.append(hostCard(open, true));
  lockHostButtons();
  paintMachineTab();
  paintHome();
  paintDash();
}

// The Machine page: whichever machine is picked - AWS, or one of yours - and
// the picker beside Refresh, while there is more than one to choose from.
function paintMachineTab() {
  const choices = [...(awsAdded() ? [['aws', 'AWS']] : []), ...(hostsNow || []).map(h => [h.name, h.name])];
  if (choices.length && !choices.some(([v]) => v === machineTab)) machineTab = choices[0][0];
  const host = machineTab !== 'aws';
  $('b-aws').hidden = host;
  $('b-own').hidden = !host;
  // A pill each, its state a dot: up, needing you, or neither. Drawn in the
  // theme - a native <select> opened as the system's own grey list.
  const pick = $('machine-pick');
  pick.hidden = view !== 'build' || choices.length < 2;
  pick.textContent = '';
  for (const [v, label] of choices) {
    const b = el('button', 'seg-item');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(v === machineTab));
    b.dataset.value = v;
    const box = v === 'aws' ? liveBox() : null;
    const tone = v === 'aws' ? (box && box.state === 'running' ? 'up' : '')
      : ({ ok: 'up', run: 'up', warn: 'warn', bad: 'warn' }[hostState((hostsNow || []).find(h => h.name === v) || { name: v }).tone] || '');
    b.append(el('span', `seg-dot ${tone}`), document.createTextNode(label));
    b.onclick = () => { machineTab = v; paintHostCards(); };
    pick.append(b);
  }
  if (view === 'build') $('view-title').textContent = 'Machine';
  // The run card follows the machine picked: under the AWS one, or yours.
  paintRun();
}
// The Machine page for the AWS machine - whichever machine it showed last.
function goAws() {
  machineTab = 'aws';
  if (view === 'build') paintMachineTab(); else goView('build');
  paintMachineTab();
}
function goHost(name) {
  machineTab = name;
  if (view === 'build') paintHostCards(); else goView('build');
  paintHostCards();
}

// Home and the sidebar, from which machines there are.
function paintHome() {
  // Until the settings are read, whether AWS is one of the machines is what it
  // was last time - so its card is in place from the first frame.
  const aws = (config || []).length ? awsAdded() : !!(homeBoot && homeBoot.aws), hosts = hostsNow || [];
  const any = aws || hosts.length > 0;
  // Nothing is said until both have been read - or remembered: a laptop with
  // machines must not flash the welcome while the list is on its way.
  const known = ((config || []).length > 0 || !!homeBoot) && hostsNow !== null;
  $('d-welcome').hidden = !known || any;
  $('d-machines').hidden = !any;
  $('d-hero').hidden = !aws;
  $('d-add-aws').hidden = aws;
  $('d-money').hidden = !aws;
  $('d-cards').hidden = !any;
  $('d-glance-label').hidden = !any;
  for (const id of ['d-games-card', 'd-protect-card']) $(id).hidden = !aws;
  for (const v of AWS_VIEWS) {
    const link = document.querySelector(`.nav-item[data-view="${v}"]`);
    if (link) link.hidden = !aws;
  }
  document.querySelector('.nav-item[data-view="build"]').hidden = !any;
  // Settings are about streaming from a machine and the machines themselves:
  // with none yet there is nothing in it worth a visit - this laptop's own
  // steps are part of adding one.
  document.querySelector('.nav-item[data-view="settings"]').hidden = known && !any;
  if (known && !any && view === 'settings') goView('dashboard');
  settingsForAws(aws);
  if (!aws && ['library', 'guards', 'cost'].includes(view)) goView('dashboard');
  if (known && !any && view === 'build') goView('dashboard');
  if (view === 'build') paintMachineTab();
}
for (const b of document.querySelectorAll('[data-add]')) b.onclick = () => openAdd(b.dataset.add);


// Setting one up again, from its card: the add dialog's own flow, with the
// machine already connected - its steps ticked, and setup starting by itself,
// its log open, its questions in the popup, closing once it is done.
function setUpHost(name) {
  openAdd('host');
  addedHost = name;
  $('onb-title').textContent = `Set up ${name}`;
  paintOnboard();
  // Only once what comes before it is met: a tool gone since is its step.
  const before = prereqs().filter(r => !r.sameAs && r.key !== 'setup');
  if (before.every(r => r.ok === true)) onbSetupHost();
}

// Streaming from it. Nothing to start and nothing billed by the hour: it is
// already there.
// Play on a machine of yours: the session as steps, on its page, and when it
// ends the page read again with the popup up - as the AWS machine's session
// is, step for step. What is read is what a session can change here: the
// machine, not AWS. What it showed stays until the new answer replaces it:
// forgotten first, the whole panel turned to "loading" and was drawn again,
// which read as being sent to another page.
async function playOn(name) {
  await startRun(['host', 'open', name], { host: name });
  await refreshShown([HOSTS_READ, hostRead(name)]);
}

// Removing a machine of yours: asked, run and reported in one dialog that
// closes by itself once Home has caught up. ayis says when the machine could not
// be reached to revoke the key: that outlasts the dialog, as a toast.
async function removeHost(name) {
  const unreachable = out => /could not reach it/.test(out);
  return runInDialog({
    title: `Remove ${name}`,
    confirm: { body: 'Revokes the app\'s SSH key on the machine and removes it from the app.\n'
                   + 'Sunshine, Steam and games on it are not changed.', yes: 'Remove', danger: true },
    args: ['host', 'remove', name],
    starting: 'Revoking SSH key…',
    // What was not done is said here, above Done, where it is read - not in a
    // note left behind once the dialog has gone.
    done: out => unreachable(out)
      ? `Removed. Its SSH key could not be revoked: ${name} was unreachable. `
        + 'Remove the line from its ~/.ssh/authorized_keys when it is back.'
      : 'Removed.',
    // Stays to be read, with Done, as disconnecting AWS does.
    close: () => false,
    stoppable: false,
    // Before it says Removed: the list read again, and Home shown without it.
    after: async () => {
      hostStatus.delete(name);
      hostLogs.delete(name);
      await refreshHosts();
      goView('dashboard');
    },
    fail: () => 'Not removed. See details above.',
  });
}

// After anything changes a machine: the list, and that machine's status.
async function refreshHosts(name) {
  if (name) hostStatus.delete(name);
  await runAyis(HOSTS_READ[0], { json: HOSTS_READ[1], group: 'refresh' });
}

// Removing AWS: ayis aws forget, which refuses while a machine or saved games are
// still there and says which. When AWS cannot be asked (exit 3), whether
// anything still bills is not known - that is said, and it is your call.
// What is in AWS, as ayis aws inventory reads it live - for the confirmation.
async function awsInventory() {
  const out = await runAyis(['aws', 'inventory', '--json'], { capture: true });
  try { return JSON.parse(out) || { error: 'Could not read what is in AWS.' }; }
  catch { return { error: 'Could not read what is in AWS.' }; }
}
// Disconnecting AWS deletes everything ayis has there, so nothing is left billing
// - the machine, every region's saved games, leftovers, the watchdog, the
// budget - in one dialog: what is there, read live; DELETE typed; the run; a
// look that nothing is left; then Home, without AWS. What stays is free.
async function removeAws() {
  const ok = await runInDialog({
    title: 'Disconnect AWS',
    checking: 'Checking what is in AWS\u2026',
    confirm: async () => {
      const d = await awsInventory();
      if (d.error) return { error: `${d.error} Nothing was deleted.` };
      const inr = d.inr_per_usd;
      const inrOf = usd => (usd == null || !inr ? null : rs(usd * inr));
      const lines = (d.items || []).map(i => `\u2022 ${i.label}${i.detail ? ': ' + i.detail : ''}`
        + (i.usd_month ? ` (${inrOf(i.usd_month)}/month)` : ''));
      const now = d.hourly ? 'billing by the hour now' : d.usd_month != null ? `${inrOf(d.usd_month)}/month now` : null;
      return {
        body: (lines.length ? 'This deletes everything the app has in AWS:\n' + lines.join('\n')
                            : 'Nothing the app made is left in AWS.')
            + `\n\n${now ? now + ', ' : ''}\u20b90/month after.`
            + (d.items.some(i => i.kind === 'games') ? ' Saved games cannot be recovered.' : '')
            + '\nKept, at no cost: your AWS account, its access key, region opt-ins and GPU quota.',
        yes: 'Disconnect', danger: true,
        word: (d.items || []).length ? 'DELETE' : null,
      };
    },
    args: ['aws', 'disconnect'],
    typed: { askId: ASK.awsDisconnect, word: 'DELETE' },
    starting: 'Deleting\u2026',
    stoppable: false,
    done: 'AWS disconnected. Nothing left billing.',
    // Stays to be read, with Done: it is the last word on the whole account.
    close: () => false,
    after: async () => { await refreshAll(); goView('dashboard'); },
    fail: rc => rc === 3 ? 'Could not reach AWS. Nothing was deleted.'
                         : 'Not everything could be deleted. See details above; AWS stays connected so it can be seen.',
  });
  return ok;
}
$('b-aws-remove').onclick = removeAws;
