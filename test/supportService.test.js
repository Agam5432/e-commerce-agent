// Live human support, against a real (temporary) MongoDB: the rules that need atomic updates and unique indexes.
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startTempMongo } from "./helpers/tempMongo.js";
import SupportCall from "../src/models/SupportCall.js";
import SupportPresence from "../src/models/SupportPresence.js";
import SupportRecording from "../src/models/SupportRecording.js";
import Conversation from "../src/models/Conversation.js";
import Message from "../src/models/Message.js";
import Booking from "../src/models/Booking.js";
import * as svc from "../src/services/supportService.js";

const SHOP = "alpha.myshopify.com";
const OTHER = "beta.myshopify.com";
const ON = { support: { liveEnabled: true, audioEnabled: true, recordingEnabled: true } };
const mongo = await startTempMongo();
const skip = mongo.available ? false : "no mongod on this machine (set MONGOD_PATH to run these)";
let clock = Date.now();
const now = () => clock;
const over = { now };

before(async () => {
  if (!mongo.available) return;
  await Promise.all([SupportCall, SupportPresence, SupportRecording, Conversation, Message, Booking].map((m) => m.init()));
});
after(async () => { await mongo.stop?.(); });
beforeEach(async () => {
  if (!mongo.available) return;
  clock = Date.now();
  await Promise.all([SupportCall, SupportPresence, SupportRecording, Conversation, Message, Booking].map((m) => m.deleteMany({})));
});

async function chat(shop = SHOP, chatRef = "chat-a") {
  return Conversation.create({ shop, chatRef, industry: "ecommerce", channel: "text", startedAt: new Date(), lastMessageAt: new Date(), messageCount: 2, expiresAt: new Date(Date.now() + 86400000 * 30), contact: { name: "Riya", email: "riya@example.com" } });
}
const online = (id, shop = SHOP) => svc.setPresence(shop, { representativeId: id, name: `Rep ${id}`, status: "online" }, over);
const ask = (extra = {}) => svc.requestCall({ shop: SHOP, chatRef: "chat-a", customer: { name: "Riya" }, reason: "wants a person", settings: ON, ...extra }, over);

test("nobody is asked to take a call when nobody is free, and nothing is created", { skip }, async () => {
  const out = await ask();
  assert.equal(out.status, "unavailable");
  assert.equal(await SupportCall.countDocuments({}), 0);
  assert.equal(out.capabilities.representativesAvailable, false);
});

test("a store that has not switched live help on offers nothing", { skip }, async () => {
  await online("1");
  assert.equal((await ask({ settings: {} })).status, "disabled");
  assert.equal((await ask({ settings: { support: { liveEnabled: true, audioEnabled: false } } })).status, "disabled");
});

test("a free team member makes a request; asking twice gives the same one", { skip }, async () => {
  const c = await chat();
  await online("1");
  const first = await ask();
  assert.equal(first.status, "requested");
  assert.equal(first.call.status, "requested");
  const second = await ask();
  assert.equal(second.call.id, first.call.id);
  assert.equal(second.existing, true);
  assert.equal(await SupportCall.countDocuments({}), 1);
  const mirrored = await Conversation.findById(c._id).lean();
  assert.equal(mirrored.support.status, "requested");
  assert.equal(mirrored.flags.needsFollowUp, true);
});

test("two requests racing from the same chat never make two open calls", { skip }, async () => {
  await online("1");
  const results = await Promise.all([ask(), ask(), ask()]);
  assert.equal(await SupportCall.countDocuments({}), 1);
  assert.equal(new Set(results.map((r) => r.call.id)).size, 1);
});

test("two team members accepting at the same moment: exactly one gets the call", { skip }, async () => {
  await chat();
  await online("1");
  await online("2");
  const { call } = await ask();
  const settled = await Promise.allSettled([svc.acceptCall(SHOP, call.id, { representativeId: "1", name: "A" }, over), svc.acceptCall(SHOP, call.id, { representativeId: "2", name: "B" }, over)]);
  assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
  const lost = settled.find((s) => s.status === "rejected");
  assert.ok(["taken", "gone"].includes(lost.reason.code), lost.reason.code);
  const stored = await SupportCall.findById(call.id).lean();
  assert.equal(stored.status, "accepted");
  const winner = stored.representative.id;
  const team = await svc.listPresence(SHOP, over);
  assert.equal(team.find((p) => p.id === winner).state, "busy");
  assert.equal(team.find((p) => p.id !== winner).state, "online", "the one who lost is free again");
});

