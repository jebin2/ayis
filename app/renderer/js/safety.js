'use strict';
// Safety: the guards and the hard limits.
// One of the renderer's scripts, loaded in order by index.html into one shared scope
// (docs/architecture.md, "The app").

function paintGuardStrip() { paintDash(); }

// The three nets in plain words. The minutes are ayis's, read from the settings
// the watchdogs run with; the wording around them is the page's.
// Which machine is said: with machines of your own beside it, "the machine"
// read as homeserver. These guard the AWS one; yours are not stopped by ayis.
const NET_NAME = { 1: 'When you quit', 2: 'On the AWS machine', 3: 'In AWS' };
function netWords(g, d) {
  if (g.layer === 1) return ['Closing Moonlight ends the session.', 'Runs on this device.'];
  if (g.layer === 2) {
    const sd = d.shutdown_action || {};
    const end = sd.expected
      ? ` Then ${sd.value === 'terminate' ? 'deleted' : 'stopped'}.` : '';
    // Every number is ayis's (ayis watcher), none is a fallback written here.
    return [`Shuts down after ${g.idle_min != null ? `${g.idle_min} min` : 'a period'} with no connection.${end}`,
            'Runs on the AWS machine itself, so it works with this device off.'];
  }
  return [`${g.every_min != null ? `Every ${g.every_min} min: ` : ''}ends the machine after ${g.idle_min ?? '?'} min without a stream, or a shutdown stuck for `
          + `${g.stuck_min ?? '?'} min.`,
          'Runs in AWS, independent of this device and the AWS machine.'];
}
function netState(g, gone) {
  if (g.layer === 1) return ['Always on', 'pill-ok'];
  // On, but no check has finished for 15 minutes: the dead-man signal.
  if (g.late === true) return ['Not running', 'pill-bad'];
  if (g.armed === true) return ['On', 'pill-ok'];
  // Every build installs it before launching: with no machine, not yet.
  if (g.layer === 3 && g.armed === false && gone) return ['Turns on when you build', ''];
  if (g.armed === false) return ['Off', 'pill-bad'];
  // Layer 2 with no machine to live on is waiting, not failing.
  // No AWS machine for it to live on: waiting, not off - "Idle" read as a fault.
  return [g.state === 'no box' ? 'Waits for a machine' : 'Unreachable', ''];
}

