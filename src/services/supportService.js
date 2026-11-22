// Live help from a person: who can take a call, the request a shopper makes, and the audio call it becomes.
// Everything is for ONE store (`shop`, from a verified token or proxy signature, never from a body). State lives in
// MongoDB so it survives a restart; the live signalling is in supportHub.js. Every change of state is one atomic
// update, so two team members can never take the same call and one chat never has two open requests.
import { markHandoff } from "./complaintService.js";
import crypto from "node:crypto";
import SupportCall, { OPEN_STATUSES } from "../models/SupportCall.js";
import SupportPresence from "../models/SupportPresence.js";
import SupportRecording from "../models/SupportRecording.js";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import Booking, { ACTIVE_STATUSES } from "../models/Booking.js";
import { attachmentStorage } from "./objectStorage.js";
import { audioCallEnabled, liveSupportEnabled, recordingAllowed } from "./bookingSettings.js";
import { bookingEnabled } from "./bookingSettings.js";
import { retentionDaysFor } from "../admin/settings.js";
import { personKeyFor } from "./people.js";
import { recordEvent } from "./conversationLog.js";

const DAY_MS = 86_400_000;
const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

/** A team member counts as present only while their browser keeps saying so. */
export const PRESENCE_FRESH_MS = () => num(process.env.SUPPORT_PRESENCE_FRESH_SECONDS, 45) * 1000;
/** How long a request waits for a person before it is closed as unanswered. */
export const REQUEST_TTL_MS = () => num(process.env.SUPPORT_REQUEST_TTL_SECONDS, 90) * 1000;
/** The most audio kept for one call (about 75 minutes at the bit rate the dashboard records at). */
export const MAX_RECORDING_BYTES = () => num(process.env.SUPPORT_MAX_RECORDING_MB, 14) * 1024 * 1024;
const MIN_DELIVERY_DAYS = 3;
const RECORDING_MIMES = /^audio\/(webm|ogg|mp4)(;.*)?$/i;

const defaultDeps = { Call: SupportCall, Presence: SupportPresence, Recording: SupportRecording, Conversation, Message, Booking, now: () => Date.now(), storage: () => attachmentStorage() };
const dep = (over) => ({ ...defaultDeps, ...over });

export class SupportError extends Error {
  constructor(message, status = 400, code = "invalid") {
    super(message);
    this.name = "SupportError";
    this.status = status;
    this.code = code;
  }
}

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const isId = (id) => /^[a-f0-9]{24}$/i.test(String(id || ""));
const openKeyFor = (shop, chatRef) => `${shop}|${chatRef}`;

// ---- who can take a call -----------------------------------------------------------------------------------
/** The team as the dashboard and the AI need it: one entry per person with a derived state. */
export async function listPresence(shop, over = {}) {
  const d = dep(over);
  const rows = await d.Presence.find({ shop }).lean();
  const fresh = d.now() - PRESENCE_FRESH_MS();
  return rows.map((r) => {
    const live = new Date(r.lastHeartbeatAt).getTime() >= fresh;
    const state = !live || r.status === "offline" ? "offline" : r.activeCallId ? "busy" : r.status === "away" ? "away" : "online";
    return { id: r.representativeId, name: r.name || "", state, activeCallId: r.activeCallId ? String(r.activeCallId) : null, lastHeartbeatAt: r.lastHeartbeatAt };
  });
}

/** A person chooses online / away / offline, or just reports in (heartbeat). Never moves them out of a call. */
export async function setPresence(shop, { representativeId, name = "", status }, over = {}) {
  const d = dep(over);
  const id = clean(representativeId, 60);
  if (!id) throw new SupportError("Sign in again.", 401, "unauthorized");
  const set = { lastHeartbeatAt: new Date(d.now()) };
  if (clean(name, 80)) set.name = clean(name, 80); // a plain heartbeat never wipes the name
  if (["online", "away", "offline"].includes(status)) set.status = status;
  const row = await d.Presence.findOneAndUpdate({ shop, representativeId: id }, { $set: set, $setOnInsert: { shop, representativeId: id, ...(set.status ? {} : { status: "offline" }) } }, { new: true, upsert: true, lean: true });
  return row;
}

