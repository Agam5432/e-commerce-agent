// Shopify's mandatory privacy webhooks: when a customer asks to see or erase their data, or a store
// is removed, everything the agent stored about them is exported or deleted. Every query is limited to
// the one store named in the (signature-checked) webhook.
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import Event from "../models/Event.js";
import Booking from "../models/Booking.js";
import AgentSettings from "../models/AgentSettings.js";
import CheckoutSession from "../models/CheckoutSession.js";
import OrderSubmission from "../models/OrderSubmission.js";
import StoreIntegration from "../models/StoreIntegration.js";
import Attachment from "../models/Attachment.js";
import OrderLookupSession from "../models/OrderLookupSession.js";
import RateLimitHit from "../models/RateLimitHit.js";
import Complaint from "../models/Complaint.js";
import SupportCall from "../models/SupportCall.js";
import SupportRecording from "../models/SupportRecording.js";
import SupportPresence from "../models/SupportPresence.js";
import VoiceSession from "../models/VoiceSession.js";
import EmailOutbox from "../models/EmailOutbox.js";
import WebhookReceipt from "../models/WebhookReceipt.js";
import ReplyLedger from "../models/ReplyLedger.js";
import { orderLookupKeys } from "./orderLookupAuth.js";
import { resolveClientId, verifiedCustomerGid } from "./customerContext.js";
import { removeAttachments } from "./attachmentService.js";

// files are deleted with their objects in object storage, when one is used
const AttachmentFiles = { find: (...a) => Attachment.find(...a), deleteMany: async (filter) => ({ deletedCount: await removeAttachments(filter) }) };
import { sendPlainEmail } from "./emailService.js";
import { invalidateSettings } from "../admin/settings.js";

// call recordings: the audio in object storage goes with the record
const RecordingFiles = { deleteMany: async (filter) => ({ deletedCount: await removeAttachments(filter, { model: SupportRecording }) }) };

const models = {
  Booking, Conversation, Message, Event, AgentSettings, CheckoutSession, OrderSubmission, StoreIntegration, Attachment: AttachmentFiles, OrderLookupSession, RateLimitHit,
  Complaint, SupportCall, SupportRecording: RecordingFiles, SupportPresence, VoiceSession, EmailOutbox, WebhookReceipt, ReplyLedger,
};
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const numericId = (v) => String(v ?? "").match(/(\d+)\s*$/)?.[1] || null;

/** Who the request is about. With neither an id nor an email nothing can match. */
export function customerKeys(customer = {}) {
  const id = numericId(customer.id);
  const email = typeof customer.email === "string" && customer.email.includes("@") ? customer.email.trim().toLowerCase() : "";
  return { id, gid: id ? `gid://shopify/Customer/${id}` : null, email, emailRe: email ? new RegExp(`^${escapeRegex(email)}$`, "i") : null };
}

function sessionFilter(shop, keys) {
  const or = [];
  if (keys.id) or.push({ "customer.id": { $in: [keys.id, keys.gid] } });
  if (keys.emailRe) or.push({ "customer.email": keys.emailRe }, { "shipping.email": keys.emailRe }, { "billing.email": keys.emailRe });
  return or.length ? { shop, $or: or } : null;
}

// A customer's chats: those they were signed in for, and those where they gave this email at checkout.
function chatMatches(keys) {
  return [...(keys.id ? [{ customerRef: keys.id }] : []), ...(keys.emailRe ? [{ "contact.email": keys.emailRe }] : [])];
}

const startsWith = (prefix) => ({ $regex: `^${escapeRegex(prefix)}` });

/** The email-verification rows of one customer in one store: by the email they verified, and by their signed-in id. */
function orderLookupFilter(shop, keys) {
  const or = [];
  if (keys.emailRe) {
    const email = `^${escapeRegex(keys.email)}$`;
    or.push(
      { key: startsWith(orderLookupKeys.sessionPrefix(shop)), "data.email": { $regex: email, $options: "i" } },
      { key: startsWith(orderLookupKeys.sessionPrefix(shop)), "data.verifiedEmail": { $regex: email, $options: "i" } },
      { key: orderLookupKeys.emailKey(shop, keys.email) }
    );
  }
  // a signed-in shopper without a browser id gets one derived from their customer id
  if (keys.id) or.push({ key: orderLookupKeys.sessionKey(shop, resolveClientId({ shop, customerId: verifiedCustomerGid(keys.id) })) });
  return or.length ? { $or: or } : null;
}

