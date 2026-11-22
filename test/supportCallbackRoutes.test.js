// The callback window as the store's database tells it: the booking survives a reload, a closed and reopened window and
// another tab; two shoppers cannot hold one time; a shopper can cancel or move only their own; one store never touches
// another's. Real routes, real (temporary) MongoDB.
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { startTempMongo } from "./helpers/tempMongo.js";
import Booking from "../src/models/Booking.js";
import AgentSettings from "../src/models/AgentSettings.js";
import Conversation from "../src/models/Conversation.js";
import SupportCall from "../src/models/SupportCall.js";
import SupportPresence from "../src/models/SupportPresence.js";
import Complaint from "../src/models/Complaint.js";
import { clearSettingsCache } from "../src/admin/settings.js";
import { chatRefFor } from "../src/services/conversationLog.js";
import * as complaints from "../src/services/complaintService.js";

const SHOP = "alpha.myshopify.com";
const OTHER = "beta.myshopify.com";
const mongo = await startTempMongo();
const skip = mongo.available ? false : "no mongod on this machine (set MONGOD_PATH to run these)";
const MODELS = [Booking, AgentSettings, Conversation, SupportCall, SupportPresence, Complaint];

// the shopper-side routes are rate limited per minute: the tests make far more calls than a shopper would
process.env.SUPPORT_RATE_LIMIT = "100000";
process.env.SUPPORT_REQUEST_RATE_LIMIT = "100000";
const { default: supportProxyRoutes } = await import("../src/routes/supportProxyRoutes.js");