/** A person's browser went away: they can no longer take calls. */
export async function dropPresence(shop, representativeId, over = {}) {
  const d = dep(over);
  await d.Presence.updateOne({ shop, representativeId }, { $set: { status: "offline" } });
}

export async function supportCapabilities(shop, settings = {}, over = {}) {
  const d = dep(over);
  const live = liveSupportEnabled(settings);
  const audio = audioCallEnabled(settings);
  const team = live ? await listPresence(shop, over) : [];
  const online = team.filter((p) => p.state === "online").length;
  const busy = team.filter((p) => p.state === "busy").length;
  const away = team.filter((p) => p.state === "away").length;
  return {
    liveHandoffEnabled: live,
    audioCallEnabled: audio,
    callbackEnabled: bookingEnabled(settings),
    recordingAvailable: recordingAllowed(settings),
    representativesOnline: online,
    representativesBusy: busy,
    representativesAway: away,
    // true only when someone is actually free to take it right now
    representativesAvailable: audio && online > 0,
    // true only when we can say they are all engaged (somebody is on, everybody on is on a call)
    allRepresentativesBusy: audio && online === 0 && busy > 0 && away === 0,
    now: d.now(),
  };
}

// ---- a request and its call -------------------------------------------------------------------------------
const view = (c) => (c ? callView(c) : null);

/**
 * Who asked, who it was given to and who really had it. Calls saved before these fields existed have only `representative`,
 * which was always the person who took the call: it is read as both (nothing is rewritten in the database).
 */
export function accountabilityView(c) {
  const rep = c.representative?.id ? { type: "human", id: c.representative.id, name: c.representative.name || "" } : null;
  const as = (h) => (h?.id ? { type: h.type || "human", id: h.id, name: h.name || "" } : rep);
  return {
    personKey: c.personKey || null,
    initiatedBy: c.initiatedBy || "customer",
    direction: c.direction || "inbound",
    callKind: "human",
    assignedTo: as(c.assignedTo),
    handledBy: as(c.handledBy),
    handlingSegments: (c.handlingSegments || []).map((s) => ({ employeeId: s.employeeId, employeeName: s.employeeName || "", startedAt: s.startedAt || null, endedAt: s.endedAt || null, durationSec: s.durationSec ?? null })),
    transfers: [],
  };
}

/** A call as the dashboard and the widget are shown it (no internal fields). */
export function callView(c) {
  return {
    id: String(c._id),
    status: c.status,
    chatRef: c.chatRef,
    conversationId: c.conversationId ? String(c.conversationId) : null,
    customer: { name: c.customer?.name || "", email: c.customer?.email || "", phone: c.customer?.phone || "" },
    reason: c.reason || "",
    representative: c.representative?.id ? { id: c.representative.id, name: c.representative.name || "" } : null,
    ...accountabilityView(c),
    recording: {
      consent: Boolean(c.recording?.consent),
      consentAt: c.recording?.consentAt || null,
      status: c.recording?.status || "none",
      available: c.recording?.status === "saved",
      sizeBytes: c.recording?.sizeBytes || 0,
    },
    requestedAt: c.requestedAt,
    acceptedAt: c.acceptedAt || null,
    connectedAt: c.connectedAt || null,
    endedAt: c.endedAt || null,
    durationSec: c.durationSec ?? null,
    failureReason: c.failureReason || "",
    expiresAt: c.expiresAt,
  };
}

async function conversationFor(shop, chatRef, d) {
  return d.Conversation.findOne({ shop, chatRef, clearedAt: null }).sort({ lastMessageAt: -1 }).select("_id").lean();
}

/** Tie a call to its stored chat as soon as that chat exists (a brand new chat is stored a moment after its first reply). */
export async function linkConversation(call, over = {}) {
  const d = dep(over);
  if (call.conversationId) return call;
  const chat = await conversationFor(call.shop, call.chatRef, d);
  if (!chat) return call;
  await d.Call.updateOne({ _id: call._id, shop: call.shop }, { $set: { conversationId: chat._id } });
  return { ...call, conversationId: chat._id };
}

