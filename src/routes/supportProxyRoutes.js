// What the chat window asks for when a shopper wants a person: is anyone free, ask for a call, cancel it, get the
// token to join it, pick a callback time, and hear a saved call. Mounted under /proxy (the Shopify App Proxy), so
// the store comes from the verified proxy signature (`req.verifiedShop`), never from the body.
import { Router } from "express";
import { createChatRateLimiter } from "../http/hardening.js";
import { createVoiceToken } from "../services/voiceTokenService.js";
import { verifiedCustomerGid, resolveClientId } from "../services/customerContext.js";
import { chatRefFor, recordEvent } from "../services/conversationLog.js";
import { visitorIdentity } from "../http/hardening.js";
import { getAgentSettings } from "../admin/settings.js";
import * as support from "../services/supportService.js";
import * as bookings from "../services/bookingService.js";
import { bookingEnabled, bookingConfig } from "../services/bookingSettings.js";
import Conversation from "../models/Conversation.js";
import { supportHub } from "../services/supportRuntime.js";
import { markHandoff, openComplaintForChat } from "../services/complaintService.js";

const light = createChatRateLimiter({ name: "support", limit: Number(process.env.SUPPORT_RATE_LIMIT) || 60 });
const heavy = createChatRateLimiter({ name: "support-request", limit: Number(process.env.SUPPORT_REQUEST_RATE_LIMIT) || 12 });

const router = Router();
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

/** The chat this window belongs to, from its own id (and the signed customer, when there is one). */
function chatOf(req) {
  const { clientId, cart } = req.body ?? {};
  const id = resolveClientId({ clientId, shop: req.verifiedShop, cartToken: cart?.token, customerId: verifiedCustomerGid(req.proxyCustomerId) });
  return { clientId: id, chatRef: chatRefFor(req.verifiedShop, id) };
}

async function contactOf(shop, chatRef, proxyCustomerId) {
  const chat = await Conversation.findOne({ shop, chatRef, clearedAt: null }).sort({ lastMessageAt: -1 }).select("contact customerRef").lean();
  return { name: chat?.contact?.name || "", email: chat?.contact?.email || "", phone: chat?.contact?.phone || "", customerId: String(proxyCustomerId || "").replace(/\D/g, "").slice(0, 30) };
}

const handle = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (error) {
    if (error?.status && error.status < 500) return res.status(error.status).json({ error: error.message, code: error.code });
    console.warn("[support] request failed:", String(error?.message || error).slice(0, 200));
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};

const publicCaps = (c) => ({
  liveHandoffEnabled: c.liveHandoffEnabled,
  audioCallEnabled: c.audioCallEnabled,
  callbackEnabled: c.callbackEnabled,
  recordingAvailable: c.recordingAvailable,
  representativesAvailable: c.representativesAvailable,
  allRepresentativesBusy: c.allRepresentativesBusy,
});

// Can a person take a call right now? Also returns the shopper's open call, so a reloaded window can pick it up.
router.post("/status", light, handle(async (req, res) => {
  const { chatRef } = chatOf(req);
  const settings = await getAgentSettings(req.verifiedShop);
  const caps = await support.supportCapabilities(req.verifiedShop, settings);
  const rows = await support.listCalls(req.verifiedShop, { chatRef, limit: 1 });
  const open = rows.find((c) => ["requested", "accepted", "connected"].includes(c.status)) || null;
  // The callback is the booking in the database, never something the page remembers: it is read here every time, so a
  // reload, a closed and reopened window or another tab shows what is true (booked, moved, cancelled).
  const [active, closed] = await Promise.all([bookings.activeBookingForChat(req.verifiedShop, chatRef), bookings.lastClosedBookingForChat(req.verifiedShop, chatRef)]);
  res.json({
    capabilities: publicCaps(caps),
    call: open ? publicCall(open) : null,
    callback: active ? bookings.bookingForShopper(active) : null,
    previousCallback: !active && closed ? bookings.bookingForShopper(closed) : null,
  });
}));