function paintGuards(d) {
  watcher = d;
  paintGuardStrip();
  const guards = d.guards || [];
  const by = n => guards.find(g => g.layer === n) || {};
  const running = d.instance_state === 'running';
  const gone = ['none', 'terminated', '', undefined, null].includes(d.instance_state);
  const on = guards.filter(g => g.layer === 1 || g.armed === true).length;

  $('g-head').textContent = running
    ? `Machine running · ${on === guards.length ? `all ${on}` : `${on} of ${guards.length}`} safeguards on`
    : gone ? 'No machine running' : `Machine ${d.instance_state}`;
  const cloud = by(3);
  $('g-sub').textContent = cloud.last_decision
    ? `Last check ${ago(cloud.last_decision_age_s)}: ${/nothing to do/.test(cloud.last_decision) ? 'idle.' : cloud.last_decision}`
    : cloud.armed ? 'Runs every 5 minutes. No activity in the last hour.' : '';

  // What is wrong, in red, on top - not three cards down.
  // AWS auto-stop and the budget are set up by every build before it
  // launches; with no machine, their absence is not something wrong.
  const warn = [];
  if (cloud.armed === false && !gone) warn.push(`AWS auto-stop is ${cloud.state || 'off'}.`);
  // The dead-man signal: armed, but no run has finished cleanly for 15 minutes.
  if (cloud.late === true) warn.push(`AWS auto-stop has not finished a check for ${ago(cloud.last_ok_age_s).replace(/ ago$/, '')} - it may not be running.`);
  if (running && by(2).armed === false) warn.push("The machine's own check is off - only AWS will stop it.");
  const sd = d.shutdown_action || {};
  if (sd.expected && !sd.ok) warn.push(`Shutdown behavior is ${sd.value === 'terminate' ? 'delete' : 'stop'}; expected ${sd.expected === 'terminate' ? 'delete' : 'stop'}.`);
  if ((d.budget || {}).usd == null && !gone) warn.push('No budget alert set in AWS.');
  $('g-warn').textContent = '';
  for (const w of warn) {
    const el = document.createElement('span');
    el.textContent = w;
    $('g-warn').append(el);
  }
  $('g-warn').hidden = !warn.length;

  const nets = $('g-nets');
  nets.textContent = '';
  for (const g of guards) {
    const [what, needs] = netWords(g, d);
    const [state, tone] = netState(g, gone);
    // A card each: its place in the order, a circle; its name over what it
    // does and where it runs; whether it is on.
    const row = document.createElement('div');
    row.className = 'flex flex-wrap items-center gap-x-space-lg gap-y-space-sm p-space-lg rounded-xl bg-surface-container-low';
    row.dataset.layer = g.layer;
    row.innerHTML = `
      <span class="w-10 h-10 shrink-0 rounded-full flex items-center justify-center font-body-md text-body-md font-semibold ${tone === 'pill-bad' ? 'bg-error/15 text-error' : 'bg-primary/15 text-primary'}"></span>
      <span class="font-headline-md text-headline-md basis-56 grow-0 shrink-0 whitespace-nowrap"></span>
      <div class="flex-1 min-w-[14rem]">
        <p class="font-body-md text-body-md text-on-surface-variant"></p>
        <p class="font-body-sm text-body-sm text-outline mt-space-xs"></p>
      </div>
      <span class="pill shrink-0 ${tone}"></span>`;
    const [n, name, , pill] = row.children;
    n.textContent = g.layer;
    name.textContent = NET_NAME[g.layer] || g.name;
    row.querySelector('p').textContent = what;
    row.querySelectorAll('p')[1].textContent = needs;
    pill.textContent = state;
    nets.append(row);
  }

  // The settings behind them, read from the settings registry and edited
  // through ayis like every other setting.
  const knobs = $('g-knobs');
  knobs.textContent = '';
  const WANT = ['GAME_BUDGET_INR', 'GAME_MAX_HOURS_MONTH', 'GAME_MAX_SESSION_HOURS', 'EMAIL_ALERTS',
                'GAME_WATCHDOG_IDLE_MIN', 'GAME_WATCHDOG_STUCK_MIN', 'GAME_NTFY_URL'];
  for (const key of WANT) {
    const r = config.find(x => x.key === key);
    if (!r) continue;
    const row = document.createElement('div');
    // Wraps rather than squeezes, as settingRow's do.
    row.className = 'row flex-wrap border-b border-surface-variant/40 last:border-b-0 items-start';
    row.dataset.key = key;          // so anything can send you to this one row
    const left = document.createElement('div');
    left.className = 'min-w-[12rem] flex-1';
    const n = document.createElement('p');
    n.className = 'font-body-md text-body-md';
    n.textContent = PLAIN[key] || label(r);
    const note = document.createElement('p');
    note.className = 'font-body-sm text-body-sm text-outline mt-0.5';
    note.textContent = PLAIN_NOTE[key] || r.note;
    left.append(n, note);
    const right = document.createElement('div');
    right.className = 'flex items-center gap-space-sm min-w-0 max-w-full ml-auto';
    const val = document.createElement('span');
    val.className = 'font-body-sm text-body-sm text-on-surface-variant text-right min-w-0 [overflow-wrap:anywhere]';
    const v = r.value != null ? r.value : r.default;
    val.textContent = key === 'GAME_BUDGET_INR' && v != null ? `${rs(Number(v))} a month`
      : /_MIN$/.test(key) && v != null ? `${v} min${r.value == null ? ' (default)' : ''}`
      // 0 is the setting's own word for "no limit".
      : /^GAME_MAX_/.test(key) && v != null ? (Number(v) === 0 ? 'off'
        : `${v} hours${key === 'GAME_MAX_HOURS_MONTH' ? ' a month' : ''}${r.value == null ? ' (default)' : ''}`)
      // No topic means your phone hears nothing, which is "off", not "not set".
      : key === 'GAME_NTFY_URL' && !r.is_set ? 'off'
      : settingValue(r);
    const edit = document.createElement('button');
    edit.className = 'btn';
    edit.textContent = r.secret && r.is_set ? 'Replace' : 'Edit';
    edit.onclick = () => editSetting(r, row);
    right.append(val, edit);
    row.append(left, right);
    knobs.append(row);
  }
}