async function mirrorOnConversation(shop, call, d) {
  const withChat = await linkConversation(call, d);
  if (!withChat.conversationId) return withChat;
  const set = { "support.status": call.status, "support.callId": call._id, "support.at": new Date(d.now()) };
  // a person is wanted while it is open or went unanswered; a call that took place closes that need
  if (OPEN_STATUSES.includes(call.status) || ["unanswered", "failed"].includes(call.status)) set["flags.needsFollowUp"] = true;
  else if (call.status === "ended") set["flags.needsFollowUp"] = false;
  // While a person has the call, they have the chat: the AI stays silent and what the shopper types goes to the team.
  const update = { $set: set };
  if (["accepted", "connected"].includes(call.status)) {
    set["handoff.active"] = true;
    set["handoff.at"] = new Date(d.now());
    set["handoff.by"] = clean(call.representative?.name || call.representative?.id, 80);
    set["handoff.callId"] = call._id;
  }
  await d.Conversation.updateOne({ _id: withChat.conversationId, shop }, update);
  // when the call closes, give the chat back to the AI (a chat a person took over by hand has no callId, so it stays theirs)
  if (!OPEN_STATUSES.includes(call.status)) await d.Conversation.updateOne({ _id: withChat.conversationId, shop, "handoff.callId": call._id }, { $unset: { handoff: "" } });
  return withChat;
}

/**
 * A shopper asks for a person. Returns { status: "requested" | "unavailable" | "disabled", call? }.
 * "unavailable" is only returned when nobody is free right now: nothing is created and nothing is promised.
 * Asking again while a request is open returns that same request (no duplicates).
 */
export async function requestCall({ shop, chatRef, customer = {}, reason = "", recordingConsent = false, settings = {} }, over = {}) {
  const d = dep(over);
  if (!chatRef) throw new SupportError("Chat not found.", 400);
  if (!audioCallEnabled(settings)) return { status: "disabled" };
  // An earlier request nobody took in time may still be open for a few seconds (the sweeper closes it every few seconds):
  // close it now, so the shopper asking again gets a NEW request instead of the dead one.
  let closedStale = null;
  const stale = await d.Call.findOne({ shop, chatRef, status: "requested", expiresAt: { $lte: new Date(d.now()) } }).select("_id").lean();
  if (stale) {
    const closed = await closeUnanswered(shop, stale._id, "nobody answered in time", d);
    if (closed) closedStale = view(closed);
  }
  const extra = closedStale ? { closedStale } : {};
  const open = await d.Call.findOne({ shop, chatRef, status: { $in: OPEN_STATUSES } }).lean();
  if (open) return { status: "requested", call: view(open), existing: true, ...extra };
  const caps = await supportCapabilities(shop, settings, d);
  if (!caps.representativesAvailable) return { status: "unavailable", capabilities: caps, ...extra };
  const now = d.now();
  const consent = recordingConsent === true && recordingAllowed(settings);
  const keepUntil = new Date(now + Math.max(retentionDaysFor(settings), 7) * DAY_MS);
  try {
    const created = await d.Call.create({
      shop, chatRef, status: "requested", openKey: openKeyFor(shop, chatRef),
      personKey: personKeyFor(shop, { customerRef: clean(customer.customerId, 30), chatRef }),
      customer: { name: clean(customer.name, 80), email: clean(customer.email, 254), phone: clean(customer.phone, 24), customerId: clean(customer.customerId, 30) },
      reason: clean(reason, 300),
      recording: { consent, consentAt: consent ? new Date(now) : undefined, status: consent ? "recording" : recordingAllowed(settings) ? "declined" : "none" },
      requestedAt: new Date(now), expiresAt: new Date(now + REQUEST_TTL_MS()), keepUntil,
    });
    const call = created.toObject();
    return { status: "requested", call: view(await mirrorOnConversation(shop, call, d)), ...extra };
  } catch (error) {
    if (error?.code === 11000) {
      const again = await d.Call.findOne({ shop, chatRef, status: { $in: OPEN_STATUSES } }).lean();
      if (again) return { status: "requested", call: view(again), existing: true, ...extra };
    }
    throw error;
  }
}