// The shopper asked for a person (the recording choice was made before). Nothing is created unless someone is free.
router.post("/request", heavy, handle(async (req, res) => {
  const { chatRef } = chatOf(req);
  const settings = await getAgentSettings(req.verifiedShop);
  const customer = await contactOf(req.verifiedShop, chatRef, req.proxyCustomerId);
  // a complaint this chat has goes with the request: the team member sees it on the call card and is not told it again
  const complaint = await openComplaintForChat(req.verifiedShop, chatRef).catch(() => null);
  const reason = complaint ? `${complaint.reference}${complaint.orderNumber ? ` · order ${complaint.orderNumber}` : ""}: ${complaint.summary || String(req.body?.reason || "")}` : String(req.body?.reason || "");
  const out = await support.requestCall({ shop: req.verifiedShop, chatRef, customer, reason: reason.slice(0, 240), recordingConsent: req.body?.recordingConsent === true, settings });
  if (out.closedStale) supportHub().announceClosed([{ shop: req.verifiedShop, call: out.closedStale }]);
  if (out.status === "requested") {
    if (!out.existing) supportHub().announceRequest(req.verifiedShop, out.call);
    if (complaint) await markHandoff({ shop: req.verifiedShop, chatRef, status: "requested", callId: out.call.id }).catch(() => {});
    const token = createVoiceToken(req.verifiedShop, { customerId: req.proxyCustomerId, purpose: "support", visitor: visitorIdentity(req), ref: out.call.id });
    return res.json({ status: "requested", call: publicCall(out.call), token, ttlSeconds: Math.round(support.REQUEST_TTL_MS() / 1000) });
  }
  const caps = out.capabilities || (await support.supportCapabilities(req.verifiedShop, settings));
  // nobody could take it: the complaint says so (never "connected")
  if (complaint) await markHandoff({ shop: req.verifiedShop, chatRef, status: "unavailable" }).catch(() => {});
  return res.json({ status: out.status, capabilities: publicCaps(caps), contactEmail: "" });
}));

// A fresh token to (re)join a call this chat owns.
router.post("/token", light, handle(async (req, res) => {
  const { chatRef } = chatOf(req);
  const call = await support.callForChat(req.verifiedShop, chatRef, String(req.body?.callId || ""));
  if (!call || !["requested", "accepted", "connected"].includes(call.status)) return res.status(404).json({ error: "This call is over." });
  res.json({ token: createVoiceToken(req.verifiedShop, { customerId: req.proxyCustomerId, purpose: "support", visitor: visitorIdentity(req), ref: String(call._id) }) });
}));

router.post("/cancel", light, handle(async (req, res) => {
  const { chatRef } = chatOf(req);
  const out = await support.cancelCall(req.verifiedShop, chatRef, String(req.body?.callId || ""));
  if (out) supportHub().announceCancelled(req.verifiedShop, out.call.id);
  res.json({ ok: true, cancelled: Boolean(out) });
}));

// Free callback times (the same hours and rules the AI offers), grouped by day.
router.post("/slots", light, handle(async (req, res) => {
  const settings = await getAgentSettings(req.verifiedShop);
  if (!bookingEnabled(settings)) return res.json({ enabled: false, days: [] });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date || "")) ? String(req.body.date) : "";
  const free = await bookings.listFreeSlots({ shop: req.verifiedShop, settings, limit: 200, perDay: 24 });
  const days = new Map();
  for (const s of free.slots) {
    if (day && s.date !== day) continue;
    if (!days.has(s.date)) days.set(s.date, []);
    days.get(s.date).push({ start: s.start, local: s.local, time: s.time || "" });
  }
  res.json({ enabled: true, timezone: free.timezone, callMinutes: free.slotMinutes, days: [...days].map(([date, slots]) => ({ date, slots })).slice(0, 14) });
}));

