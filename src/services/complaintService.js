// Customer complaints: the structured memory of a chat's problem and the single way it is escalated.
//
//   recordIssue()   the assistant is dealing with a problem: what the customer said, order, product, what was already tried
//   escalate()      the customer asked for it to be raised: by email to the store (copy to the customer) or to a person
//   markHandoff()   a call was requested / connected / could not be made / a callback was booked
//
// Nothing here is claimed in advance: an email counts as sent only when the mail server accepted it; a failure is kept,
// shown to the store in the dashboard and sent to the alert channel, and the caller says so honestly.
import crypto from "node:crypto";
import mongoose from "mongoose";
import Complaint from "../models/Complaint.js";
import Conversation from "../models/Conversation.js";
import { sendPlainEmail, isEmailConfigured } from "./emailService.js";
import { defaultOwnerEmail } from "./bookingService.js";
import { validateEmail } from "./contactValidation.js";
import { cleanEmail } from "./people.js";
import { alert } from "../observability/alerts.js";
import { retentionDaysFor } from "../admin/settings.js";

const DAY_MS = 86_400_000;
const REF_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export const newReference = () => `CMP-${Array.from(crypto.randomBytes(6), (b) => REF_CHARS[b % REF_CHARS.length]).join("")}`;

const defaults = () => ({
  model: Complaint,
  send: sendPlainEmail,
  emailConfigured: isEmailConfigured,
  ownerEmail: defaultOwnerEmail,
  now: () => Date.now(),
  flagChat: async (shop, chatRef) => { await Conversation.updateOne({ shop, chatRef, clearedAt: null }, { $set: { "flags.needsFollowUp": true } }).catch(() => {}); },
  notify: alert,
});
const deps = (over = {}) => ({ ...defaults(), ...over });

const isDuplicate = (error) => error?.code === 11000;
// Without a database connection a query would wait for one: callers on a chat's hot path get "nothing" at once instead.
const dbUp = (over) => Boolean(over?.model) || mongoose.connection?.readyState === 1;
const OPEN = { open: true };
export const ASKABLE = ["orderNumber", "email", "photo", "other"];

export async function openComplaintForChat(shop, chatRef, over = {}) {
  const d = deps(over);
  if (!shop || !chatRef || !dbUp(over)) return null;
  return d.model.findOne({ shop, chatRef: clean(chatRef, 64), ...OPEN }).lean();
}

// ---- what the customer is going through ----------------------------------------------------------------------------------
/**
 * Writes down (or adds to) the open complaint of this chat. Called while the assistant works on the problem, so the
 * structured context is kept: the customer's own first words are kept once and never overwritten, what was tried is
 * added to (never repeated), and a detail the customer gave once is not asked for again.
 */