export async function getCall(shop, callId, over = {}) {
  const d = dep(over);
  if (!isId(callId)) return null;
  return d.Call.findOne({ _id: callId, shop }).lean();
}

/** The call a chat is on (open or the last one), for the widget. */
export async function callForChat(shop, chatRef, callId, over = {}) {
  const d = dep(over);
  if (!isId(callId)) return null;
  return d.Call.findOne({ _id: callId, shop, chatRef }).lean();
}

/** Requests waiting for a person, newest first, for the dashboard. A person who passed on one does not see it again. */
export async function waitingFor(shop, representativeId, over = {}) {
  const d = dep(over);
  const rows = await d.Call.find({ shop, status: "requested", expiresAt: { $gt: new Date(d.now()) }, rejectedBy: { $ne: representativeId } }).sort({ requestedAt: 1 }).limit(20).lean();
  return rows.map(view);
}

/** The shopper gives up (or closes the chat) before anyone answers. */
export async function cancelCall(shop, chatRef, callId, over = {}) {
  const d = dep(over);
  if (!isId(callId)) throw new SupportError("Call not found.", 404);
  const now = new Date(d.now());
  const before = await d.Call.findOneAndUpdate(
    { _id: callId, shop, chatRef, status: { $in: ["requested", "accepted"] } },
    { $set: { status: "cancelled", endedAt: now, failureReason: "cancelled by the shopper" }, $unset: { openKey: "" } },
    { new: false, lean: true }
  );
  if (!before) return null;
  if (before.representative?.id) await freeRepresentative(shop, before.representative.id, before._id, d);
  const call = { ...before, status: "cancelled", endedAt: now };
  await mirrorOnConversation(shop, call, d);
  await settleAccounting(shop, call, d);
  return { call: view(call), representativeId: before.representative?.id || null, wasAccepted: before.status === "accepted" };
}

/**
 * When a call reaches a final state: close the time the handler had it, and write one small event with no personal data
 * (the call's outcome, length, handler and customer key). The call record itself is kept for the store's retention period;
 * these events live longer (EVENT_RETENTION_DAYS), which is what the dashboard's longer-term counts are read from.
 * `dedupeKey` makes it safe to run twice for the same call. A failure here never changes the call.
 */
async function settleAccounting(shop, call, d) {
  try {
    const end = call.endedAt ? new Date(call.endedAt) : new Date(d.now());
    const open = (call.handlingSegments || []).find((s) => !s.endedAt);
    if (open) {
      const sec = Math.max(0, Math.round((end.getTime() - new Date(open.startedAt).getTime()) / 1000));
      await d.Call.updateOne({ _id: call._id, shop }, { $set: { "handlingSegments.$[s].endedAt": end, "handlingSegments.$[s].durationSec": sec } }, { arrayFilters: [{ "s.endedAt": { $exists: false } }] });
    }
    const who = call.handledBy?.id ? call.handledBy : call.representative?.id ? { id: call.representative.id } : null;
    await recordEvent({
      shop, type: "support_call_closed", dedupeKey: `call:${call._id}`, at: end,
      conversationId: call.conversationId || null, chatRef: call.chatRef || null,
      props: {
        callId: String(call._id), status: call.status, durationSec: call.status === "ended" ? call.durationSec || 0 : 0,
        connected: Boolean(call.connectedAt), requestedAt: call.requestedAt, acceptedAt: call.acceptedAt || null,
        handlerType: "human", handlerId: who?.id || null, personKey: call.personKey || null,
      },
    });
  } catch (error) {
    console.warn("[support] could not settle call accounting:", String(error?.message || error).slice(0, 120));
  }
}

async function freeRepresentative(shop, representativeId, callId, d) {
  if (!representativeId) return;
  await d.Presence.updateOne({ shop, representativeId, activeCallId: callId }, { $set: { activeCallId: null } });
}

/**
 * A team member takes a request. Atomic twice over: the person must be free (not already on a call), and the call
 * must still be waiting. Whoever loses gets a clear answer and nothing changes.
 */
