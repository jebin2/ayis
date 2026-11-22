'use strict';
// Home: the machines at a glance, the network, and this month's spend.
// One of the renderer's scripts, loaded in order by index.html into one shared scope
// (docs/architecture.md, "The app").

function paintDash() {
  // ── the machine: the Machine page's own card ──
  paintMachineCards();
  const s = awsAdded() ? statusNow : null;
  if (!s) return paintNetwork(null);
  const inr = inrRate();
  const credErr = s.error && s.error.credentials;
  const box = s.box && !['terminated'].includes(s.box.state) ? s.box : null;
  const building = jobsFor('init') || unfinished(box);
  const running = !!(box && box.state === 'running');
  const idleGuard = ((watcher && watcher.guards) || []).find(g => g.layer === 2);
  const idleAfter = idleGuard && idleGuard.idle_min != null ? `${idleGuard.idle_min} min` : null;

  // ── recurring cost and this month: the Spending page's own cards ──
  renderRecurring($('d-recurring-card'), { hint: 'Exact cost reads the bill.' });
  // The same card on Spending, redrawn with it: its play line reads the
  // machine's status, which changes without a Refresh.
  if (costNow) renderRecurring($('c-recurring-card'));
  renderMonth($('d-month-card'), { hint: 'Use Exact cost to load it.' });
  const b = s.budget || {};
  const limit = budgetInr(s);
  const checked = lastCost();
  showChecked($('d-month-src'), checked ? checked.at : null, true);
  showChecked($('d-bill-src'), checked ? checked.at : null, true);
  const call = (s.rates || {}).ce_call_usd;
  $('d-cost-price').textContent = call && isFinite(inr) ? rs(call * inr) : '';
  // The Cost page's Refresh is the same call, so it carries the same price.
  $('refresh-cost').textContent = $('d-cost-price').textContent;

  // ── your games ──
  // Names, wherever they are kept; size, place and dates are on the Games page.
  const gl = $('d-games');
  gl.textContent = '';
  const a = s.archive || {};
  const say = (text, cls) => gl.append(Object.assign(document.createElement('p'),
    { className: cls || 'text-on-surface', textContent: text }));
  if (credErr || a.error || (libNow && libNow.error)) {
    say('Could not read saved games.', 'text-outline');
  } else if (!libNow) {
    say('Reading…', 'text-outline');
  } else {
    const names = [...(libNow.games || []), ...elsewherePlaces().flatMap(p => p.games || [])]
      .map(g => g.name || g.installdir).filter(Boolean);
    if (!names.length) say('No saved games', 'text-on-surface-variant');
    for (const n of names.slice(0, 5)) say(n);
    if (names.length > 5) say(`and ${names.length - 5} more`, 'text-outline');
  }

  paintNetwork(s);


  // ── protection ──
  const prot = $('d-protect');
  prot.textContent = '';
  const guards = (watcher && watcher.guards) || [];
  const g2 = guards.find(g => g.layer === 2), g3 = guards.find(g => g.layer === 3);
  const hasBox = !!(statusNow && statusNow.box && statusNow.box.state !== 'terminated');
  const lines = [
    // Installed with every build: with no machine there is nothing for it to
    // watch, which is not the same as it being off.
    [g2 ? (g2.armed === false ? false : true) : null,
     idleAfter ? `Auto-stop after ${idleAfter} idle` : 'Auto-stop when idle'],
    // These two are set up by every build before it launches: with no
    // machine yet, missing is "not yet", never a fault.
    [g3 ? (g3.armed || (hasBox ? false : null)) : null,
     g3 && g3.armed ? 'AWS auto-stop: on' : hasBox ? 'AWS auto-stop: off' : 'AWS auto-stop: turns on when you build'],
    [b.limit != null ? true : (statusNow && hasBox ? false : null),
     b.limit != null ? `Budget alert at ${rs(limit)} · ${b.alerts ? `emails ${b.alerts} address${b.alerts === 1 ? '' : 'es'}` : 'no email set'}`
                     : hasBox ? 'No budget alert is set' : 'Budget alert: set when you build'],
  ];
  for (const [ok, text] of lines) {
    const row = document.createElement('div');
    row.className = 'flex items-baseline gap-space-sm';
    row.append(Object.assign(document.createElement('span'), {
      className: 'font-code-md text-code-md w-4 shrink-0 '
        + (ok === true ? 'text-primary' : ok === false ? 'text-error' : 'text-outline'),
      textContent: ok === true ? '✓' : ok === false ? '✗' : '…' }),
      Object.assign(document.createElement('span'), {
      className: 'font-body-md text-body-md ' + (ok === false ? 'text-error' : 'text-on-surface'),
      textContent: text }));
    prot.append(row);
  }
}

