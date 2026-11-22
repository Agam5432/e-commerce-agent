// The customer care flow as the agent runs it, against a real (temporary) MongoDB: the tools the assistant calls, the
// words they allow it to say, and the store's dashboard API for complaints.
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { startTempMongo } from "./helpers/tempMongo.js";
import Complaint from "../src/models/Complaint.js";
import SupportPresence from "../src/models/SupportPresence.js";
import SupportCall from "../src/models/SupportCall.js";
import ecommerce from "../src/industries/ecommerce.js";
import * as svc from "../src/services/complaintService.js";
import { createComplaintAdminRouter } from "../src/admin/complaintRoutes.js";

const SHOP = "alpha.myshopify.com";
const OTHER = "beta.myshopify.com";
const mongo = await startTempMongo();
const skip = mongo.available ? false : "no mongod on this machine (set MONGOD_PATH to run these)";

before(async () => { if (mongo.available) await Promise.all([Complaint, SupportPresence, SupportCall].map((m) => m.init())); });
after(async () => { await mongo.stop?.(); });
beforeEach(async () => { if (mongo.available) await Promise.all([Complaint, SupportPresence, SupportCall].map((m) => m.deleteMany({}))); });

const SETTINGS = { notificationEmail: "owner@alpha-store.com", support: { liveEnabled: true, audioEnabled: true, recordingEnabled: true }, booking: { enabled: true } };

/** A session of the shopping agent whose mail goes to a list instead of the world. */
function session({ chatRef = "chat-1", send, disabledTools = [], settings = SETTINGS, userMessage = "I received a damaged product" } = {}) {
  const sent = [];
  const complaintDeps = {
    send: send || (async (m) => { sent.push(m); return { ok: true }; }),
    ownerEmail: async () => settings.notificationEmail || "",
    emailConfigured: () => true,
    notify: () => {},
    flagChat: async () => {},
  };
  const s = ecommerce.createSession(SHOP, { settings, chatRef, disabledTools, cart: { items: [] }, profile: {}, history: [], userMessage, complaintDeps, storeProfile: { storeName: "Alpha Store" } });
  return { s, sent };
}
// The backend acts on "email" or "a person" only after the choice was OFFERED in an earlier message of the customer (consent is enforced
// in the tool, not only in the prompt): this is that earlier message.
const offered = async (chatRef = "chat-1") => { const out = await session({ chatRef, userMessage: "it is still broken, nothing helped" }).s.handlers.raise_complaint({ summary: "Damaged product" }); assert.equal(out.status, "need_choice"); };
const ISSUE = { summary: "Earbuds arrived with a cracked ear cup", orderNumber: "#1021", productName: "boAt Airdopes 141 Earbuds", customerEmail: "riya@example.com", customerName: "Riya" };

test("the problem is written down while the assistant works on it, and nothing is asked twice", { skip }, async () => {
  const { s } = session();
  const first = await s.handlers.track_issue({ summary: "Damaged product", attempted: ["Asked for a photo"] });
  assert.equal(first.status, "ok");
  assert.match(first.reference, /^CMP-[A-Z0-9]{6}$/);
  const second = await s.handlers.track_issue({ orderNumber: "#1021", attempted: ["Offered a replacement"], customerResponse: "I do not want a replacement" });
  assert.equal(second.reference, first.reference, "the same complaint");
  assert.deepEqual(second.known.alreadyTried, ["Asked for a photo", "Offered a replacement"]);
  assert.equal(second.known.summary, "Damaged product", "kept from the first call");
  const saved = await Complaint.findOne({ shop: SHOP }).lean();
  assert.equal(saved.originalMessage, "I received a damaged product", "the customer's own words, taken from their message");
  assert.equal(await Complaint.countDocuments({}), 1);
});

test("an email is not sent until the customer agreed to it", { skip }, async () => {
  await offered();
  const { s, sent } = session();
  const out = await s.handlers.raise_complaint({ channel: "email", summary: ISSUE.summary, ...ISSUE });
  assert.equal(out.status, "need_confirmation");
  assert.equal(sent.length, 0);
  assert.equal((await s.handlers.raise_complaint({ summary: "x" })).status, "need_choice", "no channel: ask the one question");
});

test("the customer agrees to email: the store gets it, the customer is copied, and the assistant may say so", { skip }, async () => {
  await offered();
  const { s, sent } = session();
  await s.handlers.track_issue({ summary: ISSUE.summary, attempted: ["Asked for a photo", "Offered a replacement"] });
  const out = await s.handlers.raise_complaint({ channel: "email", customerAgreed: true, reason: "Still not solved", ...ISSUE });
  assert.equal(out.status, "email_sent");
  assert.equal(out.copyTo, "riya@example.com");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "owner@alpha-store.com");
  assert.equal(sent[0].cc, "riya@example.com");
  assert.match(sent[0].text, /Asked for a photo/, "what was already tried reaches the store");
  const raised = s.result().actions.find((a) => a.type === "complaint_raised");
  assert.equal(raised.emailStatus, "sent");
  assert.equal(raised.reference, out.reference);
  // asking again: the same complaint, no second email
  const again = await s.handlers.raise_complaint({ channel: "email", customerAgreed: true, ...ISSUE });
  assert.equal(again.status, "already_raised");
  assert.equal(sent.length, 1);
});

