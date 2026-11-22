// The ring of an incoming call, and what keeps it reliable while the status is Online.
//
// The ring is a real audio file played in a loop (see scripts/make-ringtones.mjs), started by the message that arrives
// over the socket. A browser keeps delivering socket messages and keeps playing audio in a background tab, in another
// window, on a Mac and in Safari; it slows down timers there, so nothing in the ring depends on a timer. The heartbeat
// that keeps the person "Online" for shoppers runs in a Web Worker for the same reason.
const SOUNDS = '/admin/sounds';
const KEY_TONE = 'orbi-ring-tone';
const KEY_VOLUME = 'orbi-ring-volume';

export const RINGTONES = [
  {id: 'gentle-pulse', name: 'Gentle pulse', hint: 'Narm uthti-girti awaaz'},
  {id: 'marimba', name: 'Marimba', hint: 'Khushnuma, lakdi jaisi tapak'},
  {id: 'classic-phone', name: 'Classic phone', hint: 'Asli phone jaisi ring'},
  {id: 'double-ring', name: 'Double ring', hint: 'Trring-trring, phir pause'},
  {id: 'old-bell', name: 'Old telephone bell', hint: 'Tez trill, door se sunai deti hai'},
  {id: 'soft-chime', name: 'Soft chime', hint: 'Teen narm notes'},
  {id: 'doorbell', name: 'Doorbell', hint: 'Ding-dong'},
  {id: 'harp', name: 'Harp', hint: 'Neeche se upar bahti dhun'},
];
const DEFAULT_TONE = 'gentle-pulse';

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* not remembered */ } },
};

export function getRingSettings() {
  const tone = RINGTONES.some((t) => t.id === store.get(KEY_TONE)) ? store.get(KEY_TONE) : DEFAULT_TONE;
  const v = Number(store.get(KEY_VOLUME));
  return {tone, volume: Number.isFinite(v) && v >= 0.05 && v <= 1 ? v : 0.8};
}
export function setRingTone(id) { if (RINGTONES.some((t) => t.id === id)) store.set(KEY_TONE, id); }
export function setRingVolume(volume) {
  store.set(KEY_VOLUME, String(Math.min(1, Math.max(0.05, Number(volume) || 0.8))));
  if (ringEl) ringEl.volume = getRingSettings().volume;
}

let ringEl = null;
let alertEl = null;
let ringing = false;
let blocked = false;
const onBlocked = new Set();
const setBlocked = (value) => { if (blocked !== value) { blocked = value; onBlocked.forEach((fn) => { try { fn(value); } catch { /* a screen redrawing must not stop the ring */ } }); } };
export const soundBlocked = () => blocked;
/** fn(true) when the browser refused to play the ring (it needs one click on the page), fn(false) when it plays again. */
export function watchSoundBlocked(fn) { onBlocked.add(fn); return () => onBlocked.delete(fn); }

function element(kind) {
  const el = new Audio();
  el.preload = 'auto';
  el.loop = true;
  el.setAttribute('playsinline', '');
  if (kind === 'alert') el.src = `${SOUNDS}/alert.wav`;
  return el;
}

/**
 * A browser lets a page play sound only after the person has clicked on it once. Called from a click (Start taking
 * calls, or any click later): both ring files are played silently for an instant, which lets them start by themselves
 * afterwards, also from the middle of a socket message while the tab is in the background.
 */
export async function unlockAudio() {
  try {
    ringEl = ringEl || element('ring');
    alertEl = alertEl || element('alert');
    ringEl.src = `${SOUNDS}/${getRingSettings().tone}.wav`;
    for (const el of [ringEl, alertEl]) {
      const was = el.volume;
      el.volume = 0;
      await el.play();
      el.pause();
      el.currentTime = 0;
      el.volume = was;
    }
    setBlocked(false);
  } catch { /* the next click tries again */ }
}
document.addEventListener('pointerdown', () => { if (!ringEl || blocked) unlockAudio(); }, {capture: true});

async function play(el, volume) {
  try {
    el.volume = volume;
    el.currentTime = 0;
    await el.play();
    setBlocked(false);
    return true;
  } catch {
    setBlocked(true);
    return false;
  }
}

/** Rings until stopRing(): a call is waiting. Safe to call again while it is already ringing. */
export async function startRing() {
  if (ringing) return;
  ringing = true;
  ringEl = ringEl || element('ring');
  const {tone, volume} = getRingSettings();
  const src = `${SOUNDS}/${tone}.wav`;
  if (!ringEl.src.endsWith(src)) ringEl.src = src;
  if (!(await play(ringEl, volume))) fallbackBeep();
}
export function stopRing() {
  ringing = false;
  for (const el of [ringEl, alertEl]) { try { el?.pause(); } catch { /* not playing */ } }
}
/** The sound for a callback that is due: it plays for a few seconds, then stops by itself. */
export async function playAlert(seconds = 6) {
  alertEl = alertEl || element('alert');
  if (!(await play(alertEl, Math.max(getRingSettings().volume, 0.5)))) return fallbackBeep();
  setTimeout(() => { if (!ringing) { try { alertEl.pause(); } catch { /* stopped */ } } }, seconds * 1000);
}

/** Listening to a choice: plays the ringtone once or twice, then stops. Returns after it starts. */
let previewTimer = null;
export async function previewRing(id = getRingSettings().tone, volume = getRingSettings().volume) {
  clearTimeout(previewTimer);
  const el = (ringEl = ringEl || element('ring'));
  el.pause();
  el.src = `${SOUNDS}/${id}.wav`;
  await play(el, volume);
  previewTimer = setTimeout(() => { if (!ringing) el.pause(); }, 5500);
}
export function stopPreview() {
  clearTimeout(previewTimer);
  if (!ringing) { try { ringEl?.pause(); } catch { /* stopped */ } }
}

// ---- when the ring file cannot play: a tone from the Web Audio API still tells the person something is happening --------
let audioCtx = null;
function fallbackBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.2 * getRingSettings().volume;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.4);
  } catch { /* no sound is fine */ }
}

// ---- staying reliable in the background ----------------------------------------------------------------------------------
/**
 * Calls fn every `ms` from a Web Worker. A page's own timers are slowed to one a minute in a background tab, which would
 * let the "Online" heartbeat go stale and tell shoppers nobody is there; a worker's timer is not slowed. Returns stop().
 */
export function backgroundTicker(ms, fn) {
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(1), ${Math.max(1000, Math.floor(ms))});`], {type: 'text/javascript'}));
    const worker = new Worker(url);
    worker.onmessage = () => fn();
    return () => { worker.terminate(); URL.revokeObjectURL(url); };
  } catch {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }
}

let lockRelease = null;
/** Holding a Web Lock tells the browser this page is doing live work, so it does not freeze it or drop it from memory. */
export function holdOnline(on) {
  if (!on) { lockRelease?.(); lockRelease = null; return; }
  if (lockRelease || !navigator.locks?.request) return;
  navigator.locks.request('orbi-calls-online', () => new Promise((resolve) => { lockRelease = resolve; })).catch(() => {});
}