export async function recordIssue({ shop, chatRef, language = "", settings = {}, issue = {} }, over = {}) {
  const d = deps(over);
  const ref = clean(chatRef, 64);
  if (!shop || !ref) return { status: "invalid" };
  if (!dbUp(over)) return { status: "unavailable", complaint: null };
  const set = {};
  const put = (key, value, max) => { const v = clean(value, max); if (v) set[key] = v; };
  put("summary", issue.summary, 1000);
  put("orderNumber", issue.orderNumber, 40);
  put("productName", issue.productName, 200);
  put("customerResponse", issue.customerResponse, 600);
  put("escalationReason", issue.escalationReason, 400);
  put("choiceOfferedKey", issue.choiceOfferedKey, 40);
  const asking = (Array.isArray(issue.askingFor) ? issue.askingFor : []).filter((k) => ASKABLE.includes(k)).slice(0, 4);
  put("customer.name", issue.customerName, 80);
  const email = cleanEmail(issue.customerEmail);
  if (email && validateEmail(email).ok) set["customer.email"] = email;
  if (issue.orderVerified === true) set.orderVerified = true;
  if (language) set.language = clean(language, 16);
  const attempts = (Array.isArray(issue.attempted) ? issue.attempted : []).map((a) => clean(a, 300)).filter(Boolean).slice(0, 10);
  const original = clean(issue.originalMessage, 1500);
  // the same customer message is counted once, however many times the assistant writes the problem down while answering it
  const messageKey = clean(issue.messageKey, 40);
  let counts = 0;
  if (messageKey && typeof d.model.findOne === "function") {
    const before = await d.model.findOne({ shop, chatRef: ref, ...OPEN }).select("lastMessageKey").lean().catch(() => null);
    counts = before?.lastMessageKey === messageKey ? 0 : 1;
    set.lastMessageKey = messageKey;
  }

  for (let tries = 0; tries < 2; tries += 1) {
    try {
      const now = d.now();
      const update = {
        ...(Object.keys(set).length ? { $set: set } : {}),
        ...(counts ? { $inc: { mentions: 1 } } : {}),
        ...(asking.length ? { $push: { asked: { $each: asking } } } : {}),
        ...(attempts.length ? { $addToSet: { attempts: { $each: attempts } } } : {}),
        $setOnInsert: { reference: newReference(), status: "troubleshooting", expiresAt: new Date(now + Math.max(retentionDaysFor(settings), 30) * DAY_MS) },
      };
      const doc = await d.model.findOneAndUpdate({ shop, chatRef: ref, ...OPEN }, update, { upsert: true, new: true, lean: true, setDefaultsOnInsert: true });
      // the customer's own words are kept once, as they wrote them
      if (original && !doc.originalMessage) return { status: "ok", complaint: await d.model.findOneAndUpdate({ _id: doc._id, shop }, { $set: { originalMessage: original } }, { new: true, lean: true }) };
      return { status: "ok", complaint: doc };
    } catch (error) {
      if (!isDuplicate(error)) throw error; // two requests made the first one at the same moment: the second finds it
    }
  }
  return { status: "ok", complaint: await openComplaintForChat(shop, ref, over) };
}

// ---- the email --------------------------------------------------------------------------------------------------------------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (date) => new Date(date).toUTCString().replace("GMT", "UTC");

export function complaintSubject(c) {
  return `Customer Complaint - ${c.orderNumber ? `Order ${c.orderNumber.startsWith("#") ? c.orderNumber : `#${c.orderNumber}`}` : c.reference}`;
}

