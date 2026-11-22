'use strict';
// Settings, the tools on this laptop, the AWS key and Tailscale token, the GPU quota and regions.
// One of the renderer's scripts, loaded in order by index.html into one shared scope
// (docs/architecture.md, "The app").

// --- Settings ----------------------------------------------------------------
// Every row comes from `ayis config --json`, and every change goes back through
// `ayis config set`, which validates it and writes .env. The app never touches
// the file, and never sees a secret: it can replace one, not read it.
// A setting's name is ayis's to give: `ayis config --json` carries `label` and
// `group`. This file kept its own table of both, so a setting ayis grew appeared
// in the window as a raw GAME_SHOUTING_KEY until someone added it here too.
const label = r => r.label || r.key;

// --- Tools on this laptop ---------------------------------------------------
// What ayis needs here. There is no page for it: setup lists what is missing and
// installs it in place, and anything that goes missing later is offered as an
// Install button where it is noticed. A page of green ticks was all that was
// left of it once setup could do its job.
let depsNow = null, credsNow = null, tskeyNow = null;
function paintDeps(d) {
  paintOnboardSoon();
  depsNow = d;
  paintOnboardSoon();
}

// The button for tools that are missing: Install, when this laptop can install
// at all - and otherwise the command to run by hand, because an Install button
// that cannot install anything is worse than none.
function toolAction(tools) {
  const all = (depsNow && depsNow.tools) || [];
  const rows = tools.map(t => all.find(x => x.tool === t) || { tool: t, label: t === 'aws' ? 'the AWS CLI' : t });
  const names = rows.map(x => x.label || x.tool).join(', ');
  // Not read yet: offer it, and ayis says so if it cannot.
  if (!depsNow || (depsNow.package_manager && depsNow.root)) {
    return { label: `Install ${names}`, go: () => installDeps(tools) };
  }
  return { label: `How to install ${names}`, go: () => askConfirm({
    title: `Install ${names} by hand`,
    body: (depsNow && !depsNow.package_manager ? 'No supported package manager found. '
           : `Install permission denied${depsNow && depsNow.root_blocked ? ` (${depsNow.root_blocked})` : ''}. `)
      + 'Run the following, then Refresh:\n\n' + rows.map(x => x.manual || x.plan || x.tool).join('\n'),
    yes: 'OK', no: null,
  }) };
}

function installDeps(tools) {
  const what = tools.length === 1 ? tools[0] : 'what is missing';
  return runInDialog({
    title: `Installing ${what}`,
    args: ['deps', 'install', ...tools],
    starting: 'Waiting for your password. The prompt may open behind this window.',
    done: 'Installed',
    fail: rc => 'Install failed.',
  });
}

// The AWS access key: three states, and the third is why this card exists at
// all. No CLI is not a rejected key, and a rejected key is not an absent one -
// a new laptop hits the first and used to be told the second.
function paintCreds(c) {
  credsNow = c;
  paintOnboardSoon();
  const state = $('creds-state'), detail = $('creds-detail'), btn = $('creds-set');
  btn.hidden = false;
  if (!c.cli) {
    state.textContent = 'The AWS CLI is not installed';
    state.className = 'font-code-md text-code-md text-error mt-space-sm';
    detail.textContent = 'Install it, then add your key.';
    const act = toolAction(['aws']);
    btn.textContent = act.label;
    btn.onclick = act.go;
    return;
  }
  btn.textContent = c.key_id ? 'Update access key' : 'Add access key';
  btn.onclick = setCreds;
  if (c.valid) {
    state.textContent = `Key ${c.key_id || ''} is working`.replace('  ', ' ');
    state.className = 'font-code-md text-code-md text-on-surface mt-space-sm';
    // The account is the thing worth seeing on a new laptop: a key that works
    // for the WRONG account reads as "fine" everywhere else in the app.
    detail.textContent = [c.account && `AWS account ${c.account}`]
      .filter(Boolean).join('  \u00b7  ');
    return;
  }
  state.textContent = c.key_id ? `Key ${c.key_id} was rejected` : 'No key added';
  state.className = 'font-code-md text-code-md text-error mt-space-sm';
  detail.textContent = c.error || 'Rejected by AWS.';
}

// ayis asks for the two halves of the key as events; the dialog answers them, and
// the secret one renders as a password field. Nothing is typed into the app's
// own storage - ayis writes ~/.aws/credentials.
// The Tailscale card. Two facts, and they fail independently: this laptop can
// be signed in with no API token (normal, and ayis says what it gives up), or
// hold a token while being signed out (nothing works, and no token helps).
function paintTskey(ts) {
  paintOnboardSoon();
  tskeyNow = ts;
  paintDash();
  paintOnboardSoon();
  const state = $('tskey-state'), detail = $('tskey-detail'), btn = $('tskey-set');
  const canRootNow = Boolean(depsNow && depsNow.root);
  const signed = ts.signed_in === true ? `Signed in${ts.node ? ' as ' + ts.node : ''}`
    : ts.signed_in === false
      ? (canRootNow ? 'Not signed in' : 'Not signed in. Run: sudo tailscale up')
    : 'Tailscale is not installed';
  const token =
      !ts.present      ? 'No access token. AWS builds need one.'
    : ts.valid         ? 'Access token is working'
    : ts.valid === false ? 'Access token was rejected'
    // Unreachable says nothing about the token, so it must not be drawn as a
    // bad one: the fix for a flat network is not a new token.
    : 'Access token saved; Tailscale did not respond';
  state.textContent = signed;
  state.className = 'font-code-md text-code-md mt-space-sm '
    + (ts.signed_in === true ? 'text-on-surface' : 'text-error');
  detail.textContent = token;
  // The box's own key. It is not the token and cannot be: `tailscale up` takes
  // a node registration key, and the token has no business in EC2 user-data.
  // With a token here, nobody has to paste one.
  $('tskey-auth').textContent =
      ts.auth_key_stored ? 'Auth key saved'
    : ts.can_mint        ? 'An auth key is generated from the access token at the next build'
    : 'No auth key. The next build asks for one.';
  btn.textContent = ts.present ? 'Update access token' : 'Add access token';
  btn.onclick = openTskey;
  // Pasting the box's key is for when the token cannot make one: no token, or
  // a tailnet whose ACLs will not issue an untagged key. With a working token
  // there is nothing to type, so there is no button.
  const authBtn = $('tskey-authkey');
  authBtn.hidden = ts.can_mint && !ts.auth_key_stored;
  authBtn.textContent = ts.auth_key_stored ? 'Update auth key' : 'Add auth key';
  authBtn.onclick = setAuthKey;
  // Signing in is root's business - systemctl, then `tailscale up` - which in a
  // window means polkit. Where polkit cannot be reached the card says what to
  // type instead of offering a button that dies inside sudo.
  $('tskey-signin-go').hidden = ts.signed_in !== false || !canRootNow;
}

// `tailscale up` prints a login URL and then WAITS for someone to visit it, so
// the URL has to reach the person while the command is still running - the one
// place in this app where output during a run is the point, not a log.
// The sign-in, as a dialog, because it is a thing that happens rather than a
// state to read: polkit asks for a password, `tailscale up` prints a link and
// then WAITS for someone to visit it, and none of that is over until it is.
let runDlgJob = null, runDlgRetry = null, runDlgRc = null;
let runDlgConfirm = null;   // the confirm step's answer, while it is asking
function runDlgStatus(text, tone) {
  const el = $('rundlg-status');
  el.textContent = text;
  el.className = 'font-code-sm text-code-sm mt-0.5 mb-space-md '
    + (tone === 'bad' ? 'text-error' : tone === 'ok' ? 'text-on-surface' : 'text-outline');
}

