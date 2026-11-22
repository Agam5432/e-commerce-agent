// The team's side of live help, in the dashboard: who is online, a shopper's call coming in, and the call itself
// (audio only, browser to browser over WebRTC). Everything the server decides arrives over /support-ws; this file
// only shows it and carries the audio. Nothing here pretends: "connected" is shown when the audio really is up.
import {state} from './core.js';
import {ApiError, getConversation, sendReply} from './api.js';
import {debounce, esc, icons, toast} from './ui.js';
import {backgroundTicker, holdOnline, startRing, stopRing} from './ring.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return sessionStorage.getItem(k) || localStorage.getItem(k); } catch { return null; } },
  set: (k, v, session = false) => { try { (session ? sessionStorage : localStorage).setItem(k, v); } catch { /* not remembered */ } },
};

export const sup = {
  /** 'embedded' (inside Shopify admin) or 'console' (the separate call window, see console.html) */
  mode: 'embedded', tokenFn: null, delegate: false, win: null, poll: null,
  enabled: false, audio: false, recordingAllowed: false, turn: false,
  ws: null, open: false, wanted: false, retry: 0, retryTimer: null, beat: null, authTimer: null,
  me: '', name: '', presence: 'offline', team: [], waiting: [],
  /** the call this person is on: { call, pc, local, remote, audioEl, muted, timer, startedAt, rec, ... } */
  active: null,
  pendingAccept: null, // { callId, local }
  ice: [], ring: null, chatTimer: null, onChange: new Set(),
};
const changed = () => sup.onChange.forEach((fn) => { try { fn(); } catch { /* a screen redrawing must not break a call */ } });

async function token() {
  if (sup.tokenFn) return sup.tokenFn();
  if (typeof globalThis.shopify?.idToken !== 'function') throw new ApiError('Open this app from your Shopify admin.', 401);
  return globalThis.shopify.idToken();
}

/**
 * Whether THIS page may use the microphone. Shopify's admin adds no `allow` permission to an embedded app's frame, so
 * inside it the answer is no, and calls are taken in the separate call window instead.
 */
export function microphoneAllowedHere() {
  try {
    const policy = document.permissionsPolicy || document.featurePolicy;
    if (policy?.allowsFeature) return policy.allowsFeature('microphone');
  } catch { /* fall through */ }
  return window.top === window;
}

/** The call window (console.html) calls this before initSupport: it signs in with the ticket's session token. */
export function configureConsole(sessionToken) {
  sup.mode = 'console';
  sup.tokenFn = async () => sessionToken;
  globalThis.__orbiToken = sup.tokenFn; // the chat calls of api.js use it too
}
async function authed(method, path, {body, headers = {}} = {}) {
  const res = await fetch(`/admin/api${path}`, {method, headers: {Authorization: `Bearer ${await token()}`, 'ngrok-skip-browser-warning': 'true', ...headers}, body});
  return res;
}

// ---- the socket ------------------------------------------------------------------------------------------------------
const send = (payload) => { try { if (sup.ws?.readyState === 1) sup.ws.send(JSON.stringify(payload)); } catch { /* reconnect handles it */ } };

