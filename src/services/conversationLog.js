// Records what happens in a chat so the store owner can see it: the conversation, its transcript
// (with personal data removed) and analytics events. It is written AFTER the customer has their
// answer, in the background, so logging can never slow a reply or break it.
//
// Nothing here knows about a particular industry: the industry module says which events a turn
// produced (`analytics.eventsFromResult`) and how far a chat got (`analytics.outcomes`).
import crypto from "node:crypto";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import Event from "../models/Event.js";
import { RETURNING_AFTER_MS } from "./conversationContinuity.js";
import { retentionDaysFor, transcriptsEnabled } from "../admin/settings.js";
import { cleanContact, personKeyFor } from "./people.js";
import { linkBookingsToChat, defaultOwnerEmail } from "./bookingService.js";
import { linkComplaintToConversation } from "./complaintService.js";
import { sendChatAlert } from "./bookingEmails.js";
import { alertOn } from "./bookingSettings.js";

export const EVENT_RETENTION_DAYS = Number(process.env.EVENT_RETENTION_DAYS || 400);
const DAY_MS = 24 * 3600 * 1000;
const MAX_PROPS_BYTES = 2000;

// ---- personal data ---------------------------------------------------------------------------
function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Transcripts keep what was said but not contact details or secrets: emails, phone numbers, card
 * numbers and one-time codes are replaced by a label. (Street addresses are free text and cannot be
 * recognised reliably; the retention period and the erase webhooks cover them.)
 */
export function redactText(value, max = 4000) {
  let text = String(value ?? "");
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  text = text.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? "[card]" : m;
  });
  text = text.replace(/\b(otp|code|pin|cvv|cvc|passcode)(\D{0,14})(\d{3,8})\b/gi, "$1$2[code]");
  text = text.replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => {
    const digits = m.replace(/\D/g, "").length;
    return /^\d{4}-\d{2}-\d{2}/.test(m) || digits < 8 || digits > 15 ? m : "[phone]"; // E.164 phones have at most 15 digits
  });
  if (/^\s*\d{4,8}\s*$/.test(text)) text = "[code]";
  return text.trim().slice(0, max);
}

// ---- visitor reference -----------------------------------------------------------------------
/** A stable public id for a visitor. It cannot be turned back into the private client id. */
export function chatRefFor(shop, clientId) {
  const secret = process.env.ANALYTICS_HMAC_SECRET || process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET || "development-only-secret";
  return crypto.createHmac("sha256", secret).update(`chatref:${String(shop).toLowerCase()}:${clientId}`).digest("base64url").slice(0, 22);
}

// ---- per-turn measurements -------------------------------------------------------------------
export function newTelemetry() {
  return { startedAt: Date.now(), provider: "", model: "", llmCalls: 0, tokensIn: 0, tokensCached: 0, tokensOut: 0, tools: [] };
}

export function noteLLM(telemetry, { provider, model, usage } = {}) {
  if (!telemetry) return;
  telemetry.llmCalls += 1;
  if (provider) telemetry.provider = provider;
  if (model) telemetry.model = model;
  telemetry.tokensIn += Number(usage?.promptTokenCount ?? usage?.prompt_tokens) || 0;
  telemetry.tokensCached += Number(usage?.cachedContentTokenCount) || 0;
  telemetry.tokensOut += Number(usage?.candidatesTokenCount ?? usage?.completion_tokens) || 0;
}

export function noteTool(telemetry, name, ms) {
  if (telemetry && telemetry.tools.length < 40) telemetry.tools.push({ name: String(name), ms: Math.round(ms) || 0 });
}

// ---- writing ---------------------------------------------------------------------------------
const numericId = (value) => String(value ?? "").match(/(\d+)\s*$/)?.[1] || null;