// runInDialog({...}) - run an ayis command in front of the person.
//   title    what is happening, in two or three words
//   args     the ayis command
//   starting the first status line, before ayis has said anything
//   done     the status when it succeeds (a string, or a function for one that
//            has to be read off the state the run just changed)
//   fail     the status when it does not, given the exit code
//   confirm  optional { body, yes, danger, word }: the same dialog asks first,
//            and the run happens in it - no confirm box that closes onto
//            nothing. `word` must be typed before yes can be pressed. Given as
//            an async function, it is read first, the dialog loading meanwhile
//            (`checking` says what with), and { error } stops there.
//   close    on success, close after a beat (given ayis's output: false keeps it
//            open, for a result worth reading)
//   stoppable false for a run that is over in seconds and must not be left
//            half done: no Cancel while it runs
//   after    on success, what has to happen before it is shown as done -
//            re-reading what the change touched - given ayis's output; the
//            dialog keeps loading until it has
// Resolves true on success; `false` when it failed or was not confirmed.
async function runInDialog(opts) {
  const { title, args, starting, done, fail, close, stoppable = true, after, checking } = opts;
  // typed: { askId, word } - ayis's own typed confirmation, answered with the
  // word already typed in this dialog rather than asked a second time.
  const { typed } = opts;
  let asking = opts.confirm;
  const log = $('rundlg-log'), link = $('rundlg-link'), go = $('rundlg-go');
  const wordRow = $('rundlg-word-row'), word = $('rundlg-word');
  $('rundlg-title').textContent = title;
  link.hidden = true;
  go.hidden = true;
  wordRow.hidden = true;
  $('rundlg-busy').hidden = true;
  if (asking) {
    log.textContent = '';
    $('rundlg-done').hidden = true;
    $('rundlg-retry').hidden = true;
    $('rundlg-cancel').hidden = false;
    $('rundlg-cancel').textContent = 'Cancel';
    keepOpen($('rundlg'));
    if (!$('rundlg').open) $('rundlg').showModal();
    // What it would do has to be read before it can be asked: loading till then.
    if (typeof asking === 'function') {
      // A look, over in seconds: nothing to press while it reads.
      runDlgStatus(checking || 'Checking\u2026');
      $('rundlg-busy').hidden = false;
      $('rundlg-cancel').hidden = true;
      let c;
      try { c = await asking(); } catch (e) { c = { error: String((e && e.message) || e) }; }
      $('rundlg-busy').hidden = true;
      if (!$('rundlg').open) return false;          // cancelled while it read
      if (c.error) {
        runDlgStatus(c.error, 'bad');
        runDlgRetry = () => runInDialog(opts);
        $('rundlg-retry').hidden = false;
        $('rundlg-cancel').hidden = true;
        $('rundlg-done').hidden = false;
        $('rundlg-done').textContent = 'Close';
        return false;
      }
      asking = c;
      $('rundlg-cancel').hidden = false;
    }
    $('rundlg-status').textContent = asking.body;
    $('rundlg-status').className = 'dlg-sub whitespace-pre-line mb-space-md';
    go.hidden = false;
    go.textContent = asking.yes || 'Continue';
    go.className = 'btn ' + (asking.danger ? 'btn-danger' : 'btn-primary');
    go.disabled = !!asking.word;
    if (asking.word) {
      wordRow.hidden = false;
      $('rundlg-word-label').textContent = `Type ${asking.word} to confirm`;
      word.value = '';
      word.oninput = () => { go.disabled = word.value.trim() !== asking.word; };
      word.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); if (!go.disabled) go.click(); } };
      word.focus();
    // Enter on a destructive ask is Cancel: the safe answer is the default.
    } else (asking.danger && !$('rundlg-cancel').hidden ? $('rundlg-cancel') : go).focus();
    const yes = await new Promise(resolve => {
      runDlgConfirm = resolve;
      go.onclick = e => { e.preventDefault(); if (!go.disabled) resolve(true); };
    });
    runDlgConfirm = null;
    go.hidden = true;
    wordRow.hidden = true;
    go.disabled = false;
    if (!yes) return false;
  }
  runSurface = { link: 'rundlg-link', log: 'rundlg-log', status: runDlgStatus };
  runDlgRetry = () => runInDialog({ title, args, starting, done, fail, close, stoppable, after, typed });
  $('rundlg-done').hidden = true;
  $('rundlg-done').textContent = 'Done';
  $('rundlg-retry').hidden = true;
  $('rundlg-cancel').hidden = !stoppable;
  log.textContent = '';
  // The first line ayis sends replaces the placeholder rather than appending
  // under it - see the collect handler.
  log.dataset.fresh = 'yes';
  runDlgStatus(starting);
  $('rundlg-busy').hidden = false;
  keepOpen($('rundlg'));
  if (!$('rundlg').open) $('rundlg').showModal();
  if (typed) typedPending = typed;
  const { rc, err } = await runAyis(args, { collect: 'rundlg-log', wantRc: true,
                                          onStart: id => { runDlgJob = id; } });
  if (typed) typedPending = null;
  runDlgJob = null;
  runDlgRc = rc;
  link.hidden = true;
  $('rundlg-cancel').hidden = true;
  if (rc === 0 && after) {
    // Still loading: done is said once what it changed has been read again.
    runDlgStatus('Updating…');
    try { await after(err || ''); } catch { /* the screens say what they could not read */ }
  }
  $('rundlg-busy').hidden = true;
  if (rc === 0) {
    // Everything behind the dialog has already re-read: these are writes.
    runDlgStatus(typeof done === 'function' ? done(err || '') : done, 'ok');
    const shut = !!(close && close(err || ''));
    // Done: a tick lands - then a beat and the dialog goes by itself, or it
    // waits for Done.
    $('rundlg-status').prepend(el('span', 'onb-tick text-primary mr-space-xs', '\u2713'));
    if (shut) {
      afterBeat(() => closeDialog($('rundlg')));
    } else {
      $('rundlg-done').hidden = false;
      $('rundlg-done').focus();
    }
    return true;
  }
  runDlgStatus(rc === null ? 'Another task is running.'
                           : (typeof fail === 'function' ? fail(rc) : fail), 'bad');
  $('rundlg-retry').hidden = false;
  $('rundlg-done').hidden = false;
  $('rundlg-done').textContent = 'Close';
  return false;
}
$('rundlg-done').onclick = e => { e.preventDefault(); closeDialog($('rundlg')); };
// Closed while it is still asking: a no.
// The close event is queued: one that lands after the dialog was opened again
// to ask afresh is not a no to that.
$('rundlg').addEventListener('close', () => { if (runDlgConfirm && !$('rundlg').open) runDlgConfirm(false); });
$('rundlg-retry').onclick = e => { e.preventDefault(); if (runDlgRetry) runDlgRetry(); };
// Cancelling has to reach ayis: `tailscale up` is waiting on a browser that is
// never going to answer, and a package manager can be sitting on a lock.
// Closing a dialog does not tell either of them that.
$('rundlg-cancel').onclick = e => {
  e.preventDefault();
  if (runDlgConfirm) runDlgConfirm(false);
  if (runDlgJob !== null) window.ayis.cancel(runDlgJob);
  runDlgJob = null;
  $('rundlg').close();
};
function signInTailscale() {
  return runInDialog({
    title: 'Signing in to Tailscale',
    args: ['creds', 'tailscale', 'signin'],
    starting: 'Starting. A password prompt may open behind this window.',
    done: () => (tskeyNow && tskeyNow.node) ? `signed in as ${tskeyNow.node}` : 'signed in',
    fail: rc => 'Sign-in failed.',
  });
}
$('tskey-signin-go').onclick = signInTailscale;

