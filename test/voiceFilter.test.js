// Voice transcripts are kept or ignored by facts about the text and the audio, never by word lists:
// accents, names and Hindi pass; a script no reply language uses, symbols, or words "heard" while the
// microphone carried almost no voice are ignored.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTranscriptFilter, foreignScriptShare } from "../src/voice/transcriptFilter.js";
import { createSpeechActivity, pcmLevel } from "../src/voice/speechActivity.js";
import { supportedScripts, LANGUAGE_SCRIPTS, LANGUAGE_CODES } from "../src/services/language.js";

const filter = createTranscriptFilter({ env: {} });

test("the scripts come from the reply languages, plus any the store adds", () => {
  assert.deepEqual(supportedScripts({}), ["Latin", "Devanagari"]);
  assert.deepEqual(supportedScripts({ VOICE_EXTRA_SCRIPTS: "Arabic, Tamil ,NotAScript" }), ["Latin", "Devanagari", "Arabic", "Tamil"]);
  for (const code of LANGUAGE_CODES) assert.ok(LANGUAGE_SCRIPTS[code]?.length, `${code} has a script`);
});

test("real speech is kept: accents, names, Hindi, Hinglish, short answers, numbers", () => {
  for (const text of ["Café latte for José", "मुझे लाल शर्ट चाहिए", "mujhe red shirt chahiye", "haan", "naa", "ok", "hmm", "the", "9876", "Ça va", "São Paulo delivery?", "Müller ka order"]) {
    assert.equal(filter.reasonToIgnore(text), "", text);
  }
});

test("a transcript mostly in a script no reply language uses is ignored, a stray symbol is not", () => {
  assert.equal(filter.reasonToIgnore("안녕하세요"), "unsupported_script");
  assert.equal(filter.reasonToIgnore("ありがとう"), "unsupported_script");
  assert.equal(filter.reasonToIgnore("Привет"), "unsupported_script");
  assert.equal(filter.reasonToIgnore("iPhone 15 吗"), "", "one foreign letter in a real sentence is kept");
  assert.equal(foreignScriptShare("abc", ["Latin"]), 0);
  assert.equal(foreignScriptShare("ab한국", ["Latin"]), 0.5);
  assert.equal(foreignScriptShare("!!", ["Latin"]), 0);
});

test("a store that serves another script keeps transcripts in it", () => {
  const arabic = createTranscriptFilter({ env: { VOICE_EXTRA_SCRIPTS: "Arabic" } });
  assert.equal(arabic.reasonToIgnore("مرحبا"), "");
  assert.equal(filter.reasonToIgnore("مرحبا"), "unsupported_script");
});

test("only symbols is ignored; words heard without voice on the microphone are ignored", () => {
  assert.equal(filter.reasonToIgnore("..."), "no_words");
  assert.equal(filter.reasonToIgnore("?!"), "no_words");
  assert.equal(filter.reasonToIgnore(""), "");
  assert.equal(filter.reasonToIgnore("chaussettes de gros yeux", { heardSpeech: false }), "no_speech_heard");
  assert.equal(filter.reasonToIgnore("chaussettes de gros yeux", { heardSpeech: true }), "", "spoken French is French, not noise");
});

// ---- the audio side ----------------------------------------------------------------------------
const pcm = (amplitude, ms = 100, rate = 16000) => {
  const n = Math.round((rate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 3) * amplitude * 32767), i * 2);
  return buf.toString("base64");
};

test("loudness is measured from the PCM itself", () => {
  assert.equal(pcmLevel(pcm(0)), 0);
  assert.ok(Math.abs(pcmLevel(pcm(0.5)) - 0.5 / Math.SQRT2) < 0.02);
  assert.equal(pcmLevel(""), 0);
});

test("silence and steady room noise are not speech; a voice above the room is", () => {
  let t = 0;
  const speech = createSpeechActivity({ env: {}, now: () => t });
  assert.equal(speech.heardSpeech(), true, "before any audio, nothing is judged");
  for (let i = 0; i < 30; i++) { speech.observe(pcm(0.0005)); t += 100; }
  assert.equal(speech.heardSpeech(), false, "3 s of near-silence");
  for (let i = 0; i < 50; i++) { speech.observe(pcm(0.01)); t += 100; } // a fan or traffic, steady
  const afterNoise = speech.voicedMs();
  for (let i = 0; i < 20; i++) { speech.observe(pcm(0.01)); t += 100; }
  assert.ok(speech.voicedMs() <= afterNoise, "steady noise becomes the room level and stops counting");
  for (let i = 0; i < 5; i++) { speech.observe(pcm(0.15)); t += 100; }
  assert.equal(speech.heardSpeech(), true, "speech over the noise");
});

test("a quiet microphone still counts as voice above its own silence", () => {
  let t = 0;
  const speech = createSpeechActivity({ env: {}, now: () => t });
  for (let i = 0; i < 20; i++) { speech.observe(pcm(0.0003)); t += 100; }
  for (let i = 0; i < 3; i++) { speech.observe(pcm(0.006)); t += 100; }
  assert.equal(speech.heardSpeech(), true);
});

test("voice counts only within the recent window, and the limits come from the environment", () => {
  let t = 0;
  const speech = createSpeechActivity({ env: { VOICE_SPEECH_WINDOW_MS: "2000", VOICE_MIN_VOICED_MS: "300" }, now: () => t });
  for (let i = 0; i < 3; i++) { speech.observe(pcm(0.2)); t += 100; }
  assert.equal(speech.heardSpeech(), true);
  for (let i = 0; i < 25; i++) { speech.observe(pcm(0)); t += 100; }
  assert.equal(speech.heardSpeech(), false, "the speech was more than 2 s ago");
  const off = createSpeechActivity({ env: { VOICE_MIN_VOICED_MS: "0" }, now: () => t });
  off.observe(pcm(0));
  assert.equal(off.heardSpeech(), true, "0 turns the check off");
});

test("the voice server has no hardcoded noise or foreign-word lists left", () => {
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.doesNotMatch(server, /NOISE_ONLY_RE|FOREIGN_HALLUCINATION_RE|chaussettes|queso|filha/);
  assert.match(server, /transcriptFilter\.reasonToIgnore/);
  assert.match(server, /speech\.observe\(message\.data\)/);
});
