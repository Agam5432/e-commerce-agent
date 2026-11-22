// The privacy webhooks must also reach what a shopper left with the support side: complaints, calls with the team and
// their recordings, emails still waiting to be sent. Run against a real (throwaway) MongoDB so the filters are proven.
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { startTempMongo } from "./helpers/tempMongo.js";
import { eraseCustomer, exportCustomer, eraseShop } from "../src/services/dataPrivacy.js";
import { sweepExpiredRecordings } from "../src/services/attachmentService.js";
import Conversation from "../src/models/Conversation.js";
import Complaint from "../src/models/Complaint.js";
import SupportCall from "../src/models/SupportCall.js";
import SupportRecording from "../src/models/SupportRecording.js";
import SupportPresence from "../src/models/SupportPresence.js";
import VoiceSession from "../src/models/VoiceSession.js";
import EmailOutbox from "../src/models/EmailOutbox.js";
import WebhookReceipt from "../src/models/WebhookReceipt.js";
import ReplyLedger from "../src/models/ReplyLedger.js";
import StoreIntegration from "../src/models/StoreIntegration.js";

const SHOP = "a-store.myshopify.com";
const OTHER = "b-store.myshopify.com";
const later = new Date(Date.now() + 86400_000);
const oid = () => new mongoose.Types.ObjectId();

const mongo = await startTempMongo();
const skip = mongo.available ? false : "no mongod on this machine";
test.after(async () => { await mongo.stop?.(); });

// raw inserts: only the fields the privacy code looks at matter here
async function seed(shop, { email, customerId }) {
  const conversationId = oid();
  const chatRef = `ref-${shop.slice(0, 1)}-${customerId}`;
  await Conversation.collection.insertOne({ _id: conversationId, shop, chatRef, customerRef: String(customerId), startedAt: new Date(), lastMessageAt: new Date() });
  const callId = oid();
  await SupportCall.collection.insertOne({ _id: callId, shop, chatRef, conversationId, customer: { name: "Buyer", email, phone: "+911234567890", customerId: String(customerId) }, personKey: `c${customerId}`, reason: "my order is late", status: "ended", requestedAt: new Date(), expiresAt: later, keepUntil: later, recording: { status: "saved" } });
  await SupportRecording.collection.insertOne({ shop, callId, chatRef, mime: "audio/webm", size: 3, storage: "mongo", data: Buffer.from("abc"), expiresAt: later });
  await Complaint.collection.insertOne({ shop, chatRef, conversationId, reference: `C-${customerId}`, summary: "late order", customer: { name: "Buyer", email }, expiresAt: later });
  await EmailOutbox.collection.insertOne({ kind: "complaint", shop, message: { to: email, subject: "We got your complaint", text: "hi" }, nextAttemptAt: new Date(), expiresAt: later });
  await ReplyLedger.collection.insertOne({ _id: `${shop}|${chatRef}`, expiresAt: later });
  return { conversationId, chatRef, callId };
}

const count = (Model, filter) => Model.collection.countDocuments(filter);

test("erasing a customer removes their complaints, call recordings, waiting emails and the personal details on their calls", { skip }, async () => {
  await mongoose.connection.dropDatabase();
  const mine = await seed(SHOP, { email: "buyer@example.com", customerId: 778899 });
  await seed(SHOP, { email: "someone.else@example.com", customerId: 111 });
  await seed(OTHER, { email: "buyer@example.com", customerId: 778899 });

  const out = await eraseCustomer(SHOP, { customer: { id: 778899, email: "Buyer@Example.com" } });
  assert.deepEqual([out.calls, out.recordings, out.complaints], [1, 1, 1]);

  assert.equal(await count(Complaint, { shop: SHOP, "customer.email": "buyer@example.com" }), 0, "complaint is gone");
  assert.equal(await count(SupportRecording, { callId: mine.callId }), 0, "recording is gone");
  assert.equal(await count(EmailOutbox, { shop: SHOP, "message.to": "buyer@example.com" }), 0, "waiting email is gone");
  assert.equal(await count(ReplyLedger, { _id: `${SHOP}|${mine.chatRef}` }), 0, "reply fingerprints are gone");
  const call = await SupportCall.collection.findOne({ _id: mine.callId });
  assert.ok(call, "the call record itself stays for the team's accountability");
  assert.equal(call.customer, undefined);
  assert.equal(call.personKey, undefined);
  assert.equal(call.reason, "");
  assert.equal(call.recording.status, "none");

  // another shopper of the same store and the same person in another store are untouched
  for (const Model of [Complaint, SupportRecording, EmailOutbox, ReplyLedger]) assert.equal(await Model.collection.countDocuments({}), 2, `${Model.modelName}: only this customer's row was removed`);
  assert.equal(await count(SupportCall, { "customer.email": { $exists: true } }), 2);
});

