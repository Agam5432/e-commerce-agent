// Customer complaints against a real (temporary) MongoDB: one open complaint per chat, one email per complaint (to the
// store, a copy to the customer), the customer who refuses the email goes to a person, and a failure is never reported
// as a success.
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startTempMongo } from "./helpers/tempMongo.js";
import Complaint from "../src/models/Complaint.js";
import * as svc from "../src/services/complaintService.js";

const SHOP = "alpha.myshopify.com";
const OTHER = "beta.myshopify.com";
const mongo = await startTempMongo();
const skip = mongo.available ? false : "no mongod on this machine (set MONGOD_PATH to run these)";

before(async () => { if (mongo.available) await Complaint.init(); });
after(async () => { await mongo.stop?.(); });
beforeEach(async () => { if (mongo.available) await Complaint.deleteMany({}); });

const harness = ({ owner = "owner@alpha-store.com", send } = {}) => {
  const log = { sent: [], notified: [], flagged: [] };
  const over = {
    ownerEmail: async () => owner,
    emailConfigured: () => true,
    send: send || (async (m) => { log.sent.push(m); return { ok: true, messageId: "<id@x>" }; }),
    notify: (key, message) => log.notified.push({ key, message }),
    flagChat: async (shop, chatRef) => { log.flagged.push([shop, chatRef]); },
  };
  return { log, over };
};
const ISSUE = { summary: "The headphones arrived with a cracked left ear cup", originalMessage: "I received a damaged product", orderNumber: "#1021", productName: "boAt Airdopes 141 Earbuds", attempted: ["Asked for a photo of the damage", "Offered a replacement"], customerName: "Riya Sharma", customerEmail: "riya@example.com" };

test("the first description is kept as written, what was tried only grows, and there is one open complaint per chat", { skip }, async () => {
  const { over } = harness();
  const a = await svc.recordIssue({ shop: SHOP, chatRef: "chat-1", issue: { originalMessage: "I received a damaged product", summary: "Damaged product" } }, over);
  const b = await svc.recordIssue({ shop: SHOP, chatRef: "chat-1", issue: { originalMessage: "I ALREADY TOLD YOU TWICE", orderNumber: "#1021", attempted: ["Asked for a photo"] } }, over);
  const c = await svc.recordIssue({ shop: SHOP, chatRef: "chat-1", issue: { attempted: ["Asked for a photo", "Offered a replacement"], customerResponse: "I do not want a replacement" } }, over);
  assert.equal(await Complaint.countDocuments({ shop: SHOP }), 1);
  assert.equal(String(a.complaint._id), String(c.complaint._id));
  assert.equal(c.complaint.reference, a.complaint.reference);
  assert.equal(c.complaint.originalMessage, "I received a damaged product", "the customer's first words are never overwritten");
  assert.equal(c.complaint.summary, "Damaged product", "a detail given once is kept when a later call does not repeat it");
  assert.equal(c.complaint.orderNumber, "#1021");
  assert.deepEqual(c.complaint.attempts, ["Asked for a photo", "Offered a replacement"], "no step is listed twice");
  assert.equal(c.complaint.customerResponse, "I do not want a replacement");
  assert.equal(b.complaint.status, "troubleshooting");
});

test("two requests at the same moment make one complaint", { skip }, async () => {
  const { over } = harness();
  const results = await Promise.all(Array.from({ length: 6 }, () => svc.recordIssue({ shop: SHOP, chatRef: "chat-race", issue: { summary: "Late delivery" } }, over)));
  assert.equal(await Complaint.countDocuments({ shop: SHOP, chatRef: "chat-race" }), 1);
  assert.equal(new Set(results.map((r) => String(r.complaint._id))).size, 1);
});