async function connect() {
  if (!sup.wanted || sup.ws) return;
  let jwt;
  try { jwt = await token(); } catch { return; }
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/support-ws`;
  const ws = new WebSocket(url, ['orbi.support.v1', `${sup.mode === 'console' ? 'orbi.console.' : 'orbi.admin.'}${jwt}`]);
  sup.ws = ws;
  ws.onopen = () => { sup.open = true; sup.retry = 0; renderPresence(); };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onServer(m).catch((err) => console.error('[support]', err)); };
  ws.onclose = () => {
    sup.open = false;
    if (sup.ws === ws) sup.ws = null;
    sup.beatStop?.();
    sup.beatStop = null;
    clearInterval(sup.authTimer);
    holdOnline(false);
    renderPresence();
    if (sup.wanted) {
      sup.retry += 1;
      clearTimeout(sup.retryTimer);
      sup.retryTimer = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(sup.retry, 4)));
    }
  };
  ws.onerror = () => {};
}

function onOpenReady(msg) {
  sup.me = msg.representative?.id || sup.me;
  sup.team = msg.team || [];
  sup.waiting = msg.waiting || [];
  sup.ice = msg.ice || [];
  sup.turn = Boolean(msg.turn);
  // the dashboard was reloaded in the middle of a call: the audio is gone with the page, so close the call honestly
  if (msg.active && !sup.active && !sup.pendingAccept) send({type: 'hangup', callId: msg.active.id, reason: 'the page was reloaded'});
  send({type: 'presence', status: sup.presence, name: sup.name});
  // from a worker: a background tab slows its own timers to one a minute, and the server counts a person offline after 45 s
  sup.beatStop?.();
  sup.beatStop = backgroundTicker(15000, () => send({type: 'heartbeat', name: sup.name}));
  holdOnline(sup.presence === 'online');
  clearInterval(sup.authTimer);
  sup.authTimer = setInterval(async () => { try { send({type: 'auth', token: await token()}); } catch { /* the next try will */ } }, 8 * 60000);
  renderIncoming();
  renderPresence();
  changed();
}

async function onServer(msg) {
  switch (msg.type) {
    case 'ready': return onOpenReady(msg);
    case 'presence': sup.team = msg.team || []; renderPresence(); return changed();
    case 'incoming':
      if (!sup.waiting.some((c) => c.id === msg.call.id)) sup.waiting.push(msg.call);
      renderIncoming();
      changed();
      return;
    case 'incoming_gone':
      sup.waiting = sup.waiting.filter((c) => c.id !== msg.callId);
      if (sup.pendingAccept?.callId === msg.callId && msg.reason === 'taken') { releasePending(); toast('A teammate took this call', msg.by ? `${msg.by} answered first.` : '', 'warning'); }
      renderIncoming();
      return changed();
    case 'accepted': return onAccepted(msg.call);
    case 'signal': return onSignal(msg);
    case 'connected': return onConnected(msg.call);
    case 'recording_withdrawn': return onWithdrawn();
    case 'ended': return onEnded(msg.call);
    case 'error': return onError(msg);
    default:
  }
}

function onError(msg) {
  if (msg.code === 'auth_expired') return;
  if (sup.pendingAccept) {
    releasePending();
    sup.waiting = sup.waiting.filter((c) => c.id !== msg.callId);
    renderIncoming();
  }
  toast(msg.code === 'taken' ? 'A teammate took this call' : msg.code === 'gone' ? 'The shopper is no longer waiting' : 'Could not take the call', msg.message || '', 'warning');
}

// ---- presence ----------------------------------------------------------------------------------------------------------
export function setPresence(status) {
  sup.presence = status;
  store.set('orbi-presence', status, true);
  send({type: 'presence', status, name: sup.name});
  holdOnline(status === 'online' && sup.open);
  renderPresence();
}

function renderPresence() {
  const box = $('support-presence');
  if (!box) return;
  box.hidden = !sup.enabled;
  if (!sup.enabled) return;
  if (sup.delegate) return renderDelegate(box);
  // built once and then only updated: replacing the control would close the drop-down while someone is choosing
  if (!box.firstElementChild) {
    box.innerHTML = `<label class="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-line-subtle bg-surface text-xs" title="Whether shoppers can reach you for a live call">
      <span id="presence-dot" class="w-2 h-2 rounded-full bg-slate-400"></span><span id="presence-label" class="hidden md:inline text-ink-secondary"></span>
      <select id="presence-select" aria-label="Live call availability" class="bg-transparent text-xs font-medium focus:outline-none">${['online', 'away', 'offline'].map((v) => `<option value="${v}">${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></label>`;
  }
  const busy = Boolean(sup.active);
  const dot = !sup.open ? 'bg-slate-400' : busy ? 'bg-danger' : sup.presence === 'online' ? 'bg-success' : sup.presence === 'away' ? 'bg-warning' : 'bg-slate-400';
  $('presence-dot').className = `w-2 h-2 rounded-full ${dot}`;
  // the drop-down already says Online / Away / Offline: the text beside it is only for what it cannot say
  $('presence-label').textContent = !sup.open && sup.wanted ? 'Connecting…' : busy ? 'On a call' : '';
  const select = $('presence-select');
  if (select.value !== sup.presence) select.value = sup.presence;
}
document.addEventListener('change', (e) => {
  if (e.target instanceof HTMLSelectElement && e.target.id === 'presence-select') {
    if (e.target.value === 'online' && !sup.name) askName();
    setPresence(e.target.value);
  }
});

function askName() {
  const saved = store.get('orbi-rep-name');
  const name = (saved || globalThis.prompt?.('Your name, as shoppers will see it on a call:', 'Support') || 'Support').trim().slice(0, 80) || 'Support';
  sup.name = name;
  store.set('orbi-rep-name', name);
}

// ---- a request coming in -----------------------------------------------------------------------------------------------
/** Inside Shopify admin: one button that opens the call window, and what is going on there. */
function renderDelegate(box) {
  const mine = sup.team.find((p) => p.id === sup.me);
  const live = mine && mine.state !== 'offline';
  const open = sup.win && !sup.win.closed;
  box.innerHTML = `<button type="button" data-action="support-open-console" class="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-line-subtle bg-surface text-xs font-medium hover:bg-subtle" title="Calls are taken in a separate window: Shopify's admin does not allow the microphone here"><span class="w-2 h-2 rounded-full ${live ? (mine.state === 'busy' ? 'bg-danger' : 'bg-success') : 'bg-slate-400'}"></span><i data-lucide="phone-call" class="w-3.5 h-3.5"></i><span class="hidden md:inline">${live ? (mine.state === 'busy' ? 'On a call' : 'Taking calls') : open ? 'Call window open' : 'Take calls'}</span></button>`;
  icons();
}

function renderIncoming() {
  const box = $('support-incoming');
  if (!box) return;
  if (sup.delegate) {
    const gone = !sup.waiting.length || (sup.win && !sup.win.closed);
    box.hidden = gone;
    box.innerHTML = gone ? '' : `<div class="w-[360px] max-w-[92vw] rounded-lg bg-surface border border-line-strong shadow-lg p-4 space-y-3" role="alert"><div class="flex items-center gap-3"><span class="w-10 h-10 rounded-full bg-success-soft text-success-text flex items-center justify-center shrink-0"><i data-lucide="phone-incoming" class="w-5 h-5"></i></span><div><div class="text-sm font-semibold">${sup.waiting.length === 1 ? 'A shopper wants to talk' : `${sup.waiting.length} shoppers want to talk`}</div><div class="text-[11px] text-ink-muted">Open the call window to answer.</div></div></div><button type="button" data-action="support-open-console" class="w-full px-3 py-2 rounded-md text-xs font-semibold bg-success text-white">Open call window</button></div>`;
    icons();
    return;
  }
  const list = sup.presence === 'online' && !sup.active ? sup.waiting : [];
  const baseTitle = document.documentElement.dataset.title || document.title.replace(/^📞 /, '');
  document.documentElement.dataset.title = baseTitle;
  if (!list.length) {
    stopRing();
    box.innerHTML = '';
    box.hidden = true;
    document.title = baseTitle;
    return;
  }
  box.hidden = false;
  document.title = `📞 Incoming call · ${baseTitle}`;
  startRing();
  box.innerHTML = list.map((c) => `<div class="w-[360px] max-w-[92vw] rounded-lg bg-surface border border-line-strong shadow-lg p-4 space-y-3" role="alertdialog" aria-label="Incoming call from a shopper">
    <div class="flex items-center gap-3"><span class="relative w-10 h-10 rounded-full bg-success-soft text-success-text flex items-center justify-center shrink-0"><i data-lucide="phone-incoming" class="w-5 h-5"></i><span class="absolute inset-0 rounded-full border-2 border-success animate-ping opacity-40"></span></span>
      <div class="min-w-0"><div class="text-sm font-semibold truncate">${esc(c.customer?.name || c.customer?.email || 'A shopper')} wants to talk</div><div class="text-[11px] text-ink-muted truncate">${esc(c.customer?.email || c.customer?.phone || 'Visitor on your store')}</div></div></div>
    ${c.reason ? `<p class="text-xs text-ink-secondary">“${esc(c.reason)}”</p>` : ''}
    <div class="flex flex-wrap gap-1.5">${c.recording?.consent ? '<span class="px-2 py-0.5 text-[10px] font-semibold rounded-pill bg-danger-soft text-danger-text">Shopper agreed to a recording</span>' : '<span class="px-2 py-0.5 text-[10px] font-semibold rounded-pill bg-subtle text-ink-secondary">No recording</span>'}</div>
    <div class="flex gap-2"><button type="button" data-action="support-accept" data-id="${esc(c.id)}" class="flex-1 px-3 py-2 rounded-md text-xs font-semibold bg-success text-white">Accept</button><button type="button" data-action="support-reject" data-id="${esc(c.id)}" class="flex-1 px-3 py-2 rounded-md text-xs font-medium border border-line-subtle hover:bg-subtle">Reject</button></div></div>`).join('');
  icons();
}

function releasePending() {
  sup.pendingAccept?.local?.getTracks().forEach((t) => t.stop());
  sup.pendingAccept = null;
}

export async function acceptCall(callId) {
  if (sup.active || sup.pendingAccept) return toast('Finish your current call first', '', 'warning');
  if (!navigator.mediaDevices?.getUserMedia) return toast('This browser cannot make audio calls', 'Open the dashboard in a current browser over a secure connection.', 'danger');
  let local;
  try {
    // audio only: the camera is never asked for
    local = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}, video: false});
  } catch {
    return toast('Microphone blocked', 'Allow the microphone for this page (the lock icon in the address bar), then accept again. The shopper keeps waiting.', 'danger');
  }
  sup.pendingAccept = {callId, local};
  send({type: 'accept', callId});
}

