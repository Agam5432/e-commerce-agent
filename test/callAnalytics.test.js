// Customer 360 and call accountability, against a real (temporary) MongoDB: who handled each call, how calls are counted,
// that an AI voice session and the person it was passed to are one interaction, and that one store never sees another's.
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startTempMongo } from "./helpers/tempMongo.js";
import SupportCall from "../src/models/SupportCall.js";
import SupportPresence from "../src/models/SupportPresence.js";
import SupportRecording from "../src/models/SupportRecording.js";
import Conversation from "../src/models/Conversation.js";
import Message from "../src/models/Message.js";
import Booking from "../src/models/Booking.js";
import Event from "../src/models/Event.js";
import Complaint from "../src/models/Complaint.js";
import * as svc from "../src/services/supportService.js";
import * as stats from "../src/admin/stats.js";
import * as callStats from "../src/admin/callAnalytics.js";
import express from "express";
import { createAdminRouter } from "../src/admin/routes.js";
import { recordVoiceSession } from "../src/services/voiceSessionLog.js";
import { chatRefFor } from "../src/services/conversationLog.js";

const SHOP = "alpha.myshopify.com";
const OTHER = "beta.myshopify.com";
const ON = { support: { liveEnabled: true, audioEnabled: true, recordingEnabled: true } };
const MODELS = [SupportCall, SupportPresence, SupportRecording, Conversation, Message, Booking, Event, Complaint];
const mongo = await startTempMongo();
const skip = mongo.available ? false : "no mongod on this machine (set MONGOD_PATH to run these)";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let clock = Date.now();
const over = { now: () => clock };

before(async () => { if (mongo.available) await Promise.all(MODELS.map((m) => m.init())); });
after(async () => { await mongo.stop?.(); });
beforeEach(async () => { if (mongo.available) { clock = Date.now(); await Promise.all(MODELS.map((m) => m.deleteMany({}))); } });

const range = (days = 7) => stats.parseRange({ from: new Date(Date.now() - (days - 1) * DAY).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }, "UTC");
let n = 0;
/** A call row as the database would hold it, with only what a test cares about. */
async function call(over = {}) {
  n += 1;
  const at = over.requestedAt || new Date(Date.now() - HOUR);
  return SupportCall.collection.insertOne({
    shop: SHOP, chatRef: `chat-${n}`, status: "ended", callType: "audio", customer: { name: "", email: "", phone: "", customerId: "" }, reason: "",
    requestedAt: at, expiresAt: new Date(+at + 90_000), keepUntil: new Date(Date.now() + 30 * DAY), ...over,
  }).then((r) => r.insertedId);
}
const rep = (id, name = `Rep ${id}`) => ({ "representative": { id, name } });
const handled = (id, name = `Rep ${id}`) => ({ representative: { id, name }, assignedTo: { type: "human", id, name }, handledBy: { type: "human", id, name } });

test("a call that is taken, connected and ended records who took it, who handled it, and writes one event with no personal data", { skip }, async () => {
  await svc.setPresence(SHOP, { representativeId: "u-77", name: "Asha", status: "online" }, over);
  const asked = await svc.requestCall({ shop: SHOP, chatRef: "chat-a", customer: { name: "Riya", email: "riya@example.com", phone: "+91 98765 43210", customerId: "5551234" }, reason: "damaged item", settings: ON }, over);
  assert.equal(asked.call.personKey, "c5551234", "the call belongs to the signed-in customer");
  assert.equal(asked.call.initiatedBy, "customer");
  assert.equal(asked.call.assignedTo, null, "nobody has it yet");
  clock += 5000;
  const taken = await svc.acceptCall(SHOP, asked.call.id, { representativeId: "u-77", name: "Asha" }, over);
  assert.deepEqual(taken.assignedTo, { type: "human", id: "u-77", name: "Asha" });
  assert.deepEqual(taken.handledBy, { type: "human", id: "u-77", name: "Asha" });
  clock += 4000;
  await svc.markConnected(SHOP, asked.call.id, over);
  clock += 60_000;
  const ended = await svc.endCall(SHOP, asked.call.id, { by: "shopper" }, over);
  assert.equal(ended.status, "ended");
  const row = await SupportCall.findById(asked.call.id).lean();
  assert.equal(row.handlingSegments.length, 1);
  assert.equal(row.handlingSegments[0].employeeId, "u-77");
  assert.equal(row.handlingSegments[0].durationSec, 64, "from taking it to letting go");
  assert.ok(row.handlingSegments[0].endedAt);
  const events = await Event.find({ shop: SHOP, type: "support_call_closed" }).lean();
  assert.equal(events.length, 1);
  assert.equal(events[0].props.handlerId, "u-77");
  assert.equal(events[0].props.status, "ended");
  assert.equal(events[0].props.durationSec, 60);
  assert.doesNotMatch(JSON.stringify(events[0]), /riya|98765|damaged/i, "no name, contact or reason in the event");
  // the same call reported closed again does not write a second event
  await svc.endCall(SHOP, asked.call.id, {}, over);
  assert.equal(await Event.countDocuments({ type: "support_call_closed" }), 1);
});