export async function acceptCall(shop, callId, { representativeId, name = "" }, over = {}) {
  const d = dep(over);
  if (!isId(callId)) throw new SupportError("Call not found.", 404, "not_found");
  const rep = clean(representativeId, 60);
  if (!rep) throw new SupportError("Sign in again.", 401, "unauthorized");
  const now = new Date(d.now());
  // 1. this person must be free (and be present)
  const claimed = await d.Presence.findOneAndUpdate(
    { shop, representativeId: rep, activeCallId: null, status: "online", lastHeartbeatAt: { $gte: new Date(d.now() - PRESENCE_FRESH_MS()) } },
    { $set: { activeCallId: callId } },
    { new: true, lean: true }
  );
  if (!claimed) throw new SupportError("You are not available for calls right now. Set yourself online (and finish your current call) first.", 409, "not_available");
  // 2. the call must still be waiting
  const call = await d.Call.findOneAndUpdate(
    { _id: callId, shop, status: "requested", expiresAt: { $gt: now }, rejectedBy: { $ne: rep } },
    { $set: {
      status: "accepted", acceptedAt: now, "representative.id": rep, "representative.name": clean(name, 80) || claimed.name || "",
      assignedTo: { type: "human", id: rep, name: clean(name, 80) || claimed.name || "" },
      handledBy: { type: "human", id: rep, name: clean(name, 80) || claimed.name || "" },
      handlingSegments: [{ employeeId: rep, employeeName: clean(name, 80) || claimed.name || "", startedAt: now }],
    } },
    { new: true, lean: true }
  );
  if (!call) {
    await d.Presence.updateOne({ shop, representativeId: rep, activeCallId: callId }, { $set: { activeCallId: null } });
    const now2 = await d.Call.findOne({ _id: callId, shop }).lean();
    if (!now2) throw new SupportError("Call not found.", 404, "not_found");
    if (now2.status === "accepted" || now2.status === "connected") throw new SupportError("A teammate has just taken this call.", 409, "taken");
    throw new SupportError("The shopper is no longer waiting.", 409, "gone");
  }
  return view(await mirrorOnConversation(shop, call, d));
}

/** A team member passes on a request. If every available person has passed, the shopper is told nobody is free. */
export async function rejectCall(shop, callId, representativeId, over = {}) {
  const d = dep(over);
  if (!isId(callId)) throw new SupportError("Call not found.", 404, "not_found");
  const rep = clean(representativeId, 60);
  const call = await d.Call.findOneAndUpdate({ _id: callId, shop, status: "requested" }, { $addToSet: { rejectedBy: rep } }, { new: true, lean: true });
  if (!call) return { call: null, closed: false };
  const team = await listPresence(shop, d);
  const stillCanTake = team.some((p) => p.state === "online" && !(call.rejectedBy || []).includes(p.id));
  if (stillCanTake) return { call: view(call), closed: false };
  const closed = await closeUnanswered(shop, call._id, "nobody available", d);
  return { call: view(closed || call), closed: Boolean(closed) };
}

async function closeUnanswered(shop, callId, reason, d) {
  const now = new Date(d.now());
  const call = await d.Call.findOneAndUpdate({ _id: callId, shop, status: "requested" }, { $set: { status: "unanswered", endedAt: now, failureReason: reason }, $unset: { openKey: "" } }, { new: true, lean: true });
  if (call) {
    await mirrorOnConversation(shop, call, d);
    await settleAccounting(shop, call, d);
  }
  return call;
}

/** The audio is up on both sides. */
export async function markConnected(shop, callId, over = {}) {
  const d = dep(over);
  if (!isId(callId)) return null;
  const now = new Date(d.now());
  const call = await d.Call.findOneAndUpdate({ _id: callId, shop, status: "accepted" }, { $set: { status: "connected", connectedAt: now } }, { new: true, lean: true });
  if (!call) return d.Call.findOne({ _id: callId, shop, status: "connected" }).lean().then(view);
  await mirrorOnConversation(shop, call, d);
  // a complaint of this chat says the person is really on the line only now, when the audio connected
  await markHandoff({ shop, chatRef: call.chatRef, status: "connected", callId: String(call._id) }).catch(() => {});
  return view(call);
}