export function rejectCall(callId) {
  send({type: 'reject', callId});
  sup.waiting = sup.waiting.filter((c) => c.id !== callId);
  renderIncoming();
}

// ---- the call --------------------------------------------------------------------------------------------------------
function createPeer(a) {
  const pc = new RTCPeerConnection({iceServers: sup.ice.length ? sup.ice : [{urls: 'stun:stun.l.google.com:19302'}]});
  a.pc = pc;
  a.queued = [];
  // which kinds of address each side found (host = this network, srflx = through STUN, relay = through TURN): when the audio
  // cannot connect, this says why (no relay server means two different networks cannot reach each other)
  a.kinds = {local: new Set(), remote: new Set()};
  a.local.getAudioTracks().forEach((t) => pc.addTrack(t, a.local));
  pc.onicecandidate = (e) => { if (e.candidate) { a.kinds.local.add((/ typ (w+)/.exec(e.candidate.candidate) || [])[1] || 'unknown'); send({type: 'signal', callId: a.call.id, kind: 'candidate', data: e.candidate}); } };
  pc.ontrack = (e) => {
    a.remote = e.streams[0] || new MediaStream([e.track]);
    a.audioEl = document.createElement('audio');
    a.audioEl.autoplay = true;
    a.audioEl.setAttribute('playsinline', '');
    a.audioEl.style.display = 'none';
    document.body.appendChild(a.audioEl);
    a.audioEl.srcObject = a.remote;
    a.audioEl.play?.().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (sup.active !== a) return;
    if (pc.connectionState === 'connected') { send({type: 'connected', callId: a.call.id}); }
    else if (pc.connectionState === 'disconnected') { a.status = 'reconnecting'; renderDock(); }
    else if (pc.connectionState === 'failed') { send({type: 'hangup', callId: a.call.id, reason: `audio failed (this side: ${[...a.kinds.local].join(',') || 'nothing'}; shopper: ${[...a.kinds.remote].join(',') || 'nothing'}; relay ${sup.turn ? 'on' : 'NOT set up'})`}); toast('The audio connection failed', 'The call was closed. Ask the shopper to try again.', 'danger'); closeActive('failed'); }
  };
  return pc;
}

