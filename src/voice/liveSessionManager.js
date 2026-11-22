// Rotate Gemini connections without losing the browser socket, shopping state,
// or a currently running order. Audio is bounded and buffered while reconnecting.
//
// With manualActivity, this side (not Gemini) says when the shopper starts and stops talking: Gemini's own voice detection
// sometimes never noticed clear speech in a live test (no "voice activity", so no transcript), while the server's own speech
// detector saw it every time. Each chunk comes with whether it held voice; speech is wrapped in activityStart / activityEnd.
export function createLiveSessionManager({
  connect,
  onTranscript,
  onStatus = () => {},
  onFatal = () => {},
  onEvent = () => {},
  retryDelayMs = 250,
  maxRetries = 2,
  maxPending = 40,
  maxReplay = 400,
  replayPaceMs = 0.9,
  manualActivity = false,
  // silence that ends the shopper's turn (Gemini's own setting was 900 ms)
  endSilenceMs = 900,
  // audio kept from just before speech was noticed, so the first syllable is not cut
  prerollChunks = 8,
  now = Date.now,
}) {
  let closed = false;
  let current = null;
  let generation = 0;
  let retryTimer = null;
  let failures = 0;
  let handle;
  let connectedAt = 0;
  let replaying = false;
  let speaking = false;
  let lastVoiceAt = 0;
  const preroll = [];
  // items: { data } for audio, { activity: "start" | "end" } for turn edges
  const pending = [];
  const replayQueue = [];

  const deliver = (session, item) => {
    if (item.activity === "start") session.sendRealtimeInput({ activityStart: {} });
    else if (item.activity === "end") session.sendRealtimeInput({ activityEnd: {} });
    else session.sendRealtimeInput({ audio: { data: item.data, mimeType: "audio/pcm;rate=16000" } });
  };

  function restart(failed) {
    if (closed || retryTimer !== null) return;
    if (failed && ++failures > maxRetries) { close(); onFatal(); return; }
    onStatus("Reconnecting voice; your cart and checkout are saved.");
    retryTimer = setTimeout(() => { retryTimer = null; void open(); }, failed ? retryDelayMs : 0);
  }
  async function open() {
    if (closed) return;
    const epoch = ++generation;
    const previous = current;
    current = null;
    try { previous?.close(); } catch { /* Already closed. */ }
    try {
      const session = await connect((text, meta) => { if (!closed && epoch === generation) onTranscript(text, meta); }, {
        resumptionHandle: handle,
        manualActivity,
        onEvent: (event) => { try { onEvent({ ...event, gen: epoch }); } catch { /* diagnostics only */ } },
        onResumptionUpdate: value => { if (epoch === generation) handle = value; },
        onGoAway: () => { if (epoch === generation) restart(false); },
        onClose: () => {
          if (epoch !== generation) return;
          if (connectedAt && Date.now() - connectedAt > 5000) failures = 0;
          restart(true);
        },
      });
      if (closed || epoch !== generation) { session.close(); return; }
      current = session;
      connectedAt = Date.now();
      onStatus("Listening");
      // a new connection knows nothing of a turn the old one had open: speech still going on starts a fresh one
      if (manualActivity && speaking && !replayQueue.length) pending.unshift({ activity: "start" });
      // replayed speech goes in at about real speed (Gemini wrote nothing for a burst of it in a live test), then whatever
      // arrived meanwhile
      const replay = replayQueue.splice(0);
      const step = () => {
        if (closed || epoch !== generation || current !== session) return;
        const item = replay.shift();
        if (item === undefined) {
          replaying = false;
          while (pending.length && current === session) send(pending.shift());
          return;
        }
        try { deliver(session, item); } catch { /* the next restart handles it */ }
        const ms = item.data ? Math.floor((String(item.data).length * 3) / 4) / 32 : 0;
        setTimeout(step, replayPaceMs && ms ? Math.max(1, Math.round(ms * replayPaceMs)) : 0);
      };
      replaying = replay.length > 0;
      if (replaying) step();
      else while (pending.length && current === session) send(pending.shift());
    } catch {
      handle = undefined;
      if (epoch === generation) restart(true);
    }
  }
  function send(item) {
    if (closed) return;
    if (!current || replaying) {
      pending.push(item);
      const cap = replaying ? maxReplay : maxPending;
      while (pending.length > cap) pending.shift();
      return;
    }
    try { deliver(current, item); }
    catch { pending.push(item); while (pending.length > maxPending) pending.shift(); restart(true); }
  }
  /** One chunk of microphone audio; `voiced` (manual mode) says whether it held speech. */
  function sendAudio(data, voiced = false) {
    if (closed) return;
    if (!manualActivity) { send({ data }); return; }
    const t = now();
    if (voiced) {
      lastVoiceAt = t;
      if (!speaking) {
        speaking = true;
        send({ activity: "start" });
        for (const before of preroll.splice(0)) send({ data: before });
      }
      send({ data });
      return;
    }
    if (speaking) {
      send({ data });
      if (t - lastVoiceAt >= endSilenceMs) {
        speaking = false;
        send({ activity: "end" });
      }
      return;
    }
    // between turns only a little audio is kept, for the start of the next one
    preroll.push(data);
    while (preroll.length > prerollChunks) preroll.shift();
  }
  /** The shopper's turn is over (the server is answering): Gemini is told now instead of waiting for more silence. */
  function endTurn() {
    if (!manualActivity || !speaking || closed) return;
    speaking = false;
    send({ activity: "end" });
  }
  // A fresh Gemini connection, fed again with the audio of what the shopper just said: used when Gemini stopped writing down speech it
  // clearly received (the socket stays open and "Listening" stays on screen, so nothing else would ever notice).
  function rotate(replay = []) {
    if (closed) return false;
    pending.length = 0;
    replayQueue.length = 0;
    const chunks = replay.slice(-maxReplay).map((data) => ({ data }));
    if (chunks.length) {
      if (manualActivity) replayQueue.push({ activity: "start" }, ...chunks, { activity: "end" });
      else replayQueue.push(...chunks);
    }
    restart(false);
    // audio from now on waits for the fresh connection instead of going into the one being replaced
    const previous = current;
    current = null;
    try { previous?.close(); } catch { /* Already closed. */ }
    return true;
  }
  // A fresh connection while nothing is being said (after each answer): a Gemini connection that has gone deaf is never
  // waited on by the next question.
  function refresh() {
    if (closed || replaying || speaking) return false;
    return rotate([]);
  }
  function close() {
    if (closed) return;
    closed = true;
    generation++;
    clearTimeout(retryTimer);
    pending.length = 0;
    replayQueue.length = 0;
    try { current?.close(); } catch { /* Already closed. */ }
    current = null;
  }
  return { start: open, sendAudio, endTurn, rotate, refresh, close };
}