/** The email: only what the customer and the conversation gave. Nothing is filled in. */
export function complaintEmailContent(c, { shopName = "the store", now = Date.now() } = {}) {
  const rows = [
    ["Complaint reference", c.reference],
    ["Received", when(c.createdAt || now)],
    ["Customer", c.customer?.name],
    ["Customer email", c.customer?.email],
    ["Order", c.orderNumber ? `${c.orderNumber}${c.orderVerified ? " (checked against the store's records)" : " (given by the customer, not verified)"}` : ""],
    ["Product", c.productName],
    ["Language", c.language],
    ["Conversation reference", c.chatRef],
  ].filter(([, v]) => v);
  const attempts = Array.isArray(c.attempts) ? c.attempts : [];
  const blocks = [
    ["What the customer reports", c.summary],
    ["The customer's own words", c.originalMessage],
    ["What the assistant already tried or suggested", attempts.length ? attempts.map((a) => `- ${a}`).join("\n") : "Nothing yet: the customer asked to raise the complaint straight away."],
    ["The customer's reply to that", c.customerResponse],
    ["Why it is being escalated", c.escalationReason || "The customer asked for the complaint to be raised."],
  ].filter(([, v]) => v);
  const subject = complaintSubject(c);
  const text = [`New customer complaint for ${shopName}.`, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", ...blocks.flatMap(([k, v]) => [`${k}:`, v, ""]),
    "The customer has been sent a copy of this email. Reply to it to answer them, or open the app in your Shopify admin and go to Complaints.", ""].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#0F1A1F"><h2 style="margin:0 0 4px">${esc(subject)}</h2><p style="color:#566; margin:0 0 16px">New customer complaint for ${esc(shopName)}</p>
<table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) => `<tr><td style="padding:5px 12px 5px 0;color:#566;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:5px 0">${esc(v)}</td></tr>`).join("")}</table>
${blocks.map(([k, v]) => `<h4 style="margin:16px 0 4px">${esc(k)}</h4><p style="margin:0;white-space:pre-wrap">${esc(v)}</p>`).join("")}
<p style="margin-top:20px;color:#566;font-size:13px">The customer has been sent a copy of this email. Reply to it to answer them, or open the app in your Shopify admin and go to Complaints.</p></div>`;
  return { subject, text, html };
}

// ---- raising it -----------------------------------------------------------------------------------------------------------------
/**
 * The customer asked for the complaint to be raised.
 *   channel "email": one email to the store, a copy to the customer. Sent once: asking again returns what already happened.
 *   channel "human": no email; the customer wants a person. The complaint (and everything in it) goes with the request.
 * Returns { status, complaint, email }: status is "ok", "already_raised", "needs_email", "email_not_configured", "email_failed",
 * "email_retrying" or "invalid". The email counts as sent only when `email.status` is "sent".
 */
export async function escalate({ shop, chatRef, channel, customer = {}, reason = "", issue = {}, shopName = "", settings = {}, language = "" }, over = {}) {
  const d = deps(over);
  if (!shop || !chatRef || !["email", "human"].includes(channel)) return { status: "invalid" };
  if (!dbUp(over)) return { status: "unavailable" };
  const { complaint: base } = await recordIssue({ shop, chatRef, language, settings, issue: { ...issue, escalationReason: reason || issue.escalationReason, customerName: customer.name || issue.customerName, customerEmail: customer.email || issue.customerEmail } }, over);
  let c = base;
  const view = () => complaintView(c);

  if (channel === "human") {
    // the customer does not want the email: it is not sent, and the complaint stays as it is for the person
    const emailPending = ["none", "needs_email", "failed", "not_configured"].includes(c.email?.status || "none");
    c = await d.model.findOneAndUpdate(
      { _id: c._id, shop },
      { $set: { channel: "human", escalatedAt: new Date(d.now()), ...(emailPending ? { "email.status": "refused" } : {}), ...(["troubleshooting", "raised", "email_failed"].includes(c.status) ? { status: "human_requested" } : {}) } },
      { new: true, lean: true }
    );
    return { status: "ok", complaint: view(), emailAlreadySent: c.email?.status === "sent" || c.email?.status === "retrying" };
  }

  // an email already went (or is going): it cannot be recalled and is not sent again
  if (["sent", "retrying", "sending"].includes(c.email?.status)) return { status: "already_raised", complaint: view(), email: { status: c.email.status } };

  const to = await d.ownerEmail(shop, settings);
  const cc = cleanEmail(c.customer?.email);
  if (!cc || !validateEmail(cc).ok) {
    c = await d.model.findOneAndUpdate({ _id: c._id, shop }, { $set: { "email.status": "needs_email", channel: "email" } }, { new: true, lean: true });
    return { status: "needs_email", complaint: view() };
  }
  if (!to || !d.emailConfigured()) {
    c = await d.model.findOneAndUpdate({ _id: c._id, shop }, { $set: { channel: "email", status: "email_failed", escalatedAt: new Date(d.now()), "email.status": "not_configured", "email.error": !to ? "The store has no support email set." : "Email sending is not set up on the server." } }, { new: true, lean: true });
    await failureFallback(d, shop, chatRef, c, !to ? "the store has no support email set" : "email sending is not set up");
    return { status: "email_not_configured", complaint: view(), email: { status: "not_configured" } };
  }

  // one sender: the claim is atomic, so two requests at once send one email
  const mail = complaintEmailContent(c, { shopName: shopName || shop, now: d.now() });
  const claimed = await d.model.findOneAndUpdate(
    { _id: c._id, shop, "email.status": { $in: ["none", "needs_email", "failed", "not_configured", null] } },
    { $set: { channel: "email", escalatedAt: new Date(d.now()), status: "raised", "email.status": "sending", "email.to": to, "email.cc": cc, "email.subject": mail.subject }, $unset: { "email.error": "" } },
    { new: true, lean: true }
  );
  if (!claimed) return { status: "already_raised", complaint: view(), email: { status: (await d.model.findOne({ _id: c._id, shop }).lean())?.email?.status } };

  let result;
  try {
    result = await d.send({ to, cc, replyTo: cc, subject: mail.subject, text: mail.text, html: mail.html, retry: { kind: "complaint", shop } });
  } catch (error) {
    result = { ok: false, error: String(error?.message || error) };
  }
  const final = result?.ok ? { status: "email_sent", email: "sent" } : result?.queued ? { status: "raised", email: "retrying" } : { status: "email_failed", email: "failed" };
  c = await d.model.findOneAndUpdate(
    { _id: claimed._id, shop },
    { $set: { status: final.status, "email.status": final.email, ...(result?.ok ? { "email.sentAt": new Date(d.now()) } : { "email.error": clean(result?.error, 300) }) } },
    { new: true, lean: true }
  );
  if (!result?.ok) await failureFallback(d, shop, chatRef, c, clean(result?.error, 160));
  return { status: result?.ok ? "ok" : result?.queued ? "email_retrying" : "email_failed", complaint: view(), email: { status: final.email } };
}

/** The email did not go: the store hears about it another way, and the chat is marked so the team sees it. */
async function failureFallback(d, shop, chatRef, c, why) {
  try { await d.flagChat(shop, chatRef); } catch { /* the dashboard still lists the complaint */ }
  try { d.notify(`complaint_email:${shop}`, `A customer complaint (${c.reference}) for ${shop} could not be emailed: ${why}. It is saved under Complaints in the dashboard.`); } catch { /* alerting must never break the chat */ }
}

// ---- what became of it ---------------------------------------------------------------------------------------------------------
/** A call was requested, connected, could not be made, ended, or a callback was booked for this complaint. */
export async function markHandoff({ shop, chatRef, status, callId, bookingId }, over = {}) {
  const d = deps(over);
  if (!shop || !chatRef || !["requested", "connected", "unavailable", "callback", "ended"].includes(status) || !dbUp(over)) return null;
  const set = { "handoff.status": status, "handoff.at": new Date(d.now()), ...(callId ? { "handoff.callId": String(callId) } : {}), ...(bookingId ? { "handoff.bookingId": String(bookingId) } : {}) };
  if (status === "requested" || status === "connected") set.status = "human_requested";
  if (status === "callback") set.status = "callback_booked";
  return d.model.findOneAndUpdate({ shop, chatRef: clean(chatRef, 64), ...OPEN, status: { $ne: "resolved" } }, { $set: set }, { new: true, lean: true });
}

export async function resolveComplaint(shop, id, by = "", over = {}) {
  const d = deps(over);
  if (!/^[a-f0-9]{24}$/i.test(String(id || ""))) return null;
  return d.model.findOneAndUpdate({ _id: id, shop }, { $set: { status: "resolved", open: false, resolvedAt: new Date(d.now()), resolvedBy: clean(by, 80) } }, { new: true, lean: true });
}

/** After a turn is stored: ties the complaint to its conversation so the dashboard can open the whole chat. */
export async function linkComplaintToConversation(shop, chatRef, conversationId, over = {}) {
  const d = deps(over);
  if (!shop || !chatRef || !conversationId || !dbUp(over)) return 0;
  const res = await d.model.updateMany({ shop, chatRef: clean(chatRef, 64), conversationId: null }, { $set: { conversationId } });
  return res?.modifiedCount || 0;
}

export async function listComplaints(shop, { status = "", open = null, limit = 50 } = {}, over = {}) {
  const d = deps(over);
  const filter = { shop };
  if (status) filter.status = status;
  if (open === true || open === false) filter.open = open;
  return d.model.find(filter).sort({ createdAt: -1 }).limit(Math.min(Math.max(Number(limit) || 50, 1), 200)).lean();
}

export async function getComplaint(shop, id, over = {}) {
  const d = deps(over);
  if (!/^[a-f0-9]{24}$/i.test(String(id || ""))) return null;
  return d.model.findOne({ _id: id, shop }).lean();
}

/** What the dashboard shows. */
export function complaintView(c) {
  if (!c) return null;
  return {
    id: String(c._id),
    reference: c.reference,
    status: c.status,
    open: c.open !== false,
    chatRef: c.chatRef,
    conversationId: c.conversationId ? String(c.conversationId) : null,
    summary: c.summary || "",
    originalMessage: c.originalMessage || "",
    orderNumber: c.orderNumber || "",
    orderVerified: Boolean(c.orderVerified),
    productName: c.productName || "",
    attempts: c.attempts || [],
    customerResponse: c.customerResponse || "",
    escalationReason: c.escalationReason || "",
    customer: { name: c.customer?.name || "", email: c.customer?.email || "" },
    channel: c.channel || "none",
    email: { status: c.email?.status || "none", to: c.email?.to || "", cc: c.email?.cc || "", subject: c.email?.subject || "", sentAt: c.email?.sentAt || null, error: c.email?.error || "" },
    handoff: { status: c.handoff?.status || "none", callId: c.handoff?.callId || null, bookingId: c.handoff?.bookingId || null, at: c.handoff?.at || null },
    language: c.language || "",
    createdAt: c.createdAt,
    escalatedAt: c.escalatedAt || null,
    resolvedAt: c.resolvedAt || null,
  };
}

/**
 * What the assistant is told at the start of every turn while this chat has an open complaint, so it never asks again for
 * what it already has, never suggests the same fix twice, and says only what really happened to the email or the call.
 */
export function complaintPromptBlock(c) {
  if (!c) return "";
  const lines = [
    `COMPLAINT IN PROGRESS (reference ${c.reference}, status: ${c.status}). This is what the customer already told you: do NOT ask for any of it again.`,
    c.originalMessage ? `- Their own first words: "${c.originalMessage}"` : "",
    c.summary ? `- The problem: ${c.summary}` : "",
    c.orderNumber ? `- Order: ${c.orderNumber}${c.orderVerified ? " (checked)" : " (as the customer said it)"}` : "",
    c.productName ? `- Product: ${c.productName}` : "",
    c.customer?.email ? `- Customer email: ${c.customer.email}` : "",
    c.attempts?.length ? `- Already suggested or tried (never suggest these again):\n${c.attempts.map((a) => `    * ${a}`).join("\n")}` : "",
    c.customerResponse ? `- The customer's answer to that: ${c.customerResponse}` : "",
    c.status === "troubleshooting" && (c.mentions || 0) >= 2 ? `- STAGE: the customer has now come back to this problem (${c.mentions} messages about it) and it is not solved. Do step 3 NOW: say you understand it is not resolved and that you are raising a complaint, and ask the ONE question (by email with a copy to them, or a person). Do NOT ask for any other detail, do NOT ask for an order number, do NOT suggest another step, and do NOT call raise_complaint until they have answered that question.` : "",
    !c.orderNumber ? ((c.asked || []).includes("orderNumber")
      ? "- ORDER NUMBER: you have ALREADY asked for it once and the customer did not give it. NEVER ask again and do not insist: a complaint does not need it."
      : "- ORDER NUMBER: the customer has not given one. You may ask for it ONCE in this whole chat, and when you do, call track_issue with askingFor [\"orderNumber\"] so the store remembers it. It is not needed to raise a complaint.") : "",
    c.status === "troubleshooting" && (c.mentions || 0) < 2 && !(c.attempts?.length) ? "- STAGE: you have not suggested anything yet. Solve it now (look up the order if they are verified, read the policy, give a concrete next step). Do NOT say you are raising a complaint and do NOT offer email or a person yet." : "",
    c.status === "troubleshooting" && c.attempts?.length ? "- STAGE: you have already tried (above). If the customer now says it is still not solved, repeats it, or is unhappy, raise the complaint (step 3). If they accept the suggestion or give new information, carry on helping." : "",
    `- Escalation: channel ${c.channel}; email ${c.email?.status || "none"}${c.email?.status === "sent" ? " (sent to the store and copied to the customer; it cannot be recalled)" : ""}; person/call ${c.handoff?.status || "none"}.`,
  ].filter(Boolean);
  return lines.join("\n");
}
