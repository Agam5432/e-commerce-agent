// What the agent already knows about the person it is talking to, kept on the store's side and tied to the
// visitor's browser (the chat reference made from their private id, which lives in a cookie). So the agent reads
// this BEFORE it asks anything, and it forgets it all when the shopper clears the chat or their browser data:
// that visitor then has a new id, and the store keeps its own copy for the owner.
//
// Only facts go in: the AI words everything it says.
import Conversation from "../models/Conversation.js";
import Event from "../models/Event.js";
import { chatRefFor } from "./conversationLog.js";

export const CASE_TYPES = ["refund", "exchange", "return", "replacement", "other"];
export const CASE_STATUSES = ["received", "in_progress", "approved", "completed", "rejected"];
const defaultDeps = { Conversation, Event };

const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * @param {{customerRef?: string | null, limit?: number}} [options] customerRef: a signed-in customer's chats count too, from any browser
 */
export async function recallVisitor(shop, clientId, { customerRef = null, limit = 5 } = {}, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  if (!shop || !clientId) return null;
  const chatRef = chatRefFor(shop, clientId);
  const owner = [{ chatRef }, ...(customerRef ? [{ customerRef: String(customerRef).replace(/\D/g, "") }] : [])];
  // chats the shopper cleared are forgotten (the store keeps them for itself)
  const chats = await d.Conversation.find({ shop, clearedAt: null, $or: owner }).sort({ lastMessageAt: -1 }).limit(limit).lean();
  if (!chats.length) return null;

  const contact = {};
  for (const c of chats) for (const key of ["name", "email", "phone"]) if (!contact[key] && c.contact?.[key]) contact[key] = c.contact[key];

  const orderEvents = await d.Event.find({ shop, chatRef, type: "order_placed" }).sort({ at: -1 }).limit(5).lean().catch(() => []);
  const orders = orderEvents.map((e) => ({ name: clip(e.props?.orderName, 20), total: e.props?.shopTotal ?? e.props?.total ?? null, currency: e.props?.shopCurrency || e.props?.currency || "", at: e.at })).filter((o) => o.name);

  const cases = chats
    .filter((c) => c.case?.type || c.case?.status)
    .map((c) => ({ type: c.case.type || "other", status: c.case.status || "received", note: clip(c.case.note, 400), updatedAt: c.case.updatedAt || c.lastMessageAt, reason: clip(c.flags?.reason, 200) }));

  return {
    contact,
    orders,
    cases: cases.slice(0, 3),
    chats: chats.slice(0, 4).map((c) => ({ at: c.startedAt, firstMessage: clip(c.firstMessage, 120), outcome: c.outcome || "", reason: clip(c.flags?.reason, 160) })),
  };
}

const when = (value) => {
  const t = value instanceof Date ? value : new Date(value);
  return Number.isNaN(t.getTime()) ? "" : t.toISOString().slice(0, 10);
};
const words = (value) => String(value || "").replace(/_/g, " ");

/** The LIVE CONTEXT lines for the system prompt. Empty when there is nothing to say. */
export function visitorMemoryBlock(memory) {
  if (!memory) return "";
  const lines = [];
  const { contact = {}, orders = [], cases = [], chats = [] } = memory;
  const given = [contact.name && `name ${contact.name}`, contact.email && `email ${contact.email}`, contact.phone && `phone ${contact.phone}`].filter(Boolean);
  if (given.length) lines.push(`- Details they gave earlier: ${given.join(", ")}.`);
  if (orders.length) lines.push(`- Orders they placed in earlier chats here: ${orders.map((o) => `${o.name}${o.total != null && o.currency ? ` (${o.total} ${o.currency})` : ""}`).join(", ")}.`);
  for (const c of cases) {
    lines.push(`- Request with the store team: ${words(c.type)}, status "${words(c.status)}"${when(c.updatedAt) ? `, updated ${when(c.updatedAt)}` : ""}${c.note ? `. Team note for the customer: "${c.note}"` : ". The team has written no note yet"}${c.reason ? `. Why it was raised: ${c.reason}` : ""}.`);
  }
  const earlier = chats.filter((c) => c.firstMessage).slice(0, 3);
  if (earlier.length) lines.push(`- Earlier chats with them (newest first): ${earlier.map((c) => `${when(c.at)} "${c.firstMessage}"`).join(" | ")}.`);
  if (!lines.length) return "";
  return [
    "WHAT YOU ALREADY KNOW ABOUT THIS VISITOR (saved from their earlier chats on this browser; clearing the chat or browser data erases it):",
    ...lines,
    "- Before you ask this person for anything (name, email, phone, address, order number, what the problem was), look here first. If you already have it, use it and just confirm in a few words instead of asking again. Do not read a full email or phone number aloud unless they ask.",
    "- For where a refund, exchange or return stands, use ONLY the team's status and note above. If there is none, say the team has not updated it yet. Never invent a status, a date or an outcome, and never promise one.",
    "",
  ].join("\n");
}