function safeProps(props) {
  try {
    const json = JSON.stringify(props ?? {});
    return json.length <= MAX_PROPS_BYTES ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

function highestOutcome(events, outcomes) {
  let best = { name: "", rank: 0 };
  for (const event of events) {
    const rank = outcomes?.[event.type] ?? 0;
    if (rank > best.rank) best = { name: event.type, rank };
  }
  return best;
}

const defaultDeps = {
  Conversation,
  Message,
  Event,
  connected: () => Conversation.db?.readyState === 1,
  now: () => Date.now(),
  linkBookings: linkBookingsToChat,
  ownerEmail: defaultOwnerEmail,
  alert: sendChatAlert,
};

/** What the reply put on screen, with free text redacted like the transcript itself. */
function cleanShown(shown) {
  const redactAll = (value) => (typeof value === "string" ? redactText(value, 300) : value);
  const products = (shown?.products || []).map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== "")));
  const actions = (shown?.actions || []).map((a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, redactAll(v)])));
  return products.length || actions.length ? { ...(products.length ? { products } : {}), ...(actions.length ? { actions } : {}) } : null;
}

/**
 * Stores one finished turn. Returns the conversation id, or null when nothing was stored.
 * @param analytics  the industry's `analytics` block: { outcomes: {eventType: rank}, eventsFromResult(result) }
 */