function mmss(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** The line the chat gets when a call is over (the shopper sees it as a team message, the dashboard as a call). */
export function summaryText(call) {
  const who = call.representative?.name || "Support Representative";
  const status = call.status === "ended" ? "Completed" : call.status === "cancelled" ? "Cancelled" : call.status === "unanswered" ? "Not answered" : "Could not connect";
  const dur = call.durationSec != null && call.status === "ended" ? ` · Duration ${mmss(call.durationSec)}` : "";
  return `Audio call with ${who}${dur} · ${status}`;
}

async function writeSummary(shop, call, d) {
  const withChat = await linkConversation(call, d);
  if (!withChat.conversationId) return;
  const chat = await d.Conversation.findOne({ _id: withChat.conversationId, shop }).select("expiresAt chatRef").lean();
  if (!chat) return;
  const now = d.now();
  const expiresAt = new Date(Math.max(chat.expiresAt ? new Date(chat.expiresAt).getTime() : 0, now + MIN_DELIVERY_DAYS * DAY_MS));
  await d.Message.create({
    shop, conversationId: withChat.conversationId, role: "staff", staffBy: clean(call.representative?.name, 80), text: summaryText(call), at: new Date(now), degraded: false, expiresAt,
    call: { callId: String(call._id), status: call.status, durationSec: call.durationSec ?? 0, recording: call.recording?.status === "saved" },
  });
  await d.Conversation.updateOne({ _id: withChat.conversationId, shop }, { $set: { lastMessageAt: new Date(now), expiresAt }, $inc: { messageCount: 1 } });
}

/**
 * Ends an accepted or connected call (by either side, or because a side was lost). `failed` is for a call that never
 * got audio or dropped for good; a call that was connected and then hung up is simply `ended`.
 */
export async function endCall(shop, callId, { by = "", failure = "" } = {}, over = {}) {
  const d = dep(over);
  if (!isId(callId)) return null;
  const now = new Date(d.now());
  const open = await d.Call.findOne({ _id: callId, shop, status: { $in: ["accepted", "connected"] } }).lean();
  if (!open) return null;
  const connected = open.status === "connected" && open.connectedAt;
  const status = connected ? "ended" : "failed";
  const set = { status, endedAt: now, durationSec: connected ? Math.max(0, Math.round((now.getTime() - new Date(open.connectedAt).getTime()) / 1000)) : 0 };
  if (failure || !connected) set.failureReason = clean(failure || `ended before the audio connected${by ? ` (${by})` : ""}`, 220);
  if (open.recording?.status === "recording") set["recording.status"] = connected ? "uploading" : "none";
  const call = await d.Call.findOneAndUpdate({ _id: callId, shop, status: open.status }, { $set: set, $unset: { openKey: "" } }, { new: true, lean: true });
  if (!call) return null;
  await freeRepresentative(shop, call.representative?.id, call._id, d);
  await mirrorOnConversation(shop, call, d);
  await settleAccounting(shop, call, d);
  await writeSummary(shop, call, d);
  await markHandoff({ shop, chatRef: call.chatRef, status: connected ? "ended" : "unavailable", callId: String(call._id) }).catch(() => {});
  return view(call);
}

// ---- recording -----------------------------------------------------------------------------------------------
/** The shopper takes their consent back: recording must stop and what was kept so far is not saved. */
export async function withdrawRecording(shop, chatRef, callId, over = {}) {
  const d = dep(over);
  if (!isId(callId)) return null;
  const call = await d.Call.findOneAndUpdate(
    { _id: callId, shop, chatRef, "recording.consent": true },
    { $set: { "recording.consent": false, "recording.withdrawnAt": new Date(d.now()), "recording.status": "withdrawn" } },
    { new: true, lean: true }
  );
  return call ? view(call) : null;
}

/** The dashboard could not record or upload: say so honestly instead of showing a recording that is not there. */
export async function recordingFailed(shop, callId, error = "", over = {}) {
  const d = dep(over);
  if (!isId(callId)) return null;
  const call = await d.Call.findOneAndUpdate({ _id: callId, shop, "recording.consent": true }, { $set: { "recording.status": "failed", "recording.error": clean(error, 200) } }, { new: true, lean: true });
  return call ? view(call) : null;
}

/** Stores the audio of a finished call. Only for a call whose shopper agreed, on a store that allows recording. */
export async function saveRecording(shop, callId, { buffer, mime, durationSec = 0, settings = {} }, over = {}) {
  const d = dep(over);
  if (!isId(callId)) throw new SupportError("Call not found.", 404, "not_found");
  if (!recordingAllowed(settings)) throw new SupportError("Recording is turned off for this store.", 403, "recording_off");
  if (!Buffer.isBuffer(buffer) || buffer.length < 1) throw new SupportError("The recording is empty.", 400);
  if (buffer.length > MAX_RECORDING_BYTES()) throw new SupportError("The recording is too large to keep.", 413, "too_large");
  const type = clean(mime, 60);
  if (!RECORDING_MIMES.test(type)) throw new SupportError("That is not an audio recording.", 415, "type");
  const call = await d.Call.findOne({ _id: callId, shop }).lean();
  if (!call) throw new SupportError("Call not found.", 404, "not_found");
  if (!call.recording?.consent || call.recording?.withdrawnAt) throw new SupportError("The shopper did not agree to a recording of this call.", 403, "no_consent");
  if (call.recording.status === "saved") return view(call);
  const until = new Date(d.now() + retentionDaysFor(settings) * DAY_MS);
  const storage = d.storage();
  const base = { shop, callId: call._id, chatRef: call.chatRef, mime: type.split(";")[0].toLowerCase(), size: buffer.length, durationSec: Math.max(0, Math.round(Number(durationSec) || 0)) };
  let doc;
  if (storage) {
    const objectKey = storage.keyFor(shop);
    await storage.put(objectKey, buffer, base.mime);
    doc = await d.Recording.create({ ...base, storage: "s3", objectKey, deleteAfter: until });
  } else {
    doc = await d.Recording.create({ ...base, storage: "mongo", data: buffer, expiresAt: until });
  }
  const saved = await d.Call.findOneAndUpdate({ _id: callId, shop }, { $set: { "recording.status": "saved", "recording.recordingId": doc._id, "recording.sizeBytes": buffer.length }, $unset: { "recording.error": "" } }, { new: true, lean: true });
  await d.Message.updateOne({ shop, "call.callId": String(callId) }, { $set: { "call.recording": true } });
  return view(saved);
}

/** The audio of a call, for the store's team (any call of this store) or the shopper's own chat (`chatRef`). */
export async function recordingBytes(shop, callId, { chatRef = "" } = {}, over = {}) {
  const d = dep(over);
  if (!isId(callId)) return null;
  const filter = { shop, _id: callId, "recording.status": "saved", ...(chatRef ? { chatRef } : {}) };
  const call = await d.Call.findOne(filter).select("_id").lean();
  if (!call) return null;
  const rec = await d.Recording.findOne({ shop, callId }).select("+data").lean();
  if (!rec) return null;
  let bytes;
  if (rec.storage === "s3") {
    const storage = d.storage();
    bytes = storage && rec.objectKey ? await storage.get(rec.objectKey) : null;
  } else bytes = rec.data ? Buffer.from(rec.data.buffer ? rec.data.buffer : rec.data) : null;
  if (!bytes) return null;
  return { bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), mime: rec.mime };
}

