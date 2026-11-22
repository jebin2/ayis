'use strict';
// Moving around with a game controller, and the start-up reads.
// One of the renderer's scripts, loaded in order by index.html into one shared scope
// (docs/architecture.md, "The app").

// ── A controller ────────────────────────────────────────────────────────────
//
// The app from the sofa: the D-pad or left stick moves between what can be
// pressed, nearest in that direction on screen; A presses it; B leaves a popup
// by its own Cancel or Close - never around it, so a popup that holds you while
// a step runs holds you here too - or, with none open, goes Home; LB and RB
// change page; the right stick scrolls. An open popup is the whole screen.
//
// Read only while this window has focus. A game streaming in Moonlight is
// played with the same controller, and nothing pressed in it may press
// anything here; coming back, a button still held from the game is not a press.
const PAD = { a: 0, b: 1, lb: 4, rb: 5, up: 12, down: 13, left: 14, right: 15 };
const PAD_DIRS = ['up', 'down', 'left', 'right'];
const PAD_STICK = 0.5;                 // how far a stick tilts before it counts
const PAD_REPEAT = [380, 110];         // ms: held, the first repeat, then each
const PAD_SCROLL = 22;                 // px a frame, the right stick at full tilt
const PAD_FOCUSABLE = 'button, a[href], input:not([type=hidden]), select, textarea, summary, '
                    + '[tabindex]:not([tabindex="-1"])';
// A popup's way out, in the order it is looked for.
const PAD_LEAVE = '[value=no], [id$="-cancel"], [id$="-close"], [id$="-done"], [id$="-no"]';
let padHeld = {}, padAway = true, padRaf = 0;