// The link, lifted out of whatever ayis relayed. Only this host, and the main
// process checks it again before anything opens.
// A sign-in waiting on a browser is login.tailscale.com/a/<code>, as
// `tailscale up` prints it. Not any page there: a delete that tells you where to
// remove old devices by hand (/admin/...) is not a sign-in to wait for.
const SIGNIN_RE = /https:\/\/login\.tailscale\.com\/a\/[^\s]+/;
// Where the words of the run in flight go. Two surfaces now: the dialog, for a
// run you asked for from a card, and the first-run pipeline's pane. The link
// has to appear on whichever one is in front of you.
let runSurface = { link: 'rundlg-link', log: 'rundlg-log', status: runDlgStatus };
function watchForSignInLink(text) {
  const m = SIGNIN_RE.exec(text || '');
  if (!m) return;
  const link = $(runSurface.link);
  link.hidden = false;
  link.onclick = () => window.ayis.openSignIn(m[0]);
  // What is being waited for, in words: the command is not stuck, it is
  // waiting for a browser - and that distinction is the whole dialog.
  runSurface.status('Complete sign-in in your browser.');
}

// Same shape as the AWS form, for the same reasons: one field, one Save, the
// answer checked before it is believed, and the failure shown here.
// Asking AWS for quota, as four states of one dialog.
//
// The ask is mechanical and free; what gets it approved is the appeal on the
// case it opens, which is a letter to a person - so this drafts it and sending
// it is yours. The Support API could not post it anyway without a Business
// plan.
//
// AWS has five words for where a request stands and they mean quite different
// things. DENIED in particular is not the end: every quota this account holds
// was granted on appeal rather than on the first ask.
const QUOTA_STATE = {
  PENDING: ['Sent',
            'Submitted. It appears within a few minutes.'],
  CASE_OPENED: ['Being reviewed',
            'First requests are usually denied. Reply with the text below to get a manual review (2-4 days).'],
  DENIED: ['Denied',
            'Reply to the case with the text below to request a review.'],
  CASE_CLOSED: ['Closed',
            'Closed without an increase. Submit a new request.'],
  APPROVED: ['granted',
            'May take up to an hour to appear.'],
};
let quotaNow = null, quotaKind = '', quotaAppeal = '', quotaCase = null, quotaWhere = '';

const quotaCaseUrl = id => `https://console.aws.amazon.com/support/home#/case/?displayId=${id}`;

function quotaClear() {
  $('quota-state').textContent = '';
  $('quota-explain').textContent = '';
  $('quota-pre-label').hidden = true;
  $('quota-pre-label').textContent = '';
  $('quota-log').textContent = '';
  $('quota-case-row').hidden = true;
  $('quota-case-url').textContent = '';
  $('quota-copy').textContent = 'Copy reply';
  quotaAppeal = '';
  quotaCase = null;
}

// Reading, and saying so: the controls are dead while it reads, because a
// second Refresh on top of the first answers the first one's question.
function quotaBusy(on) {
  $('quota-where').disabled = on;
  $('quota-kind').disabled = on;
  $('quota-refresh').disabled = on;
  $('quota-go').disabled = on || $('quota-go').disabled;
  $('quota-refresh').textContent = on ? 'Reading\u2026' : 'Refresh';
}

function quotaSay(state, explain, tone) {
  $('quota-state').textContent = state;
  $('quota-state').className = 'font-code-md text-code-md mt-space-md '
    + (tone === 'bad' ? 'text-error' : tone === 'ok' ? 'text-on-surface' : 'text-on-surface-variant');
  $('quota-explain').textContent = explain || '';
}

// One read answers everything the dialog shows: the applied value, whether it
// covers a box, and where the last request stands.
const quotaCmd = (...rest) => (quotaWhere ? ['--region', quotaWhere, ...rest] : rest);

async function quotaRead() {
  const out = await runAyis(quotaCmd('quota', '--json'), { capture: true });
  try { quotaNow = JSON.parse(out); } catch { quotaNow = null; }
  $('quota-region').textContent = quotaNow ? quotaNow.region : '';
  return quotaNow;
}

async function quotaRender() {
  const kind = quotaKind;
  $('quota-case-row').hidden = true;
  $('quota-pre-label').hidden = true;
  $('quota-log').textContent = '';
  $('quota-refresh').hidden = !kind;
  $('quota-refresh').disabled = false;
  $('quota-kind').disabled = false;
  $('quota-where').disabled = false;
  $('quota-go').hidden = false;
  $('quota-go').disabled = true;
  $('quota-go').textContent = 'Submit request';
  if (!kind) {
    quotaSay('', 'Select a quota.');
    return;
  }
  const q = (quotaNow || {})[kind];
  if (!q) { quotaSay('Could not read this quota', '', 'bad'); return; }
  const need = quotaNow.vcpus_needed, type = quotaNow.instance_type;

  // Nothing to ask for. Offering the button here gets a duplicate refused.
  if (q.enough) {
    quotaSay(`Current quota covers one ${type}`, 'No increase needed.', 'ok');
    $('quota-go').hidden = true;
    return;
  }

  const r = q.request;
  if (r && r.status && r.status !== 'APPROVED') {
    const [head, why] = QUOTA_STATE[r.status] || [r.status.toLowerCase().replace(/_/g, ' '), ''];
    const when = (r.created || '').slice(0, 10);
    const moved = (r.last_updated || '').slice(0, 10);
    quotaSay(`\u25cf ${head}${when ? ' \u00b7 asked ' + when : ''}${r.desired ? ' \u00b7 ' + r.desired + ' vCPU' : ''}`
             + (moved && moved !== when ? ` \u00b7 AWS last moved it ${moved}` : ''),
             why, r.status === 'DENIED' || r.status === 'CASE_CLOSED' ? 'bad' : '');
    quotaCase = r.case_id || null;
    $('quota-case-row').hidden = false;
    $('quota-case').hidden = !quotaCase;
    $('quota-case-url').textContent = quotaCase ? quotaCaseUrl(quotaCase) : 'Not available yet. Refresh shortly.';
    // A closed case cannot be appealed, so asking again is the only way on.
    $('quota-go').hidden = r.status !== 'CASE_CLOSED';
    $('quota-go').disabled = r.status !== 'CASE_CLOSED';
    if (r.status === 'CASE_CLOSED') $('quota-go').textContent = 'Resubmit';
    const appeal = await runAyis(quotaCmd('quota', 'appeal', kind), { capture: true });
    quotaAppeal = (appeal || '').trim();
    $('quota-copy').hidden = !quotaAppeal;
    if (quotaAppeal) {
      $('quota-pre-label').hidden = false;
      $('quota-pre-label').textContent = 'If denied, reply with:';
      $('quota-log').textContent = quotaAppeal;
    }
    return;
  }

  // Nothing asked for yet: say exactly what the case would contain.
  quotaSay(`Quota: ${q.value === null ? 'unknown' : q.value} vCPU. One ${type} needs ${need}.`, '');
  $('quota-pre-label').hidden = false;
  $('quota-pre-label').textContent = 'Request:';
  $('quota-log').textContent =
      `Service:    EC2 Instances\n`
    + `Region:     ${quotaNow.region}\n`
    + `Quota:      ${kind === 'spot' ? 'Spot GPU instances' : 'On-demand GPU instances'}\n`
    + `New value:  ${need} vCPU (one instance)\n\n`
    + `No charge. First requests are usually denied; reply to the case for a review.`;
  $('quota-go').disabled = false;
}