test("a visitor's call is kept under their browser key, and every end state writes its event once", { skip }, async () => {
  await svc.setPresence(SHOP, { representativeId: "u-1", name: "Asha", status: "online" }, over);
  const a = await svc.requestCall({ shop: SHOP, chatRef: "chat-v", customer: {}, settings: ON }, over);
  assert.equal(a.call.personKey, "vchat-v");
  await svc.cancelCall(SHOP, "chat-v", a.call.id, over);
  const b = await svc.requestCall({ shop: SHOP, chatRef: "chat-v", customer: {}, settings: ON }, over);
  clock += 200_000; // nobody took it in time
  await svc.sweepSupport(over);
  const types = (await Event.find({ type: "support_call_closed" }).lean()).map((e) => e.props.status).sort();
  assert.deepEqual(types, ["cancelled", "unanswered"]);
  assert.equal((await SupportCall.findById(b.call.id).lean()).status, "unanswered");
});

test("calls saved before the new fields existed are still read, counted and attributed", { skip }, async () => {
  await call({ ...rep("u-1", "Asha"), durationSec: 120, connectedAt: new Date(), customer: { name: "Old", email: "", phone: "", customerId: "99" } });
  await call({ ...rep("u-1", "Asha"), status: "failed" });
  const out = await callStats.storeCallAnalytics(SHOP, range(), {}, undefined);
  assert.equal(out.human.total, 2);
  assert.equal(out.human.completed, 1);
  assert.equal(out.employees.length, 1);
  assert.equal(out.employees[0].id, "u-1", "the person who took it is the handler");
  assert.equal(out.employees[0].taken, 2);
  assert.equal(out.topCustomers.find((c) => c.id === "c99")?.calls, 1, "an older signed-in call is still the customer's");
  const list = await callStats.listSupportCalls(SHOP, {});
  assert.equal(list.items[0].handledBy.id, "u-1");
  assert.equal(list.items[0].personKey, null);
  assert.equal(list.items[0].initiatedBy, "customer");
});

test("pending and cancelled requests are not missed; an expired or unanswered one is", { skip }, async () => {
  const soon = new Date(Date.now() + 60_000);
  await call({ status: "requested", expiresAt: soon });                              // still waiting: pending
  await call({ status: "accepted", ...rep("u-1"), expiresAt: soon });                // taken, connecting: pending
  await call({ status: "connected", ...rep("u-1"), connectedAt: new Date() });       // talking now: live
  await call({ status: "cancelled" });                                               // the shopper gave up: cancelled
  await call({ status: "unanswered" });                                              // closed, nobody answered: missed
  await call({ status: "requested", expiresAt: new Date(Date.now() - 5000) });       // expired, not yet closed by the sweeper: missed
  await call({ status: "failed" });
  await call({ status: "ended", durationSec: 90, connectedAt: new Date() });
  const out = (await callStats.storeCallAnalytics(SHOP, range(), {})).human;
  assert.deepEqual({ pending: out.pending, live: out.live, cancelled: out.cancelled, missed: out.missed, failed: out.failed, completed: out.completed, total: out.total }, { pending: 2, live: 1, cancelled: 1, missed: 2, failed: 1, completed: 1, total: 8 });
  assert.equal(out.totalDurationSec, 90);
  assert.equal(out.avgDurationSec, 90);
  const missed = await callStats.listSupportCalls(SHOP, { outcome: "missed" });
  assert.equal(missed.total, 2);
  assert.deepEqual(missed.items.map((c) => c.outcome), ["missed", "missed"]);
  await assert.rejects(() => callStats.listSupportCalls(SHOP, { outcome: "nope" }), /outcome must be one of/);
  assert.equal(callStats.outcomeOf({ status: "requested", expiresAt: soon }), "pending");
  assert.equal(callStats.outcomeOf({ status: "cancelled" }), "cancelled");
});