async function onAccepted(call) {
  const pending = sup.pendingAccept;
  if (!pending || pending.callId !== call.id) return;
  sup.pendingAccept = null;
  sup.waiting = sup.waiting.filter((c) => c.id !== call.id);
  const a = {call, local: pending.local, status: 'connecting', muted: false, startedAt: 0, chat: [], recording: Boolean(call.recording?.consent), recChunks: [], recBytes: 0, withdrawn: false};
  sup.active = a;
  createPeer(a);
  renderIncoming();
  renderPresence();
  renderDock();
  loadChat();
  changed();
}

async function onSignal(msg) {
  const a = sup.active;
  if (!a || a.call.id !== msg.callId || !a.pc) return;
  try {
    if (msg.kind === 'offer') {
      await a.pc.setRemoteDescription(msg.data);
      for (const c of a.queued.splice(0)) await a.pc.addIceCandidate(c).catch(() => {});
      const answer = await a.pc.createAnswer();
      await a.pc.setLocalDescription(answer);
      send({type: 'signal', callId: a.call.id, kind: 'answer', data: a.pc.localDescription});
    } else if (msg.kind === 'candidate') {
      a.kinds.remote.add((/ typ (w+)/.exec(msg.data?.candidate || '') || [])[1] || 'unknown');
      if (a.pc.remoteDescription) await a.pc.addIceCandidate(msg.data).catch(() => {});
      else a.queued.push(msg.data);
    }
  } catch (error) {
    console.error('[support] signal failed', error);
  }
}