function quotaWhereOptions(selected) {
  const sel = $('quota-where');
  const cfg = (config || []).find(r => r.key === 'GAME_REGION');
  const current = (cfg && (cfg.value || cfg.default)) || (machinesNow && machinesNow.region) || '';
  const seen = new Set();
  sel.textContent = '';
  const add = (code, label) => {
    if (!code || seen.has(code)) return;
    seen.add(code);
    const o = document.createElement('option');
    o.value = code;
    o.textContent = label || code;
    sel.append(o);
  };
  add(current, current ? `${current} (current)` : '');
  for (const r of (sweepNow && sweepNow.regions) || []) {
    if (r.enabled === false) continue;   // no quota to ask for until it is on
    add(r.region, `${r.region} - ${shortCity(r.city)}`);
  }
  sel.value = selected && seen.has(selected) ? selected : current;
  quotaWhere = sel.value;
}

async function openQuota(kind, where) {
  quotaKind = kind || '';
  quotaWhereOptions(where);
  // Cleared BEFORE the dialog is shown, not after the read comes back: what
  // was on it is an answer about the last thing you asked, and showing it for
  // half a second under a new question is worse than showing nothing.
  quotaClear();
  $('quota-kind').value = quotaKind;
  $('quota-title').textContent = 'Ask AWS for a higher GPU limit';
  $('quota-go').hidden = false;
  $('quota-go').disabled = true;
  $('quota-refresh').hidden = true;
  quotaBusy(true);
  quotaSay('reading\u2026', '');
  if (!$('quota').open) $('quota').showModal();
  await quotaRead();
  quotaBusy(false);
  await quotaRender();
}

$('quota-where').onchange = async () => {
  quotaWhere = $('quota-where').value;
  quotaClear();
  quotaBusy(true);
  quotaSay('reading\u2026', '');
  await quotaRead();
  quotaBusy(false);
  await quotaRender();
};
$('quota-kind').onchange = async () => {
  quotaKind = $('quota-kind').value;
  quotaClear();
  quotaBusy(true);
  quotaSay('reading\u2026', '');
  await quotaRender();
  quotaBusy(false);
};
$('quota-refresh').onclick = async e => {
  e.preventDefault();
  if ($('quota-refresh').disabled) return;
  quotaClear();
  quotaBusy(true);
  quotaSay('reading\u2026', '');
  await quotaRead();
  await quotaRender();
  quotaBusy(false);
};
$('quota-cancel').onclick = e => { e.preventDefault(); $('quota').close(); };
$('quota-copy').onclick = async e => {
  e.preventDefault();
  try { await navigator.clipboard.writeText(quotaAppeal); $('quota-copy').textContent = 'Copied'; }
  catch { $('quota-copy').textContent = 'Select it below and copy'; }
};
$('quota-case').onclick = e => {
  e.preventDefault();
  if (quotaCase) window.ayis.openSignIn(quotaCaseUrl(quotaCase));
};
$('quota-go').onclick = async e => {
  e.preventDefault();
  if (!quotaKind) return;
  $('quota-go').disabled = true;
  $('quota-go').textContent = 'Creating\u2026';
  $('quota-kind').disabled = true;
  quotaSay('Submitting\u2026', '');
  $('quota-pre-label').hidden = true;
  const { rc, err } = await runAyis(quotaCmd('quota', 'request', quotaKind), { wantRc: true });
  $('quota-kind').disabled = false;
  if (rc !== 0) {
    quotaSay('Request not submitted', (err || '').trim().split('\n')[0]
      || '', 'bad');
    $('quota-log').textContent = (err || '').trim();
    $('quota-go').disabled = false;
    $('quota-go').textContent = 'Submit request';
    return;
  }
  // Read it back rather than believing the submit: the case id lags the
  // request by up to a minute, and the status is AWS's to report.
  await quotaRead();
  await quotaRender();
  if (!quotaCase) {
    $('quota-case-row').hidden = false;
    $('quota-case-url').textContent = 'Not available yet. Refresh shortly.';
  }
};

// Turning a region on: one API call, no case, no person - the opposite of a
// quota. What it needs instead is care, because it is account-wide and undoing
// it is slower than doing it.
const OPTIN_STATE = {
  ENABLING: ['enabling', 'In progress. Usually a few minutes.'],
  ENABLED: ['enabled', 'Enabled. Ready to use.'],
  ENABLED_BY_DEFAULT: ['enabled', 'Already enabled.'],
  DISABLING: ['being disabled', 'Being disabled. Wait for it to finish.'],
};
let optinNow = null, optinPick = '';

function optinClear() {
  $('optin-state').textContent = '';
  $('optin-explain').textContent = '';
  $('optin-log').textContent = '';
}
function optinBusy(on) {
  $('optin-pick').disabled = on;
  $('optin-refresh').disabled = on;
  $('optin-refresh').textContent = on ? 'Reading\u2026' : 'Refresh';
  if (on) $('optin-go').disabled = true;
}
function optinSay(state, why, tone) {
  $('optin-state').textContent = state;
  $('optin-state').className = 'font-code-md text-code-md mt-space-md '
    + (tone === 'bad' ? 'text-error' : tone === 'ok' ? 'text-on-surface' : 'text-on-surface-variant');
  $('optin-explain').textContent = why || '';
}

async function optinRead() {
  const out = await runAyis(['regions', 'optin', '--json'], { capture: true });
  try { optinNow = JSON.parse(out); } catch { optinNow = null; }
  return optinNow;
}

// The list is every disabled region, but the ones the sweep has measured come
// first and carry their numbers: "ap-southeast-5 - Malaysia, 48ms, 9/10" is a
// decision, where a bare region code is a guess.
//
// The regions already ON are listed too, in their own group. They were left out
// at first - there is nothing to enable - and that made the dialog unable to
// answer the question people actually bring to it: I enabled Malaysia, the
// table still will not let me pick it, did the enable work? Nothing to enable
// looked exactly like nothing happened. Selecting one now says it is on, and
// what is really in the way.
function optinOptions() {
  const sel = $('optin-pick');
  const seen = new Set();
  sel.textContent = '';
  const first = document.createElement('option');
  first.value = ''; first.textContent = 'Pick one\u2026';
  sel.append(first);
  const measured = new Map();
  for (const r of (sweepNow && sweepNow.regions) || []) measured.set(r.region, r);
  const group = label => {
    const g = document.createElement('optgroup');
    g.label = label;
    sel.append(g);
    return g;
  };
  const add = (into, code, m) => {
    if (seen.has(code)) return;
    seen.add(code);
    const o = document.createElement('option');
    o.value = code;
    const best = m && (m.machines || [])[0];
    o.textContent = m
      ? `${code} - ${shortCity(m.city)}, ${Math.round(m.rtt_ms)}ms`
        + (best ? `, ${best.type} at ${best.score}/10` : '')
      : code;
    into.append(o);
  };
  const off = group('Not enabled');
  for (const code of (optinNow && optinNow.disabled) || []) if (measured.has(code)) add(off, code, measured.get(code));
  for (const code of (optinNow && optinNow.disabled) || []) add(off, code, null);
  for (const code of (optinNow && optinNow.enabling) || []) add(off, code, measured.get(code));
  // Only the measured ones: every account has a dozen enabled by default, and
  // listing all of them would bury the one you came to check.
  const on = group('Enabled');
  for (const r of (optinNow && optinNow.regions) || [])
    if (ON_ALREADY.has(r.status) && measured.has(r.region)) add(on, r.region, measured.get(r.region));
  if (!off.children.length) off.remove();
  if (!on.children.length) on.remove();
}
const ON_ALREADY = new Set(['ENABLED', 'ENABLED_BY_DEFAULT']);