export async function recordTurn(turn, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  if (!d.connected()) return null;
  const { shop, clientId, analytics = {}, settings = {}, result = {}, userMessage = "", telemetry = null, degraded = false } = turn;
  if (!shop || !clientId) return null;

  const now = d.now();
  const at = new Date(now);
  const chatRef = chatRefFor(shop, clientId);
  const keepText = transcriptsEnabled(settings);
  const messageExpiry = new Date(now + retentionDaysFor(settings) * DAY_MS);
  const eventExpiry = new Date(now + EVENT_RETENTION_DAYS * DAY_MS);
  const industryEvents = (typeof analytics.eventsFromResult === "function" ? analytics.eventsFromResult(result) : []) || [];
  const outcome = highestOutcome(industryEvents, analytics.outcomes);
  const customerRef = numericId(turn.customerId);
  const language = String(turn.language || "").slice(0, 16);
  const channel = turn.channel === "voice" ? "voice" : "text";
  const tokensIn = telemetry?.tokensIn || 0;
  const tokensOut = telemetry?.tokensOut || 0;
  // Who this is, when the chat has shown it (a signed-in customer, or the name and email given at checkout).
  const contact = cleanContact({ ...(turn.contact || {}), ...(typeof analytics.contactFromResult === "function" ? cleanContact(analytics.contactFromResult(result) || {}) : {}) });
  const identified = Boolean(customerRef || contact.email);
  const knownKey = identified ? personKeyFor(shop, { customerRef, email: contact.email, chatRef }) : null;
  // Files the shopper sent and flags the owner should act on (a call was booked, the AI asked for a person).
  const attachmentMeta = (Array.isArray(turn.attachments) ? turn.attachments : []).slice(0, 10).map((a) => ({ id: String(a.id), name: String(a.name || "file").slice(0, 120), kind: a.kind, mime: a.mime, size: a.size }));
  const flags = (typeof analytics.flagsFromResult === "function" ? analytics.flagsFromResult(result) : null) || {};
  const flagSet = Object.fromEntries(Object.entries(flags).map(([k, v]) => [`flags.${k}`, k === "reason" ? redactText(v, 300) : v]));
  const contactSet = Object.fromEntries(Object.entries(contact).map(([k, v]) => [`contact.${k}`, v]));

  // 1. the conversation: continue the open one, or start a new one after a long silence
  let conversation = await d.Conversation.findOneAndUpdate(
    { shop, chatRef, clearedAt: null, lastMessageAt: { $gte: new Date(now - RETURNING_AFTER_MS) } },
    {
      $set: { lastMessageAt: at, expiresAt: messageExpiry, channel, ...(language ? { language } : {}), ...(customerRef ? { customerRef } : {}), ...contactSet, ...flagSet, ...(knownKey ? { personKey: knownKey } : {}) },
      $inc: { messageCount: 1, tokensIn, tokensOut, degradedTurns: degraded ? 1 : 0, fileCount: attachmentMeta.length },
    },
    { sort: { lastMessageAt: -1 }, new: true, lean: true }
  );
  let started = false;
  if (!conversation) {
    // A visitor who comes back after a silence is the same person: carry over who they were.
    const earlier = await previousIdentity(d, shop, chatRef);
    const key = knownKey || earlier?.personKey || null;
    const carried = { ...(earlier?.contact || {}), ...contact };
    const created = await d.Conversation.create({
      shop, chatRef, industry: turn.industry || "ecommerce", channel, language, startedAt: at, lastMessageAt: at,
      messageCount: 1, firstMessage: keepText ? redactText(userMessage, 240) : "", customerRef,
      ...(key ? { personKey: key } : {}), ...(Object.keys(carried).length ? { contact: carried } : {}),
      degradedTurns: degraded ? 1 : 0, tokensIn, tokensOut, expiresAt: messageExpiry, fileCount: attachmentMeta.length,
      ...(Object.keys(flags).length ? { flags: { ...flags, ...(flags.reason ? { reason: redactText(flags.reason, 300) } : {}) } } : {}),
    });
    conversation = created.toObject ? created.toObject() : created;
    started = true;
  }
  const conversationId = conversation._id;
  // Once we know who it is, this visitor's earlier chats (before they logged in or gave an email) belong to them too.
  if (knownKey) await adoptEarlierChats(d, shop, chatRef, knownKey, contact);

  if (outcome.rank > (conversation.outcomeRank || 0)) {
    await d.Conversation.updateOne({ _id: conversationId, shop, outcomeRank: { $lt: outcome.rank } }, { $set: { outcome: outcome.name, outcomeRank: outcome.rank } });
  }

  // 2. the transcript (only when the owner keeps transcripts)
  if (keepText) {
    const docs = [];
    const userText = redactText(userMessage);
    const attachments = attachmentMeta;
    if (userText || attachments.length) docs.push({ shop, conversationId, role: "user", text: userText, at, degraded: false, expiresAt: messageExpiry, ...(attachments.length ? { attachments } : {}) });
    const answer = redactText(result.answer);
    const shown = typeof analytics.shownFromResult === "function" ? cleanShown(analytics.shownFromResult(result)) : null;
    if (answer) docs.push({ shop, conversationId, role: "assistant", text: answer, at: new Date(now + 1), degraded, expiresAt: messageExpiry, ...(shown ? { shown } : {}) });
    if (docs.length) await d.Message.insertMany(docs, { ordered: true });
  }

  // Tell the owner once per chat: the first files, and the first time the agent asks for a person.
  await alertOwnerOnce(d, { shop, conversationId, settings, kind: "files", due: attachmentMeta.length > 0, on: alertOn(settings, "onFiles"), fileCount: attachmentMeta.length });
  await alertOwnerOnce(d, { shop, conversationId, settings, kind: "follow_up", due: Boolean(flags.reason), on: alertOn(settings, "onFollowUp"), reason: redactText(flags.reason || "", 300) });

  // a complaint raised in this chat opens the whole conversation from the Complaints screen
  await linkComplaintToConversation(shop, chatRef, conversationId).catch(() => {});

  // A call booked in this turn belongs to this chat, and its email and phone tell us who this is.
  const bookingIds = typeof analytics.bookingIdsFromResult === "function" ? analytics.bookingIdsFromResult(result) : [];
  if (bookingIds.length) {
    try {
      const linked = await d.linkBookings(shop, { ids: bookingIds, conversationId, chatRef, customerRef });
      const who = linked.find((b) => b.email);
      if (who) {
        const asked = cleanContact({ name: who.name, email: who.email, phone: who.phone });
        const set = { personKey: who.personKey, ...Object.fromEntries(Object.entries(asked).map(([k, v]) => [`contact.${k}`, v])) };
        await d.Conversation.updateOne({ _id: conversationId, shop }, { $set: set });
        await adoptEarlierChats(d, shop, chatRef, who.personKey, asked);
      }
    } catch (error) {
      console.warn("[log] could not link the booking to its chat:", String(error?.message || error).slice(0, 120));
    }
  }

  // 3. events
  const base = { shop, at, conversationId, chatRef, channel, language, expiresAt: eventExpiry };
  const events = [];
  if (started) events.push({ ...base, type: "conversation_started", props: {} });
  events.push({
    ...base,
    type: "turn",
    props: safeProps({
      ms: telemetry ? Math.max(0, now - telemetry.startedAt) : 0,
      llmCalls: telemetry?.llmCalls || 0,
      tokensIn, tokensCached: telemetry?.tokensCached || 0, tokensOut,
      provider: telemetry?.provider || "", model: telemetry?.model || "",
      tools: (telemetry?.tools || []).map((t) => t.name).slice(0, 10),
      degraded,
    }),
  });
  for (const event of industryEvents) {
    if (!event?.type) continue;
    events.push({ ...base, type: String(event.type).slice(0, 60), props: safeProps(event.props), ...(event.dedupeKey ? { dedupeKey: String(event.dedupeKey).slice(0, 120) } : {}) });
  }
  try {
    await d.Event.insertMany(events, { ordered: false });
  } catch (error) {
    // a repeated order (same dedupe key) is expected; anything else is a real failure
    const failures = Array.isArray(error?.writeErrors) ? error.writeErrors : [];
    const duplicates = error?.code === 11000 || (failures.length > 0 && failures.every((e) => e.code === 11000 || e.err?.code === 11000));
    if (!duplicates) throw error;
  }
  return conversationId;
}

