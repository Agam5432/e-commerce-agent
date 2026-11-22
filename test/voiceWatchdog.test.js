// A Gemini Live connection that keeps receiving speech but stops writing it down is replaced, and the speech is replayed into the
// new one (live voice test on TechStore, 2026-11-22: after a few turns the shopper's words got no transcript at all).
import test from "node:test";
import assert from "node:assert/strict";
import { createTranscriptWatchdog } from "../src/voice/transcriptWatchdog.js";
import { createLiveSessionManager } from "../src/voice/liveSessionManager.js";

// 100 ms of 16 kHz 16-bit audio, base64
const CHUNK = Buffer.alloc(3200).toString("base64");

function clock() {
  let t = 1_000_000;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

test("speech with no transcript is reported once, with the audio to replay", () => {
  const c = clock();
  const w = createTranscriptWatchdog({ now: c.now, env: {} });
  for (let i = 0; i < 5; i++) { w.audio(CHUNK, false); c.tick(100); }
  for (let i = 0; i < 15; i++) { w.audio(CHUNK, true); c.tick(100); } // 1.5 s of speech
  for (let i = 0; i < 20; i++) { w.audio(CHUNK, false); c.tick(100); assert.equal(i < 34 ? w.stuck() : null, null); }
  for (let i = 0; i < 16; i++) { w.audio(CHUNK, false); c.tick(100); }
  const replay = w.stuck();
  assert.ok(Array.isArray(replay) && replay.length >= 15, `replay ${replay && replay.length}`);
  assert.equal(w.stuck(), null, "reported once");
});

test("a transcript means Gemini is working: nothing is replaced", () => {
  const c = clock();
  const w = createTranscriptWatchdog({ now: c.now, env: {} });
  for (let i = 0; i < 15; i++) { w.audio(CHUNK, true); c.tick(100); }
  w.transcript();
  for (let i = 0; i < 50; i++) { w.audio(CHUNK, false); c.tick(100); }
  assert.equal(w.stuck(), null);
});

test("a short noise is not speech", () => {
  const c = clock();
  const w = createTranscriptWatchdog({ now: c.now, env: {} });
  for (let i = 0; i < 3; i++) { w.audio(CHUNK, true); c.tick(100); }
  for (let i = 0; i < 60; i++) { w.audio(CHUNK, false); c.tick(100); }
  assert.equal(w.stuck(), null);
});

test("rotate opens a fresh connection and plays the replayed speech into it first", async () => {
  const sessions = [];
  const connect = async () => {
    const sent = [];
    const session = { sent, sendRealtimeInput: ({ audio }) => sent.push(audio.data), close() { session.closed = true; } };
    sessions.push(session);
    return session;
  };
  const m = createLiveSessionManager({ connect, onTranscript: () => {} });
  await m.start();
  m.sendAudio("live1");
  assert.equal(m.rotate(["r1", "r2", "r3"]), true);
  m.sendAudio("during");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].closed, true);
  assert.deepEqual(sessions[1].sent, ["r1", "r2", "r3", "during"]);
});

// Clearing the chat ends a half-done checkout: its open question ("is billing the same?") must not answer itself later.
test("abandonCheckoutInProgress resets every checkout step but keeps saved addresses", async () => {
  const { default: CheckoutSession } = await import("../src/models/CheckoutSession.js");
  const { abandonCheckoutInProgress } = await import("../src/services/checkoutSessionService.js");
  const original = { update: CheckoutSession.findOneAndUpdate, find: CheckoutSession.findOne };
  let update = null;
  const address = { name: "Agam QA Test", address1: "221 Test Street", city: "Mohali", zip: "160071", country: "IN" };
  CheckoutSession.findOneAndUpdate = (_filter, u) => { update = u; return { lean: async () => ({}) }; };
  CheckoutSession.findOne = () => ({ lean: async () => ({ shipping: address, lastOrderShipping: null, step: "billing_inquiry" }) });
  try {
    await abandonCheckoutInProgress("techstore.myshopify.com", "c_1");
  } finally {
    CheckoutSession.findOneAndUpdate = original.update;
    CheckoutSession.findOne = original.find;
  }
  const set = update.$set;
  assert.equal(set.step, "cart");
  assert.equal(set.billingConfirmed, false);
  assert.equal(set.shippingConfirmed, false);
  assert.equal(set.billing, null);
  assert.equal(set.shipping, null, "the address is not used silently in the next chat");
  assert.equal(set.lastCartSnapshot, null, "nor brought back from the copy kept beside the cart");
  assert.deepEqual(set.lastOrderShipping, address, "it is offered for reuse instead");
});

test("refresh after an answer opens a fresh connection; audio meanwhile is kept for it", async () => {
  const sessions = [];
  const connect = async () => {
    const sent = [];
    const session = { sent, sendRealtimeInput: ({ audio }) => sent.push(audio.data), close() { session.closed = true; } };
    sessions.push(session);
    return session;
  };
  const m = createLiveSessionManager({ connect, onTranscript: () => {} });
  await m.start();
  assert.equal(m.refresh(), true);
  m.sendAudio("next-question");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].closed, true);
  assert.deepEqual(sessions[1].sent, ["next-question"]);
});

test("manual activity: speech is wrapped in activityStart / activityEnd, with the audio just before it", async () => {
  let t = 0;
  const sent = [];
  const connect = async () => ({ sendRealtimeInput: (m) => sent.push(m.activityStart ? "START" : m.activityEnd ? "END" : m.audio.data), close() {} });
  const m = createLiveSessionManager({ connect, onTranscript: () => {}, manualActivity: true, now: () => t, prerollChunks: 2 });
  await m.start();
  for (const [data, voiced] of [["q1", false], ["q2", false], ["q3", false], ["v1", true], ["v2", true], ["s1", false]]) { m.sendAudio(data, voiced); t += 100; }
  t += 1000;
  m.sendAudio("s2", false);
  m.sendAudio("q4", false);
  assert.deepEqual(sent, ["START", "q2", "q3", "v1", "v2", "s1", "s2", "END"]);
});

test("manual activity: the server ending the turn ends it for Gemini at once", async () => {
  const sent = [];
  const connect = async () => ({ sendRealtimeInput: (m) => sent.push(m.activityStart ? "START" : m.activityEnd ? "END" : m.audio.data), close() {} });
  const m = createLiveSessionManager({ connect, onTranscript: () => {}, manualActivity: true });
  await m.start();
  m.sendAudio("v1", true);
  m.endTurn();
  m.endTurn();
  assert.deepEqual(sent, ["START", "v1", "END"]);
});