// Why an enabled region is still greyed in the table, said from the sweep. The
// quota is the usual answer: a region you have just enabled starts at 0 vCPU of
// G instances, and the opt-in does not carry any across from another region.
function optinBlocker(code) {
  const m = ((sweepNow && sweepNow.regions) || []).find(r => r.region === code);
  if (!m) return 'Not measured yet. Check all regions under Machine type.';
  const ms = (m.machines || []);
  const fits = ms.filter(x => x.fits_spot || x.fits_ondemand);
  if (fits.length) return `${code} is enabled; ${fits.length} machine type`
    + `${fits.length > 1 ? 's are' : ' is'} available.`;
  if (!ms.length) return `${code} is enabled but offers no supported machine types.`;
  const q = m.quota || {};
  return `${code} is enabled, but its GPU quota is too low:\n`
    + `  on demand  ${q.ondemand_vcpu ?? '?'} vCPU\n`
    + `  spot       ${q.spot_vcpu ?? '?'} vCPU\n`
    + 'New regions start at 0. Request an increase under Machine type.';
}

function optinRender() {
  const code = optinPick;
  $('optin-refresh').hidden = !code;
  $('optin-go').hidden = false;
  $('optin-go').disabled = true;
  $('optin-go').textContent = 'Confirm \u00b7 enable';
  if (!code) {
    optinSay('', 'Select a region.');
    return;
  }
  const row = ((optinNow && optinNow.regions) || []).find(r => r.region === code);
  const status = row && row.status;
  if (status && status !== 'DISABLED') {
    const [head, why] = OPTIN_STATE[status] || [status.toLowerCase(), ''];
    optinSay(`\u25cf ${head}`, why, ON_ALREADY.has(status) ? 'ok' : '');
    $('optin-go').hidden = status !== 'DISABLING';
    // On, and still not pickable: the opt-in is not what is in the way. Say
    // what is, because the next step is a different button.
    if (ON_ALREADY.has(status)) $('optin-log').textContent = optinBlocker(code);
    return;
  }
  const m = ((sweepNow && sweepNow.regions) || []).find(r => r.region === code);
  const best = m && (m.machines || [])[0];
  optinSay(`${code}${m ? ' \u00b7 ' + shortCity(m.city) : ''}`
    + (m ? ` \u00b7 ${Math.round(m.rtt_ms)}ms` : '')
    + (best ? ` \u00b7 ${best.type} at ${best.score}/10` : ''), '');
  $('optin-log').textContent =
      'Applies to the whole AWS account. No charge.\n'
    + '\n'
    + 'Takes a few minutes. Disabling is slow; treat it as permanent.';
  $('optin-go').disabled = false;
}

async function openOptin(code) {
  optinPick = code || '';
  optinClear();
  $('optin-refresh').hidden = true;
  $('optin-go').hidden = false;
  $('optin-go').disabled = true;
  optinBusy(true);
  optinSay('reading\u2026', '');
  if (!$('optin').open) $('optin').showModal();
  await optinRead();
  optinOptions();
  $('optin-pick').value = optinPick;
  optinBusy(false);
  optinRender();
}

$('optin-pick').onchange = () => {
  optinPick = $('optin-pick').value;
  optinClear();
  optinRender();
};
$('optin-cancel').onclick = e => { e.preventDefault(); $('optin').close(); };
$('optin-refresh').onclick = async e => {
  e.preventDefault();
  if ($('optin-refresh').disabled) return;
  optinClear();
  optinBusy(true);
  optinSay('reading\u2026', '');
  await optinRead();
  optinBusy(false);
  optinRender();
};
$('optin-go').onclick = async e => {
  e.preventDefault();
  if (!optinPick) return;
  const code = optinPick;
  $('optin-go').disabled = true;
  $('optin-go').textContent = 'Enabling\u2026';
  optinBusy(true);
  optinSay(`Enabling ${code}\u2026`, 'Takes a few minutes.');
  $('optin-log').textContent = '';
  const { rc, err } = await runAyis(['regions', 'enable', code], { wantRc: true });
  $('optin-log').textContent = (err || '').trim();
  optinBusy(false);
  if (rc !== 0) {
    optinSay('Rejected by AWS', (err || '').trim().split('\n')[0] || '', 'bad');
    $('optin-go').disabled = false;
    $('optin-go').textContent = 'Confirm \u00b7 enable';
    return;
  }
  // Read it back: "asked" is not "usable", and the status is AWS's to report.
  await optinRead();
  optinRender();
};

