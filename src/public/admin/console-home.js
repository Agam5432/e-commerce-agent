// What the call window shows when no call is in progress: whether you are reachable, what is waiting, the callbacks
// the team promised (with an alert when one is due, so nobody has to remember), and the recent calls. It only reads
// what the call window's token may read (see CONSOLE_ALLOWED in consoleAuth.js).
import {sup} from './support.js';
import {esc, icons, toast} from './ui.js';
import {RINGTONES, getRingSettings, playAlert, previewRing, setRingTone, setRingVolume, soundBlocked, stopPreview, unlockAudio, watchSoundBlocked} from './ring.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 30_000;
const SOON_MS = 10 * 60_000;
const alerted = new Set(); // "<id>:due" / "<id>:soon": each alert is made once
let callbacks = [];
let calls = [];
let started = false;
let titleTimer = null;
let alertTimer = null;
const baseTitle = document.title;

async function api(method, path, body) {
  const token = await sup.tokenFn();
  const res = await fetch(`/admin/api${path}`, {method, headers: {Authorization: `Bearer ${token}`, 'ngrok-skip-browser-warning': 'true', ...(body ? {'Content-Type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// ---- sound and notifications --------------------------------------------------------------------------------------------
function notify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification(title, {body, tag: title, requireInteraction: true});
  } catch { /* not supported */ }
}
function flashTitle(text) {
  clearInterval(titleTimer);
  let on = false;
  titleTimer = setInterval(() => { on = !on; document.title = on ? text : baseTitle; }, 1000);
}
function stopFlash() {
  clearInterval(titleTimer);
  titleTimer = null;
  document.title = baseTitle;
}

// ---- time ----------------------------------------------------------------------------------------------------------------
const clock = (iso) => new Date(iso).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
const dayWord = (iso) => {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], {weekday: 'short', day: 'numeric', month: 'short'});
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${dayWord(iso)}, ${clock(iso)}`;
}
const callbackState = (b) => {
  const diff = new Date(b.startAt).getTime() - Date.now();
  if (diff < -15 * 60_000) return 'overdue';
  if (diff <= 0) return 'due';
  if (diff <= SOON_MS) return 'soon';
  return 'later';
};
const STATE_STYLE = {
  overdue: {label: 'Overdue', chip: 'bg-danger-soft text-danger-text', ring: 'border-danger'},
  due: {label: 'Call now', chip: 'bg-danger-soft text-danger-text', ring: 'border-danger'},
  soon: {label: 'Starting soon', chip: 'bg-warning-soft text-warning-text', ring: 'border-warning'},
  later: {label: 'Later', chip: 'bg-subtle text-ink-secondary', ring: 'border-line-subtle'},
};

// ---- rendering -------------------------------------------------------------------------------------------------------------
function hero() {
  const busy = Boolean(sup.active);
  const live = sup.open;
  const kind = !live ? 'connecting' : busy ? 'busy' : sup.presence === 'online' ? 'ready' : sup.presence === 'away' ? 'away' : 'offline';
  const text = {
    connecting: ['Connecting…', 'Reaching the server. Calls cannot ring yet.', 'bg-slate-400'],
    ready: ['Ready for calls', 'You will hear a ring and see the shopper here when someone asks for a person.', 'bg-success'],
    busy: ['On a call', 'New shoppers are told you are busy until this call ends.', 'bg-danger'],
    away: ['Away', 'Shoppers will not be connected to you. Switch to Online (top right) to take calls.', 'bg-warning'],
    offline: ['Offline', 'Shoppers will not be connected to you. Switch to Online (top right) to take calls.', 'bg-slate-400'],
  }[kind];
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  return `<section class="rounded-xl border border-line-subtle bg-surface p-5 flex items-start gap-4">
    <span class="relative mt-1 shrink-0 w-3 h-3"><span class="absolute inset-0 rounded-full ${text[2]} ${kind === 'ready' ? 'animate-ping opacity-60' : 'hidden'}"></span><span class="absolute inset-0 rounded-full ${text[2]}"></span></span>
    <div class="min-w-0 flex-1">
      <h2 class="type-h2">${esc(text[0])}${sup.name ? ` <span class="font-normal text-ink-secondary">· ${esc(sup.name)}</span>` : ''}</h2>
      <p class="text-xs text-ink-secondary mt-0.5">${esc(text[1])}</p>
      <div class="flex flex-wrap gap-2 mt-3">
        <button type="button" data-home="mic" class="px-2.5 py-1.5 text-xs font-medium rounded-md border border-line-subtle hover:bg-subtle">Test microphone</button>
        ${permission === 'default' ? '<button type="button" data-home="notify" class="px-2.5 py-1.5 text-xs font-medium rounded-md border border-line-subtle hover:bg-subtle">Allow desktop alerts</button>' : permission === 'granted' ? '<span class="px-2 py-1 text-[11px] rounded-pill bg-success-soft text-success-text">Desktop alerts on</span>' : permission === 'denied' ? '<span class="px-2 py-1 text-[11px] rounded-pill bg-warning-soft text-warning-text" title="Allow notifications for this site in the browser">Desktop alerts blocked</span>' : ''}
      </div>
      <div id="home-mic" hidden class="mt-3"><div class="h-2 rounded-full bg-subtle overflow-hidden"><div id="home-mic-bar" class="h-full w-0 bg-success transition-[width] duration-75"></div></div><p id="home-mic-note" class="text-[11px] text-ink-muted mt-1">Say something…</p></div>
    </div>
  </section>`;
}

// ---- the ring: which sound, how loud, and whether the browser lets it play ------------------------------------------------------
function soundWarning() {
  if (!soundBlocked()) return '';
  return `<button type="button" data-home="unlock" class="w-full text-left rounded-lg bg-warning-soft text-warning-text px-4 py-3 text-xs"><span class="font-semibold">The browser is blocking sound.</span> Click here once, so incoming calls can ring.</button>`;
}

function ringCard() {
  const {tone, volume} = getRingSettings();
  const options = RINGTONES.map((t) => `<option value="${esc(t.id)}" ${t.id === tone ? 'selected' : ''}>${esc(t.name)} · ${esc(t.hint)}</option>`).join('');
  return `<section class="rounded-xl border border-line-subtle bg-surface p-5 space-y-3">
    <div><h3 class="type-h2">Ring sound</h3><p class="text-xs text-ink-secondary mt-0.5">Rings for every incoming call while you are Online, also when this window is behind other windows or tabs. Saved in this browser.</p></div>
    <div class="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-end">
      <label class="block text-xs font-medium">Ringtone<select id="ring-tone" class="mt-1 w-full px-3 py-2 text-xs rounded-md border border-line-subtle bg-subtle/40 focus-ring">${options}</select></label>
      <button type="button" data-home="ring-play" class="px-3 py-2 text-xs font-semibold rounded-md bg-accent-gradient text-white">Play</button>
    </div>
    <label class="flex items-center gap-3 text-xs font-medium"><span class="w-14 shrink-0">Volume</span><input id="ring-volume" type="range" min="5" max="100" value="${Math.round(volume * 100)}" class="flex-1 accent-[var(--accent-primary)]" aria-label="Ring volume" /><output id="ring-volume-out" class="w-10 text-right tabular-nums text-ink-secondary">${Math.round(volume * 100)}%</output></label>
    <p class="text-[11px] text-ink-muted">Keep this window open and set to Online. If the laptop sleeps or the window is closed, nothing can ring: calls then go to the shoppers as "nobody is available".</p>
  </section>`;
}

function stats() {
  const todayCalls = calls.filter((c) => new Date(c.requestedAt).toDateString() === new Date().toDateString());
  const due = callbacks.filter((b) => ['due', 'overdue'].includes(callbackState(b))).length;
  const card = (label, value, tone = '') => `<div class="rounded-lg border border-line-subtle bg-surface p-3"><div class="text-[11px] text-ink-secondary">${label}</div><div class="text-2xl font-semibold tabular-nums ${tone}">${value}</div></div>`;
  return `<div class="grid grid-cols-3 gap-3">${card('Waiting now', sup.waiting.length, sup.waiting.length ? 'text-danger-text' : '')}${card('Calls today', todayCalls.length)}${card('Callbacks due', due, due ? 'text-danger-text' : '')}</div>`;
}

function callbackCard(b) {
  const s = callbackState(b);
  const st = STATE_STYLE[s];
  const who = b.name || b.email || 'A shopper';
  const contact = [b.phone ? `<a class="font-medium text-accent-text hover:underline" href="tel:${esc(b.phone)}">${esc(b.phone)}</a>` : '', b.email ? `<span class="text-ink-muted">${esc(b.email)}</span>` : ''].filter(Boolean).join(' · ');
  return `<li class="rounded-lg border ${st.ring} bg-surface p-3 ${s === 'due' ? 'ring-2 ring-danger/20' : ''}">
    <div class="flex items-center justify-between gap-2">
      <div class="min-w-0"><div class="text-sm font-semibold truncate">${esc(who)}</div><div class="text-[11px] text-ink-secondary">${esc(dayWord(b.startAt))} · ${esc(clock(b.startAt))}${b.endAt ? ` – ${esc(clock(b.endAt))}` : ''}</div></div>
      <span class="shrink-0 px-2 py-0.5 text-[10px] font-semibold rounded-pill ${st.chip}">${st.label}</span>
    </div>
    ${b.topic ? `<p class="text-xs text-ink-secondary mt-1.5">“${esc(b.topic)}”</p>` : ''}
    <div class="text-xs mt-1.5">${contact || '<span class="text-ink-muted">No contact details were given</span>'}</div>
    <div class="flex gap-2 mt-2.5">
      <button type="button" data-home="done" data-id="${esc(b.id)}" class="flex-1 px-2.5 py-1.5 text-xs font-semibold rounded-md bg-success text-white">I called them</button>
      <button type="button" data-home="missed" data-id="${esc(b.id)}" class="px-2.5 py-1.5 text-xs font-medium rounded-md border border-line-subtle hover:bg-subtle">Could not reach</button>
    </div>
  </li>`;
}

function callbacksSection() {
  const body = callbacks.length
    ? `<ul class="space-y-2.5">${callbacks.map(callbackCard).join('')}</ul>`
    : '<p class="text-xs text-ink-muted py-2">No callbacks are waiting. When a shopper books one, it shows up here, and this window sounds an alert when it is time.</p>';
  return `<section class="space-y-2"><h3 class="text-xs font-semibold uppercase tracking-wide text-ink-secondary">Callbacks</h3>${body}</section>`;
}

const CALL_STATUS = {
  ended: ['Completed', 'bg-success-soft text-success-text'],
  connected: ['In progress', 'bg-success-soft text-success-text'],
  accepted: ['Connecting', 'bg-warning-soft text-warning-text'],
  requested: ['Waiting', 'bg-warning-soft text-warning-text'],
  unanswered: ['Not answered', 'bg-subtle text-ink-secondary'],
  cancelled: ['Cancelled', 'bg-subtle text-ink-secondary'],
  failed: ['Failed', 'bg-danger-soft text-danger-text'],
};
function recentSection() {
  const rows = calls.slice(0, 8).map((c) => {
    const [label, chip] = CALL_STATUS[c.status] || [c.status, 'bg-subtle text-ink-secondary'];
    const rec = c.recording?.status === 'saved' ? '<span class="px-1.5 py-0.5 text-[10px] rounded-pill bg-subtle text-ink-secondary">Recording saved</span>' : c.recording?.consent ? '<span class="px-1.5 py-0.5 text-[10px] rounded-pill bg-warning-soft text-warning-text">Recording not saved</span>' : '';
    const who = c.customer?.name || c.customer?.email || 'A shopper';
    return `<li class="flex items-center justify-between gap-3 py-2"><div class="min-w-0"><div class="text-xs font-medium truncate">${esc(who)}</div><div class="text-[11px] text-ink-muted">${esc(ago(c.requestedAt))}${c.durationSec ? ` · ${esc(mmss(c.durationSec))}` : ''}</div></div><div class="flex items-center gap-1.5 shrink-0">${rec}<span class="px-2 py-0.5 text-[10px] font-semibold rounded-pill ${chip}">${esc(label)}</span></div></li>`;
  }).join('');
  return `<section class="space-y-1"><h3 class="text-xs font-semibold uppercase tracking-wide text-ink-secondary">Recent calls</h3>${rows ? `<ul class="divide-y divide-line-subtle rounded-lg border border-line-subtle bg-surface px-3">${rows}</ul>` : '<p class="text-xs text-ink-muted py-2">No calls yet.</p>'}</section>`;
}

function dueBanner() {
  const due = callbacks.filter((b) => ['due', 'overdue'].includes(callbackState(b)));
  if (!due.length) return '';
  const b = due[0];
  return `<div role="alert" class="rounded-lg bg-danger text-white px-4 py-3 flex items-center gap-3"><i data-lucide="phone-call" class="w-5 h-5 shrink-0"></i><div class="min-w-0 text-sm"><div class="font-semibold truncate">Callback due: ${esc(b.name || b.email || 'a shopper')}</div><div class="text-xs opacity-90 truncate">${b.phone ? esc(b.phone) : 'no phone number'} · ${esc(b.topic || 'no topic given')}${due.length > 1 ? ` · +${due.length - 1} more` : ''}</div></div></div>`;
}

export function render() {
  const el = $('console-home');
  if (!el || el.hidden) return;
  // keep an open microphone test across redraws
  const micOpen = $('home-mic') && !$('home-mic').hidden;
  // the ring card is built once and kept: a redraw would close the open drop-down and stop the slider mid-drag
  let ring = $('console-ring');
  if (!ring) { ring = document.createElement('div'); ring.id = 'console-ring'; ring.innerHTML = ringCard(); }
  el.innerHTML = `${dueBanner()}${soundWarning()}${hero()}<div id="console-ring-slot"></div>${stats()}${callbacksSection()}${recentSection()}`;
  $('console-ring-slot').replaceWith(ring);
  if (micOpen) $('home-mic').hidden = false;
  icons();
}

// ---- data and alerts --------------------------------------------------------------------------------------------------------
function checkAlerts() {
  for (const b of callbacks) {
    const s = callbackState(b);
    const who = b.name || b.email || 'a shopper';
    if (s === 'soon' && !alerted.has(`${b.id}:soon`)) {
      alerted.add(`${b.id}:soon`);
      playAlert(2);
      notify('Callback soon', `${who} at ${clock(b.startAt)}`);
    }
    if ((s === 'due' || s === 'overdue') && !alerted.has(`${b.id}:due`)) {
      alerted.add(`${b.id}:due`);
      playAlert(6);
      notify('Callback due now', `${who}${b.phone ? ` · ${b.phone}` : ''}`);
      toast('Callback due now', `${who}${b.phone ? ` · ${b.phone}` : ''}`, 'warning');
    }
  }
  const dueNow = callbacks.filter((b) => ['due', 'overdue'].includes(callbackState(b)));
  if (dueNow.length) {
    if (!titleTimer) flashTitle(`📞 Callback due: ${dueNow[0].name || 'shopper'}`);
    // stay audible: a short reminder every minute until it is dealt with
    if (!alertTimer) alertTimer = setInterval(() => { if (callbacks.some((b) => ['due', 'overdue'].includes(callbackState(b)))) playAlert(3); else { clearInterval(alertTimer); alertTimer = null; } }, 60_000);
  } else {
    stopFlash();
  }
}

async function refresh() {
  try {
    const [cb, list] = await Promise.all([api('GET', '/support/callbacks'), api('GET', '/support/calls?limit=20')]);
    callbacks = (cb.items || []).sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    calls = list.items || [];
  } catch { /* the next poll tries again */ }
  checkAlerts();
  render();
}

async function micTest() {
  const box = $('home-mic');
  const bar = $('home-mic-bar');
  const note = $('home-mic-note');
  box.hidden = false;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: true, video: false});
  } catch {
    note.textContent = 'The microphone is blocked. Allow it for this page (the lock icon in the address bar).';
    return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const analyser = ctx.createAnalyser();
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  let peak = 0;
  const until = Date.now() + 5000;
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let max = 0;
    for (const v of data) max = Math.max(max, Math.abs(v - 128));
    const level = Math.min(1, max / 64);
    peak = Math.max(peak, level);
    bar.style.width = `${Math.round(level * 100)}%`;
    if (Date.now() < until) requestAnimationFrame(tick);
    else {
      stream.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
      note.textContent = peak > 0.12 ? 'Your microphone works.' : 'No sound heard. Check that the right microphone is selected in the browser.';
    }
  };
  tick();
}

document.addEventListener('click', async (e) => {
  const el = e.target instanceof Element ? e.target.closest('[data-home]') : null;
  if (!el) return;
  const kind = el.getAttribute('data-home');
  if (kind === 'mic') return micTest();
  if (kind === 'unlock') { await unlockAudio(); return render(); }
  if (kind === 'ring-play') {
    const playing = el.dataset.playing === '1';
    if (playing) { stopPreview(); el.dataset.playing = ''; el.textContent = 'Play'; return; }
    await previewRing($('ring-tone').value, Number($('ring-volume').value) / 100);
    el.dataset.playing = '1';
    el.textContent = 'Stop';
    setTimeout(() => { if (el.isConnected) { el.dataset.playing = ''; el.textContent = 'Play'; } }, 5600);
    return;
  }
  if (kind === 'notify') {
    try { await Notification.requestPermission(); } catch { /* not supported */ }
    return render();
  }
  if (kind === 'done' || kind === 'missed') {
    const id = el.getAttribute('data-id');
    el.disabled = true;
    try {
      await api('POST', `/support/callbacks/${encodeURIComponent(id)}/done`, {status: kind === 'missed' ? 'missed' : 'completed'});
      callbacks = callbacks.filter((b) => b.id !== id);
      toast(kind === 'missed' ? 'Marked as not reached' : 'Marked as called', '');
    } catch {
      toast('That did not save', 'Try again.', 'danger');
    }
    checkAlerts();
    render();
  }
});

/** Called once the call window has signed in and the team member pressed "Start taking calls". */
export function startHome() {
  if (started) return;
  started = true;
  $('console-home').hidden = false;
  sup.onChange.add(render);
  refresh();
  setInterval(refresh, POLL_MS);
  setInterval(() => { checkAlerts(); render(); }, 15_000);
  // a call just ended: the list of recent calls changes
  sup.onChange.add(debounceRefresh());
}

function debounceRefresh() {
  let t = null;
  let lastActive = false;
  return () => {
    const active = Boolean(sup.active);
    if (lastActive && !active) { clearTimeout(t); t = setTimeout(refresh, 1500); }
    lastActive = active;
  };
}

// the ring card is redrawn only when something else changes: choosing and sliding must not be interrupted
document.addEventListener('change', (e) => {
  if (e.target instanceof HTMLSelectElement && e.target.id === 'ring-tone') { setRingTone(e.target.value); previewRing(e.target.value); }
});
document.addEventListener('input', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.id === 'ring-volume') {
    const v = Number(e.target.value) / 100;
    setRingVolume(v);
    const out = $('ring-volume-out');
    if (out) out.textContent = `${e.target.value}%`;
  }
});
watchSoundBlocked(() => render());