test("the customer refuses the email: no email, the complaint goes with the request for a person", { skip }, async () => {
  await offered();
  await SupportPresence.create({ shop: SHOP, representativeId: "rep-1", name: "Asha", status: "online", lastHeartbeatAt: new Date() });
  const { s, sent } = session();
  await s.handlers.track_issue({ summary: ISSUE.summary, attempted: ["Asked for a photo"] });
  const out = await s.handlers.raise_complaint({ channel: "human", reason: "The customer does not want an email", ...ISSUE });
  assert.equal(out.status, "person_requested");
  assert.equal(out.emailSent, false);
  assert.equal(sent.length, 0, "no complaint email");
  assert.equal(out.humanSupport.status, "offered");
  const result = s.result();
  const human = result.actions.find((a) => a.type === "human_support");
  assert.ok(human, "the chat window is told to connect");
  assert.equal(human.complaintRef, out.reference, "the call request carries the complaint");
  assert.equal(human.available, true);
  const saved = await Complaint.findOne({ shop: SHOP }).lean();
  assert.equal(saved.email.status, "refused");
  assert.equal(saved.channel, "human");
  assert.equal(saved.summary, ISSUE.summary, "nothing to repeat");
  assert.match(out.note, /Do not ask them to explain/);
});

test("an email that fails is never reported as sent", { skip }, async () => {
  await offered();
  const { s } = session({ send: async () => ({ ok: false, error: "smtp down" }) });
  const out = await s.handlers.raise_complaint({ channel: "email", customerAgreed: true, ...ISSUE });
  assert.equal(out.status, "email_failed");
  assert.equal(out.emailSent, false);
  assert.match(out.note, /NOT sent/);
  assert.match(out.note, /request_human_support/, "a person or a callback is offered instead");
  assert.equal(s.result().actions.find((a) => a.type === "complaint_raised").emailStatus, "failed");
  await offered("chat-2");
  const noOwner = session({ settings: { ...SETTINGS, notificationEmail: "" }, chatRef: "chat-2" });
  const none = await noOwner.s.handlers.raise_complaint({ channel: "email", customerAgreed: true, ...ISSUE });
  assert.equal(none.status, "email_not_configured");
  assert.equal(none.emailSent, false);
});

test("without the customer's email the one missing thing is asked for", { skip }, async () => {
  await offered();
  const { s, sent } = session();
  const out = await s.handlers.raise_complaint({ channel: "email", customerAgreed: true, summary: "Late delivery" });
  assert.equal(out.status, "needs_email");
  assert.equal(sent.length, 0);
  assert.match(out.note, /do not ask about the problem again/);
});

test("a store that switched the action off cannot have it run, even when the tool is called directly", { skip }, async () => {
  const { s, sent } = session({ disabledTools: ["raise_complaint", "track_issue"] });
  const out = await s.handlers.raise_complaint({ channel: "email", customerAgreed: true, ...ISSUE });
  assert.notEqual(out.status, "email_sent");
  assert.equal(sent.length, 0);
  assert.equal(await Complaint.countDocuments({}), 0, "nothing was saved");
  assert.notEqual((await s.handlers.track_issue({ summary: "x" })).status, "ok");
});