function onConnected(call) {
  const a = sup.active;
  if (!a || a.call.id !== call.id) return;
  a.call = {...a.call, ...call};
  a.status = 'connected';
  // "connected" arrives again whenever either side's connection blips and returns: the call began once, and is recorded once
  if (!a.startedAt) a.startedAt = Date.now();
  a.recording = Boolean(call.recording?.consent);
  if (a.recording && sup.recordingAllowed && !a.rec && !a.withdrawn) startRecording(a);
  renderDock();
  renderPresence();
  changed();
}

// ---- recording: both sides, only while the shopper's consent stands -----------------------------------------------------------
function startRecording(a) {
  try {
    if (!window.MediaRecorder || !a.remote) throw new Error('not supported');
    const Ctx = window.AudioContext || window.webkitAudioContext;
    a.ctx = new Ctx();
    // a context made outside a click can start suspended, and a suspended one records silence
    if (a.ctx.state === 'suspended') a.ctx.resume().catch(() => {});
    const dest = a.ctx.createMediaStreamDestination();
    a.ctx.createMediaStreamSource(a.local).connect(dest);
    a.ctx.createMediaStreamSource(a.remote).connect(dest);
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    a.rec = new MediaRecorder(dest.stream, {...(mime ? {mimeType: mime} : {}), audioBitsPerSecond: 24000});
    a.recMime = a.rec.mimeType || mime || 'audio/webm';
    a.rec.ondataavailable = (e) => {
      if (!e.data?.size || a.withdrawn) return;
      a.recChunks.push(e.data);
      a.recBytes += e.data.size;
      // stay within what the server keeps: the audio so far is saved, not lost
      if (a.recBytes > 13.5 * 1024 * 1024 && a.rec.state === 'recording') a.rec.stop();
    };
    a.rec.start(4000);
  } catch (error) {
    console.warn('[support] recording could not start', error);
    reportRecordingFailed(a.call.id, 'The browser could not record this call.');
    a.recording = false;
  }
}

function onWithdrawn() {
  const a = sup.active;
  if (!a) return;
  a.withdrawn = true;
  a.recording = false;
  a.recChunks = [];
  try { if (a.rec?.state === 'recording') a.rec.stop(); } catch { /* already stopped */ }
  toast('The shopper stopped the recording', 'Nothing from this call will be saved.', 'warning');
  renderDock();
}

async function reportRecordingFailed(callId, error) {
  try { await authed('POST', `/support/calls/${encodeURIComponent(callId)}/recording-failed`, {body: JSON.stringify({error}), headers: {'Content-Type': 'application/json'}}); } catch { /* the call record keeps "not saved" */ }
}

async function finishRecording(a) {
  if (!a.rec || a.withdrawn) return;
  await new Promise((resolve) => {
    if (a.rec.state === 'inactive') return resolve();
    a.rec.onstop = resolve;
    try { a.rec.stop(); } catch { resolve(); }
  });
  try { a.ctx?.close(); } catch { /* closed */ }
  if (!a.recChunks.length) return;
  const blob = new Blob(a.recChunks, {type: a.recMime.split(';')[0] || 'audio/webm'});
  const seconds = a.startedAt ? Math.round((Date.now() - a.startedAt) / 1000) : 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await authed('POST', `/support/calls/${encodeURIComponent(a.call.id)}/recording?duration=${seconds}`, {body: blob, headers: {'Content-Type': blob.type}});
      if (res.ok) { toast('Recording saved', 'It is attached to this conversation.'); return; }
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break; // the server refused it; retrying cannot help
    } catch { /* offline: try again */ }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  toast('The recording could not be saved', 'The call is in your history without audio.', 'danger');
  reportRecordingFailed(a.call.id, 'The upload failed.');
}

