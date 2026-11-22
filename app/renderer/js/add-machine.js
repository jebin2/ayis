'use strict';
// Adding a machine: AWS, or a server of your own.
// One of the renderer's scripts, loaded in order by index.html into one shared scope
// (docs/architecture.md, "The app").

// --- Adding a machine ----------------------------------------------------------
// The add dialog: the steps the machine needs (prereqs), the active one with
// the one button that meets it. AWS ends when a location is chosen; a server
// of yours ends with setting it up, now or later.
function openAdd(kind) {
  // No engine: the dialog already says so, and there is nothing to add with.
  if (engineGone) return paintOnboard();
  adding = kind;
  addedHost = null;
  setupDone = false;
  // Each time it opens, it starts fresh: nothing typed for the last machine,
  // and no log from the last attempt - except a step still running.
  if (!connecting) {
    for (const id of ['add-addr', 'add-user', 'add-pw', 'add-name']) serverForm.querySelector('#' + id).value = '';
    serverForm.querySelector('#add-port').value = '22';
    const log = serverForm.querySelector('#add-log');
    log.textContent = ''; log.hidden = true; log.classList.remove('text-error');
  }
  for (const u of [...document.querySelectorAll('[id^="onb-unit-"]')])
    if (u.id !== 'onb-unit-' + onbRunning) u.remove();
  onbNote = ''; onbTone = '';
  $('onb-title').textContent = kind === 'aws'
    ? (awsAdded() ? 'Finish setting up AWS' : 'Add AWS') : 'Add a server';
  paintOnboard();
  keepOpen($('adddlg'));
  if (!$('adddlg').open) $('adddlg').showModal();
  // Everything its steps are judged on was read when the window opened, except
  // what only AWS answers: AWS not added yet, the reads behind the gate go now -
  // or, with a step still to do, as soon as it is (gateMayOpen).
  if (kind === 'aws' && !awsAdded()) { gateShut = true; gateMayOpen(); }
}
function closeAdd() {
  if (onbHandover) { clearTimeout(onbHandover); onbHandover = null; }
  adding = null;
  // Closed while it waits for the password: an empty answer, and ayis stops with
  // nothing changed on the server.
  if (serverPwAsk) { window.ayis.answer(serverPwAsk, ''); serverPwAsk = null; }
  serverForm.querySelector('#add-pw').value = '';
  if ($('adddlg').open) closeDialog($('adddlg'));
  paintHome();
}
$('adddlg-close').onclick = e => { e.preventDefault(); closeAdd(); };
// Esc closes none of the add, run, Play-games or copy-progress dialogs: each is a flow under
// way, and leaving one is its own button - Close, Cancel, Later, Done. Stopped
// at the key, because a cancel event the dialog has already been sent is not
// reliably stoppable.
for (const id of ['adddlg', 'rundlg', 'playdlg', 'restoredlg', 'keepdlg']) {
  $(id).addEventListener('keydown', e => { if (e.key === 'Escape') e.preventDefault(); });
  $(id).addEventListener('cancel', e => e.preventDefault());
}
// Closed any other way, it is closed all the same. A close event is queued, so
// it can land after the dialog was opened again; only one that finds it still
// closed is a close.
$('adddlg').addEventListener('close', () => { if (adding && !$('adddlg').open) closeAdd(); });