// The hard limits, from `ayis limits --json`: a row each, with the way past it
// beside it. The buttons run ayis, which writes; nothing here decides a limit.
let limitsNow = null;
function limitRow(title, detail, tone, actions) {
  const row = document.createElement('div');
  row.className = 'row flex-wrap border-b border-surface-variant/40 last:border-b-0 items-start';
  const left = document.createElement('div');
  left.className = 'min-w-[12rem] flex-1';
  const n = document.createElement('p');
  n.className = 'font-body-md text-body-md' + (tone === 'bad' ? ' text-error' : '');
  n.textContent = title;
  const d = document.createElement('p');
  d.className = 'font-body-sm text-body-sm text-outline mt-0.5';
  d.textContent = detail;
  left.append(n, d);
  const right = document.createElement('div');
  right.className = 'flex flex-wrap items-center gap-space-sm ml-auto';
  for (const [text, go, danger] of actions) {
    const b = document.createElement('button');
    b.className = 'btn' + (danger ? ' btn-danger' : '');
    b.textContent = text;
    b.onclick = go;
    right.append(b);
  }
  row.append(left, right);
  return row;
}
async function limitRun(args, done) {
  const { rc, err } = await runAyis(['limits', ...args], { wantRc: true });
  if (rc === 0) note(done, 'text-primary');
  else note(`Not changed: ${(err || '').trim().split('\n').pop() || 'ayis limits failed'}`, 'text-error');
}
function paintLimits(d) {
  limitsNow = d;
  const box = $('g-limit-rows');
  if (!box) return;
  box.textContent = '';
  const m = d.month || {};
  const h = x => (Math.round(x * 10) / 10).toLocaleString();
  const resets = d.month_resets ? new Date(d.month_resets).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'the 1st';
  const addHours = n => [`+${n} hours`, () => limitRun(['extend-month', String(n)], `Added ${n} hours to this month`)];
  if (d.month_error) {
    box.append(limitRow('Play hours this month: unknown', d.month_error, 'bad', []));
  } else if (!m.cap_hours) {
    box.append(limitRow(`Play hours this month: ${h(m.used_hours || 0)}`, 'No monthly limit is set.', '', []));
  } else {
    const extra = m.extra_hours ? ` (${h(m.extra_hours)} added this month)` : '';
    box.append(limitRow(
      m.reached ? `This month's ${h(m.cap_hours)} hours are used up` : `Play hours this month: ${h(m.used_hours)} of ${h(m.cap_hours)}`,
      m.reached ? `No machine starts until ${resets}, unless you add hours.${extra}`
        : `${h(m.left_hours)} hours left${extra}. Resets ${resets}.`,
      m.reached ? 'bad' : '', [addHours(5), addHours(20)]));
  }
  const sessions = d.sessions || [];
  if (!d.session_hours) {
    box.append(limitRow('Session limit: off', 'A session can run as long as you play.', '', []));
  } else if (!sessions.length) {
    box.append(limitRow(`Session limit: ${d.session_hours} hours`, 'Counts from when the machine starts.', '', []));
  }
  for (const s of sessions) {
    const at = new Date(s.ends).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    box.append(limitRow(`Session ends at ${at}`, `${s.left_minutes} min left. You get a phone alert ${d.warn_minutes} min before.`,
      s.left_minutes <= d.warn_minutes ? 'bad' : '',
      [['+1 hour', () => limitRun(['extend-session', '1'], 'Session extended by 1 hour')],
       ['+3 hours', () => limitRun(['extend-session', '3'], 'Session extended by 3 hours')]]));
  }
  if (d.budget_error) {
    box.append(limitRow('Budget block: unknown', d.budget_error, 'bad', []));
  } else if (d.budget_blocked) {
    box.append(limitRow('Budget spent: machines are blocked',
      'AWS reports this month\'s budget as used up, so no machine can start.', 'bad',
      [['Unblock', async () => {
        if (await askConfirm({ title: 'Unblock until next month?',
          body: 'Machines can start again, and AWS will not block them again this month, so spending beyond the budget is possible. The hour limits still apply.',
          yes: 'Unblock', danger: true })) limitRun(['unblock'], 'Budget block lifted until next month');
      }, true]]));
  } else if (d.budget_armed === false) {
    box.append(limitRow('Budget block: not set up',
      'Set it up so that when this month\'s budget is used up, AWS stops new machines from starting and the running one is switched off.', 'bad',
      [['Set up', () => limitRun(['arm'], 'Budget block set up')]]));
  } else {
    box.append(limitRow('Budget block: ready',
      'If this month\'s budget is used up, AWS stops new machines from starting and the running one is switched off.', '', []));
  }
}