// One secret, typed once and checked before it is kept: the Tailscale API
// token and the box's own auth key are the same dialog with different words.
// ayis still asks its question - that is the protocol, and both commands work in
// a terminal unchanged - and this answers it from the field.
let oneFieldPending = null;
function oneFieldAnswer(askId) {
  return oneFieldPending && oneFieldPending.askId === askId ? oneFieldPending.value : null;
}
function oneFieldFail(text, go) {
  const box = $('onefield-err');
  box.hidden = false;
  box.textContent = text;
  $('onefield-go').disabled = false;
  $('onefield-go').textContent = go;
  $('onefield-cancel').disabled = false;
  oneFieldPending = null;
}
// `args` is either the command, or a function of the typed value for a command
// that takes it as an argument rather than answering a question - `ayis config
// set` is the second kind. `after` is for those: ayis does not list them as
// running alone, so the window does not count them as writes and nothing
// re-reads by itself.
// `secret` is what the field is for, not how long it is: a key is bulleted
// because it is a credential sitting on screen, an email address is typed
// wrong constantly and must be readable. The field was hard-coded to a
// password because for a while every caller was a key.
// `log` is a step's log in the first-run pipeline, when it was opened from
// there: what ayis said while checking lands under the step, folded.
// `readBack` is the read that shows what was saved, [args, json]: the dialog
// stays, saying so, until it has answered - as the AWS key's does - so it
// closes onto the step already ticked, not onto its button for a moment.
let oneFieldOpens = 0;
function openOneField({ title, note, label, placeholder, args, askId, save = 'Save',
                        working = 'Checking…', strip, after, secret = true, log, readBack }) {
  // Wired straight to onclick in places, which hands over an event, not a log.
  if (typeof log !== 'string') log = undefined;
  // The dialog is shared: a read-back finishing after this one was cancelled
  // and another opened must not close that one.
  const mine = ++oneFieldOpens;
  $('onefield-title').textContent = title;
  $('onefield-note').textContent = note;
  $('onefield-label').textContent = label;
  $('onefield-input').type = secret ? 'password' : 'text';
  $('onefield-input').value = '';
  $('onefield-input').placeholder = placeholder || '';
  $('onefield-err').hidden = true;
  $('onefield-err').textContent = '';
  $('onefield-go').disabled = false;
  $('onefield-go').textContent = save;
  $('onefield-cancel').disabled = false;
  $('onefield-go').onclick = async e => {
    e.preventDefault();
    const value = $('onefield-input').value.trim();
    if (!value) return oneFieldFail('Required.', save);
    const argv = typeof args === 'function' ? args(value) : args;
    if (askId) oneFieldPending = { askId, value };
    $('onefield-err').hidden = true;
    $('onefield-go').disabled = true;
    $('onefield-go').textContent = working;
    // Closing does not stop ayis: the value would be saved behind a Cancel, or
    // ayis would ask for it again in a popup of its own. A few seconds; wait.
    $('onefield-cancel').disabled = true;
    const { rc, err } = await runAyis(argv, { wantRc: true, collect: log });
    oneFieldPending = null;
    if (rc === 0) {
      $('onefield-go').textContent = 'Saved. Checking\u2026';
      if (after) await after();
      if (readBack) await readFresh(...readBack);
      if (mine === oneFieldOpens) closeDialog($('onefield'));
      return;
    }
    // ayis's own words, minus the lines that only say where to make one - you
    // are holding one.
    oneFieldFail((err || `ayis ${argv.join(' ')} exited ${rc}`).split('\n')
      .filter(l => l.trim() && !(strip && l.includes(strip)))
      .join('\n').trim() || `ayis ${argv.join(' ')} exited ${rc}`, save);
  };
  // Opened again while the last one is still fading out: keep it, not a throw.
  keepOpen($('onefield'));
  if (!$('onefield').open) $('onefield').showModal();
  $('onefield-input').focus();
}
$('onefield-cancel').onclick = e => {
  e.preventDefault();
  oneFieldPending = null;
  $('onefield').close();
};

function openTskey(log) {
  openOneField({ log,
    title: 'Tailscale access token',
    note: 'login.tailscale.com → Settings → Keys → Generate access token. '
        + 'Each AWS build checks the machine\'s auth key with it first.',
    label: 'Access token', placeholder: 'tskey-api-…',
    args: ['creds', 'set', 'tailscale'], askId: ASK.tsToken,
    readBack: [['creds', 'tailscale', '--json'], 'tskey'],
    save: 'Save token', working: 'Checking with Tailscale…',
    strip: 'Tailscale API token (NOT',
  });
}

// The box's own key, pasted. Only needed when the API token cannot make one -
// a tailnet whose ACLs want tags, or no token at all - so the button appears
// only then, and the dialog says what kind of key to make.
function setAuthKey(log) {
  openOneField({
    title: 'Tailscale auth key',
    note: 'login.tailscale.com \u2192 Settings \u2192 Keys \u2192 Generate auth key. '
        + 'Reusable on, Ephemeral off.'
        + '',
    label: 'Auth key', placeholder: 'tskey-auth-…', log,
    args: ['creds', 'tailscale', 'authkey'], askId: ASK.tsAuthKey,
    readBack: [['creds', 'tailscale', '--json'], 'tskey'],
    save: 'Save key', working: 'Checking with Tailscale…',
    strip: 'Machine key',
  });
}

// Where the billing alert goes, asked where it is needed. It is one line of
// text and ayis validates it, so it is the same dialog as the keys - and the
// alternative was sending someone to Settings to find the row and edit it in
// place, which is the detour the key stage used to make.
//
// Not a secret, and not an ask either: `ayis config set` takes the value as an
// argument, validates it against the registry rule and writes .env.
function openAlertEmail(log) {
  openOneField({
    title: 'Budget alert email',
    note: 'Notified when spending passes the budget. Separate multiple addresses with commas.',
    label: 'Email', placeholder: 'you@example.com', secret: false, log,
    args: v => ['config', 'set', 'EMAIL_ALERTS', v],
    save: 'Save address', working: 'Saving\u2026',
    // `ayis config set` is not a command ayis says runs alone, so no re-read
    // follows it on its own: the stage would stay exactly as it was.
    after: () => runAyis(['config', '--json'], { json: 'config' }),
  });
}

// The AWS key, as one form: both halves, one Save, the answer checked with AWS
// before anything is written, and the failure shown HERE rather than in a log
// pane behind the dialog.
let awsKeyPending = null;
let awsKeyLog = null;     // a pipeline step's log, when it was opened from there
function awsKeyAnswer(askId) {
  if (!awsKeyPending) return null;
  if (askId === ASK.awsId) return awsKeyPending.id;
  if (askId === ASK.awsSecret) return awsKeyPending.secret;
  return null;
}
function openAwsKey(log) {
  awsKeyLog = typeof log === 'string' ? log : null;
  $('awskey-id').value = '';
  $('awskey-secret').value = '';
  $('awskey-err').hidden = true;
  $('awskey-err').textContent = '';
  $('awskey-go').disabled = false;
  $('awskey-go').textContent = 'Connect';
  $('awskey-cancel').disabled = false;
  keepOpen($('awskey'));
  if (!$('awskey').open) $('awskey').showModal();
  $('awskey-id').focus();
}
function awsKeyFail(text) {
  const box = $('awskey-err');
  box.hidden = false;
  box.textContent = text;
  $('awskey-go').disabled = false;
  $('awskey-go').textContent = 'Connect';
  $('awskey-cancel').disabled = false;
  awsKeyPending = null;
}
$('awskey-cancel').onclick = e => { e.preventDefault(); awsKeyPending = null; $('awskey').close(); };
$('awskey-go').onclick = async e => {
  e.preventDefault();
  const id = $('awskey-id').value.trim(), secret = $('awskey-secret').value.trim();
  if (!id || !secret) return awsKeyFail('Access key ID and secret are both required.');
  awsKeyPending = { id, secret };
  $('awskey-err').hidden = true;
  $('awskey-go').disabled = true;
  $('awskey-go').textContent = 'Checking with AWS\u2026';
  // As the one-field dialog: closing would not stop ayis saving the key.
  $('awskey-cancel').disabled = true;
  const { rc, err } = await runAyis(['creds', 'set'], { wantRc: true, collect: awsKeyLog });
  awsKeyPending = null;
  if (rc === 0) {
    // Saved. The dialog stays until the key has been read back, so what it
    // closes onto already shows it - not, for a moment, Connect AWS again.
    $('awskey-go').textContent = 'Connected. Checking\u2026';
    await readFresh(['creds', '--json'], 'creds');
    closeDialog($('awskey'));
    return;
  }
  // ayis's own words, minus the line that only tells you where to find a key -
  // you are holding one.
  awsKeyFail((err || 'Could not save the key.').split('\n')
    .filter(l => l.trim() && !l.startsWith('AWS credentials: paste'))
    .join('\n').trim() || 'Could not save the key.');
};

function setCreds() { openAwsKey(); }

// "1" means nothing to a person: a choice shows what it chose.
const CHOICE_LABEL = {
  GAME_SPOT: { '1': 'Spot', '0': 'On-demand', auto: 'Spot, else on-demand' },
  GAME_STEAM_LOGIN: { use: 'Use the saved login', fresh: 'Ask me to sign in' },
};
const choiceLabel = (key, v) => (CHOICE_LABEL[key] || {})[v] || v;