// The server step's form. Built once and kept, so a repaint while you type -
// every read that lands repaints the steps - never loses what was typed.
const serverForm = (() => {
  const wrap = el('div', 'flex flex-col gap-space-sm mt-space-sm');
  const field = (label, id, placeholder, note) => {
    const l = el('label', 'block font-body-sm text-body-sm text-on-surface-variant', label);
    const i = el('input', 'mt-space-xs field');
    i.id = id; i.placeholder = placeholder; i.autocomplete = 'off'; i.spellcheck = false;
    l.append(i);
    if (note) l.append(el('span', 'block font-code-sm text-code-sm text-outline mt-0.5', note));
    wrap.append(l);
    return i;
  };
  // Host and its ssh port on one line: 22 unless the machine's ssh server
  // listens elsewhere. The port is only written into the target when it is
  // not 22, so an ordinary machine stays "user@address".
  const hostRow = el('div', 'flex items-start gap-space-sm');
  const hostLabel = el('label', 'block flex-1 font-body-sm text-body-sm text-on-surface-variant', 'Host');
  const addr = el('input', 'mt-space-xs field');
  addr.id = 'add-addr'; addr.placeholder = 'IP address or hostname';
  addr.autocomplete = 'off'; addr.spellcheck = false;
  hostLabel.append(addr);
  const portLabel = el('label', 'block w-24 shrink-0 font-body-sm text-body-sm text-on-surface-variant', 'Port');
  const port = el('input', 'mt-space-xs field text-center');
  port.id = 'add-port'; port.value = '22'; port.inputMode = 'numeric'; port.maxLength = 5;
  port.autocomplete = 'off'; port.spellcheck = false; port.title = 'SSH port';
  portLabel.append(port);
  hostRow.append(hostLabel, portLabel);
  wrap.append(hostRow);
  field('Username', 'add-user', 'SSH user');
  // Its password, here in the form rather than in a dialog on top of it. Only
  // asked of it when no key of the app's gets in yet - so empty is fine for a
  // server that already takes your key.
  const pw = field('Password', 'add-pw', '', 'Used once to install an SSH key. Not stored.');
  pw.type = 'password';
  pw.parentElement.id = 'add-pw-row';
  field('Display name', 'add-name', 'Defaults to its hostname');
  const log = el('pre', 'font-code-sm text-code-sm whitespace-pre-wrap text-on-surface-variant max-h-[20vh] overflow-auto');
  log.id = 'add-log'; log.hidden = true;
  wrap.append(log);
  for (const i of wrap.querySelectorAll('input'))
    i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); connectServer(); } });
  return wrap;
})();
// readFresh(args, json) - that read, answered after now: the one already under
// way when there is one (a write re-reads by itself), else a new one.
async function readFresh(args, json) {
  if (readOut(json)) { while (readOut(json)) await new Promise(r => jobEnded.push(r)); return; }
  await runAyis(args, { json, group: 'refresh' });
}
let connecting = false;
// Until a machine's status has answered once, or failed - asking for it if no
// read of it is under way.
async function hostAnswered(name) {
  const key = `host:${name}`;
  while (!hostStatus.has(name) && !readFailures.has(key)) {
    if (readOut(key)) { await new Promise(r => jobEnded.push(r)); continue; }
    const [args, json] = hostRead(name);
    await runAyis(args, { json, group: 'refresh' });
    break;
  }
}
let serverPwAsk = null;   // the job whose password question the form is holding
// ayis's password question while connecting: answered from the form - at once
// when it is filled in already, otherwise when you press Continue.
function serverPwAnswer(job, askId) {
  if (askId !== ASK.hostSshPw || !connecting) return false;
  const pw = $('add-pw');
  if (pw.value) { window.ayis.answer(job, pw.value); pw.value = ''; return true; }
  serverPwAsk = job;
  $('add-log').textContent = 'Password required.';
  paintOnboard();
  pw.focus();
  return true;
}
async function connectServer() {
  if (serverPwAsk) {
    const pw = $('add-pw');
    if (!pw.value) { pw.focus(); return; }
    const job = serverPwAsk;
    serverPwAsk = null;
    window.ayis.answer(job, pw.value); pw.value = '';
    $('add-log').textContent = 'Installing key…';
    paintOnboard();
    return;
  }
  if (connecting) return;
  const addr = $('add-addr').value.trim(), user = $('add-user').value.trim(), name = $('add-name').value.trim();
  const portText = $('add-port').value.trim() || '22';
  const log = $('add-log');
  log.hidden = false;
  log.classList.remove('text-error');
  if (!addr || !user) { log.textContent = 'Host and username are required.'; log.classList.add('text-error'); return; }
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    log.textContent = 'Port must be a whole number from 1 to 65535.'; log.classList.add('text-error'); return;
  }
  // 22 needs no saying: the target stays the address alone.
  const target = port === 22 ? `${user}@${addr}` : `${user}@${addr}:${port}`;
  connecting = true;
  log.textContent = 'Connecting…';
  log.dataset.fresh = 'yes';
  paintOnboard();
  const before = new Set((hostsNow || []).map(h => h.name));
  const { rc } = await runAyis(['host', 'add', ...(name ? [name] : []), '--ssh', target],
                             { collect: 'add-log', wantRc: true });
  if (rc !== 0) { connecting = false; log.classList.add('text-error'); paintOnboard(); return; }
  await refreshHosts();
  const added = (hostsNow || []).map(h => h.name).find(n => !before.has(n)) || name || null;
  // The step is done with what the machine is, not before: its first status
  // has to answer, or the summary filled in under the next step.
  if (added) await hostAnswered(added);
  addedHost = added;
  connecting = false;
  paintOnboard();
  // Connected: setup follows by itself - there is nothing to decide in between.
  // Already set up (added again), it is done as it is.
  if (!added || adding !== 'host') return;
  if ((hostStatus.get(added) || {}).set_up) {
    setupDone = true;
    paintOnboard();
    onbHandOver(() => { if (adding === 'host' && setupDone) { note(`${added} added`, 'text-primary'); closeAdd(); } });
    return;
  }
  onbSetupHost();
}