test("an AI voice session passed to a person and that person's call are one interaction, not two", { skip }, async () => {
  const id = await call({ ...handled("u-1", "Asha"), connectedAt: new Date(), durationSec: 200, personKey: "c42", customer: { name: "", email: "", phone: "", customerId: "42" } });
  const base = { shop: SHOP, type: "ai_voice_session", expiresAt: new Date(Date.now() + DAY) };
  await Event.create({ ...base, at: new Date(), chatRef: "x", props: { sessionId: "s1", durationSec: 80, turns: 4, personKey: "c42", handedOff: true, handedOffCallId: String(id) } });
  await Event.create({ ...base, at: new Date(), chatRef: "y", props: { sessionId: "s2", durationSec: 30, turns: 2, personKey: "c42", handedOff: false } });
  const out = await callStats.storeCallAnalytics(SHOP, range(), {});
  assert.equal(out.ai.sessions, 2, "AI sessions on their own");
  assert.equal(out.ai.handedToPerson, 1);
  assert.equal(out.human.completed, 1, "human calls on their own");
  assert.equal(out.interactions, 2, "the handed-over session and its call count once, plus the other session");
  const mine = await callStats.customerCalls(SHOP, { key: "c42" });
  assert.equal(mine.interactions, 2);
  assert.equal(mine.ai.sessions, 2);
  assert.equal(mine.human.total, 1);
});

test("employee-wise numbers attribute each call to the person who really had it", { skip }, async () => {
  await call({ ...handled("u-1", "Asha"), durationSec: 100, connectedAt: new Date() });
  await call({ ...handled("u-1", "Asha"), durationSec: 200, connectedAt: new Date() });
  await call({ ...handled("u-2", "Dev"), durationSec: 50, connectedAt: new Date() });
  await call({ ...handled("u-2", "Dev"), status: "cancelled" });
  await call({ status: "unanswered" }); // nobody had it: no employee
  const { employees } = await callStats.storeCallAnalytics(SHOP, range(), {});
  const asha = employees.find((e) => e.id === "u-1");
  const dev = employees.find((e) => e.id === "u-2");
  assert.equal(employees.length, 2);
  assert.deepEqual([asha.taken, asha.completed, asha.totalDurationSec, asha.avgDurationSec, asha.name], [2, 2, 300, 150, "Asha"]);
  assert.deepEqual([dev.taken, dev.completed, dev.droppedBeforeTalking, dev.totalDurationSec], [2, 1, 1, 50]);
  const theirs = await callStats.listSupportCalls(SHOP, { handler: "u-2" });
  assert.equal(theirs.total, 2);
  assert.ok(theirs.items.every((c) => c.handledBy.id === "u-2"));
});

test("one store never sees another store's calls, customers or call detail", { skip }, async () => {
  const mine = await call({ ...handled("u-1"), personKey: "c1", connectedAt: new Date(), durationSec: 10 });
  const theirs = await call({ shop: OTHER, ...handled("u-9"), personKey: "c1", connectedAt: new Date(), durationSec: 10 });
  assert.equal((await callStats.storeCallAnalytics(SHOP, range(), {})).human.total, 1);
  assert.equal((await callStats.storeCallAnalytics(OTHER, range(), {})).human.total, 1);
  assert.equal((await callStats.listSupportCalls(SHOP, { person: "c1" })).total, 1);
  assert.equal(await callStats.getSupportCall(SHOP, String(theirs)), null);
  assert.ok(await callStats.getSupportCall(SHOP, String(mine)));
  assert.equal((await callStats.customerCalls(SHOP, { key: "c1" })).human.total, 1);
  assert.equal((await callStats.callCountsForPeople(SHOP, ["c1"])).get("c1").calls, 1);
});