test("the email goes to the store with a copy to the customer, with what the customer and the chat gave", { skip }, async () => {
  const { over, log } = harness();
  const out = await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "email", issue: ISSUE, reason: "The customer said the problem is still not fixed", shopName: "Alpha Store", language: "hinglish" }, over);
  assert.equal(out.status, "ok");
  assert.equal(out.email.status, "sent");
  assert.equal(out.complaint.status, "email_sent");
  assert.equal(log.sent.length, 1);
  const mail = log.sent[0];
  assert.equal(mail.to, "owner@alpha-store.com", "the store's own configured address");
  assert.equal(mail.cc, "riya@example.com", "the customer gets the same email");
  assert.equal(mail.replyTo, "riya@example.com");
  assert.equal(mail.subject, "Customer Complaint - Order #1021");
  for (const part of [out.complaint.reference, "riya@example.com", "Riya Sharma", "#1021", "boAt Airdopes 141 Earbuds", "cracked left ear cup", "I received a damaged product", "Asked for a photo of the damage", "Offered a replacement", "still not fixed", "chat-1"]) {
    assert.ok(mail.text.includes(part), `the email carries: ${part}`);
  }
  assert.match(mail.text, /not verified/, "an order the customer only named is not presented as checked");
  assert.deepEqual(mail.retry, { kind: "complaint", shop: SHOP });
});

test("the subject names the reference when there is no order", { skip }, async () => {
  const { over, log } = harness();
  const out = await svc.escalate({ shop: SHOP, chatRef: "chat-2", channel: "email", issue: { summary: "Rude delivery person", customerEmail: "a@example.com" } }, over);
  assert.equal(log.sent[0].subject, `Customer Complaint - ${out.complaint.reference}`);
});

test("repeating the request, or many at once, sends one email only", { skip }, async () => {
  const { over, log } = harness();
  await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "email", issue: ISSUE }, over);
  const again = await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "email", issue: ISSUE }, over);
  assert.equal(again.status, "already_raised");
  const burst = await Promise.all(Array.from({ length: 5 }, () => svc.escalate({ shop: SHOP, chatRef: "chat-2", channel: "email", issue: { ...ISSUE, orderNumber: "#2000" } }, over)));
  assert.equal(log.sent.filter((m) => m.subject.includes("#2000")).length, 1);
  assert.equal(burst.filter((r) => r.status === "ok").length, 1);
  assert.equal(log.sent.length, 2);
});

test("without an email address for the customer nothing is sent, and the missing piece is what is asked for", { skip }, async () => {
  const { over, log } = harness();
  const out = await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "email", issue: { ...ISSUE, customerEmail: "" } }, over);
  assert.equal(out.status, "needs_email");
  assert.equal(log.sent.length, 0);
  const later = await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "email", issue: { customerEmail: "riya@example.com" } }, over);
  assert.equal(later.status, "ok");
  assert.equal(log.sent.length, 1);
  const bad = await svc.escalate({ shop: SHOP, chatRef: "chat-3", channel: "email", issue: { summary: "x", customerEmail: "not-an-email" } }, over);
  assert.equal(bad.status, "needs_email", "an invalid address is not used");
});

test("a customer who refuses the email goes straight to a person: no email, nothing to repeat", { skip }, async () => {
  const { over, log } = harness();
  await svc.recordIssue({ shop: SHOP, chatRef: "chat-1", issue: ISSUE }, over);
  const out = await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "human", reason: "The customer does not want an email" }, over);
  assert.equal(out.status, "ok");
  assert.equal(log.sent.length, 0, "no complaint email");
  assert.equal(out.complaint.email.status, "refused");
  assert.equal(out.complaint.channel, "human");
  assert.equal(out.complaint.status, "human_requested");
  assert.equal(out.complaint.summary, ISSUE.summary, "the complaint travels with the request");
  assert.equal(out.complaint.originalMessage, ISSUE.originalMessage);
  assert.deepEqual(out.complaint.attempts, ISSUE.attempted);
  assert.equal(await Complaint.countDocuments({ shop: SHOP }), 1, "no second complaint");
});

test("a customer who changes their mind after the email went: it is not claimed to be recalled", { skip }, async () => {
  const { over, log } = harness();
  await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "email", issue: ISSUE }, over);
  const out = await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "human" }, over);
  assert.equal(out.emailAlreadySent, true);
  assert.equal(out.complaint.email.status, "sent", "the record still says it was sent");
  assert.equal(log.sent.length, 1);
});