// The setup step: run right here, its log open as it goes. Closes the dialog
// once it is done; a failure keeps it open, with the reason.
let setupDone = false;

// A password asked in passing - sudo, while a machine is set up: a small popup
// over whatever is running, one field, Continue. Resolves the password, or
// null when it is cancelled.
function askPassword({ title, sub, placeholder = '' }) {
  return new Promise(resolve => {
    const dlg = $('pwdlg'), input = $('pwdlg-input'), yes = $('pwdlg-yes');
    $('pwdlg-title').textContent = title;
    $('pwdlg-sub').textContent = sub || '';
    input.placeholder = placeholder;
    input.value = '';
    yes.disabled = true;
    input.oninput = () => { yes.disabled = !input.value; };
    // Enter would submit the form's first button, which is Cancel.
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); if (input.value) yes.click(); } };
    // Answered by the buttons themselves, not the close event: that one is
    // queued, and can land after whatever runs next. Esc is a Cancel.
    let done = false;
    const finish = v => {
      if (done) return;
      done = true;
      input.value = '';
      if (dlg.open) closeDialog(dlg);
      resolve(v);
    };
    yes.onclick = e => { e.preventDefault(); if (input.value) finish(input.value); };
    $('pwdlg-no').onclick = e => { e.preventDefault(); finish(null); };
    dlg.onclose = () => finish(null);
    keepOpen(dlg);
    if (!dlg.open) dlg.showModal();
    input.focus();
  });
}
// What ayis asks while it sets a machine up - its sudo password, and the
// Tailscale auth key when it is not on the tailnet yet: the popup, and an empty
// answer if it is cancelled - ayis then stops, with nothing changed.
const SETUP_ASKS = {
  [ASK.hostSudo]: name => ({ title: 'Sudo password', wait: 'Waiting for the sudo password…',
    sub: `${name ? name + ': ' : ''}used once for setup. Not stored.` }),
  [ASK.tsAuthKey]: name => ({ title: 'Tailscale auth key', wait: 'Waiting for a Tailscale auth key…',
    placeholder: 'tskey-auth-…',
    sub: `${name || 'This machine'} is not on your tailnet yet. login.tailscale.com → Settings → Keys → `
       + 'Generate auth key (Reusable on, Ephemeral off). Saved for later builds.' }),
};
function sudoAnswer(job, askId) {
  const j = jobs.get(job);
  if (!SETUP_ASKS[askId] || !j || j.cmd[0] !== 'host' || j.cmd[1] !== 'setup') return false;
  const q = SETUP_ASKS[askId](j.cmd[2]);
  const live = onbRunning === 'setup' ? $('onb-live-setup') : null;
  if (live) live.textContent = q.wait;
  askPassword(q).then(v => {
    window.ayis.answer(job, v || '');
    if (live && v) live.textContent = 'Continuing…';
  });
  return true;
}
async function onbSetupHost() {
  const name = addedHost;
  if (!name || onbRunning) return;
  onbUnit('setup');
  onbLogOpen('setup', true);
  const ok = await runInPipeline('setup', ['host', 'setup', name], 'Starting setup…', paintHostCards);
  // Nothing to re-read for this step: its own exit is the verdict.
  if (onbVerifying === 'setup') onbVerifying = null;
  $('onb-prog-setup').hidden = true;
  await refreshHosts(name);
  if (!ok) { onbLogOpen('setup', true); paintOnboard(); return; }
  setupDone = true;
  paintOnboard();
  onbHandOver(() => {
    if (adding !== 'host' || !setupDone) return;
    note(`${name} set up`, 'text-primary');
    closeAdd();
  });
}
