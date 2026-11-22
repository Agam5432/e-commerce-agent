// A person from the store takes over a chat. While they have it, the AI stays silent: the shopper's messages
// are recorded for the team, and the team's replies are picked up by the chat window. Nothing here writes
// words to the shopper: they come from the team member (or, before the takeover, from the AI as usual).
import { replyLedger } from "./replyLedger.js";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import { RETURNING_AFTER_MS } from "./conversationContinuity.js";
import { chatRefFor, redactText } from "./conversationLog.js";
import { retentionDaysFor, transcriptsEnabled } from "../admin/settings.js";

const DAY_MS = 86400_000;
export const MAX_STAFF_TEXT = 2000;
// a reply the team sends must reach the shopper even when transcripts are off, so it is kept this long at least
const MIN_DELIVERY_DAYS = 3;
const defaultDeps = { Conversation, Message, now: () => Date.now(), ledger: () => replyLedger() };

export class HandoffError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const waiting = (c) => Boolean(c.flags?.needsFollowUp) && c.status !== "resolved";

/** The chat this visitor is in right now: the same one the next message would continue. */
export async function currentChat(shop, chatRef, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  return d.Conversation.findOne({ shop, chatRef, clearedAt: null, lastMessageAt: { $gte: new Date(d.now() - RETURNING_AFTER_MS) } }).sort({ lastMessageAt: -1 }).lean();
}

/**
 * If a person has this chat, record the shopper's message for them and say so. Returns false when the AI should answer.
 * @returns {Promise<boolean>}
 */
export async function holdForTeam({ shop, clientId, text = "", attachments = [], settings = {} }, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const chat = await currentChat(shop, chatRefFor(shop, clientId), d);
  if (!chat?.handoff?.active) return false;
  const now = d.now();
  const at = new Date(now);
  const keep = transcriptsEnabled(settings);
  const expiresAt = new Date(now + retentionDaysFor(settings) * DAY_MS);
  const files = (Array.isArray(attachments) ? attachments : []).slice(0, 10);
  await d.Conversation.updateOne({ _id: chat._id, shop }, { $set: { lastMessageAt: at, expiresAt }, $inc: { messageCount: 1, fileCount: files.length } });
  const body = redactText(text);
  if (keep && (body || files.length)) {
    await d.Message.insertMany([{ shop, conversationId: chat._id, role: "user", text: body, at, degraded: false, expiresAt, ...(files.length ? { attachments: files } : {}) }]);
  }
  return true;
}

/** Take the chat over, or give it back to the AI. */
export async function setHandoff(shop, conversationId, { active, by = "" } = {}, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const update = active
    ? { $set: { "handoff.active": true, "handoff.at": new Date(d.now()), "handoff.by": String(by || "").slice(0, 80), "flags.needsFollowUp": true } }
    : { $unset: { handoff: "" } };
  const result = await d.Conversation.findOneAndUpdate({ _id: conversationId, shop }, update, { new: true, lean: true });
  if (!result) throw new HandoffError("Chat not found.", 404);
  return result;
}

/** A team member's message to the shopper. Writing it takes the chat over, so the AI does not talk over them. */
export async function sendStaffReply(shop, conversationId, { text, by = "" } = {}, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const clean = String(text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!clean) throw new HandoffError("Write a message first.");
  if (clean.length > MAX_STAFF_TEXT) throw new HandoffError(`Keep the message under ${MAX_STAFF_TEXT} characters.`);
  const chat = await d.Conversation.findOne({ _id: conversationId, shop }).lean();
  if (!chat) throw new HandoffError("Chat not found.", 404);
  if (chat.clearedAt) throw new HandoffError("The customer cleared this chat, so they can no longer receive replies.", 409);
  const now = d.now();
  const at = new Date(now);
  const expiresAt = new Date(Math.max(chat.expiresAt ? new Date(chat.expiresAt).getTime() : 0, now + MIN_DELIVERY_DAYS * DAY_MS));
  await d.Message.insertMany([{ shop, conversationId: chat._id, role: "staff", text: clean, staffBy: String(by || "").slice(0, 80), at, degraded: false, expiresAt }]);
  // the shopper's window adds it to its history as a reply: let the server recognise it there
  if (chat.chatRef) void Promise.resolve(d.ledger().remember(shop, { chatRef: chat.chatRef }, clean)).catch(() => {});
  const updated = await d.Conversation.findOneAndUpdate(
    { _id: chat._id, shop },
    { $set: { lastMessageAt: at, expiresAt, status: chat.status === "resolved" ? "open" : chat.status, "handoff.active": true, "handoff.at": chat.handoff?.at || at, "handoff.by": String(by || "").slice(0, 80), "flags.needsFollowUp": true }, $inc: { messageCount: 1 } },
    { new: true, lean: true }
  );
  return { at, conversation: updated };
}

/**
 * What the chat window asks every few seconds: the team's replies since it last looked, whether a person has
 * the chat, and whether it is worth asking again.
 */
export async function staffMessagesSince({ shop, clientId, since }, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const chat = await currentChat(shop, chatRefFor(shop, clientId), d);
  if (!chat) return { handedOff: false, watch: false, messages: [] };
  const after = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : new Date(0);
  const rows = await d.Message.find({ shop, conversationId: chat._id, role: "staff", at: { $gt: after } }).sort({ at: 1 }).limit(20).lean();
  return {
    handedOff: Boolean(chat.handoff?.active),
    watch: Boolean(chat.handoff?.active) || waiting(chat),
    messages: rows.map((m) => ({ id: String(m._id), text: m.text, at: m.at.toISOString ? m.at.toISOString() : new Date(m.at).toISOString(), ...(m.call ? { call: { callId: m.call.callId, status: m.call.status, durationSec: m.call.durationSec, recording: Boolean(m.call.recording) } } : {}) })),
  };
}