test("an email that fails is recorded as failed, the store is told another way, and a later try can send it", { skip }, async () => {
  const { over, log } = harness({ send: async () => ({ ok: false, error: "smtp down" }) });
  const out = await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "email", issue: ISSUE }, over);
  assert.equal(out.status, "email_failed");
  assert.equal(out.email.status, "failed");
  assert.equal(out.complaint.status, "email_failed");
  assert.equal(out.complaint.email.error, "smtp down");
  assert.equal(log.notified.length, 1, "the alert channel hears about it");
  assert.match(log.notified[0].message, /could not be emailed/);
  assert.deepEqual(log.flagged, [[SHOP, "chat-1"]], "the chat is marked so the team sees it in the dashboard");
  const saved = await Complaint.findOne({ shop: SHOP }).lean();
  assert.equal(saved.summary, ISSUE.summary, "the complaint itself is kept");
  // the mail server is back
  const ok = harness();
  const retry = await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "email", issue: {} }, ok.over);
  assert.equal(retry.status, "ok");
  assert.equal(retry.complaint.email.status, "sent");
  assert.equal(ok.log.sent.length, 1);
});

test("an email kept for a later try is retrying, never sent", { skip }, async () => {
  const { over } = harness({ send: async () => ({ ok: false, error: "timeout", queued: true }) });
  const out = await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "email", issue: ISSUE }, over);
  assert.equal(out.status, "email_retrying");
  assert.equal(out.email.status, "retrying");
  assert.notEqual(out.complaint.status, "email_sent");
  const again = await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "email", issue: {} }, over);
  assert.equal(again.status, "already_raised", "the kept email is not sent a second time");
});

test("a store without a support email, or a server without email, saves the complaint and says so", { skip }, async () => {
  let h = harness({ owner: "" });
  let out = await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "email", issue: ISSUE }, h.over);
  assert.equal(out.status, "email_not_configured");
  assert.equal(h.log.sent.length, 0);
  assert.equal(h.log.notified.length, 1);
  h = harness();
  h.over.emailConfigured = () => false;
  out = await svc.escalate({ shop: SHOP, chatRef: "chat-2", channel: "email", issue: ISSUE }, h.over);
  assert.equal(out.status, "email_not_configured");
  assert.equal(h.log.sent.length, 0);
  assert.equal((await Complaint.findOne({ shop: SHOP, chatRef: "chat-2" }).lean()).email.status, "not_configured");
});

test("what became of a request for a person is kept on the complaint", { skip }, async () => {
  const { over } = harness();
  await svc.recordIssue({ shop: SHOP, chatRef: "chat-1", issue: ISSUE }, over);
  assert.equal((await svc.markHandoff({ shop: SHOP, chatRef: "chat-1", status: "requested", callId: "c1" }, over)).status, "human_requested");
  assert.equal((await svc.markHandoff({ shop: SHOP, chatRef: "chat-1", status: "unavailable" }, over)).handoff.status, "unavailable");
  const booked = await svc.markHandoff({ shop: SHOP, chatRef: "chat-1", status: "callback", bookingId: "b1" }, over);
  assert.equal(booked.status, "callback_booked");
  assert.equal(booked.handoff.bookingId, "b1");
  assert.equal(booked.handoff.callId, "c1", "the call it came from is not lost");
  assert.equal(await svc.markHandoff({ shop: SHOP, chatRef: "no-chat", status: "requested" }, over), null);
  assert.equal(await svc.markHandoff({ shop: SHOP, chatRef: "chat-1", status: "nonsense" }, over), null);
});

test("one store never sees, changes or settles another store's complaint", { skip }, async () => {
  const { over } = harness();
  const mine = (await svc.recordIssue({ shop: SHOP, chatRef: "chat-1", issue: ISSUE }, over)).complaint;
  assert.equal(await svc.getComplaint(OTHER, String(mine._id), over), null);
  assert.equal((await svc.listComplaints(OTHER, {}, over)).length, 0);
  assert.equal(await svc.openComplaintForChat(OTHER, "chat-1", over), null);
  assert.equal(await svc.resolveComplaint(OTHER, String(mine._id), "x", over), null);
  assert.equal(await svc.markHandoff({ shop: OTHER, chatRef: "chat-1", status: "requested" }, over), null);
  // the same chat reference in another store is a different complaint
  const theirs = (await svc.recordIssue({ shop: OTHER, chatRef: "chat-1", issue: { summary: "other" } }, over)).complaint;
  assert.notEqual(String(theirs._id), String(mine._id));
  assert.equal((await svc.getComplaint(SHOP, String(mine._id), over)).summary, ISSUE.summary);
  assert.equal((await svc.resolveComplaint(SHOP, String(mine._id), "Asha", over)).status, "resolved");
  assert.equal(await svc.openComplaintForChat(SHOP, "chat-1", over), null, "a settled complaint is no longer open, a new one can start");
});

