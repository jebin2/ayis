'use strict';
// Spending: the bill, month by month and day by day.
// One of the renderer's scripts, loaded in order by index.html into one shared scope
// (docs/architecture.md, "The app").

// Redrawn from the last paid answer when a free one lands - the games found in
// other places explain storage the bill charges for - so it never asks again.
// The two cards Home and Spending share, drawn from the last bill check and
// nothing else - so a build changes neither until the bill is checked again,
// and the two pages can never disagree. `hint` is what an unchecked card says.
const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls || '', textContent: text || '' });
// A large figure: the number monospaced, the words after it in the page's own
// type - "left", "a month" set in the digits' face read as part of the sum.
function figureText(node, number, words) {
  node.textContent = number;
  if (words) node.append(el('span', 'font-body-md text-body-md font-normal tracking-normal text-on-surface-variant', ` ${words}`));
}
function billParts() {
  const d = costNow;
  if (!d) return null;
  const m = d.month || {}, rate = d.rates || {};
  const inr = rate.inr_per_usd || m.inr_per_usd;
  const r = usd => (usd == null || !isFinite(usd) || !inr ? '—' : rs(usd * inr));
  return { d, m, rate, inr, r };
}
function renderMonth(box, { hint } = {}) {
  if (!box) return;
  box.textContent = '';
  const p = billParts();
  const total = el('p', 'text-headline-xl figure mt-space-sm');
  total.dataset.f = 'total';
  const sub = el('p', 'font-code-sm text-code-sm text-on-surface-variant mt-space-xs');
  sub.dataset.f = 'sub';
  box.append(total, sub);
  if (!p) { total.textContent = '—'; sub.textContent = hint || ''; return; }
  const { d, m, inr, r } = p;
  const hours = m.hours ? m.hours.on_demand + m.hours.spot : 0;
  const projected = m.projected_usd ?? null;
  const now = new Date();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  total.textContent = m.total_usd != null ? r(m.total_usd) : '—';
  // AWS's bill is the account's - every region, and anything not ayis's.
  sub.textContent = m.total_usd == null ? 'No response from AWS.'
    : `so far on the whole AWS account${(d.rates || {}).tax_pct ? `, with ${d.rates.tax_pct}% GST` : ''} · ${hours.toFixed(1)} h runtime`
      + (projected != null ? ` · projected ${r(projected)} by ${monthEnd.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '');
  // Your number, in rupees, as you set it. AWS keeps it in dollars, converted
  // when it was made; turned back at today's rate it read Rs 5,412 for 5,000.
  const budget = Number(setting('GAME_BUDGET_INR', NaN));
  const inAws = (d.resources || {}).budget_usd != null;
  if (inAws && isFinite(budget) && projected != null && inr) {
    const over = projected * inr > budget;
    const wrap = el('div', 'h-1.5 rounded-full bg-surface-container mt-space-md overflow-hidden');
    const bar = el('div', 'h-full ' + (over ? 'bg-error' : 'bg-primary'));
    bar.style.width = Math.min(100, (projected * inr / budget) * 100) + '%';
    bar.dataset.f = 'bar';
    wrap.append(bar);
    const chip = el('span', 'pill ml-space-xs ' + (over ? 'pill-bad' : 'pill-ok'), over ? 'over budget' : 'under budget');
    chip.dataset.f = 'chip';
    box.append(wrap);
    sub.append(' ', chip);
  }
  // Every build sets the budget before it launches: with no machine yet,
  // none in AWS is "not yet", not a fault.
  const hasBox = !!(statusNow && statusNow.box && statusNow.box.state !== 'terminated');
  const note = el('p', 'font-code-sm text-code-sm mt-space-sm ' + (inAws || !hasBox ? 'text-outline' : 'text-error'),
    !inAws ? (hasBox ? 'No budget alert set in AWS.' : 'The budget alert is set when you build.')
      : isFinite(budget) ? `Budget ${rs(budget)}/month. Email at 80%; when spent, the machine is switched off and blocked.` : '');
  note.dataset.f = 'note';
  box.append(note);
}
function renderRecurring(box, { hint } = {}) {
  if (!box) return;
  box.textContent = '';
  const p = billParts();
  const head = el('p', 'text-headline-lg figure mt-space-sm');
  head.dataset.f = 'total';
  const sub = el('p', 'font-code-sm text-code-sm text-on-surface-variant mt-0.5', 'Billed monthly, whether or not you play.');
  sub.dataset.f = 'sub';
  box.append(head, sub);
  if (!p) { head.textContent = '—'; sub.textContent = hint || ''; return; }
  const { d, inr, r } = p;
  const standby = d.standby || {}, res = d.resources || {}, arch = d.archive || {};
  // Games ayis found in other places bill like any others. What the bill says
  // beyond those is not guessed at here: the bill runs days behind, so a game
  // just deleted read as "storage this app cannot find" for three days.
  const away = elsewherePlaces().filter(x => x.usd_month);
  const awayUsd = away.reduce((a, x) => a + x.usd_month, 0);
  if (standby.usd_month != null) figureText(head, r(standby.usd_month + awayUsd), 'a month');
  else head.textContent = '—';
  const list = el('div', 'flex flex-col mt-space-sm');
  list.dataset.f = 'rows';
  const line = (label, value, go) => {
    const row = el('div', 'row border-b border-surface-variant/40 last:border-b-0');
    const a = el(go ? 'button' : 'span', 'font-code-sm text-code-sm ' + (go ? 'text-primary hover:underline text-left' : 'text-outline'),
                 go ? `${label} →` : label);
    if (go) a.onclick = go;
    row.append(a, el('span', 'font-code-sm text-code-sm', value));
    list.append(row);
  };
  // One row for saved games, wherever they are; the Games page has them one by one.
  // With none saved there is nothing to charge and nothing to open, so no row.
  const savedBytes = (arch.bytes || 0) + away.reduce((a, x) => a + (x.bytes || 0), 0);
  const savedUsd = (standby.archive_usd_month || 0) + awayUsd;
  if (savedBytes) line('Saved games', `${r(savedUsd)} a month`, () => goView('library'));
  // The machine as the bill saw it: by the hour while it ran, its disk by the
  // month while stopped. Otherwise only a disk a deleted machine left behind.
  if (res.instance) {
    const st = res.instance.state;
    const hr = boxNow ? machineFacts().price : null;
    line(`Machine (${st})`, st === 'running' ? (hr != null ? `${rsh(hr)} an hour` : 'by the hour')
                                             : `${r(standby.volumes_usd_month)} a month`, () => goAws());
  } else if (res.volumes_gb) {
    line('Orphaned disk', `${res.volumes_gb} GB · ${r(standby.volumes_usd_month)} a month`);
  }
  if (res.snapshots_gb) line('Snapshots', `${res.snapshots_gb} GB · ${r(standby.snapshots_usd_month)} a month`);
  if (!list.children.length) {
    const none = el('p', 'font-code-sm text-code-sm text-outline', 'Nothing stored.');
    none.dataset.f = 'none';
    list.append(none);
  }
  box.append(list);
  // What playing adds on top: the machine, by the hour.
  const play = machineFacts().priceText;
  if (play != null) {
    const pl = el('p', 'font-code-sm text-code-sm text-on-surface-variant mt-space-sm',
      res.instance && res.instance.state === 'running'
        ? `Running now: +${play}/hour.`
        : `Playing adds ${play}/hour.`);
    pl.dataset.f = 'play';
    box.append(pl);
  }
}

function paintCostPage() {
  const d = costNow;
  if (!d) return;
  const m = d.month || {};
  // Every rate on this screen comes from ayis, and one rupee rate converts all
  // of it - ayis's own, so the rows add up to the total under them.
  const rate = d.rates || {};
  const inr = rate.inr_per_usd || m.inr_per_usd;
  const r = usd => (usd == null || !isFinite(usd) || !inr ? '—' : rs(usd * inr));
  const short = dt => dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const day = iso => short(new Date(iso + 'T00:00:00'));
  const now = new Date();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const hours = m.hours ? m.hours.on_demand + m.hours.spot : 0;
  const projected = m.projected_usd ?? null;
  renderMonth($('c-month-card'), { hint: 'Refresh to load this month\'s bill.' });

  // ── credits ──
  const credits = d.credits_usd;
  if (credits != null) figureText($('c-credits'), r(credits), 'left');
  else $('c-credits').textContent = '—';
  $('c-credits-note').textContent = credits == null ? 'Not reported by AWS.'
    : 'Applied before your card is charged'
      + (projected ? ` · about ${Math.round(credits / projected)} months at this rate.` : '.');

  // ── day by day: what you played, the machine, storage, and the rest ──
  $('c-days-note').textContent = 'Days with no charges are omitted. The AWS bill lags about a day.'
    + (inr ? ` ₹${(+inr).toFixed(2)} to the dollar.` : '');
  paintRefreshAge();
  const parts = x => ({ machine: x.compute || 0, storage: (x.s3 || 0) + (x.disk || 0),
                        other: (x.egress || 0) + (x.api || 0) + (x.other || 0) });
  const money0 = v => (v ? r(v) : '–');
  const rows = $('c-rows');
  rows.textContent = '';
  const sum = { machine: 0, storage: 0, other: 0 };
  for (const dayRow of m.days || []) {
    const p = parts(dayRow);
    for (const k in sum) sum[k] += p[k];
    const tr = document.createElement('tr');
    tr.className = 'border-b border-surface-variant/40';
    cell(tr, day(dayRow.date), 'pr-space-md text-on-surface-variant whitespace-nowrap');
    cell(tr, dayRow.hours ? `${dayRow.hours.toFixed(1)} h` : '–', 'text-right');
    for (const k of ['machine', 'storage', 'other']) cell(tr, money0(p[k]), 'text-right');
    cell(tr, r(dayRow.total), 'text-right pl-space-md text-primary');
    rows.append(tr);
  }
  const foot = $('c-foot');
  foot.textContent = '';
  if (m.total_usd != null) {
    const tr = document.createElement('tr');
    cell(tr, 'Month so far', 'pr-space-md whitespace-nowrap');
    cell(tr, hours ? `${hours.toFixed(1)} h` : '–', 'text-right');
    for (const k of ['machine', 'storage', 'other']) cell(tr, money0(sum[k]), 'text-right');
    cell(tr, r(m.total_usd), 'text-right pl-space-md text-primary font-medium');
    foot.append(tr);
  }

  // ── where it went: the same three columns, added up, as bars ──
  const where = $('c-where');
  where.textContent = '';
  const spent = [
    ['machine', `Machine${hours ? ` \u00b7 ${hours.toFixed(1)} h` : ''}`, sum.machine],
    ['storage', 'Saved games and disks', sum.storage],
    ['other', 'Transfer, address and the rest', sum.other],
  ];
  const most = Math.max(...spent.map(x => x[2]));
  if (m.total_usd == null || !most) {
    where.append(el('p', 'font-body-sm text-body-sm text-outline',
      m.total_usd == null ? 'No response from AWS.' : 'Nothing billed yet this month.'));
  }
  else for (const [key, what, usd] of spent) {
    const row = el('div', 'grid grid-cols-[minmax(0,1fr)_minmax(4rem,8rem)_5rem] items-center gap-space-md font-body-md text-body-md');
    row.dataset.f = key;
    const bar = el('div', 'h-2 rounded-full bg-primary');
    bar.style.width = `${Math.max(usd ? 3 : 0, (usd / most) * 100)}%`;
    const track = el('div', 'h-2 rounded-full bg-surface-container');
    track.append(bar);
    row.append(el('span', 'min-w-0', what), track, el('span', 'figure text-right', money0(usd)));
    where.append(row);
  }

  renderRecurring($('c-recurring-card'));

  // ── free streaming ──
  const e = m.egress || {};
  // Bitrate decides how fast the free 100 GB goes; it is a setting, not a guess.
  const kbps = Number(setting('GAME_BITRATE_KBPS', 20000));
  const gbPerHour = (kbps * 3600) / 8 / 1e6;
  if (e.gb_used != null) {
    figureText($('c-egress'), `${e.gb_used.toFixed(1)} of ${e.gb_free} GB`, 'used this month');
    $('c-egress-src').textContent = 'From the AWS bill.';
    const pct = Math.min(100, (e.gb_used / e.gb_free) * 100);
    $('c-egress-pct').hidden = false;
    $('c-egress-pct').textContent = `${pct.toFixed(0)}% used`;
    $('c-egress-pct').className = 'pill ' + (pct > 80 ? 'pill-bad' : 'pill-ok');
    $('c-egress-bar').style.width = pct + '%';
    $('c-egress-bar').className = 'h-full ' + (pct > 80 ? 'bg-tertiary' : 'bg-primary');
    // The used figure is measured; the hours are the worst case - what the
    // quality setting would use flat out - so they are said as "at least".
    const fps = setting('GAME_FPS', '60'), res = setting('GAME_RES', null);
    const quality = `${(kbps / 1000).toFixed(0)} Mbps, ${fps} fps, ${res || 'native resolution'}`;
    $('c-egress-note').textContent = e.gb_left > 0
      ? `At ${quality} (~${gbPerHour.toFixed(0)} GB/hour): at least ${Math.floor(e.gb_left / gbPerHour)} free hours left, then ${r(rate.egress_gb)}/GB.`
      : `Free ${e.gb_free} GB used. Streaming costs ${r(rate.egress_gb)}/GB, up to ${r(gbPerHour * rate.egress_gb)}/hour at ${quality}.`;
  }
}
