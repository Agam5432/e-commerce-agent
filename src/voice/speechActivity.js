// How much the shopper actually spoke recently, measured from the microphone audio itself.
// Speech recognisers sometimes "hear" words in silence or hiss (a phrase in another language, a
// stray word). A transcript that arrives when the microphone carried almost no voice is one of those.
// Works the same for every language: it only looks at loudness against the room's own noise level.
// Cheap: one pass over a sample of the audio, no pitch or frequency analysis.

const envNumber = (env, name, fallback) => {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

/** Loudness (RMS, 0..1) of 16-bit little-endian PCM in base64, read every `stride`-th sample. */
export function pcmLevel(base64Data, stride = 4) {
  const buf = Buffer.from(String(base64Data || ""), "base64");
  const samples = Math.floor(buf.length / 2);
  if (!samples) return 0;
  let energy = 0;
  let n = 0;
  for (let i = 0; i < samples; i += stride) {
    const s = buf.readInt16LE(i * 2) / 32768;
    energy += s * s;
    n++;
  }
  return Math.sqrt(energy / n);
}

export function createSpeechActivity({
  env = process.env,
  now = Date.now,
  sampleRate = 16000,
  // a transcript needs at least this much voiced audio in the last `windowMs`; 0 turns the check off
  minVoicedMs = envNumber(env, "VOICE_MIN_VOICED_MS", 200),
  windowMs = envNumber(env, "VOICE_SPEECH_WINDOW_MS", 5000),
  // below this loudness nothing counts as voice, however quiet the room
  minLevel = envNumber(env, "VOICE_SPEECH_MIN_LEVEL", 0.003),
  // voice must be this many times louder than the room's background noise
  floorRatio = envNumber(env, "VOICE_SPEECH_NOISE_RATIO", 3),
} = {}) {
  let floor = 0;
  let observed = 0;
  let lastVoiceAt = -Infinity;
  let extraWaited = 0;
  const voiced = [];

  const prune = () => {
    const since = now() - windowMs;
    while (voiced.length && voiced[0].at < since) voiced.shift();
  };

  return {
    /** One chunk of microphone audio (16 kHz, 16-bit mono PCM, base64). */
    observe(base64Data) {
      const bytes = Math.floor((String(base64Data || "").length * 3) / 4);
      const durationMs = (bytes / 2 / sampleRate) * 1000;
      if (!durationMs) return false;
      const level = pcmLevel(base64Data);
      observed++;
      const isVoice = level >= Math.max(minLevel, floor * floorRatio);
      // the noise floor falls quickly in a pause and rises slowly, so speech does not become "background"
      floor = level < floor ? floor * 0.7 + level * 0.3 : floor * 0.99 + level * 0.01;
      if (isVoice) {
        voiced.push({ at: now(), ms: durationMs });
        lastVoiceAt = now();
      }
      prune();
      return isVoice;
    },
    voicedMs() {
      prune();
      return voiced.reduce((sum, v) => sum + v.ms, 0);
    },
    /**
     * How much longer to wait before answering: while the shopper's voice is still coming in (voice in
     * the last `stillSpeakingMs`), wait that long again, up to `maxExtraMs` in all for one answer. 0 = answer now.
     */
    waitBeforeAnswer({ stillSpeakingMs = 350, maxExtraMs = 2500 } = {}) {
      if (now() - lastVoiceAt >= stillSpeakingMs || extraWaited >= maxExtraMs) return 0;
      const wait = Math.min(stillSpeakingMs, maxExtraMs - extraWaited);
      extraWaited += wait;
      return wait;
    },
    /** An answer started: the next one may wait again. */
    answered() {
      extraWaited = 0;
    },
    /** True unless audio was received and almost none of it, recently, was voice. */
    heardSpeech() {
      if (minVoicedMs <= 0 || observed === 0) return true;
      return this.voicedMs() >= minVoicedMs;
    },
  };
}