test("someone already on a call cannot take a second one", { skip }, async () => {
  await online("1");
  await online("2");
  const first = (await ask()).call;
  await svc.acceptCall(SHOP, first.id, { representativeId: "1" }, over);
  const second = (await svc.requestCall({ shop: SHOP, chatRef: "chat-b", settings: ON }, over)).call;
  await assert.rejects(svc.acceptCall(SHOP, second.id, { representativeId: "1" }, over), (e) => e.code === "not_available");
  await svc.acceptCall(SHOP, second.id, { representativeId: "2" }, over);
});

test("a person who is offline or has gone quiet cannot take a call", { skip }, async () => {
  await online("1");
  const { call } = await ask();
  await svc.setPresence(SHOP, { representativeId: "2", status: "offline" }, over);
  await assert.rejects(svc.acceptCall(SHOP, call.id, { representativeId: "2" }, over), (e) => e.code === "not_available");
  clock += 5 * 60_000;
  await assert.rejects(svc.acceptCall(SHOP, call.id, { representativeId: "1" }, over), (e) => e.code === "not_available");
  assert.equal((await svc.listPresence(SHOP, over)).find((p) => p.id === "1").state, "offline");
});

test("passing on a request: the next person can still take it; when everyone has passed the shopper is told", { skip }, async () => {
  await online("1");
  await online("2");
  const { call } = await ask();
  const one = await svc.rejectCall(SHOP, call.id, "1", over);
  assert.equal(one.closed, false);
  await assert.rejects(svc.acceptCall(SHOP, call.id, { representativeId: "1" }, over));
  const two = await svc.rejectCall(SHOP, call.id, "2", over);
  assert.equal(two.closed, true);
  assert.equal((await SupportCall.findById(call.id).lean()).status, "unanswered");
  // and the chat can ask again
  assert.equal((await ask()).status, "requested");
});

test("a call goes accepted, connected, ended: duration, summary line, team member free, need cleared", { skip }, async () => {
  const c = await chat();
  await online("1");
  const { call } = await ask();
  await svc.acceptCall(SHOP, call.id, { representativeId: "1", name: "Asha" }, over);
  assert.equal((await svc.markConnected(SHOP, call.id, over)).status, "connected");
  clock += 125_000;
  await svc.setPresence(SHOP, { representativeId: "1" }, over); // the dashboard keeps reporting in during the call
  const ended = await svc.endCall(SHOP, call.id, { by: "team" }, over);
  assert.equal(ended.status, "ended");
  assert.ok(ended.durationSec >= 120 && ended.durationSec <= 126, String(ended.durationSec));
  const line = await Message.findOne({ shop: SHOP, "call.callId": call.id }).lean();
  assert.match(line.text, /Audio call with Asha · Duration 02:0\d · Completed/);
  assert.equal(line.role, "staff");
  assert.equal((await svc.listPresence(SHOP, over)).find((p) => p.id === "1").state, "online");
  assert.equal((await Conversation.findById(c._id).lean()).flags.needsFollowUp, false);
  assert.equal(await svc.endCall(SHOP, call.id, {}, over), null, "ending twice changes nothing");
});

test("a call that never got audio is failed, not completed", { skip }, async () => {
  await chat();
  await online("1");
  const { call } = await ask();
  await svc.acceptCall(SHOP, call.id, { representativeId: "1" }, over);
  const out = await svc.endCall(SHOP, call.id, { by: "shopper" }, over);
  assert.equal(out.status, "failed");
  assert.match((await Message.findOne({ shop: SHOP, "call.callId": call.id }).lean()).text, /Could not connect/);
});