test("the dashboard API lists a store's complaints, retries a failed email once, and settles them", { skip }, async () => {
  const failing = { send: async () => ({ ok: false, error: "smtp down" }), ownerEmail: async () => "owner@alpha-store.com", emailConfigured: () => true, notify: () => {}, flagChat: async () => {} };
  await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "email", issue: ISSUE }, failing);
  await svc.recordIssue({ shop: OTHER, chatRef: "chat-9", issue: { summary: "Another store's problem" } });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.shop = req.headers["x-shop"]; req.adminUser = "user-1"; next(); });
  const sentByRetry = [];
  const service = { ...svc, escalate: (args) => svc.escalate(args, { ...failing, send: async (m) => { sentByRetry.push(m); return { ok: true }; } }) };
  app.use("/complaints", createComplaintAdminRouter({ service, settings: { getAgentSettings: async () => SETTINGS } }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/complaints`;
  const call = async (path, shop, method = "GET") => { const r = await fetch(base + path, { method, headers: { "x-shop": shop, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    const mine = await call("/", SHOP);
    assert.equal(mine.body.items.length, 1, "only this store's");
    assert.equal(mine.body.items[0].email.status, "failed");
    assert.equal(mine.body.counts.emailFailed, 1);
    const id = mine.body.items[0].id;
    assert.equal((await call(`/${id}`, OTHER)).status, 404, "another store cannot open it");
    assert.equal((await call(`/${id}/retry-email`, OTHER, "POST")).status, 404, "or retry it");
    assert.equal((await call(`/${id}/resolve`, OTHER, "POST")).status, 404, "or settle it");
    const retry = await call(`/${id}/retry-email`, SHOP, "POST");
    assert.equal(retry.body.status, "ok");
    assert.equal(retry.body.complaint.email.status, "sent");
    assert.equal(sentByRetry.length, 1);
    assert.equal((await call(`/${id}/retry-email`, SHOP, "POST")).body.status, "already_raised", "an email that went is not sent again");
    assert.equal(sentByRetry.length, 1);
    assert.equal((await call(`/${id}/resolve`, SHOP, "POST")).body.complaint.status, "resolved");
    assert.equal((await call("/?open=1", SHOP)).body.items.length, 0);
    assert.equal((await call(`/${id}/retry-email`, SHOP, "POST")).status, 409, "a settled complaint is not touched again");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---- the workflow rules are enforced by the backend, not only asked of the AI -----------------------------------------------------------------
test("consent: nothing is sent or raised until the choice was offered in an earlier message, however the AI calls the tool", { skip }, async () => {
  const { s, sent } = session({ userMessage: "Raise a complaint, my charger is dead" });
  // the AI jumps straight to "email, customer agreed" in the very message that asked for a complaint
  const jump = await s.handlers.raise_complaint({ channel: "email", customerAgreed: true, ...ISSUE });
  assert.equal(jump.status, "need_choice");
  assert.equal(sent.length, 0);
  assert.equal(await Complaint.countDocuments({ channel: { $in: ["email", "human"] } }), 0, "nothing was escalated");
  // calling again in the SAME message does not turn the offer into consent
  const same = await s.handlers.raise_complaint({ channel: "human", reason: "x", ...ISSUE });
  assert.equal(same.status, "need_choice");
  assert.equal(sent.length, 0);
  // the customer answers in their NEXT message: now it goes
  const next = session({ userMessage: "yes, email it" });
  const done = await next.s.handlers.raise_complaint({ channel: "email", customerAgreed: true, ...ISSUE });
  assert.equal(done.status, "email_sent");
  assert.equal(next.sent.length, 1);
  assert.equal(await Complaint.countDocuments({ shop: SHOP }), 1, "one complaint, not one per attempt");
});

test("a person is never called for 'raise a complaint' alone: the person channel also waits for the customer's answer", { skip }, async () => {
  const first = session({ userMessage: "raise a complaint" });
  const out = await first.s.handlers.raise_complaint({ channel: "human", reason: "complaint", summary: "Dead charger" });
  assert.equal(out.status, "need_choice");
  assert.equal(await SupportCall.countDocuments({}), 0);
  const later = session({ userMessage: "I would rather talk to someone" });
  const person = await later.s.handlers.raise_complaint({ channel: "human", reason: "The customer asked for a person", summary: "Dead charger" });
  assert.equal(person.status, "person_requested");
});

test("a detail already asked for is not asked again: the backend remembers it", { skip }, async () => {
  const one = session({ userMessage: "my order arrived damaged" });
  const first = await one.s.handlers.track_issue({ summary: "Damaged", askingFor: ["orderNumber"] });
  assert.equal(first.status, "ok");
  const two = session({ userMessage: "the screen is broken" });
  const second = await two.s.handlers.track_issue({ summary: "Screen broken", askingFor: ["orderNumber"] });
  assert.equal(second.status, "already_asked", "the order number was asked once already");
  assert.deepEqual(second.alreadyAsked, ["orderNumber"]);
  assert.match(second.note, /do NOT ask again/);
  const saved = await Complaint.findOne({ shop: SHOP }).lean();
  assert.deepEqual(saved.asked, ["orderNumber"], "asked once, written once");
  assert.match(svc.complaintPromptBlock(saved), /ALREADY asked for it once.*NEVER ask again/);
  // a different detail is still allowed, and once the customer gives the order number nothing about it is blocked
  const photo = await session({ userMessage: "it is cracked" }).s.handlers.track_issue({ summary: "Cracked", askingFor: ["photo"] });
  assert.equal(photo.status, "ok");
  const given = await session({ userMessage: "order #1050" }).s.handlers.track_issue({ summary: "Cracked", orderNumber: "#1050", askingFor: ["orderNumber"] });
  assert.equal(given.status, "ok", "an order number the customer did give is never 'already asked'");
});

test("the backend confirms the complaint exists before the assistant may say it was raised", { skip }, async () => {
  await offered();
  const { s } = session({ send: async () => ({ ok: false, error: "smtp down" }) });
  const out = await s.handlers.raise_complaint({ channel: "email", customerAgreed: true, ...ISSUE });
  assert.notEqual(out.status, "email_sent");
  assert.ok(out.reference, "the complaint is saved");
  assert.match(String(out.note), /(NOT|not) (been )?sent|did not go|could not|retry/i);
  assert.equal(await Complaint.countDocuments({ shop: SHOP }), 1);
});