function padHasFocus() { return document.hasFocus(); }
const padShown = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
// The open popup on top - the one holding focus, else the last opened - or the page.
function padScope() {
  const open = [...document.querySelectorAll('dialog[open]')];
  if (!open.length) return document.body;
  return open.find(d => d.contains(document.activeElement)) || open[open.length - 1];
}
function padTargets(scope) {
  return [...scope.querySelectorAll(PAD_FOCUSABLE)].filter(e => !e.disabled && padShown(e)
    && (scope !== document.body || !e.closest('dialog')));
}
function padFocus(e) {
  if (!e) return;
  e.focus({ preventScroll: true });
  // The top bar stays put: scrolling the page to one of its tabs moved the
  // page, not the tab.
  for (let a = e; a && a !== document.body; a = a.parentElement) {
    if (getComputedStyle(a).position === 'fixed') return;
  }
  e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
// Nearest in that direction: how far along it, and twice as much for how far
// off to the side - so straight down beats a closer one diagonally.
function padMove(dir) {
  const scope = padScope();
  const all = padTargets(scope);
  const cur = all.includes(document.activeElement) ? document.activeElement : null;
  if (!cur) {
    padFocus(scope === document.body ? document.querySelector('.nav-item.on') || all[0] : all[0]);
    return;
  }
  // A list steps through its choices sideways; up and down still leave it.
  if (cur.tagName === 'SELECT' && (dir === 'left' || dir === 'right')) {
    const i = cur.selectedIndex + (dir === 'right' ? 1 : -1);
    if (i >= 0 && i < cur.options.length) {
      cur.selectedIndex = i;
      cur.dispatchEvent(new Event('input', { bubbles: true }));
      cur.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return;
  }
  const r = cur.getBoundingClientRect();
  const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
  let best = null, score = Infinity;
  for (const e of all) {
    if (e === cur) continue;
    const b = e.getBoundingClientRect();
    // Past the middle of this one that way: a neighbour level with it is
    // sideways, not down, however close.
    const past = { up: b.bottom < cy, down: b.top > cy, left: b.right < cx, right: b.left > cx }[dir];
    if (!past) continue;
    const along = Math.max(0, { up: r.top - b.bottom, down: b.top - r.bottom,
                                left: r.left - b.right, right: b.left - r.right }[dir]);
    const side = dir === 'up' || dir === 'down'
      ? Math.max(0, b.left - r.right, r.left - b.right)
      : Math.max(0, b.top - r.bottom, r.top - b.bottom);
    const s = along + side * 2;
    if (s < score) { score = s; best = e; }
  }
  if (best) padFocus(best);
}
function padPress() {
  const e = document.activeElement;
  if (!e || e === document.body || !padScope().contains(e)) return padMove('down');
  // A text field is typed into, and a list is stepped sideways: A does nothing to either.
  if (e.tagName === 'SELECT' || (e.tagName === 'INPUT' && !['radio', 'checkbox', 'button'].includes(e.type))
      || e.tagName === 'TEXTAREA') return;
  e.click();
}
function padBack() {
  const scope = padScope();
  if (scope !== document.body) {
    const ok = b => !b.disabled && padShown(b);
    const out = [...scope.querySelectorAll(PAD_LEAVE)].find(ok);
    if (out) out.click();
    return;
  }
  if (view !== 'dashboard') { goView('dashboard'); padFocus(document.querySelector('.nav-item.on')); }
}
function padPage(step) {
  if (padScope() !== document.body) return;
  const items = [...document.querySelectorAll('.nav-item')].filter(padShown);
  const at = items.findIndex(n => n.classList.contains('on'));
  const next = items[at + step];
  if (!next) return;
  next.click();
  padFocus(next);
}
// The right stick: whatever scrolls around what has focus, else the popup, else the page.
function padScroll(dy) {
  let el = document.activeElement;
  while (el && el !== document.body) {
    const st = getComputedStyle(el);
    if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight) break;
    el = el.parentElement;
  }
  const scope = padScope();
  const target = el && el !== document.body ? el : scope === document.body ? document.scrollingElement : scope;
  target.scrollTop += dy;
}
// One frame of every controller, merged. Exposed by name so a test can drive it.
function padTick(pads, now) {
  if (!padHasFocus()) { padAway = true; return; }
  const down = {};
  for (const p of pads) {
    for (const [name, i] of Object.entries(PAD)) if (p.buttons[i] && p.buttons[i].pressed) down[name] = true;
    const [lx = 0, ly = 0, , ry = 0] = p.axes;
    if (lx < -PAD_STICK) down.left = true;
    if (lx > PAD_STICK) down.right = true;
    if (ly < -PAD_STICK) down.up = true;
    if (ly > PAD_STICK) down.down = true;
    if (Math.abs(ry) > PAD_STICK / 2) padScroll(ry * PAD_SCROLL);
  }
  // Back from the game: what is held now was pressed there.
  if (padAway) {
    padAway = false;
    padHeld = Object.fromEntries(Object.keys(down).map(k => [k, { next: Infinity }]));
    return;
  }
  for (const k of Object.keys(padHeld)) if (!down[k]) delete padHeld[k];
  for (const k of Object.keys(down)) {
    const h = padHeld[k];
    const dir = PAD_DIRS.includes(k);
    if (h && !(dir && now >= h.next)) continue;
    padHeld[k] = { next: dir ? now + PAD_REPEAT[h ? 1 : 0] : Infinity };
    document.body.classList.add('pad');
    if (dir) padMove(k);
    else if (k === 'a') padPress();
    else if (k === 'b') padBack();
    else if (k === 'lb') padPage(-1);
    else if (k === 'rb') padPage(1);
  }
  // B says what it will do from here - each frame, as a popup can open or
  // close without the controller.
  if (document.body.classList.contains('pad')) {
    $('pad-b').textContent = padScope() === document.body ? 'Home' : 'Close';
  }
}
function padFrame(now) {
  padRaf = 0;
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  if (!pads.length) return;          // gone: the next connect starts it again
  padTick(pads, now);
  padRaf = requestAnimationFrame(padFrame);
}
addEventListener('gamepadconnected', () => { if (!padRaf) padRaf = requestAnimationFrame(padFrame); });
// The mouse or keyboard again: the controller's focus ring and hints go.
for (const ev of ['mousedown', 'mousemove', 'keydown']) {
  addEventListener(ev, e => { if (e.isTrusted) document.body.classList.remove('pad'); }, { passive: true });
}

// Settings' sections: the account cards are there before ayis's settings are
// read, and stay if that read fails.
paintSettingsNav();
// Drawn once before anything has been read, so the card has its rows and they
// say "reading…", rather than being blank until two reads land.
checkAsks();
// Is there an engine? Then what does it say. In that order: without ayis the
// reads cannot even be started, and nine spawn errors describe one problem
// badly.
// The steps are drawn at once, all of them still being checked, so the window
// never opens on a blank page while the first answers come back.
paintOnboard();
// The remembered layout, filled with loading cards, from the first frame.
if (hostsNow) paintHostCards();
if (homeBoot && homeBoot.aws) paintMachineCards();
(async () => {
  if (!(await engineReady())) return;
  // The remembered machines are checked at once, beside the startup reads,
  // not after the list comes back: their cards are already on screen.
  for (const h of hostsNow || []) {
    const [args, json] = hostRead(h.name);
    runAyis(args, { json, group: 'refresh' });
  }
  await refreshAll();
})();