test("a range older than the detailed records says so and shows the longer-term counts, never silently incomplete", { skip }, async () => {
  const old = new Date(Date.now() - 200 * DAY);
  await Event.create({ shop: SHOP, type: "support_call_closed", at: old, props: { status: "ended", durationSec: 60 }, expiresAt: new Date(Date.now() + DAY) });
  await Event.create({ shop: SHOP, type: "support_call_closed", at: old, props: { status: "unanswered", durationSec: 0 }, expiresAt: new Date(Date.now() + DAY) });
  const wide = stats.parseRange({ from: new Date(Date.now() - 250 * DAY).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }, "UTC");
  const out = await callStats.storeCallAnalytics(SHOP, wide, { retentionDays: 90 });
  assert.equal(out.coverage.complete, false);
  assert.match(out.coverage.note, /kept for 90 days/);
  assert.equal(out.longTerm.completed, 1);
  assert.equal(out.longTerm.missed, 1);
  assert.equal(out.longTerm.source, "events");
  const recent = await callStats.storeCallAnalytics(SHOP, range(), { retentionDays: 90 });
  assert.equal(recent.coverage.complete, true);
  assert.equal(recent.longTerm, null);
});

test("Customer 360: calls, voice sessions, complaints and callbacks on one profile, without another person who shared the browser", { skip }, async () => {
  const mk = (extra) => Conversation.create({ shop: SHOP, industry: "ecommerce", channel: "text", startedAt: new Date(), lastMessageAt: new Date(), messageCount: 3, expiresAt: new Date(Date.now() + 30 * DAY), ...extra });
  const mine = await mk({ chatRef: "shared-browser", customerRef: "42", personKey: "c42", contact: { name: "Riya", email: "riya@example.com" } });
  await mk({ chatRef: "shared-browser", personKey: "e-someone-else", contact: { name: "Other", email: "other@example.com" } });
  await call({ ...handled("u-1", "Asha"), personKey: "c42", conversationId: mine._id, chatRef: "shared-browser", connectedAt: new Date(), durationSec: 70 });
  await call({ ...handled("u-2", "Dev"), personKey: "e-someone-else", chatRef: "shared-browser", connectedAt: new Date(), durationSec: 10 });
  await Event.create({ shop: SHOP, type: "ai_voice_session", at: new Date(), chatRef: "shared-browser", props: { sessionId: "s1", durationSec: 40, turns: 2, personKey: "c42" }, expiresAt: new Date(Date.now() + DAY) });
  await Complaint.create({ shop: SHOP, chatRef: "shared-browser", conversationId: mine._id, reference: "CMP-AAAAAA", summary: "Cracked", expiresAt: new Date(Date.now() + DAY) });
  await Booking.create({ shop: SHOP, personKey: "c42", conversationId: mine._id, chatRef: "shared-browser", name: "Riya", email: "riya@example.com", phone: "+919876543210", status: "confirmed", startAt: new Date(Date.now() + DAY), endAt: new Date(Date.now() + DAY + 900_000), timezone: "UTC", expiresAt: new Date(Date.now() + 5 * DAY) });
  const profile = await stats.getCustomer(SHOP, "c42", {});
  assert.equal(profile.person.identity, "shopify");
  assert.equal(profile.calls.human.total, 1, "only this person's call, not the other person on the same browser");
  assert.equal(profile.calls.human.completed, 1);
  assert.equal(profile.calls.calls[0].handledBy.name, "Asha");
  assert.equal(profile.calls.ai.sessions, 1);
  assert.equal(profile.calls.interactions, 2, "one human call and one separate AI session");
  assert.equal(profile.complaints.length, 1);
  assert.equal(profile.callbacks.length, 1, "a callback is listed, but it is not in the call counts");
  assert.equal(profile.person.humanCalls, 1);
  // the list carries the same counts
  const list = await stats.listCustomers(SHOP, { from: new Date(Date.now() - DAY).toISOString().slice(0, 10), to: new Date(Date.now() + DAY).toISOString().slice(0, 10) }, {});
  const row = list.items.find((p) => p.id === "c42");
  assert.equal(row.humanCalls, 1);
  assert.equal(row.aiVoiceSessions, 1);
  assert.equal(await stats.getCustomer(OTHER, "c42", {}), null, "another store has no such customer");
});

