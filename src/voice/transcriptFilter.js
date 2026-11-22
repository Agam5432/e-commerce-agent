// Which voice transcripts are not the shopper talking. No word lists: each rule is a fact about the
// text or the audio, and works for every language the assistant serves.
//  - no_words:            nothing but punctuation or symbols
//  - unsupported_script:  mostly written in a script none of the reply languages use
//  - no_speech_heard:     the microphone carried almost no voice when it was "heard"
//                         (speech recognisers invent words in silence or hiss)
// Short answers ("ok", "haan", "naa", "hmm") are kept: telling a hesitation from a real one-word
// answer needs the meaning, which the AI has and these rules do not.
import { supportedScripts } from "../services/language.js";

const LETTER = /\p{L}/u;
const WORD = /[\p{L}\p{N}]/u;

/** Share of the letters written in none of `scripts` (0 when there are no letters). */
export function foreignScriptShare(text, scripts) {
  const letters = [...String(text || "").normalize("NFC")].filter((ch) => LETTER.test(ch));
  if (!letters.length) return 0;
  const known = scripts.map((name) => new RegExp(`\\p{Script=${name}}`, "u"));
  const foreign = letters.filter((ch) => !known.some((re) => re.test(ch))).length;
  return foreign / letters.length;
}

export function createTranscriptFilter({ env = process.env, scripts = supportedScripts(env) } = {}) {
  return {
    scripts,
    /** Why this transcript should be ignored, or "" to keep it. */
    reasonToIgnore(text, { heardSpeech = true } = {}) {
      const clean = String(text || "").trim();
      if (!clean) return "";
      if (!WORD.test(clean)) return "no_words";
      if (foreignScriptShare(clean, scripts) > 0.5) return "unsupported_script";
      if (!heardSpeech) return "no_speech_heard";
      return "";
    },
  };
}