test("the shopper cancelling while waiting closes it and frees the team", { skip }, async () => {
  await online("1");
  const { call } = await ask();
  const out = await svc.cancelCall(SHOP, "chat-a", call.id, over);
  assert.equal(out.call.status, "cancelled");
  assert.equal(await svc.cancelCall(SHOP, "chat-a", call.id, over), null);
  assert.equal((await ask()).status, "requested", "a new request is allowed after cancelling");
});

test("a store only ever sees and changes its own calls", { skip }, async () => {
  await online("1");
  await online("1", OTHER);
  const { call } = await ask();
  assert.equal(await svc.getCall(OTHER, call.id), null);
  assert.equal(await svc.callForChat(OTHER, "chat-a", call.id), null);
  await assert.rejects(svc.acceptCall(OTHER, call.id, { representativeId: "1" }, over), (e) => e.code === "not_found" || e.code === "gone");
  assert.equal(await svc.cancelCall(OTHER, "chat-a", call.id, over), null);
  assert.deepEqual(await svc.waitingFor(OTHER, "1", over), []);
  assert.equal((await svc.listCalls(OTHER, {})).length, 0);
  assert.equal((await svc.listPresence(OTHER, over)).length, 1);
  assert.equal((await SupportCall.findById(call.id).lean()).status, "requested");
});

test("recording: only with the shopper's consent, never public, and consent can be taken back", { skip }, async () => {
  await chat();
  await online("1");
  const audio = Buffer.from("fake-opus-audio-bytes");
  // declined
  const declined = (await ask()).call;
  assert.equal(declined.recording.consent, false);
  await assert.rejects(svc.saveRecording(SHOP, declined.id, { buffer: audio, mime: "audio/webm", settings: ON }, over), (e) => e.code === "no_consent");
  await svc.cancelCall(SHOP, "chat-a", declined.id, over);
  // agreed
  const { call } = await ask({ recordingConsent: true });
  assert.equal(call.recording.consent, true);
  await svc.acceptCall(SHOP, call.id, { representativeId: "1" }, over);
  await svc.markConnected(SHOP, call.id, over);
  clock += 5000;
  await svc.endCall(SHOP, call.id, {}, over);
  await assert.rejects(svc.saveRecording(SHOP, call.id, { buffer: audio, mime: "text/html", settings: ON }, over), (e) => e.code === "type");
  await assert.rejects(svc.saveRecording(SHOP, call.id, { buffer: audio, mime: "audio/webm", settings: { support: { liveEnabled: true, audioEnabled: true } } }, over), (e) => e.code === "recording_off");
  const saved = await svc.saveRecording(SHOP, call.id, { buffer: audio, mime: "audio/webm;codecs=opus", durationSec: 5, settings: ON }, over);
  assert.equal(saved.recording.available, true);
  assert.equal((await Message.findOne({ shop: SHOP, "call.callId": call.id }).lean()).call.recording, true);
  const back = await svc.recordingBytes(SHOP, call.id, {}, over);
  assert.equal(back.bytes.toString(), "fake-opus-audio-bytes");
  assert.equal(back.mime, "audio/webm");
  assert.ok(await svc.recordingBytes(SHOP, call.id, { chatRef: "chat-a" }, over), "the shopper's own chat may hear it");
  assert.equal(await svc.recordingBytes(SHOP, call.id, { chatRef: "chat-z" }, over), null, "another chat may not");
  assert.equal(await svc.recordingBytes(OTHER, call.id, {}, over), null, "another store may not");
});

test("withdrawing consent stops saving: the upload is refused afterwards", { skip }, async () => {
  await chat();
  await online("1");
  const { call } = await ask({ recordingConsent: true });
  await svc.acceptCall(SHOP, call.id, { representativeId: "1" }, over);
  const out = await svc.withdrawRecording(SHOP, "chat-a", call.id, over);
  assert.equal(out.recording.consent, false);
  assert.equal(out.recording.status, "withdrawn");
  await assert.rejects(svc.saveRecording(SHOP, call.id, { buffer: Buffer.from("x"), mime: "audio/webm", settings: ON }, over), (e) => e.code === "no_consent");
  assert.equal(await svc.withdrawRecording(SHOP, "chat-other", call.id, over), null, "only the chat that owns the call can withdraw");
});