// Book the callback. Reuses the store's booking rules: the time is re-checked and reserved atomically, and the calendar
// event follows (a failed sync is kept and retried by the owner; the shopper is only told "confirmed" when it is).
router.post("/callback", heavy, handle(async (req, res) => {
  const { chatRef } = chatOf(req);
  const settings = await getAgentSettings(req.verifiedShop);
  if (!bookingEnabled(settings)) return res.status(409).json({ error: "Callbacks are not available at this store.", code: "disabled" });
  const b = req.body || {};
  const out = await bookings.createBooking({ shop: req.verifiedShop, settings, chatRef, language: String(b.language || ""), country: String(b.country || ""), input: { slotStart: b.slotStart, name: b.name, phone: b.phone, email: b.email, topic: String(b.topic || "Customer support callback") } });
  if (out.status === "invalid") return res.status(400).json({ status: "invalid", problems: out.problems, error: "Please check your phone number and email." });
  if (out.status === "slot_unavailable") return res.status(409).json({ status: "slot_unavailable", error: "That time was just taken. Please pick another." });
  if (out.status === "already_booked") return res.status(409).json({ status: "already_booked", error: "You already have a callback booked.", callback: bookings.bookingForShopper(out.booking) });
  if (out.status !== "booked" && out.status !== "confirmed") return res.status(409).json({ status: out.status || "failed", error: "The callback could not be booked." });
  const booking = out.booking;
  // tie it to the chat the way an AI-booked call is
  const chat = await Conversation.findOne({ shop: req.verifiedShop, chatRef, clearedAt: null }).sort({ lastMessageAt: -1 }).select("_id customerRef").lean();
  if (chat) {
    await bookings.linkBookingsToChat(req.verifiedShop, { ids: [String(booking._id)], conversationId: chat._id, chatRef, customerRef: chat.customerRef });
    await Conversation.updateOne({ _id: chat._id, shop: req.verifiedShop }, { $set: { "flags.callRequested": true, "flags.needsFollowUp": true } });
    await recordEvent({ shop: req.verifiedShop, type: "call_booked", props: { status: booking.status, startAt: new Date(booking.startAt).toISOString(), via: "support" }, conversationId: chat._id, chatRef }).catch(() => {});
  }
  // a complaint this chat has records that a callback was booked for it
  await markHandoff({ shop: req.verifiedShop, chatRef, status: "callback", bookingId: String(booking._id) }).catch(() => {});
  const config = bookingConfig(settings);
  res.json({
    status: out.status,
    // "confirmed" only when the store's own rule confirmed it and the calendar, if there is one, took it
    confirmed: out.status === "confirmed",
    calendarSynced: booking.calendar?.status === "synced",
    startAt: new Date(booking.startAt).toISOString(),
    timezone: booking.timezone || config.timezone,
    bookingId: String(booking._id),
    replayed: Boolean(out.replayed),
    callback: bookings.bookingForShopper(booking),
  });
}));

// The shopper cancels their own callback (only a booking of THIS chat; the store comes from the signed proxy request).
router.post("/callback/cancel", heavy, handle(async (req, res) => {
  const { chatRef } = chatOf(req);
  const settings = await getAgentSettings(req.verifiedShop);
  const out = await bookings.cancelOwnBooking(req.verifiedShop, String(req.body?.bookingId || ""), chatRef, { settings });
  if (out.status === "not_found") return res.status(404).json({ status: "not_found", error: "This callback was not found." });
  if (out.status === "wrong_state") return res.status(409).json({ status: "wrong_state", error: "This callback is already closed." });
  if (out.status !== "ok") return res.status(409).json({ status: out.status || "failed", error: "The callback could not be cancelled." });
  res.json({ status: "cancelled", callback: bookings.bookingForShopper(out.booking) });
}));

// The shopper moves their own callback to another free time. The time is checked again and reserved atomically.
router.post("/callback/reschedule", heavy, handle(async (req, res) => {
  const { chatRef } = chatOf(req);
  const settings = await getAgentSettings(req.verifiedShop);
  if (!bookingEnabled(settings)) return res.status(409).json({ error: "Callbacks are not available at this store.", code: "disabled" });
  const out = await bookings.rescheduleOwnBooking(req.verifiedShop, String(req.body?.bookingId || ""), chatRef, { startAt: req.body?.slotStart, settings });
  if (out.status === "not_found") return res.status(404).json({ status: "not_found", error: "This callback was not found." });
  if (out.status === "wrong_state") return res.status(409).json({ status: "wrong_state", error: "This callback is already closed." });
  if (out.status === "slot_unavailable") return res.status(409).json({ status: "slot_unavailable", error: "That time was just taken. Please pick another." });
  if (out.status === "invalid") return res.status(400).json({ status: "invalid", error: "Please pick one of the times shown." });
  if (out.status !== "booked" && out.status !== "confirmed") return res.status(409).json({ status: out.status || "failed", error: "The callback could not be moved." });
  res.json({ status: out.status, confirmed: out.status === "confirmed", callback: bookings.bookingForShopper(out.booking) });
}));

// A saved call, for the shopper who had it (their own chat only).
router.post("/recording", light, handle(async (req, res) => {
  const { chatRef } = chatOf(req);
  const found = await support.recordingBytes(req.verifiedShop, String(req.body?.callId || ""), { chatRef });
  if (!found) return res.status(404).json({ error: "This recording is not available." });
  res.set({ "Content-Type": found.mime, "Content-Length": String(found.bytes.length), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  res.send(found.bytes);
}));

/** What the shopper's window may know about a call (no internal fields, nothing about the team beyond a name). */
export function publicCall(c) {
  return {
    id: c.id,
    status: c.status,
    representativeName: c.representative?.name || "",
    recording: { consent: c.recording?.consent === true, status: c.recording?.status || "none", available: c.recording?.available === true },
    durationSec: c.durationSec,
    expiresAt: c.expiresAt,
  };
}

export default router;
