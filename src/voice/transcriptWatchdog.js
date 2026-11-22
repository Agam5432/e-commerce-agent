// Gemini Live can keep a connection open and keep receiving the shopper's audio, yet stop writing any of it down: the shopper speaks,
// the mic shows "Listening…", and nothing ever happens (a live voice test on TechStore, 2026-11-22: after a few turns, clear speech got
// no transcript until the connection was replaced). This notices that case: a real stretch of speech, then silence, and still no words
// from Gemini. The caller then opens a fresh connection and plays that speech into it again, so the shopper does not have to repeat it.

const envNumber = (env, key, fallback) => {
  const value = Number(env?.[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export function createTranscriptWatchdog({
  env = process.env,
  now = Date.now,
  sampleRate = 16000,
  // this much voiced audio counts as someone saying something (a cough or a click does not)
  minVoicedMs = envNumber(env, "VOICE_WATCHDOG_MIN_VOICED_MS", 700),
  // how long after the speech stopped Gemini may take to write it down
  silenceAfterMs = envNumber(env, "VOICE_WATCHDOG_WAIT_MS", 3500),
  // a fresh connection at most this often
  cooldownMs = envNumber(env, "VOICE_WATCHDOG_COOLDOWN_MS", 15000),
  // audio kept for replay
  keepMs = 15000,
} = {}) {
  const recent = [];
  let utteranceStart = 0;
  let voicedMs = 0;
  let lastVoiceAt = 0;
  let lastTranscriptAt = 0;
  let lastRotateAt = -Infinity;

  const reset = () => {
    utteranceStart = 0;
    voicedMs = 0;
  };

  return {
    /** Every chunk of microphone audio, with whether it held voice. */
    audio(chunk, isVoice) {
      const at = now();
      recent.push({ at, chunk });
      while (recent.length && recent[0].at < at - keepMs) recent.shift();
      if (!isVoice) return;
      const bytes = Math.floor((String(chunk || "").length * 3) / 4);
      if (!utteranceStart) utteranceStart = at;
      voicedMs += (bytes / 2 / sampleRate) * 1000;
      lastVoiceAt = at;
    },
    /** Gemini wrote something down: it is working. */
    transcript() {
      lastTranscriptAt = now();
      reset();
    },
    /** The speech to play into a fresh connection when Gemini went quiet on it, otherwise null. */
    stuck() {
      if (!utteranceStart) return null;
      const at = now();
      if (lastTranscriptAt >= utteranceStart) {
        reset();
        return null;
      }
      if (voicedMs < minVoicedMs || at - lastVoiceAt < silenceAfterMs) return null;
      const from = utteranceStart - 500;
      reset();
      if (at - lastRotateAt < cooldownMs) return null;
      lastRotateAt = at;
      return recent.filter((item) => item.at >= from).map((item) => item.chunk);
    },
  };
}