function onEnded(call) {
  if (sup.active && sup.active.call.id === call.id) {
    toast(call.status === 'ended' ? 'Call ended' : 'The call could not be completed', call.failureReason || '', call.status === 'ended' ? 'success' : 'warning');
    closeActive(call.status);
  }
  sup.waiting = sup.waiting.filter((c) => c.id !== call.id);
  renderIncoming();
  changed();
}

async function closeActive() {
  const a = sup.active;
  if (!a) return;
  sup.active = null;
  clearInterval(a.timer);
  clearInterval(sup.chatTimer);
  stopLevels(a);
  const recording = finishRecording(a);
  try { a.pc?.close(); } catch { /* closed */ }
  a.local?.getTracks().forEach((t) => t.stop());
  if (a.audioEl) { a.audioEl.srcObject = null; a.audioEl.remove(); }
  renderDock();
  renderPresence();
  changed();
  await recording;
  changed();
}

export function hangUp() {
  const a = sup.active;
  if (!a) return;
  send({type: 'hangup', callId: a.call.id});
  closeActive();
}
export function toggleMute() {
  const a = sup.active;
  if (!a) return;
  a.muted = !a.muted;
  a.local.getAudioTracks().forEach((t) => { t.enabled = !a.muted; });
  renderDock();
}

// ---- the call panel ---------------------------------------------------------------------------------------------------------
function levels(a) {
  stopLevels(a);
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !a.remote) return;
    a.lvCtx = new Ctx();
    const an = a.lvCtx.createAnalyser();
    an.fftSize = 64;
    a.lvCtx.createMediaStreamSource(a.remote).connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    a.lvTimer = setInterval(() => {
      const bars = document.querySelectorAll('#support-dock .sup-wave i');
      if (!bars.length) return;
      an.getByteFrequencyData(data);
      bars.forEach((b, i) => b.style.setProperty('--h', String(Math.max(0.12, data[Math.min(data.length - 1, Math.floor((i / bars.length) * data.length))] / 255).toFixed(2))));
    }, 90);
    document.querySelector('#support-dock .sup-wave')?.classList.add('driven');
  } catch { /* the animated bars stay */ }
}
function stopLevels(a) {
  clearInterval(a.lvTimer);
  try { a.lvCtx?.close(); } catch { /* closed */ }
}

const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