test("an oversized recording is refused", { skip }, async () => {
  await chat();
  await online("1");
  const { call } = await ask({ recordingConsent: true });
  const big = Buffer.alloc(svc.MAX_RECORDING_BYTES() + 1);
  await assert.rejects(svc.saveRecording(SHOP, call.id, { buffer: big, mime: "audio/webm", settings: ON }, over), (e) => e.code === "too_large");
});

test("the sweeper closes a request nobody answered, and a call whose team member vanished", { skip }, async () => {
  await chat();
  await online("1");
  const waiting = (await ask()).call;
  clock += svc.REQUEST_TTL_MS() + 1000;
  let closed = await svc.sweepSupport(over);
  assert.deepEqual(closed.map((c) => c.call.id), [waiting.id]);
  assert.equal(closed[0].call.status, "unanswered");
  clock += 1000;
  await online("1");
  const { call } = await ask();
  await svc.acceptCall(SHOP, call.id, { representativeId: "1" }, over);
  await svc.markConnected(SHOP, call.id, over);
  clock += svc.PRESENCE_FRESH_MS() * 3;
  closed = await svc.sweepSupport(over);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].call.status, "ended");
  assert.equal((await SupportCall.findById(call.id).lean()).status, "ended");
});

test("the metrics are counted from the database", { skip }, async () => {
  await chat();
  await online("1");
  await online("2");
  await online("3");
  const a = (await ask()).call;
  await svc.acceptCall(SHOP, a.id, { representativeId: "1" }, over);
  await svc.requestCall({ shop: SHOP, chatRef: "chat-b", settings: ON }, over);
  const m = await svc.supportMetrics(SHOP, ON, over);
  assert.equal(m.online, 2);
  assert.equal(m.busy, 1);
  assert.equal(m.activeCalls, 1);
  assert.equal(m.waiting, 1);
  assert.equal((await svc.supportMetrics(OTHER, ON, over)).online, 0);
});

test("capabilities say all busy only when everyone on is on a call", { skip }, async () => {
  await online("1");
  const { call } = await ask();
  await svc.acceptCall(SHOP, call.id, { representativeId: "1" }, over);
  const caps = await svc.supportCapabilities(SHOP, ON, over);
  assert.equal(caps.representativesAvailable, false);
  assert.equal(caps.allRepresentativesBusy, true);
  const none = await svc.supportCapabilities(OTHER, ON, over);
  assert.equal(none.allRepresentativesBusy, false, "nobody on is not the same as everybody busy");
});

test("ICE servers: STUN by default, TURN only when configured, with short-lived credentials when a secret is set", () => {
  assert.deepEqual(svc.iceServers({}).map((s) => s.urls), [["stun:stun.l.google.com:19302"]]);
  const fixed = svc.iceServers({ SUPPORT_TURN_URLS: "turn:t.example.com:3478", SUPPORT_TURN_USERNAME: "u", SUPPORT_TURN_CREDENTIAL: "p" });
  assert.equal(fixed[1].username, "u");
  const temp = svc.iceServers({ SUPPORT_TURN_URLS: "turn:t.example.com:3478", SUPPORT_TURN_SECRET: "s3cret" }, 1_000_000);
  assert.match(temp[1].username, /^\d+:orbi$/);
  assert.ok(temp[1].credential.length > 10);
  assert.equal(svc.iceServers({ SUPPORT_TURN_URLS: "turn:t.example.com" }).length, 1, "a TURN address without credentials is not used");
  assert.equal(svc.turnConfigured({}), false);
});

// ---- the AI's tool ---------------------------------------------------------------------------------------------------
import ecommerce from "../src/industries/ecommerce.js";
import { admin as ecommerceAdmin } from "../src/industries/ecommerce/analytics.js";

const session = (settings) => ecommerce.createSession(SHOP, { llmMode: true, clientId: "ai1", userMessage: "connect me with a human", replyLanguage: "en", settings }, { loadCheckout: async () => null, saveCheckout: async () => null });