test("cookie loss and unverified email: nothing is merged and the dashboard says how sure it is", { skip }, async () => {
  const mk = (extra) => Conversation.create({ shop: SHOP, industry: "ecommerce", channel: "text", startedAt: new Date(), lastMessageAt: new Date(), messageCount: 2, expiresAt: new Date(Date.now() + 30 * DAY), ...extra });
  await mk({ chatRef: "VIS_001", personKey: "vVIS_001" });
  await mk({ chatRef: "VIS_009", personKey: "vVIS_009" });                       // the same person after clearing cookies
  await mk({ chatRef: "A", personKey: "eHASH", contact: { email: "same@example.com" } });
  const list = await stats.listCustomers(SHOP, { from: new Date(Date.now() - DAY).toISOString().slice(0, 10), to: new Date(Date.now() + DAY).toISOString().slice(0, 10) }, {});
  const byId = Object.fromEntries(list.items.map((p) => [p.id, p]));
  assert.ok(byId.vVIS_001 && byId.vVIS_009, "two browsers stay two visitors: cookie loss is not recoverable without a sign-in");
  assert.equal(byId.vVIS_001.identity, "visitor_browser");
  assert.equal(byId.eHASH.identity, "guest_unverified_email");
  // a Shopify sign-in is the one thing that ties the new browser back: both chats carry the same verified id
  await mk({ chatRef: "VIS_001", customerRef: "42", personKey: "c42" });
  await mk({ chatRef: "VIS_009", customerRef: "42", personKey: "c42" });
  const signedIn = await stats.getCustomer(SHOP, "c42", {});
  assert.equal(signedIn.conversations.length, 2);
  assert.equal(signedIn.person.identity, "shopify");
});

test("erasing a person removes their name, contact, complaints and recordings from calls, and unlinks their events, but not another person's", { skip }, async () => {
  const mk = (extra) => Conversation.create({ shop: SHOP, industry: "ecommerce", channel: "text", startedAt: new Date(), lastMessageAt: new Date(), messageCount: 2, expiresAt: new Date(Date.now() + 30 * DAY), ...extra });
  const mine = await mk({ chatRef: "shared", customerRef: "42", personKey: "c42", contact: { name: "Riya" } });
  const other = await mk({ chatRef: "shared", personKey: "vother" });
  const myCall = await call({ ...handled("u-1", "Asha"), personKey: "c42", conversationId: mine._id, chatRef: "shared", customer: { name: "Riya", email: "r@e.com", phone: "+911111111111", customerId: "42" }, reason: "damaged", connectedAt: new Date(), durationSec: 30 });
  const otherCall = await call({ ...handled("u-1", "Asha"), personKey: "vother", conversationId: other._id, chatRef: "shared", customer: { name: "Other", email: "", phone: "", customerId: "" }, reason: "refund" });
  await SupportRecording.create({ shop: SHOP, callId: myCall, chatRef: "shared", mime: "audio/webm", size: 3, data: Buffer.from("abc"), expiresAt: new Date(Date.now() + DAY) });
  await Complaint.create({ shop: SHOP, chatRef: "shared", conversationId: mine._id, reference: "CMP-BBBBBB", summary: "x", expiresAt: new Date(Date.now() + DAY) });
  await Event.create({ shop: SHOP, type: "support_call_closed", at: new Date(), chatRef: "shared", conversationId: mine._id, props: { personKey: "c42", status: "ended" }, expiresAt: new Date(Date.now() + DAY) });
  const done = await stats.erasePerson(SHOP, "c42");
  assert.equal(done.calls, 1);
  assert.equal(done.recordings, 1);
  assert.equal(done.complaints, 1);
  const row = await SupportCall.findById(myCall).lean();
  assert.equal(row.customer, undefined);
  assert.equal(row.reason, "");
  assert.equal(row.personKey, undefined);
  assert.equal(row.handledBy.id, "u-1", "who handled it, and that it happened, stay");
  assert.equal(await SupportRecording.countDocuments({}), 0);
  assert.equal(await Complaint.countDocuments({}), 0);
  const ev = await Event.findOne({ type: "support_call_closed" }).lean();
  assert.equal(ev.props.personKey, undefined);
  assert.equal(ev.props.status, "ended", "the count stays");
  const untouched = await SupportCall.findById(otherCall).lean();
  assert.equal(untouched.reason, "refund", "another person on the same browser is not touched");
  assert.equal(untouched.customer.name, "Other");
});