// Their calls with the team: from their chats, their signed-in id or the email they gave. (Never by the browser alone: it can be shared.)
function callMatches(keys, ids) {
  return [
    ...(ids.length ? [{ conversationId: { $in: ids } }] : []),
    ...(keys.id ? [{ "customer.customerId": keys.id }, { personKey: `c${keys.id}` }] : []),
    ...(keys.emailRe ? [{ "customer.email": keys.emailRe }] : []),
  ];
}

function complaintMatches(keys, ids) {
  return [...(ids.length ? [{ conversationId: { $in: ids } }] : []), ...(keys.emailRe ? [{ "customer.email": keys.emailRe }] : [])];
}

/**
 * What a customer left with the support side. Complaints and call recordings are deleted; the call records lose the name,
 * contact and reason (that a call happened and who of the team took it stays: it says nothing about who the shopper was);
 * emails still waiting to be sent to them are dropped, and the reply fingerprints of their chats go.
 */
async function eraseSupportTrail(shop, keys, ids, refs, m) {
  const out = { calls: 0, recordings: 0, complaints: 0 };
  const calls = callMatches(keys, ids);
  if (m.SupportCall && calls.length) {
    const rows = await m.SupportCall.find({ shop, $or: calls }, { _id: 1 }).lean();
    const callIds = rows.map((c) => c._id);
    if (callIds.length) {
      if (m.SupportRecording) out.recordings = (await m.SupportRecording.deleteMany({ shop, callId: { $in: callIds } })).deletedCount || 0;
      await m.SupportCall.updateMany({ shop, _id: { $in: callIds } }, { $set: { reason: "", "recording.status": "none" }, $unset: { customer: "", personKey: "", "recording.recordingId": "" } });
      out.calls = callIds.length;
    }
  }
  const complaints = complaintMatches(keys, ids);
  if (m.Complaint && complaints.length) out.complaints = (await m.Complaint.deleteMany({ shop, $or: complaints })).deletedCount || 0;
  if (m.EmailOutbox && keys.emailRe) await m.EmailOutbox.deleteMany({ shop, $or: [{ "message.to": keys.emailRe }, { "message.cc": keys.emailRe }] });
  if (m.ReplyLedger && refs.length) await m.ReplyLedger.deleteMany({ _id: { $in: refs.map((ref) => `${shop}|${ref}`) } });
  return out;
}

/** customers/redact: delete this customer's chats, files, saved checkout details, email checks, complaints, call recordings and order records. */
export async function eraseCustomer(shop, { customer, ordersToRedact = [] } = {}, m = models) {
  const keys = customerKeys(customer);
  const out = { conversations: 0, messages: 0, events: 0, attachments: 0, sessions: 0, verifications: 0, submissions: 0, bookings: 0, calls: 0, recordings: 0, complaints: 0 };
  if (keys.id || keys.emailRe) {
    const chats = await m.Conversation.find({ shop, $or: chatMatches(keys) }, { _id: 1, chatRef: 1 }).lean();
    const ids = chats.map((c) => c._id);
    const refs = [...new Set(chats.map((c) => c.chatRef).filter(Boolean))];
    // photos, videos and PDFs they sent in those chats
    if (refs.length) out.attachments = (await m.Attachment.deleteMany({ shop, chatRef: { $in: refs } })).deletedCount || 0;
    if (ids.length) {
      out.messages = (await m.Message.deleteMany({ shop, conversationId: { $in: ids } })).deletedCount || 0;
      out.events = (await m.Event.deleteMany({ shop, conversationId: { $in: ids } })).deletedCount || 0;
      out.conversations = (await m.Conversation.deleteMany({ shop, _id: { $in: ids } })).deletedCount || 0;
    }
    // calls they asked for, from those chats or under their email
    const bookingMatch = [...(ids.length ? [{ conversationId: { $in: ids } }] : []), ...(keys.emailRe ? [{ email: keys.emailRe }] : [])];
    if (bookingMatch.length && m.Booking) out.bookings = (await m.Booking.deleteMany({ shop, $or: bookingMatch })).deletedCount || 0;
    Object.assign(out, await eraseSupportTrail(shop, keys, ids, refs, m));
  }
  const filter = sessionFilter(shop, keys);
  if (filter) out.sessions = (await m.CheckoutSession.deleteMany(filter)).deletedCount || 0;
  const lookups = orderLookupFilter(shop, keys);
  if (lookups) out.verifications = (await m.OrderLookupSession.deleteMany(lookups)).deletedCount || 0;
  // short-lived request counters keyed by their signed-in id
  if (keys.id) await m.RateLimitHit.deleteMany({ _id: { $regex: `^visitor:[a-z0-9-]+:${escapeRegex(shop)}\\|customer:${keys.id}@` } });
  const orderGids = ordersToRedact.map(numericId).filter(Boolean).map((id) => `gid://shopify/Order/${id}`);
  if (orderGids.length) out.submissions = (await m.OrderSubmission.deleteMany({ shop, "result.shopifyOrderId": { $in: orderGids } })).deletedCount || 0;
  return out;
}