/** Sends one alert per chat and kind: the claim on the chat is atomic, so two turns at once cannot send it twice. */
async function alertOwnerOnce(d, { shop, conversationId, settings, kind, due, on, fileCount = 0, reason = "" }) {
  if (!due || !on) return;
  try {
    const field = kind === "files" ? "flags.alertedFiles" : "flags.alertedFollowUp";
    const claimed = await d.Conversation.updateOne({ _id: conversationId, shop, [field]: { $ne: true } }, { $set: { [field]: true } });
    if (!(claimed?.modifiedCount > 0)) return;
    const to = await d.ownerEmail(shop, settings);
    if (to) await d.alert({ kind, to, shopName: shop, reason, fileCount });
  } catch (error) {
    console.warn("[log] could not alert the owner:", String(error?.message || error).slice(0, 120));
  }
}

async function previousIdentity(d, shop, chatRef) {
  try {
    if (typeof d.Conversation.findOne !== "function") return null;
    const last = await d.Conversation.findOne({ shop, chatRef, personKey: { $ne: null } }).sort({ lastMessageAt: -1 }).lean();
    return last ? { personKey: last.personKey, contact: last.contact || {} } : null;
  } catch {
    return null;
  }
}

async function adoptEarlierChats(d, shop, chatRef, personKey, contact) {
  try {
    if (typeof d.Conversation.updateMany !== "function") return;
    // Only this visitor's still-anonymous chats, or ones that already carry the same email, become theirs. A chat tied to
    // someone else (another person who used the same browser) keeps its own owner.
    const sameEmail = contact?.email ? [{ "contact.email": contact.email }] : [];
    await d.Conversation.updateMany({ shop, chatRef, $or: [{ personKey: null }, { personKey: `v${chatRef}` }, ...sameEmail], customerRef: null }, { $set: { personKey, ...Object.fromEntries(Object.entries(contact).map(([k, v]) => [`contact.${k}`, v])) } });
  } catch (error) {
    console.warn("[log] could not link earlier chats to this person:", String(error?.message || error).slice(0, 120));
  }
}

/** The shopper cleared the chat on their screen: mark the open conversation so the next message starts a new one. The store keeps this copy. */
export async function markChatCleared(shop, chatRef, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  if (!d.connected()) return 0;
  const result = await d.Conversation.updateMany({ shop, chatRef, clearedAt: null }, { $set: { clearedAt: new Date(d.now()) } });
  return result?.modifiedCount ?? 0;
}

/** Fire and forget: logging problems are reported but never reach the customer. */
export function recordTurnInBackground(turn, deps = {}) {
  return Promise.resolve()
    .then(() => recordTurn(turn, deps))
    .catch((error) => {
      console.warn("[log] could not record the turn:", String(error?.message || error).slice(0, 160));
      return null;
    });
}

/** An event that is not part of a chat turn (e.g. a Shopify webhook). Idempotent via dedupeKey. */
export async function recordEvent({ shop, type, props = {}, dedupeKey, conversationId = null, chatRef = null, at = new Date() }, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  if (!d.connected()) return false;
  try {
    await d.Event.create({
      shop, type, at, conversationId, chatRef, props: safeProps(props),
      ...(dedupeKey ? { dedupeKey } : {}),
      expiresAt: new Date(d.now() + EVENT_RETENTION_DAYS * DAY_MS),
    });
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}