test("the assistant is told what it already knows, and only what really happened", { skip }, async () => {
  const { over } = harness();
  const { complaint } = await svc.recordIssue({ shop: SHOP, chatRef: "chat-1", issue: ISSUE }, over);
  const block = svc.complaintPromptBlock(complaint);
  for (const part of ["do NOT ask for any of it again", "I received a damaged product", "#1021", "Asked for a photo of the damage", "never suggest these again"]) assert.ok(block.includes(part), part);
  assert.doesNotMatch(block, /email sent|sent to the store/i, "no email has been sent yet");
  const sent = await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "email", issue: {} }, harness().over);
  assert.match(svc.complaintPromptBlock(await Complaint.findOne({ shop: SHOP }).lean()), /sent to the store and copied to the customer/);
  void sent;
  assert.equal(svc.complaintPromptBlock(null), "");
});

test("the dashboard view carries the delivery status of the email and of the handoff", { skip }, async () => {
  const { over } = harness({ send: async () => ({ ok: false, error: "smtp down" }) });
  const out = await svc.escalate({ shop: SHOP, chatRef: "chat-1", channel: "email", issue: ISSUE }, over);
  assert.equal(out.complaint.email.status, "failed");
  assert.equal(out.complaint.email.error, "smtp down");
  assert.equal(out.complaint.customer.email, "riya@example.com");
  assert.equal(out.complaint.orderNumber, "#1021");
  assert.equal(out.complaint.handoff.status, "none");
});

// ---- the customer who comes back to the same problem is offered the complaint; nothing more is asked of them ----------------------------------
test("each different customer message about the problem is counted once; the same message written down twice is not", { skip }, async () => {
  const { over } = harness();
  const first = await svc.recordIssue({ shop: SHOP, chatRef: "chat-m", issue: { summary: "Damaged", messageKey: "msg-1" } }, over);
  assert.equal(first.complaint.mentions, 1);
  const again = await svc.recordIssue({ shop: SHOP, chatRef: "chat-m", issue: { attempted: ["Asked for the order number"], messageKey: "msg-1" } }, over);
  assert.equal(again.complaint.mentions, 1, "the same customer message, written down a second time while answering it");
  const second = await svc.recordIssue({ shop: SHOP, chatRef: "chat-m", issue: { customerResponse: "it is still broken", messageKey: "msg-2" } }, over);
  assert.equal(second.complaint.mentions, 2);
  const third = await svc.recordIssue({ shop: SHOP, chatRef: "chat-m", issue: { messageKey: "msg-3" } }, over);
  assert.equal(third.complaint.mentions, 3);
  assert.equal(await Complaint.countDocuments({ shop: SHOP }), 1);
});

test("a first mention gets no complaint offer; the second tells the assistant to offer it now and to ask for nothing else", { skip }, async () => {
  const { over } = harness();
  const one = await svc.recordIssue({ shop: SHOP, chatRef: "chat-p", issue: { summary: "Screen broken", messageKey: "a" } }, over);
  const firstBlock = svc.complaintPromptBlock(one.complaint);
  assert.doesNotMatch(firstBlock, /come back to this problem/);
  assert.match(firstBlock, /STAGE: you have not suggested anything yet/);
  assert.match(firstBlock, /ORDER NUMBER: the customer has not given one. You may ask for it ONCE/);
  const two = await svc.recordIssue({ shop: SHOP, chatRef: "chat-p", issue: { messageKey: "b" } }, over);
  const secondBlock = svc.complaintPromptBlock(two.complaint);
  assert.match(secondBlock, /come back to this problem \(2 messages about it\)/);
  assert.match(secondBlock, /Do NOT ask for any other detail, do NOT ask for an order number/);
  assert.doesNotMatch(secondBlock, /STAGE: you have not suggested anything yet/, "the 'solve it now' stage must not contradict the offer");
  const withOrder = await svc.recordIssue({ shop: SHOP, chatRef: "chat-p", issue: { orderNumber: "#1050", messageKey: "c" } }, over);
  assert.doesNotMatch(svc.complaintPromptBlock(withOrder.complaint), /ORDER NUMBER: the customer has not given one/, "an order number already given is never asked for");
});