// ---- reads for the dashboard --------------------------------------------------------------------------------
export async function listCalls(shop, { conversationId = "", chatRef = "", limit = 20 } = {}, over = {}) {
  const d = dep(over);
  const filter = { shop };
  if (conversationId) {
    if (!isId(conversationId)) return [];
    filter.conversationId = conversationId;
  }
  if (chatRef) filter.chatRef = chatRef;
  const rows = await d.Call.find(filter).sort({ requestedAt: -1 }).limit(Math.min(Math.max(Number(limit) || 20, 1), 100)).lean();
  return rows.map(view);
}

/** Numbers for the Home screen, counted now. */
export async function supportMetrics(shop, settings = {}, over = {}) {
  const d = dep(over);
  const now = new Date(d.now());
  const team = await listPresence(shop, d);
  const [waiting, active, callbacks] = await Promise.all([
    d.Call.countDocuments({ shop, status: "requested", expiresAt: { $gt: now } }),
    d.Call.countDocuments({ shop, status: { $in: ["accepted", "connected"] } }),
    d.Booking.countDocuments({ shop, status: { $in: ACTIVE_STATUSES }, startAt: { $gte: now } }),
  ]);
  return {
    enabled: liveSupportEnabled(settings),
    audio: audioCallEnabled(settings),
    online: team.filter((p) => p.state === "online").length,
    busy: team.filter((p) => p.state === "busy").length,
    away: team.filter((p) => p.state === "away").length,
    activeCalls: active,
    waiting,
    // asked for and not yet talking: waiting for someone, or taken and still connecting
    pendingRequests: waiting + (await d.Call.countDocuments({ shop, status: "accepted" })),
    scheduledCallbacks: callbacks,
  };
}