// The private network: this laptop, the AWS machine when there is one, and
// each machine of yours. Own machines only, there is no AWS status at all.
function paintNetwork(s) {
  const box = s && s.box && !['terminated'].includes(s.box.state) ? s.box : null;
  const building = !!s && (jobsFor('init') || unfinished(box));
  // "Your machine" is the AWS one only while it is the only one.
  const it = (hostsNow || []).length ? 'AWS machine' : 'Machine';
  const ts = $('d-ts');
  ts.textContent = '';
  const tn = (s && s.tailnet) || {};
  const tsLines = [];
  // This laptop. null is "not read yet", not "signed out".
  const me = tskeyNow ? tskeyNow.signed_in : null;
  tsLines.push([me === true ? true : me === false ? false : null,
    me === true ? `This device: signed in${tskeyNow.node ? ` as ${tskeyNow.node}` : ''}`
      : me === false ? 'This device: not signed in' : 'Checking this device']);
  // The machine, only if there is one.
  if (!s) {
    // No AWS machine on this laptop: nothing to say about one.
  } else if (!box) {
    tsLines.push([undefined, building ? `${it}: connecting…` : `${it}: joins on build`]);
  } else if (tn.node && tn.online) {
    tsLines.push([true, `${it}: connected`]);
  } else if (tn.node) {
    tsLines.push([false, `${it}: not connected`]);
  } else {
    tsLines.push(building ? [null, `${it}: connecting…`] : [false, `${it}: not connected`]);
  }
  // The path, while the machine is online.
  if (box && tn.online) {
    const ms = pingNow && pingNow.median_ms != null ? ` · ${pingNow.median_ms} ms` : '';
    tsLines.push(!pingNow ? [null, 'Checking the connection']
      : pingNow.path === 'direct' ? [true, `Direct connection${ms}`]
      : pingNow.path === 'DERP' ? ['warn', `Relayed${ms} · higher latency`]
      : [null, 'Connection not measured']);
  }
  for (const h of hostsNow || []) {
    const hs = hostStatus.get(h.name);
    tsLines.push(!hs ? [null, `Checking ${h.name}`]
      : hs.online ? [true, `${h.name}: connected`]
      : [hs.set_up ? false : undefined, hs.set_up ? `${h.name}: not connected` : `${h.name}: joins on setup`]);
  }
  for (const [ok, text] of tsLines) {
    const row = document.createElement('div');
    row.className = 'flex items-baseline gap-space-sm';
    row.append(Object.assign(document.createElement('span'), {
      className: 'font-code-md text-code-md w-4 shrink-0 '
        + (ok === true ? 'text-primary' : ok === false ? 'text-error' : ok === 'warn' ? 'text-tertiary' : 'text-outline'),
      textContent: ok === true ? '✓' : ok === false ? '✗' : ok === 'warn' ? '!' : ok === undefined ? '·' : '…' }),
      Object.assign(document.createElement('span'), {
      className: 'font-body-md text-body-md ' + (ok === false ? 'text-error' : ok === undefined ? 'text-outline' : 'text-on-surface'),
      textContent: text }));
    ts.append(row);
  }
  $('d-ts-signin').hidden = me !== false;
}

// Play, on both screens, says what it would do - and says no when a stream is
// already up, which is what ayis itself does.
function paintSession() {
  const live = !!sessionNow;
  for (const id of ['d-open', 'b-open']) {
    const b = $(id);
    if (!b) continue;
    const label = b.lastChild;
    if (label && label.nodeType === 3 && b.dataset.stopped !== 'yes') label.textContent = live ? 'Streaming' : 'Play';
    b.title = live
      ? `a session is already open`
      : 'Opens Moonlight and connects to your machine';
  }
  paintMachineCards();
  paintHostCards();
}



// Rendered from `ayis cost --json`: the same single Cost Explorer call the CLI makes.
function setting(key, fallback) {
  const r = config.find(x => x.key === key);
  return (r && (r.effective ?? r.value)) || fallback;
}