function settingValue(r) {
  if (r.secret) return r.is_set ? 'Set' : 'Not set';
  if (r.value != null) return choiceLabel(r.key, r.value);
  if (r.default != null) return `${choiceLabel(r.key, r.default)} (default)`;
  return 'Not set';
}

// Settings: only what this page sets (SETTINGS_CARDS). Every rule and value is
// ayis's; the names and the cards are the app's.
function paintConfig(rows) {
  paintOnboardSoon();
  config = rows;
  // Which machines there are is read from the settings (a region chosen is
  // an AWS machine), so Home and its cards follow them.
  paintHome();
  paintDash();
  paintBuildLogin();
  if (watcher) paintGuards(watcher);
  const wrap = $('s-groups');
  if (!wrap) return;
  wrap.textContent = '';
  for (const [title, note, keys] of SETTINGS_CARDS) {
    const present = keys.map(k => rows.find(r => r.key === k)).filter(Boolean);
    if (!present.length) continue;
    const card = document.createElement('div');
    card.className = 'p-space-lg rounded-xl bg-surface-container-low';
    card.dataset.title = title;
    const head = document.createElement('div');
    head.className = 'pb-space-sm';
    const h = document.createElement('span');
    h.className = 'section-label';
    h.textContent = title;
    head.append(h);
    if (note) head.append(Object.assign(document.createElement('p'),
      { className: 'font-code-sm text-code-sm text-outline mt-0.5', textContent: note }));
    card.append(head);
    for (const r of present) card.append(settingRow(r));
    wrap.append(card);
  }
  settingsForAws();
}

// What only AWS needs, in Settings: the AWS key, the machine's disk. Applied
// after the cards are drawn as well as when AWS comes or goes - paintConfig
// redraws the disk card after Home has run this, and it came back shown.
function settingsForAws(aws = awsAdded()) {
  if ($('s-creds-card')) $('s-creds-card').hidden = !aws;
  const disk = settingEl('GAME_DISK_GB');
  if (disk && disk.parentElement) disk.parentElement.hidden = !aws;
  paintSettingsNav();
}

// Settings' sections, down its side: one per card on the page, in its order,
// each scrolling to its card - and Alerts, which are Safety's to set, going
// there rather than being copied here. The one marked is the card at the top
// of the view, whatever brought it there.
function paintSettingsNav() {
  const nav = $('s-nav');
  if (!nav) return;
  // Rebuilt only when the cards change: every status read passes through
  // here, and a rebuilt button loses the keyboard's focus.
  const sig = settingsCards().map(c => c.dataset.title).join('\n');
  // Alerts and auto-stop are AWS's: with only your own machines there is
  // nothing for them to watch, so the link is not there to follow.
  const alertsLink = () => { const a = nav.querySelector('.alerts-link'); if (a) a.hidden = !awsAdded(); };
  if (nav.dataset.sig === sig) { alertsLink(); return markSettingsNav(); }
  nav.dataset.sig = sig;
  nav.textContent = '';
  for (const c of settingsCards()) {
    const b = el('button', 'side-item', c.dataset.title);
    b.dataset.title = c.dataset.title;
    b.onclick = () => {
      settingsPicked = c.dataset.title;
      c.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      markSettingsNav();
    };
    nav.append(b);
  }
  const alerts = el('button', 'side-item', 'Alerts and auto-stop \u2192');
  alerts.onclick = () => document.querySelector('.nav-item[data-view=guards]').click();
  alerts.classList.add('alerts-link');
  nav.append(alerts);
  alertsLink();
  markSettingsNav();
}
// The cards, not the list's own buttons, and only those shown.
const settingsCards = () => [...document.querySelectorAll('section[data-view=settings] [data-title]:not(.side-item)')]
  .filter(c => !c.hidden);
// The section last clicked: a card near the bottom cannot scroll to the top,
// so with the page as far down as it goes, the click says which is meant.
let settingsPicked = null;
function markSettingsNav() {
  if (view !== 'settings') return;
  const cards = settingsCards();
  // The last card whose top has reached its scroll margin - the line a jump
  // to it stops on - and the first when none has.
  const line = cards.length ? parseFloat(getComputedStyle(cards[0]).scrollMarginTop) + 1 : 0;
  const bottom = scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
  const picked = bottom && cards.find(c => c.dataset.title === settingsPicked);
  const atTop = picked || cards.filter(c => c.getBoundingClientRect().top <= line).pop() || cards[0];
  for (const b of $('s-nav').children)
    b.classList.toggle('on', !!atTop && b.dataset.title === atTop.dataset.title);
}
// Once a frame at most, however fast the scroll events come.
let settingsMarkQueued = false;
addEventListener('scroll', () => {
  if (settingsMarkQueued || view !== 'settings') return;
  settingsMarkQueued = true;
  requestAnimationFrame(() => { settingsMarkQueued = false; markSettingsNav(); });
}, { passive: true });

// What only Settings sets. The rest of ayis's settings each have one home on the
// page they are about - the machine on Build, the guards and alerts on Guards,
// how long games are kept on Library - and three copies of one setting is how
// this page used to read.
const SETTINGS_CARDS = [
  ['Stream', 'Applied per session. Moonlight settings are not changed.',
   ['GAME_RES', 'GAME_FPS', 'GAME_BITRATE_KBPS']],
  ['Machine disk', '', ['GAME_DISK_GB']],
];
// The names a person uses; ayis's own labels are for the terminal.
const PLAIN = { GAME_RES: 'Resolution', GAME_FPS: 'Frame rate', GAME_BITRATE_KBPS: 'Quality',
                GAME_DISK_GB: 'System disk',
                GAME_BUDGET_INR: 'Monthly budget', EMAIL_ALERTS: 'Alert email',
                GAME_MAX_HOURS_MONTH: 'Play hours a month', GAME_MAX_SESSION_HOURS: 'Session limit',
                GAME_WATCHDOG_IDLE_MIN: 'Stop after idle', GAME_WATCHDOG_STUCK_MIN: 'Force stop after',
                GAME_NTFY_URL: 'Phone alerts' };
const PLAIN_NOTE = {
  GAME_RES: 'e.g. 1920x1080. Empty uses Moonlight default.',
  GAME_DISK_GB: 'Applies at next build. Cannot be reduced later.',
  GAME_BUDGET_INR: 'Emails at 80%. Once spent, the machine switches off and cannot start until you unblock it or the month ends.',
  GAME_MAX_HOURS_MONTH: 'Switches the machine off when the month\'s hours are used, even mid-game. 0 turns it off.',
  GAME_MAX_SESSION_HOURS: 'Switches the machine off this long after it starts, even mid-game. 0 turns it off.',
  EMAIL_ALERTS: 'Comma-separated.',
  GAME_WATCHDOG_IDLE_MIN: 'Idle time before auto-stop.',
  GAME_WATCHDOG_STUCK_MIN: 'Forces a stuck shutdown after this long.',
  GAME_NTFY_URL: 'ntfy topic. Empty disables phone alerts.',
};
// The value, said the way the row means it.
function plainValue(r) {
  const v = r.value != null ? r.value : r.default;
  if (r.key === 'GAME_RES') return v || 'Default';
  if (r.key === 'GAME_FPS') return v ? `${v} fps` : '—';
  if (r.key === 'GAME_DISK_GB') return v ? `${v} GB` : '—';
  if (r.key === 'GAME_BITRATE_KBPS') {
    if (!v) return '—';
    const gbHour = (Number(v) * 3600) / 8 / 1e6;
    const rate = (statusNow && statusNow.rates) || {};
    const inr = inrRate();
    const after = rate.egress_gb && isFinite(inr) ? `, then ${rs(gbHour * rate.egress_gb * inr)}/hour` : '';
    return `${(Number(v) / 1000).toFixed(0)} Mbps · about ${gbHour.toFixed(1)} GB an hour`
      + (rate.egress_free_gb ? ` · first ${rate.egress_free_gb} GB/month free${after}` : '');
  }
  return settingValue(r);
}