// ---- housekeeping -----------------------------------------------------------------------------------------------
/**
 * Closes what nobody is looking after: requests nobody took in time, and calls whose team member vanished
 * (their heartbeat stopped). Safe to run often. Returns the calls it closed, for the hub to tell their owners.
 */
export async function sweepSupport(over = {}) {
  const d = dep(over);
  const now = new Date(d.now());
  const closed = [];
  const expired = await d.Call.find({ status: "requested", expiresAt: { $lte: now } }).select("_id shop").lean();
  for (const row of expired) {
    const call = await closeUnanswered(row.shop, row._id, "nobody answered in time", d);
    if (call) closed.push({ shop: row.shop, call: view(call) });
  }
  const stale = new Date(d.now() - PRESENCE_FRESH_MS() * 2);
  const open = await d.Call.find({ status: { $in: ["accepted", "connected"] } }).select("_id shop representative").lean();
  for (const row of open) {
    const p = await d.Presence.findOne({ shop: row.shop, representativeId: row.representative?.id }).select("lastHeartbeatAt").lean();
    if (p && new Date(p.lastHeartbeatAt) >= stale) continue;
    const call = await endCall(row.shop, row._id, { by: "team", failure: "the team member lost their connection" }, d);
    if (call) closed.push({ shop: row.shop, call });
  }
  return closed;
}

// ---- audio servers ------------------------------------------------------------------------------------------------
/**
 * The ICE servers both browsers use: STUN to find each other, and TURN to relay audio when a network blocks a direct path.
 * TURN comes from the environment (SUPPORT_TURN_URLS with either SUPPORT_TURN_SECRET for short-lived coturn credentials,
 * or SUPPORT_TURN_USERNAME + SUPPORT_TURN_CREDENTIAL). Without it calls still work on most networks, not on every one.
 */
export function iceServers(env = process.env, now = Date.now()) {
  const stun = String(env.SUPPORT_STUN_URLS || "stun:stun.l.google.com:19302").split(",").map((u) => u.trim()).filter(Boolean);
  const out = stun.length ? [{ urls: stun }] : [];
  const turn = String(env.SUPPORT_TURN_URLS || "").split(",").map((u) => u.trim()).filter(Boolean);
  if (turn.length) {
    if (env.SUPPORT_TURN_SECRET) {
      const username = `${Math.floor(now / 1000) + 3600}:orbi`;
      const credential = crypto.createHmac("sha1", env.SUPPORT_TURN_SECRET).update(username).digest("base64");
      out.push({ urls: turn, username, credential });
    } else if (env.SUPPORT_TURN_USERNAME && env.SUPPORT_TURN_CREDENTIAL) {
      out.push({ urls: turn, username: env.SUPPORT_TURN_USERNAME, credential: env.SUPPORT_TURN_CREDENTIAL });
    }
  }
  return out;
}
export const turnConfigured = (env = process.env) => Boolean(String(env.SUPPORT_TURN_URLS || "").trim() && (env.SUPPORT_TURN_SECRET || (env.SUPPORT_TURN_USERNAME && env.SUPPORT_TURN_CREDENTIAL)));