// The last bill check: this window's, else the one remembered on this laptop
// from the same month. Last month's total is not this month's.
// The last bill on this laptop, drawn again at start until a new check -
// with when it was checked, so it is never read as current.
function restoreBill() {
  if (costNow) return;
  try {
    const kept = JSON.parse(localStorage.getItem('ayis.lastCost') || 'null');
    if (!kept || !kept.bill) return;
    const at = new Date(kept.at), now = new Date();
    if (at.getFullYear() !== now.getFullYear() || at.getMonth() !== now.getMonth()) return;
    costNow = kept.bill;
    costNowAt = at;
    paintCostPage();
    paintDash();
  } catch { /* nothing remembered */ }
}
function lastCost() {
  const m = costNow && costNow.month;
  if (m && m.total_inr != null) return { total_inr: m.total_inr, projected_inr: m.projected_inr ?? null, at: costNowAt.toISOString() };
  try {
    const kept = JSON.parse(localStorage.getItem('ayis.lastCost') || 'null');
    const at = kept && new Date(kept.at), now = new Date();
    if (at && at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth()) return kept;
  } catch { /* nothing remembered */ }
  return null;
}
// "Checked today 14:15", on any element, red and blinking once it is more
// than a day old. Every "Checked" in the app goes through this.
function showChecked(el, iso, bill = false) {
  if (!el) return;
  el.textContent = iso ? `Checked ${whenChecked(iso)}` : '';
  const old = !!iso && Date.now() - Date.parse(iso) > 86400000;
  // A bill label is also out of date once something since has changed it.
  const since = bill && iso ? billChangesSince(iso) : [];
  el.classList.toggle('out-of-date', old || since.length > 0);
  el.title = !iso ? ''
    : since.length ? `Checked ${whenChecked(iso)}. Since then: `
        + since.map(c => `${c.what} (${whenChecked(c.at)})`).join(', ')
        + '. Refresh for the new total. The AWS bill lags about a day.'
    : old ? `Checked ${whenChecked(iso)}. Over a day old.`
    : '';
}

// What changed the bill after it was checked: actions here that cost or save
// money, and a machine seen running. Kept on this laptop with the bill, and
// cleared by the next check.
const BILL_CHANGE = {
  init: 'you built a machine', destroy: 'you deleted the machine', open: 'you played',
  'library move': 'you moved a game', 'library forget': 'you deleted a game',
  'library clean': 'you cleaned up leftover files',
  'disk add': 'you added disk space',
};
function billChanges() {
  try { return JSON.parse(localStorage.getItem('ayis.billChanges') || '[]'); } catch { return []; }
}
// At or after: the list is cleared when a check is made, so anything in it
// came after that check - even within the same millisecond.
const billChangesSince = iso => billChanges().filter(c => Date.parse(c.at) >= Date.parse(iso));
// A machine ran after the bill was checked: once, however it is found out -
// seen running here, or, with this app closed the whole time it ran and
// auto-stop ending it, by the cloud watchdog's last-seen mark (`seen`), which
// it moves every five minutes while a machine exists. Free: that mark arrives
// with the saved games' read. The bill is never checked by itself - each check
// is a paid call, and the bill runs a day behind anyway - the label only beats.
function noteMachineRan(seen) {
  const checkedAt = lastCost() && lastCost().at;
  if (!checkedAt || (seen && Date.parse(seen) <= Date.parse(checkedAt))) return;
  if (billChangesSince(checkedAt).some(c => c.what === 'a machine was running')) return;
  noteBillChange('a machine was running');
}
function noteBillChange(what) {
  if (!lastCost()) return;              // nothing checked yet: nothing to go out of date
  const list = billChanges();
  list.push({ what, at: new Date().toISOString() });
  try { localStorage.setItem('ayis.billChanges', JSON.stringify(list.slice(-20))); } catch { /* this window only */ }
  paintDash();
  paintRefreshAge();
}
const whenChecked = iso => {
  const d = new Date(iso), hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `today ${hm}`
    : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${hm}`;
};

function paintSpend(d) {
  // The dashboard shows the last paid fetch and says how old it is. It never
  // fetches on its own: Cost Explorer bills a cent a call.
  costNow = d;
  costNowAt = new Date();
  // Kept on this laptop, so Home is not empty again after a restart; it is
  // shown with when it was checked, never as if it were live.
  const m = d.month || {};
  try { localStorage.removeItem('ayis.billChanges'); } catch { /* nothing kept */ }
  if (m.total_inr != null) {
    try {
      localStorage.setItem('ayis.lastCost', JSON.stringify({
        total_inr: m.total_inr, projected_inr: m.projected_inr ?? null, at: costNowAt.toISOString(), bill: d }));
    } catch { /* storage unavailable: this window still has it */ }
  }
  paintDash();
}

// Spending's Refresh says what it costs and how old the bill on screen is.
function paintRefreshAge() {
  const el = $('refresh-age');
  showChecked(el, costNowAt ? costNowAt.toISOString() : null, true);
  el.hidden = view !== 'cost' || !costNowAt;
}

function paintCost(d) {
  paintSpend(d);
  paintCostPage();
}