// The three settings the chooser table owns. They are one decision, so they
// have one control - see chooseMachine.
const CHOSEN_IN_TABLE = new Set(['GAME_REGION', 'GAME_INSTANCE_TYPE', 'GAME_SPOT']);

// One row: what it is, what it is for, what it says now, and how to change it.
function settingRow(r) {
  const row = document.createElement('div');
  // Wraps rather than squeezes: a narrow card - a 1000px window, the sidebar
  // beside it - put the value and its button on a line of their own, at the
  // right where every row's button is, instead of crushing the label to 62px
  // and pushing Edit past the card's edge.
  row.className = 'row flex-wrap border-b border-surface-variant/40 items-start';
  row.dataset.key = r.key;          // so anything can send you to this one row

  const left = document.createElement('div');
  left.className = 'min-w-[12rem] flex-1';
  const name = document.createElement('p');
  name.className = 'font-code-md text-code-md';
  name.textContent = PLAIN[r.key] || label(r);
  const note = document.createElement('p');
  note.className = 'font-code-sm text-code-sm text-outline mt-0.5';
  note.textContent = PLAIN[r.key] ? (PLAIN_NOTE[r.key] || '') : r.note;
  left.append(name, note);

  const right = document.createElement('div');
  right.className = 'flex items-center gap-space-sm min-w-0 max-w-full ml-auto';
  const val = document.createElement('span');
  // Anywhere: two addresses joined by a comma are one word to the browser,
  // and break-words would not break it.
  val.className = 'font-code-md text-code-md text-right max-w-[22rem] min-w-0 [overflow-wrap:anywhere] '
    + (r.is_set ? 'text-on-surface-variant' : 'text-outline');
  val.textContent = plainValue(r);

  // Region, machine and purchase model are chosen in the table above, together.
  // Editing them one at a time is what made this confusing: three controls for
  // one decision, and two of the three combinations they can produce cannot
  // launch. The value is still shown here - it is still a setting - but there
  // is exactly one place to change it.
  // ...but only while the table can actually offer something. With no scan and
  // a failing `ayis machines` - no credentials, no aws binary - the table is
  // empty, and locking the only other way to set a region would leave no way at
  // all. Then the plain editor comes back.
  if (CHOSEN_IN_TABLE.has(r.key) && !chooserDead()) {
    const where = document.createElement('span');
    where.className = 'font-code-sm text-code-sm text-outline';
    where.textContent = 'set under Machine';
    right.append(val, where);
    row.append(left, right);
    return row;
  }

  const edit = document.createElement('button');
  edit.className = 'btn';
  edit.textContent = r.secret && r.is_set ? 'Replace' : 'Edit';
  edit.onclick = () => editSetting(r, row);

  if (r.secret && r.is_set) {
    // Secrets are withheld everywhere else. Showing one is a deliberate act,
    // so it takes a click, asks ayis for it, and hides again.
    const eye = document.createElement('button');
    eye.className = 'btn';
    eye.title = 'Show the value';
    const glyph = document.createElement('span');
    glyph.className = 'material-symbols-outlined text-[16px]';
    glyph.textContent = ICON.visibility;
    eye.append(glyph);
    let shown = false;
    eye.onclick = async () => {
      if (shown) {
        val.textContent = settingValue(r);
        glyph.textContent = ICON.visibility;
        shown = false;
        return;
      }
      const out = await runAyis(['config', 'get', r.key], { capture: true });
      val.textContent = out === undefined ? `Not read: ${busyWhy()}` : out.trim() || '(empty)';
      glyph.textContent = ICON.visibility_off;   // click again to hide it
      shown = true;
    };
    right.append(val, eye, edit);
  } else {
    right.append(val, edit);
  }
  row.append(left, right);
  return row;
}

function editSetting(r, row) {
  const right = row.lastElementChild;
  // Kept, so Cancel can put the row back as it was: nothing changed, so
  // nothing needs reading again.
  const was = [...right.childNodes];
  right.textContent = '';
  row.classList.add('editing');
  let input;
  if (r.kind === 'choice') {
    input = document.createElement('select');
    for (const opt of (r.rule || '').split(',')) {
      const o = document.createElement('option');
      o.value = opt; o.textContent = choiceLabel(r.key, opt);
      input.append(o);
    }
    input.value = r.value || r.default || 'auto';
  } else {
    input = document.createElement('input');
    input.type = r.secret ? 'password' : (r.kind === 'number' ? 'number' : 'text');
    if (r.kind === 'number' && r.rule) input.min = r.rule;
    input.value = r.secret ? '' : (r.value || '');
    input.placeholder = r.secret
      ? (r.is_set ? 'Type a new value, or leave empty to clear' : 'Leave empty to go without')
      : (r.default || '');
  }
  input.className = 'bg-surface border border-surface-variant rounded px-space-sm py-0.5 '
                  + 'font-code-md text-code-md text-on-surface min-w-0 '
                  + 'w-64';
  const save = document.createElement('button');
  save.className = 'btn btn-primary'; save.textContent = 'Save';
  const cancel = document.createElement('button');
  cancel.className = 'btn'; cancel.textContent = 'Cancel';
  cancel.onclick = () => {
    right.replaceChildren(...was);
    row.classList.remove('editing');
    const reply = row.querySelector('.edit-reply');
    if (reply) reply.remove();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); cancel.click(); } });
  save.onclick = async () => {
    const value = input.value.trim();
    if (r.secret && !value && r.is_set && !(await askConfirm({
          title: `Clear ${label(r)}?`,
          body: 'The value is removed and will not be asked for again.',
          yes: 'Clear', danger: true,
        }))) return;
    save.disabled = true;
    // ayis's answer goes where the row is: Settings has its panel for it, and
    // anywhere else it goes under the row - a refusal sent to another page
    // read as a save that did nothing.
    let reply = row.querySelector('.edit-reply');
    if (!reply) {
      reply = document.createElement('pre');
      reply.id = 'edit-reply';
      reply.className = 'edit-reply font-code-sm text-code-sm whitespace-pre-wrap text-error mt-space-xs';
      row.firstElementChild.append(reply);
    }
    reply.textContent = '';
    const { rc } = await runAyis(['config', 'set', r.key, value], { collect: 'edit-reply', wantRc: true });
    if (rc !== 0) { save.disabled = false; input.focus(); return; }
    // refresh() re-reads config, machines AND regions for this screen, so a new
    // region repaints the Build picker too - different regions rent different
    // machines, and the type in force may not exist in the one just chosen.
    await refresh();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
  right.append(input, save, cancel);
  input.focus();
}