let server;
let base;
before(async () => {
  if (!mongo.available) return;
  await Promise.all(MODELS.map((m) => m.init()));
  const app = express();
  app.use(express.json());
  // what the Shopify app proxy would have verified: the store (never read from the body)
  app.use((req, _res, next) => { req.verifiedShop = req.headers["x-shop"]; req.proxyCustomerId = ""; next(); });
  app.use("/support", supportProxyRoutes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/support`;
});
after(async () => { await new Promise((r) => (server ? server.close(r) : r())); await mongo.stop?.(); });
beforeEach(async () => {
  if (!mongo.available) return;
  clearSettingsCache();
  await Promise.all(MODELS.map((m) => m.deleteMany({})));
  // every day, all day, so there are always free times; no notice needed
  for (const shop of [SHOP, OTHER]) {
    await AgentSettings.create({ shop, booking: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "23:30", slotMinutes: 30, timezone: "UTC", leadHours: 0, maxDaysAhead: 14, autoConfirm: false }, support: { liveEnabled: true, audioEnabled: true } });
  }
});

const post = async (path, body, shop = SHOP) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-shop": shop }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const A = "c_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "c_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const who = { name: "Riya Sharma", phone: "+91 98765 43210", email: "riya@example.com", language: "en" };

async function firstSlots(clientId, shop = SHOP) {
  const { body } = await post("/slots", { clientId }, shop);
  assert.equal(body.enabled, true);
  return body.days.flatMap((d) => d.slots);
}

test("the available dates and times come from the store's rules, and a booked time is not offered to anyone else", { skip }, async () => {
  const slots = await firstSlots(A);
  assert.ok(slots.length > 10);
  const taken = slots[3].start;
  assert.equal((await post("/callback", { clientId: A, slotStart: taken, ...who })).status, 200);
  const left = await firstSlots(B);
  assert.ok(!left.some((s) => s.start === taken), "the booked time is gone from what another shopper is shown");
  assert.ok((await firstSlots(A, OTHER)).some((s) => s.start === taken), "another store's calendar is its own");
});

test("a booking is shown again after a reload, a closed and reopened window, and from another tab", { skip }, async () => {
  const [slot] = await firstSlots(A);
  const booked = await post("/callback", { clientId: A, slotStart: slot.start, ...who });
  assert.equal(booked.status, 200);
  assert.equal(booked.body.callback.status, "requested");
  assert.equal(booked.body.callback.startAt, new Date(slot.start).toISOString());
  for (let i = 0; i < 3; i += 1) {
    const status = await post("/status", { clientId: A });
    assert.equal(status.body.callback.id, booked.body.callback.id, `read ${i + 1}: the same booking`);
    assert.equal(status.body.callback.startAt, booked.body.callback.startAt);
    assert.equal(status.body.callback.timezone, "UTC");
    assert.equal(status.body.callback.callMinutes, 30);
  }
  assert.equal((await post("/status", { clientId: B })).body.callback, null, "another shopper has none");
  assert.equal((await post("/status", { clientId: A }, OTHER)).body.callback, null, "another store knows nothing of it");
});

test("pressing Confirm twice, or a retried request, is one booking", { skip }, async () => {
  const [slot] = await firstSlots(A);
  const results = await Promise.all([1, 2, 3].map(() => post("/callback", { clientId: A, slotStart: slot.start, ...who })));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  assert.equal(new Set(results.map((r) => r.body.bookingId)).size, 1);
  assert.equal(await Booking.countDocuments({ shop: SHOP }), 1);
});

test("two shoppers choosing the same time: one gets it, the other is told and asked to choose again", { skip }, async () => {
  const [slot] = await firstSlots(A);
  const [a, b] = await Promise.all([
    post("/callback", { clientId: A, slotStart: slot.start, ...who }),
    post("/callback", { clientId: B, slotStart: slot.start, ...who, email: "other@example.com" }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal([a, b].find((r) => r.status === 409).body.status, "slot_unavailable");
  assert.equal(await Booking.countDocuments({ shop: SHOP }), 1);
});

test("a shopper with a callback who asks for another is shown the one they have", { skip }, async () => {
  const slots = await firstSlots(A);
  const first = await post("/callback", { clientId: A, slotStart: slots[0].start, ...who });
  const second = await post("/callback", { clientId: A, slotStart: slots[5].start, ...who });
  assert.equal(second.status, 409);
  assert.equal(second.body.status, "already_booked");
  assert.equal(second.body.callback.id, first.body.callback.id);
  assert.equal(await Booking.countDocuments({ shop: SHOP }), 1);
});

test("cancelling: only the shopper's own booking, then it is gone from their window and its time is free for others", { skip }, async () => {
  const [slot] = await firstSlots(A);
  const id = (await post("/callback", { clientId: A, slotStart: slot.start, ...who })).body.bookingId;
  assert.equal((await post("/callback/cancel", { clientId: B, bookingId: id })).status, 404, "another shopper cannot cancel it");
  assert.equal((await post("/callback/cancel", { clientId: A, bookingId: id }, OTHER)).status, 404, "another store cannot either");
  assert.equal((await Booking.findById(id).lean()).status, "requested", "still booked");
  const done = await post("/callback/cancel", { clientId: A, bookingId: id });
  assert.equal(done.status, 200);
  assert.equal(done.body.callback.status, "cancelled");
  const status = (await post("/status", { clientId: A })).body;
  assert.equal(status.callback, null, "a cancelled callback is not shown as booked");
  assert.equal(status.previousCallback.status, "cancelled", "what happened to it is shown as it is");
  assert.ok((await firstSlots(B)).some((s) => s.start === slot.start), "the time is free again");
  assert.equal((await post("/callback/cancel", { clientId: A, bookingId: id })).status, 409, "cancelling twice changes nothing");
  assert.equal((await post("/callback", { clientId: A, slotStart: slot.start, ...who })).status, 200, "and the shopper can book again");
});

test("moving a callback: a free time moves it, a taken time is refused, and the window shows the new time after a reload", { skip }, async () => {
  const slots = await firstSlots(A);
  const id = (await post("/callback", { clientId: A, slotStart: slots[0].start, ...who })).body.bookingId;
  await post("/callback", { clientId: B, slotStart: slots[4].start, ...who, email: "other@example.com" });
  assert.equal((await post("/callback/reschedule", { clientId: A, bookingId: id, slotStart: slots[4].start })).status, 409, "a taken time");
  assert.equal((await post("/callback/reschedule", { clientId: B, bookingId: id, slotStart: slots[7].start })).status, 404, "not their booking");
  const moved = await post("/callback/reschedule", { clientId: A, bookingId: id, slotStart: slots[7].start });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.callback.startAt, new Date(slots[7].start).toISOString());
  assert.equal((await post("/status", { clientId: A })).body.callback.startAt, new Date(slots[7].start).toISOString());
  assert.ok((await firstSlots(B)).some((s) => s.start === slots[0].start), "the time it left is free");
});

test("the store cancelling or moving a booking is what the shopper's window shows next", { skip }, async () => {
  const slots = await firstSlots(A);
  const id = (await post("/callback", { clientId: A, slotStart: slots[0].start, ...who })).body.bookingId;
  await Booking.updateOne({ _id: id }, { $set: { startAt: new Date(slots[6].start), endAt: new Date(new Date(slots[6].start).getTime() + 1800000) } });
  assert.equal((await post("/status", { clientId: A })).body.callback.startAt, new Date(slots[6].start).toISOString(), "moved by the store");
  await Booking.updateOne({ _id: id }, { $set: { status: "cancelled" }, $unset: { activeSlot: "" } });
  assert.equal((await post("/status", { clientId: A })).body.callback, null, "cancelled by the store");
});

test("a callback is a booking of the database: the calendar is a separate fact and is never claimed", { skip }, async () => {
  const [slot] = await firstSlots(A);
  const booked = await post("/callback", { clientId: A, slotStart: slot.start, ...who });
  assert.equal(booked.body.calendarSynced, false, "no calendar event is claimed (none was made)");
  assert.ok(["off", "pending"].includes(booked.body.callback.calendar));
  assert.equal(booked.body.callback.confirmed, false, "waiting for the store to confirm: not 'confirmed'");
});

test("a complaint of the chat records where it went: a callback was booked", { skip }, async () => {
  await complaints.recordIssue({ shop: SHOP, chatRef: chatRefFor(SHOP, A), issue: { summary: "Late delivery" } });
  const [slot] = await firstSlots(A);
  const booked = await post("/callback", { clientId: A, slotStart: slot.start, ...who });
  const saved = await Complaint.findOne({ shop: SHOP }).lean();
  assert.equal(saved.status, "callback_booked");
  assert.equal(saved.handoff.bookingId, booked.body.bookingId);
});

test("no one available: 'unavailable' (never 'connected'), the complaint says so, and asking again makes no second request", { skip }, async () => {
  const chatRef = chatRefFor(SHOP, A);
  await complaints.recordIssue({ shop: SHOP, chatRef, issue: { summary: "Damaged product", orderNumber: "#1021" } });
  const first = await post("/request", { clientId: A, reason: "x", recordingConsent: false });
  assert.equal(first.body.status, "unavailable");
  assert.equal((await Complaint.findOne({ shop: SHOP }).lean()).handoff.status, "unavailable");
  await post("/request", { clientId: A, reason: "x", recordingConsent: false });
  assert.equal(await SupportCall.countDocuments({ shop: SHOP }), 0, "nothing was created while nobody is free");
  // someone comes online: the retry creates ONE request, with the complaint on it, and a further retry reuses it
  await SupportPresence.create({ shop: SHOP, representativeId: "rep-1", name: "Asha", status: "online", lastHeartbeatAt: new Date() });
  const retry = await post("/request", { clientId: A, reason: "x", recordingConsent: false });
  assert.equal(retry.body.status, "requested");
  const again = await post("/request", { clientId: A, reason: "x", recordingConsent: false });
  assert.equal(again.body.call.id, retry.body.call.id, "the same request");
  assert.equal(await SupportCall.countDocuments({ shop: SHOP }), 1, "no duplicate request");
  const call = await SupportCall.findOne({ shop: SHOP }).lean();
  assert.match(call.reason, /^CMP-[A-Z0-9]{6} · order #1021: Damaged product/, "the team member sees the complaint");
  const saved = await Complaint.findOne({ shop: SHOP }).lean();
  assert.equal(saved.handoff.status, "requested");
  assert.equal(saved.handoff.callId, String(call._id));
  // cancelling the attempt
  const cancel = await post("/cancel", { clientId: A, callId: retry.body.call.id });
  assert.equal(cancel.body.cancelled, true);
  assert.equal((await post("/status", { clientId: A })).body.call, null);
});

test("recording is only ever the customer's own choice: declined means nothing is kept", { skip }, async () => {
  await SupportPresence.create({ shop: SHOP, representativeId: "rep-1", name: "Asha", status: "online", lastHeartbeatAt: new Date() });
  const declined = await post("/request", { clientId: A, reason: "x", recordingConsent: false });
  assert.equal(declined.body.call.recording.consent, false);
  const call = await SupportCall.findById(declined.body.call.id).lean();
  assert.notEqual(call.recording?.status, "recording");
  assert.equal(call.recording?.consent === true, false);
  // there is nothing to play
  const play = await post("/recording", { clientId: A, callId: declined.body.call.id });
  assert.equal(play.status, 404);
});