function renderDock() {
  const dock = $('support-dock');
  if (!dock) return;
  const a = sup.active;
  if (!a) { dock.hidden = true; dock.innerHTML = ''; clearInterval(sup.dockTimer); return; }
  const c = a.call;
  const who = c.customer?.name || c.customer?.email || 'Shopper';
  dock.hidden = false;
  if (!dock.dataset.callId || dock.dataset.callId !== c.id) {
    dock.dataset.callId = c.id;
    dock.innerHTML = `<div class="flex items-center justify-between gap-2 px-4 py-3 border-b border-line-subtle">
        <div class="min-w-0"><div class="text-sm font-semibold truncate" id="sup-who"></div><div class="text-[11px] text-ink-muted" id="sup-sub"></div></div>
        <span class="tabular-nums text-sm font-semibold" id="sup-timer" aria-label="Call duration">00:00</span></div>
      <div class="px-4 pt-3"><div class="sup-wave" aria-hidden="true">${Array.from({length: 26}, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>
        <div id="sup-rec" class="mt-2"></div></div>
      <div class="px-4 py-3 flex items-center justify-center gap-3">
        <button type="button" data-action="support-mute" id="sup-mute" class="w-11 h-11 rounded-full border border-line-subtle bg-surface flex items-center justify-center hover:bg-subtle" aria-label="Mute microphone"><i data-lucide="mic" class="w-5 h-5"></i></button>
        <button type="button" data-action="support-end" class="px-4 h-11 rounded-full bg-danger text-white text-xs font-semibold flex items-center gap-1.5"><i data-lucide="phone-off" class="w-4 h-4"></i>End call</button>
        ${sup.mode === 'console' ? '' : '<button type="button" data-action="support-open-chat" class="px-3 h-11 rounded-full border border-line-subtle text-xs font-medium hover:bg-subtle">Open chat</button>'}</div>
      <div class="border-t border-line-subtle bg-subtle/40"><div id="sup-chat" class="max-h-48 overflow-y-auto px-4 py-2 space-y-1.5 text-xs" aria-live="polite"></div>
        <form id="sup-reply" class="flex gap-2 p-3 border-t border-line-subtle"><input id="sup-reply-input" maxlength="1000" autocomplete="off" placeholder="Type to the shopper while you talk" aria-label="Message to the shopper" class="flex-1 px-3 py-2 text-xs rounded-md border border-line-subtle bg-surface focus-ring" /><button class="px-3 rounded-md text-xs font-semibold bg-accent-gradient text-white">Send</button></form></div>`;
    clearInterval(sup.dockTimer);
    sup.dockTimer = setInterval(() => { const t = $('sup-timer'); if (t && sup.active?.startedAt) t.textContent = mmss(Date.now() - sup.active.startedAt); }, 1000);
    icons();
  }
  $('sup-who').textContent = who;
  $('sup-sub').textContent = a.status === 'connected' ? [c.customer?.email, c.customer?.phone].filter(Boolean).join(' · ') || 'Connected' : a.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting the audio…';
  const mute = $('sup-mute');
  mute.classList.toggle('bg-danger-soft', a.muted);
  mute.setAttribute('aria-pressed', String(a.muted));
  mute.setAttribute('aria-label', a.muted ? 'Unmute microphone' : 'Mute microphone');
  mute.innerHTML = `<i data-lucide="${a.muted ? 'mic-off' : 'mic'}" class="w-5 h-5"></i>`;
  $('sup-rec').innerHTML = a.recording ? '<span class="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-semibold rounded-pill bg-danger-soft text-danger-text"><span class="w-2 h-2 rounded-full bg-danger animate-pulse"></span>Recording (shopper agreed' + (a.call?.recording?.consentAt ? ' at ' + new Date(a.call.recording.consentAt).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}) : '') + ')</span>' : (a.withdrawn ? '<span class="px-2 py-0.5 text-[11px] rounded-pill bg-subtle text-ink-secondary">Recording stopped by the shopper</span>' : '<span class="px-2 py-0.5 text-[11px] rounded-pill bg-subtle text-ink-secondary">Not recording</span>');
  if (a.status === 'connected' && !a.lvTimer) levels(a);
  icons();
}

async function loadChat() {
  const a = sup.active;
  if (!a?.call.conversationId) return;
  clearInterval(sup.chatTimer);
  const pull = async () => {
    if (sup.active !== a) return;
    try {
      const out = await getConversation(a.call.conversationId);
      a.chat = out.messages.slice(-30);
      const box = $('sup-chat');
      if (!box) return;
      const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
      box.innerHTML = a.chat.map((m) => `<div class="flex ${m.role === 'user' ? 'justify-start' : 'justify-end'}"><span class="max-w-[85%] px-2.5 py-1.5 rounded-md ${m.role === 'user' ? 'bg-slate-800 text-white' : m.role === 'staff' ? 'bg-success text-white' : 'bg-surface border border-line-subtle'} whitespace-pre-wrap break-words">${esc(m.text)}</span></div>`).join('');
      if (atEnd) box.scrollTop = box.scrollHeight;
    } catch { /* the next round tries again */ }
  };
  await pull();
  sup.chatTimer = setInterval(pull, 3500);
}

document.addEventListener('submit', async (e) => {
  if (!(e.target instanceof HTMLFormElement) || e.target.id !== 'sup-reply') return;
  e.preventDefault();
  const input = $('sup-reply-input');
  const text = input.value.trim();
  const a = sup.active;
  if (!text || !a?.call.conversationId) return;
  input.disabled = true;
  try {
    await sendReply(a.call.conversationId, text);
    input.value = '';
    await loadChat();
  } catch (error) {
    toast('Could not send', error instanceof ApiError ? error.message : 'Try again.', 'danger');
  }
  input.disabled = false;
  input.focus();
});