test("an AI voice session is recorded once, with the person it was passed to, and never when nothing was said", { skip }, async () => {
  const clientId = "client-abcdefghijklmnop";
  const startedAt = Date.now() - 90_000;
  assert.equal(await recordVoiceSession({ shop: SHOP, clientId, sessionId: "s0", startedAt, turns: 0 }), false);
  await svc.setPresence(SHOP, { representativeId: "u-1", name: "Asha", status: "online" }, over);
  const asked = await svc.requestCall({ shop: SHOP, chatRef: chatRefFor(SHOP, clientId), customer: { customerId: "42" }, settings: ON }, { now: () => Date.now() });
  const first = await recordVoiceSession({ shop: SHOP, clientId, sessionId: "s1", startedAt, turns: 3, endedBy: "idle", customerId: "gid://shopify/Customer/42" });
  const again = await recordVoiceSession({ shop: SHOP, clientId, sessionId: "s1", startedAt, turns: 3 });
  assert.equal(first, true);
  assert.equal(again, false, "the same session twice writes once");
  const ev = await Event.findOne({ type: "ai_voice_session" }).lean();
  assert.equal(ev.props.handlerType, "ai");
  assert.equal(ev.props.handlerId, "ai-agent");
  assert.equal(ev.props.handedOff, true);
  assert.equal(ev.props.handedOffCallId, asked.call.id);
  assert.equal(ev.props.personKey, "c42");
  assert.ok(ev.props.durationSec >= 89);
});

test("a call window token's tenant is the only one used: the call list needs a store and ignores a store named in the query", { skip }, async () => {
  await call({ shop: OTHER, ...handled("u-9"), personKey: "c1" });
  const out = await callStats.listSupportCalls(SHOP, { person: "c1", handler: "u-9" });
  assert.equal(out.total, 0);
  await assert.rejects(() => callStats.listSupportCalls(SHOP, { person: "../etc" }), /person is not valid/);
  await assert.rejects(() => callStats.listSupportCalls(SHOP, { handler: "a b" }), /handler is not valid/);
});

test("the dashboard API: each store gets only its own calls, a bad filter is a clear 400, an unknown or foreign call is a 404", { skip }, async () => {
  const mine = await call({ ...handled("u-1", "Asha"), personKey: "c1", connectedAt: new Date(), durationSec: 20 });
  const theirs = await call({ shop: OTHER, ...handled("u-9"), personKey: "c1", connectedAt: new Date(), durationSec: 20 });
  const app = express();
  app.use("/admin/api", createAdminRouter({
    auth: (req, _res, next) => { req.shop = req.headers["x-shop"]; req.adminUser = "u-1"; next(); },
    limit: (_req, _res, next) => next(),
    store: async (shop) => ({ shop, name: shop, currency: "USD", timezone: "UTC", industry: "ecommerce" }),
    config: { getAgentSettings: async () => ({}) },
  }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/admin/api`;
  const get = async (path, shop = SHOP) => { const r = await fetch(base + path, { headers: { "x-shop": shop } }); return { status: r.status, body: await r.json() }; };
  try {
    assert.equal((await get("/call-analytics")).body.human.total, 1);
    assert.equal((await get("/call-analytics", OTHER)).body.human.total, 1);
    const list = await get("/call-log?person=c1");
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].id, String(mine));
    assert.equal(list.body.items[0].handledBy.name, "Asha");
    assert.equal((await get(`/call-log/${mine}`)).status, 200);
    assert.equal((await get(`/call-log/${theirs}`)).status, 404, "another store's call");
    assert.equal((await get(`/call-log/${theirs}`, OTHER)).status, 200);
    assert.equal((await get("/call-log/not-an-id")).status, 404);
    assert.equal((await get("/call-log?outcome=bogus")).status, 400);
    assert.equal((await get("/call-log?person=../x")).status, 400);
    assert.equal((await get("/call-analytics?from=2026-13-40&to=2026-01-01")).status, 400, "a bad date range");
    const hasPii = JSON.stringify((await get("/call-analytics")).body);
    assert.doesNotMatch(hasPii, /beta\.myshopify/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