/** customers/data_request: everything stored about this customer, as plain data. */
export async function exportCustomer(shop, { customer } = {}, m = models) {
  const keys = customerKeys(customer);
  const data = { shop, generatedAt: new Date().toISOString(), conversations: [], checkoutSessions: [], bookings: [], attachments: [], complaints: [], calls: [] };
  if (keys.id || keys.emailRe) {
    const conversations = await m.Conversation.find({ shop, $or: chatMatches(keys) }).sort({ startedAt: 1 }).lean();
    const refs = [...new Set(conversations.map((c) => c.chatRef).filter(Boolean))];
    if (refs.length) {
      // what each file is (the files themselves stay with the store, which can open them in the dashboard)
      const files = await m.Attachment.find({ shop, chatRef: { $in: refs } }, { name: 1, kind: 1, mime: 1, size: 1, createdAt: 1 }).lean();
      data.attachments = files.map((f) => ({ name: f.name, kind: f.kind, mime: f.mime, size: f.size, createdAt: f.createdAt }));
    }
    if (m.Booking) {
      const bookingMatch = [...(conversations.length ? [{ conversationId: { $in: conversations.map((c) => c._id) } }] : []), ...(keys.emailRe ? [{ email: keys.emailRe }] : [])];
      const rows = bookingMatch.length ? await m.Booking.find({ shop, $or: bookingMatch }).lean() : [];
      data.bookings = rows.map((b) => ({ name: b.name, email: b.email, phone: b.phone, topic: b.topic, status: b.status, startAt: b.startAt, timezone: b.timezone }));
    }
    const ids = conversations.map((c) => c._id);
    if (m.Complaint && complaintMatches(keys, ids).length) {
      const rows = await m.Complaint.find({ shop, $or: complaintMatches(keys, ids) }).lean();
      data.complaints = rows.map((c) => ({ reference: c.reference, status: c.status, summary: c.summary, originalMessage: c.originalMessage, orderNumber: c.orderNumber, productName: c.productName, customer: c.customer || null, createdAt: c.createdAt }));
    }
    if (m.SupportCall && callMatches(keys, ids).length) {
      const rows = await m.SupportCall.find({ shop, $or: callMatches(keys, ids) }).lean();
      data.calls = rows.map((c) => ({ status: c.status, reason: c.reason, customer: c.customer || null, requestedAt: c.requestedAt, connectedAt: c.connectedAt, endedAt: c.endedAt, recorded: c.recording?.status === "saved" }));
    }
    for (const c of conversations) {
      const messages = await m.Message.find({ shop, conversationId: c._id }).sort({ at: 1 }).lean();
      data.conversations.push({
        startedAt: c.startedAt, channel: c.channel, language: c.language, outcome: c.outcome,
        messages: messages.map((x) => ({ at: x.at, role: x.role, text: x.text })),
      });
    }
  }
  const filter = sessionFilter(shop, keys);
  if (filter) {
    const sessions = await m.CheckoutSession.find(filter).lean();
    data.checkoutSessions = sessions.map((s) => ({ customer: s.customer || null, shipping: s.shipping || null, billing: s.billing || null, profile: s.profile || null, updatedAt: s.updatedAt }));
  }
  return data;
}