test("the AI's tool is only available when the store offers live audio help", () => {
  assert.deepEqual(ecommerceAdmin.liveSupportTools({}), ["request_human_support"]);
  assert.deepEqual(ecommerceAdmin.liveSupportTools({ support: { liveEnabled: true, audioEnabled: false } }), ["request_human_support"]);
  assert.deepEqual(ecommerceAdmin.liveSupportTools(ON), []);
  assert.deepEqual(ecommerceAdmin.inactiveTools({}), ["get_call_slots", "book_call"], "the booking tools keep their own rule");
});

test("asking for a person on a store without live help offers nothing and shows no call", { skip }, async () => {
  const s = session({});
  const out = await s.handlers.request_human_support({ reason: "wants a person" });
  assert.equal(out.status, "not_offered");
  assert.equal(s.result().actions.length, 0);
  assert.match(out.note, /flag_for_owner/);
});

test("the tool reports what the backend knows and never says a person has joined", { skip }, async () => {
  await chat();
  const none = session(ON);
  const first = await none.handlers.request_human_support({ reason: "wants a person" });
  assert.equal(first.status, "offered");
  assert.equal(first.representativesAvailable, false);
  assert.equal(first.allRepresentativesBusy, false, "nobody on is not 'everyone is busy'");
  assert.match(first.note, /Do NOT say a person has joined/);
  assert.deepEqual(none.result().actions.map((a) => [a.type, a.available]), [["human_support", false]]);
  await online("1");
  const some = session(ON);
  const second = await some.handlers.request_human_support({ reason: "again" });
  assert.equal(second.representativesAvailable, true);
  assert.equal(some.result().actions[0].available, true);
  const { analytics } = await import("../src/industries/ecommerce/analytics.js");
  assert.equal(analytics.eventsFromResult(some.result()).some((e) => e.type === "human_requested"), true);
  assert.equal(analytics.flagsFromResult(some.result()).needsFollowUp, true);
});

test("when a call ends the chat goes back to the AI, even if the team member typed during the call", { skip }, async () => {
  const c = await chat();
  await online("1");
  const { call } = await ask();
  await svc.acceptCall(SHOP, call.id, { representativeId: "1", name: "Asha" }, over);
  assert.equal((await Conversation.findById(c._id).lean()).handoff.active, true, "the AI is quiet while the call is on");
  // the team member also types a reply during the call (this rewrites the handoff, as a normal reply does)
  await Conversation.updateOne({ _id: c._id }, { $set: { "handoff.active": true, "handoff.by": "1" } });
  await svc.markConnected(SHOP, call.id, over);
  clock += 3000;
  await svc.setPresence(SHOP, { representativeId: "1" }, over);
  await svc.endCall(SHOP, call.id, {}, over);
  assert.equal((await Conversation.findById(c._id).lean()).handoff?.active, undefined);
});

test("a chat a person took over by hand is not given back when a call ends", { skip }, async () => {
  const c = await chat();
  await Conversation.updateOne({ _id: c._id }, { $set: { "handoff.active": true, "handoff.by": "owner" } });
  await online("1");
  const { call } = await ask();
  await svc.cancelCall(SHOP, "chat-a", call.id, over);
  assert.equal((await Conversation.findById(c._id).lean()).handoff.active, true);
});

test("a plain heartbeat keeps the name a team member chose", { skip }, async () => {
  await svc.setPresence(SHOP, { representativeId: "9", name: "Meera", status: "online" }, over);
  await svc.setPresence(SHOP, { representativeId: "9" }, over);
  const row = (await svc.listPresence(SHOP, over)).find((p) => p.id === "9");
  assert.equal(row.name, "Meera");
  assert.equal(row.state, "online");
});

test("a request nobody took in time does not block the shopper asking again before the sweeper runs", { skip }, async () => {
  await chat();
  await online("1");
  const first = await ask();
  clock += svc.REQUEST_TTL_MS() + 1000; // expired, but the sweeper has not closed it yet
  await online("1"); // the team member is still there (presence refreshed)
  const again = await ask();
  assert.equal(again.status, "requested");
  assert.notEqual(again.call.id, first.call.id);
  assert.equal(again.existing, undefined);
  assert.equal(again.closedStale.id, first.call.id);
  assert.equal(again.closedStale.status, "unanswered");
  assert.equal(await SupportCall.countDocuments({ status: "requested" }), 1);
});
