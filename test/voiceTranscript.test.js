import test from "node:test";
import assert from "node:assert/strict";
import { isLikelyEcho, speechWindowMs } from "../src/voice/transcriptUtils.js";
import { createSpeechActivity } from "../src/voice/speechActivity.js";
import { createLiveSessionManager } from "../src/voice/liveSessionManager.js";

test("billing confirmation and spoken addresses cannot be discarded as echo", () => {
  const answer = "Is your shipping address the same as your billing address or would you like another?";
  // the shopper answers once the assistant has finished speaking (heard while it speaks, the same words would be its echo)
  const finished = Date.now() - speechWindowMs(answer) - 500;
  assert.equal(isLikelyEcho("Shipping address is same as billing address", answer, finished), false);
  assert.equal(isLikelyEcho("Yeah, it is same", answer, Date.now()), false);
  assert.equal(isLikelyEcho("My address is 10 New Road Delhi India 110001 please use this address", answer, Date.now()), false);
});
test("a long exact assistant fragment can still be detected as echo", () => {
  const answer = "Here are some useful products for your journey and the rest of your trip today";
  assert.equal(isLikelyEcho(answer, answer, Date.now()), true);
  assert.equal(isLikelyEcho(answer, answer, Date.now() - 60000), false);
});
test("GoAway reconnects with a resumption handle without closing the shopper session", async () => {
  const sessions = [];
  let reconnected;
  const nextConnection = new Promise(resolve => { reconnected = resolve; });
  let fatal = false;
  const manager = createLiveSessionManager({ connect: async (transcript, callbacks) => {
    const session = { callbacks, audio: [], sendRealtimeInput(input) { this.audio.push(input); }, close() { callbacks.onClose(); } };
    sessions.push(session);
    return session;
  }, onTranscript: () => {}, onFatal: () => { fatal = true; }, onStatus: status => { if (status === "Listening" && sessions.length === 2) reconnected(); } });
  await manager.start();
  sessions[0].callbacks.onResumptionUpdate("resume-test");
  sessions[0].callbacks.onGoAway();
  await nextConnection;
  assert.equal(sessions[1].callbacks.resumptionHandle, "resume-test");
  manager.sendAudio("test-audio");
  assert.equal(sessions[1].audio.length, 1);
  assert.equal(fatal, false);
  manager.close();
});
test("failed reconnect attempts are bounded", async () => {
  let attempts = 0;
  let failed;
  const exhausted = new Promise(resolve => { failed = resolve; });
  const manager = createLiveSessionManager({ connect: async () => { attempts++; throw new Error("offline"); }, onTranscript: () => {}, retryDelayMs: 0, maxRetries: 2, onFatal: failed });
  await manager.start();
  await exhausted;
  assert.equal(attempts, 3);
});


test("a pause mid-sentence waits while the shopper's voice is still coming in, in any language", () => {
  let t = 0;
  const speech = createSpeechActivity({ env: {}, now: () => t });
  const pcm = (amp) => {
    const b = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) b.writeInt16LE(Math.round(Math.sin(i / 3) * amp * 32767), i * 2);
    return b.toString("base64");
  };
  for (let i = 0; i < 10; i++) { speech.observe(pcm(0.0005)); t += 100; }
  assert.equal(speech.waitBeforeAnswer(), 0, "silent: answer now");
  speech.observe(pcm(0.2)); // they start again
  t += 100;
  assert.equal(speech.waitBeforeAnswer({ stillSpeakingMs: 350, maxExtraMs: 800 }), 350);
  assert.equal(speech.waitBeforeAnswer({ stillSpeakingMs: 350, maxExtraMs: 800 }), 350);
  assert.equal(speech.waitBeforeAnswer({ stillSpeakingMs: 350, maxExtraMs: 800 }), 100, "never more than the cap in all");
  assert.equal(speech.waitBeforeAnswer({ stillSpeakingMs: 350, maxExtraMs: 800 }), 0);
  speech.answered();
  assert.equal(speech.waitBeforeAnswer({ stillSpeakingMs: 350, maxExtraMs: 800 }), 350, "the next answer may wait again");
  t += 400;
  assert.equal(speech.waitBeforeAnswer({ stillSpeakingMs: 350, maxExtraMs: 800 }), 0, "quiet for long enough");
});

test("no word lists decide when to answer or what is an echo", async () => {
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const utils = readFileSync(new URL("../src/voice/transcriptUtils.js", import.meta.url), "utf8");
  assert.doesNotMatch(server, /INCOMPLETE_LEADIN|needsMoreSpeech/);
  assert.doesNotMatch(utils, /billing\|shipping|lekin|kyunki/);
  const answer = "Ki aap kis rang ki shirt dekhna chahenge, laal, neela, hara ya kaala, bataiye na";
  assert.equal(isLikelyEcho(answer, answer, Date.now()), true, "an echo in Hinglish is caught too");
  assert.equal(isLikelyEcho("मेरा पता है १२ एमजी रोड पुणे", "मेरा पता है १२ एमजी रोड पुणे", Date.now()), false, "numbers in any script are never an echo");
});