/** The store owner's email, where the export is sent (they answer the customer, as Shopify requires). */
async function ownerEmail(shop, m) {
  const settings = await m.AgentSettings.findOne({ shop }, { notificationEmail: 1 }).lean();
  if (settings?.notificationEmail) return settings.notificationEmail;
  const store = await m.StoreIntegration.findOne({ platform: "shopify", storeDomain: shop }).lean();
  return store?.contactEmail || store?.shopEmail || store?.storeProfile?.email || store?.storeProfile?.contactEmail || "";
}

export async function fulfillDataRequest(shop, payload = {}, { models: m = models, send = sendPlainEmail } = {}) {
  const data = await exportCustomer(shop, payload, m);
  const found = data.conversations.length + data.checkoutSessions.length + (data.bookings?.length || 0) + (data.attachments?.length || 0) + data.complaints.length + data.calls.length;
  const to = await ownerEmail(shop, m);
  if (!to) return { found, emailed: false, reason: "no store contact email" };
  const sent = await send({
    to,
    subject: `Customer data request for ${shop}`,
    text: [
      `A customer of ${shop} asked Shopify for the data stored about them (request ${payload.data_request?.id ?? "n/a"}).`,
      `The attached file holds what the AI chat assistant stored: ${data.conversations.length} conversation(s), ${data.checkoutSessions.length} saved checkout record(s), ${data.bookings.length} call request(s), ${data.calls.length} call(s) with your team, ${data.complaints.length} complaint(s) and ${data.attachments.length} file(s) they sent.`,
      "Please send it to the customer yourself, as Shopify's rules require you to answer within 30 days. Order data itself is in your Shopify admin.",
    ].join("\n\n"),
    attachments: [{ filename: "customer-data.json", content: JSON.stringify(data, null, 2), contentType: "application/json" }],
  });
  return { found, emailed: Boolean(sent?.ok), ...(sent?.ok ? {} : { reason: sent?.error || "email failed" }) };
}

/**
 * shop/redact: 48 hours after uninstall, delete everything about the store. If the store has come
 * back and is active again, nothing is deleted.
 */
export async function eraseShop(shop, m = models) {
  const store = await m.StoreIntegration.findOne({ platform: "shopify", storeDomain: shop }).lean();
  if (store?.status === "active") return { skipped: "store is installed again" };
  const out = {};
  for (const name of ["Booking", "Conversation", "Message", "Event", "Attachment", "AgentSettings", "CheckoutSession", "OrderSubmission"]) {
    out[name] = (await m[name].deleteMany({ shop })).deletedCount || 0;
  }
  // complaints, calls with the team and their recordings, who was on duty, voice slots and emails still waiting to go
  for (const name of ["Complaint", "SupportRecording", "SupportCall", "SupportPresence", "VoiceSession", "EmailOutbox"]) {
    if (m[name]) out[name] = (await m[name].deleteMany({ shop })).deletedCount || 0;
  }
  // webhook work that was given up on still holds its body; work still running (this very request) is left to finish
  if (m.WebhookReceipt) out.WebhookReceipt = (await m.WebhookReceipt.deleteMany({ shop, status: { $in: ["done", "dead"] } })).deletedCount || 0;
  if (m.ReplyLedger) out.ReplyLedger = (await m.ReplyLedger.deleteMany({ _id: startsWith(`${shop}|`) })).deletedCount || 0;
  // rows keyed by the store's name rather than a shop field
  out.OrderLookupSession = (await m.OrderLookupSession.deleteMany({ $or: [{ key: startsWith(orderLookupKeys.sessionPrefix(shop)) }, { key: startsWith(orderLookupKeys.emailPrefix(shop)) }] })).deletedCount || 0;
  out.RateLimitHit = (await m.RateLimitHit.deleteMany({ _id: { $regex: `:${escapeRegex(shop)}[|@]` } })).deletedCount || 0;
  out.StoreIntegration = (await m.StoreIntegration.deleteMany({ platform: "shopify", storeDomain: shop })).deletedCount || 0;
  invalidateSettings(shop);
  return out;
}