test("a customer known only by email is found on complaints and calls made without a chat of theirs", { skip }, async () => {
  await mongoose.connection.dropDatabase();
  const mine = await seed(SHOP, { email: "guest@example.com", customerId: 5 });
  await Conversation.collection.deleteMany({});
  const out = await eraseCustomer(SHOP, { customer: { email: "guest@example.com" } });
  assert.deepEqual([out.calls, out.recordings, out.complaints], [1, 1, 1]);
  assert.equal((await SupportCall.collection.findOne({ _id: mine.callId })).customer, undefined);
});

test("a data request includes the customer's complaints and calls", { skip }, async () => {
  await mongoose.connection.dropDatabase();
  await seed(SHOP, { email: "buyer@example.com", customerId: 778899 });
  await seed(OTHER, { email: "buyer@example.com", customerId: 778899 });
  const data = await exportCustomer(SHOP, { customer: { id: 778899, email: "buyer@example.com" } });
  assert.equal(data.complaints.length, 1);
  assert.equal(data.complaints[0].summary, "late order");
  assert.equal(data.calls.length, 1);
  assert.equal(data.calls[0].reason, "my order is late");
  assert.equal(data.calls[0].recorded, true);
});

test("shop erase removes the support side of an uninstalled store and nothing of another store", { skip }, async () => {
  await mongoose.connection.dropDatabase();
  await seed(SHOP, { email: "buyer@example.com", customerId: 778899 });
  await seed(OTHER, { email: "buyer@example.com", customerId: 778899 });
  for (const shop of [SHOP, OTHER]) {
    await SupportPresence.collection.insertOne({ shop, representativeId: "u1", name: "Asha", lastHeartbeatAt: new Date() });
    await VoiceSession.collection.insertOne({ shop, instance: "i1", heartbeatAt: new Date(), expiresAt: later });
    await WebhookReceipt.collection.insertOne({ kind: "compliance", shop, topic: "customers/redact", body: { customer: { email: "buyer@example.com" } }, status: "dead", expiresAt: later });
    await WebhookReceipt.collection.insertOne({ kind: "compliance", shop, topic: "shop/redact", body: {}, status: "processing", expiresAt: later });
  }
  await StoreIntegration.collection.insertOne({ platform: "shopify", storeDomain: SHOP, status: "uninstalled" });

  await eraseShop(SHOP);
  for (const Model of [Complaint, SupportCall, SupportRecording, SupportPresence, VoiceSession, EmailOutbox]) {
    assert.equal(await count(Model, { shop: SHOP }), 0, `${Model.modelName} of the erased store is gone`);
    assert.ok(await count(Model, { shop: OTHER }) > 0, `${Model.modelName} of the other store stays`);
  }
  assert.equal(await count(ReplyLedger, { _id: { $regex: `^${SHOP.replace(/\./g, "\\.")}\\|` } }), 0);
  assert.equal(await ReplyLedger.collection.countDocuments({}), 1);
  // work still running (this very request) stays until the webhook layer finishes it; given-up ones, which still hold their body, go
  assert.deepEqual((await WebhookReceipt.collection.find({ shop: SHOP }).toArray()).map((r) => r.topic), ["shop/redact"]);
  assert.equal(await count(WebhookReceipt, { shop: OTHER }), 2);
});

// ---- recordings kept in object storage --------------------------------------------------------
test("the clean-up job removes call recordings in object storage whose time is up (object first, then the record)", { skip }, async () => {
  await mongoose.connection.dropDatabase();
  const base = { shop: SHOP, chatRef: "r", mime: "audio/webm", size: 3, storage: "s3" };
  await SupportRecording.collection.insertOne({ ...base, callId: oid(), objectKey: "rec/due", deleteAfter: new Date(Date.now() - 1000) });
  await SupportRecording.collection.insertOne({ ...base, callId: oid(), objectKey: "rec/keep", deleteAfter: later });
  const removedKeys = [];
  const storage = { remove: async (key) => { removedKeys.push(key); } };
  const removed = await sweepExpiredRecordings({ storage });
  assert.equal(removed, 1);
  assert.deepEqual(removedKeys, ["rec/due"]);
  assert.deepEqual((await SupportRecording.collection.find({}).toArray()).map((r) => r.objectKey), ["rec/keep"]);
});