// ---- start ---------------------------------------------------------------------------------------------------------------------
export async function initSupport() {
  try {
    const res = await authed('GET', '/support/state');
    if (!res.ok) return;
    const data = await res.json();
    sup.me = data.me || '';
    sup.team = data.team || [];
    sup.waiting = data.waiting || [];
    sup.enabled = Boolean(data.capabilities?.liveHandoffEnabled && data.capabilities?.audioCallEnabled);
    sup.recordingAllowed = Boolean(data.recordingAllowed);
    sup.metrics = data.metrics;
    sup.turn = Boolean(data.turnConfigured);
  } catch { return; }
  sup.delegate = sup.mode === 'embedded' && !microphoneAllowedHere();
  if (sup.delegate) {
    // no microphone here: show who is on and what is waiting, and send the team member to the call window
    renderPresence();
    renderIncoming();
    clearInterval(sup.poll);
    if (sup.enabled) sup.poll = setInterval(() => { if (!document.hidden) initSupport(); }, 8000);
    changed();
    return;
  }
  sup.name = store.get('orbi-rep-name') || '';
  const saved = store.get('orbi-presence');
  sup.presence = ['online', 'away', 'offline'].includes(saved) ? saved : 'offline';
  if (sup.presence === 'online' && !sup.name) sup.presence = 'away';
  renderPresence();
  const wanted = sup.enabled;
  if (wanted && !sup.wanted) { sup.wanted = true; connect(); }
  if (!wanted && sup.wanted) { sup.wanted = false; try { sup.ws?.close(1000, 'off'); } catch { /* closed */ } }
  renderIncoming();
  changed();
}

/** After the owner changes the support settings: connect, or let go, without a page reload. */
export const refreshSupport = debounce(() => initSupport(), 300);

/** Opens the call window. The window is opened on the click itself (pop-up blockers), then pointed at its one-time ticket. */
export async function openConsole() {
  if (sup.win && !sup.win.closed) { sup.win.focus(); return; }
  const win = window.open('', 'orbi-calls', 'popup=yes,width=460,height=780');
  if (!win) return toast('Your browser blocked the call window', 'Allow pop-ups for this page, then try again.', 'warning');
  sup.win = win;
  const fail = (why) => {
    // never close the window silently: say what went wrong, in the window and here
    try { win.document.body.textContent = `Could not open the call window: ${why}`; win.document.body.style.cssText = 'font:14px system-ui;padding:20px;color:#991b1b'; } catch { /* closed */ }
    toast('Could not open the call window', why, 'danger');
  };
  try {
    win.document.title = 'Calls';
    win.document.body.textContent = 'Opening…';
    const res = await authed('POST', '/support/console-ticket', {body: '{}', headers: {'Content-Type': 'application/json'}});
    if (res.status === 404) return fail('the server does not have this feature yet. Restart the server (npm start) and reload the dashboard.');
    if (res.status === 401) return fail('your Shopify session expired. Reload the dashboard and try again.');
    if (!res.ok) return fail(`the server answered ${res.status}.`);
    const {ticket} = await res.json();
    win.location.href = `/admin/console.html#ticket=${encodeURIComponent(ticket)}`;
  } catch (error) {
    fail(error instanceof ApiError ? error.message : 'the server could not be reached.');
  }
  renderPresence();
  renderIncoming();
}

// the clicks the markup above names (the page's one listener calls these through `actions`)
export const supportActions = {
  'support-accept': (el) => acceptCall(el.getAttribute('data-id')),
  'support-reject': (el) => rejectCall(el.getAttribute('data-id')),
  'support-end': () => hangUp(),
  'support-mute': () => toggleMute(),
  'support-open-console': () => openConsole(),
  'support-open-chat': async () => {
    const a = sup.active;
    if (!a?.call.conversationId) return toast('The chat is still being linked', 'Try again in a moment.', 'warning');
    state.openConv = a.call.conversationId;
    (await import('./app.js')).show('conversations');
  },
};

window.addEventListener('beforeunload', (e) => {
  if (sup.active) { e.preventDefault(); e.returnValue = ''; }
});
