// Call booking: which times are free, taking a request from a shopper, and the owner's actions on it
// (confirm, change the time, mark done / missed / cancelled). Everything is per shop. Confirming puts the call
// in the owner's Google Calendar and emails the shopper; both are retried safely and their result is kept on the booking.
import Booking, { ACTIVE_STATUSES, BOOKING_STATUSES } from "../models/Booking.js";
import { bookingConfig } from "./bookingSettings.js";
import { addDays, describeLocal, localDate, parseClock, zonedParts, zonedTimeToUtc } from "./bookingTime.js";
import { validateEmail, validatePhone } from "./contactValidation.js";
import { cleanEmail, personKeyFor } from "./people.js";
import { retentionDaysFor } from "../admin/settings.js";
import StoreIntegration from "../models/StoreIntegration.js";
import { upsertEvent, deleteEvent, isCalendarConfigured } from "./googleCalendar.js";
import { sendCustomerConfirmation, sendOwnerAlert } from "./bookingEmails.js";
import { isEmailConfigured } from "./emailService.js";

const MIN = 60000;
const DAY_MS = 24 * 3600 * 1000;
const MAX_SLOTS_PER_DAY = 4;

/** Where to tell the owner: the alert email they set, else the store's own contact email. */
export async function defaultOwnerEmail(shop, settings) {
  if (settings?.notificationEmail) return settings.notificationEmail;
  try {
    const store = await StoreIntegration.findOne({ platform: "shopify", storeDomain: shop }).lean();
    return store?.contactEmail || store?.shopEmail || store?.storeProfile?.email || store?.storeProfile?.contactEmail || "";
  } catch {
    return "";
  }
}

const defaults = () => ({
  model: Booking,
  ownerEmail: defaultOwnerEmail,
  now: () => Date.now(),
  calendar: { upsertEvent, deleteEvent, configured: isCalendarConfigured },
  mail: { sendCustomerConfirmation, sendOwnerAlert, configured: isEmailConfigured },
});
const deps = (over = {}) => ({ ...defaults(), ...over, calendar: { ...defaults().calendar, ...(over.calendar || {}) }, mail: { ...defaults().mail, ...(over.mail || {}) } });

const clean = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const slotKey = (shop, startMs) => `${shop}|${startMs}`;
export const isObjectId = (id) => /^[a-f0-9]{24}$/i.test(String(id));

// ---- which times are free ---------------------------------------------------------------------------
/**
 * Every bookable start time in the owner's hours from now, as UTC milliseconds, earliest first.
 * @param taken  start times (ms) already held by a requested or confirmed call
 */
export function computeSlots(config, { now, taken = [], perDay = MAX_SLOTS_PER_DAY, limit = 200 } = {}) {
  const tz = config.timezone;
  const from = parseClock(config.from);
  const to = parseClock(config.to);
  const step = config.slotMinutes;
  const earliest = now + config.leadHours * 60 * MIN;
  const busy = new Set(taken.map(Number));
  const today = zonedParts(now, tz);
  const slots = [];
  for (let offset = 0; offset <= config.maxDaysAhead && slots.length < limit; offset++) {
    const day = addDays(today, offset);
    const weekday = zonedParts(zonedTimeToUtc({ ...day, hour: 12 }, tz), tz).weekday;
    if (!config.days.includes(weekday)) continue;
    let count = 0;
    for (let m = from; m + step <= to && count < perDay; m += step) {
      const start = zonedTimeToUtc({ ...day, hour: Math.floor(m / 60), minute: m % 60 }, tz);
      if (start < earliest || busy.has(start)) continue;
      slots.push(start);
      count += 1;
    }
  }
  return slots;
}

/** Whether `startMs` is exactly one of the owner's slots (right day, hour and step), ignoring who holds it. */
export function isOnGrid(config, startMs) {
  const p = zonedParts(startMs, config.timezone);
  if (!config.days.includes(p.weekday) || p.second !== 0) return false;
  const minutes = p.hour * 60 + p.minute;
  const from = parseClock(config.from);
  return minutes >= from && minutes + config.slotMinutes <= parseClock(config.to) && (minutes - from) % config.slotMinutes === 0;
}

async function takenStarts(m, shop, fromMs, toMs) {
  const rows = await m.find({ shop, status: { $in: ACTIVE_STATUSES }, startAt: { $gte: new Date(fromMs), $lte: new Date(toMs) } }).select("startAt").lean();
  return rows.map((r) => new Date(r.startAt).getTime());
}

/** Free times for the agent to offer: a few per day over the next days, with the local day and time spelled out as facts. */
export async function listFreeSlots({ shop, settings, limit = 8, perDay = 3 }, over = {}) {
  const d = deps(over);
  const config = bookingConfig(settings);
  if (!config.enabled) return { enabled: false, slots: [], config };
  const now = d.now();
  const taken = await takenStarts(d.model, shop, now, now + (config.maxDaysAhead + 2) * DAY_MS);
  const starts = computeSlots(config, { now, taken, perDay }).slice(0, limit);
  return {
    enabled: true,
    timezone: config.timezone,
    slotMinutes: config.slotMinutes,
    slots: starts.map((ms) => ({ start: new Date(ms).toISOString(), date: localDate(ms, config.timezone), local: describeLocal(ms, config.timezone) })),
    config,
  };
}

// ---- taking a request -------------------------------------------------------------------------------
/**
 * A shopper's call request. Returns { status: "booked" | "confirmed", booking } or { status: "invalid" | "slot_unavailable" | "disabled", ... }.
 * The AI has already collected name, phone and email; they are checked again here, and the time must be one of the owner's free slots.
 */
export async function createBooking({ shop, settings, input = {}, chatRef = "", country = "", language = "", shopName = "" }, over = {}) {
  const d = deps(over);
  const config = bookingConfig(settings);
  if (!config.enabled) return { status: "disabled" };
  const problems = [];
  const email = cleanEmail(input.email);
  if (!email || !validateEmail(email).ok) problems.push({ field: "email", reason: input.email ? "invalid" : "missing" });
  const phone = clean(input.phone, 24);
  if (!validatePhone(phone, country).ok) problems.push({ field: "phone", reason: phone ? "invalid" : "missing" });
  const startMs = Date.parse(String(input.slotStart || ""));
  if (!Number.isFinite(startMs)) problems.push({ field: "slotStart", reason: "invalid" });
  if (problems.length) return { status: "invalid", problems };

  // A chat has one callback at a time, and asking again for the same time (a second click, a retried request, a reloaded page)
  // is the same request: it returns the booking that already exists instead of failing as "taken" or making a second one.
  if (chatRef) {
    const mine = await activeBookingForChat(shop, chatRef, over);
    if (mine) {
      if (new Date(mine.startAt).getTime() === startMs) return { status: mine.status === "confirmed" ? "confirmed" : "booked", booking: mine, replayed: true };
      return { status: "already_booked", booking: mine };
    }
  }

  const now = d.now();
  const free = await takenStarts(d.model, shop, startMs, startMs);
  const earliest = now + config.leadHours * 60 * MIN;
  if (!isOnGrid(config, startMs) || startMs < earliest || startMs > now + (config.maxDaysAhead + 1) * DAY_MS || free.length) {
    // the time is held by this same shopper (their other click got there a moment earlier): that is the booking they asked for
    const mine = chatRef && free.length ? await activeBookingForChat(shop, chatRef, over) : null;
    if (mine && new Date(mine.startAt).getTime() === startMs) return { status: mine.status === "confirmed" ? "confirmed" : "booked", booking: mine, replayed: true };
    return { status: "slot_unavailable" };
  }

  const endMs = startMs + config.slotMinutes * MIN;
  let booking;
  try {
    booking = await d.model.create({
      shop, chatRef: clean(chatRef, 64), name: clean(input.name, 80), email, phone,
      topic: clean(input.topic, 300), language: clean(language, 16),
      startAt: new Date(startMs), endAt: new Date(endMs), timezone: config.timezone,
      status: "requested", activeSlot: slotKey(shop, startMs),
      calendar: { status: d.calendar.configured() ? "pending" : "off" },
      expiresAt: new Date(endMs + retentionDaysFor(settings) * DAY_MS),
    });
  } catch (error) {
    if (error?.code === 11000) {
      // two clicks of the same shopper arrive at the same moment: the one that lost the race finds its own booking, not "taken"
      const mine = chatRef ? await activeBookingForChat(shop, chatRef, over) : null;
      if (mine && new Date(mine.startAt).getTime() === startMs) return { status: mine.status === "confirmed" ? "confirmed" : "booked", booking: mine, replayed: true };
      return { status: "slot_unavailable" };
    }
    throw error;
  }
  const plain = toPlain(booking);

  // tell the owner (best effort: a mail problem never loses the booking)
  const alertTo = settings?.alerts?.onCallRequest !== false && !config.autoConfirm ? await d.ownerEmail(shop, settings) : "";
  if (alertTo) {
    const sent = await d.mail.sendOwnerAlert({ booking: plain, to: alertTo, shopName: shopName || shop, confirmed: false });
    await d.model.updateOne({ _id: plain._id, shop }, { $set: { "emails.owner": sent.ok ? "sent" : "failed", ...(sent.ok ? {} : { "emails.error": clean(sent.error, 200) }) } });
    plain.emails = { ...(plain.emails || {}), owner: sent.ok ? "sent" : "failed" };
  }
  if (config.autoConfirm) {
    const confirmed = await confirmBooking(shop, plain._id, { settings, shopName, notifyOwner: true }, over);
    return { status: "confirmed", booking: confirmed.booking || plain };
  }
  return { status: "booked", booking: plain };
}

function toPlain(doc) {
  const o = doc?.toObject ? doc.toObject() : { ...doc };
  return o;
}

// ---- the owner's actions ----------------------------------------------------------------------------
async function load(m, shop, id) {
  if (!isObjectId(id)) return null;
  return m.findOne({ _id: id, shop }).lean();
}

/**
 * Confirms a call: calendar event + email to the shopper. Safe to call again: only the parts that have not
 * succeeded yet are retried (so "Retry" in the dashboard never sends a second email or makes a second event).
 */
export async function confirmBooking(shop, id, { settings = {}, shopName = "", notifyOwner = false, force = false } = {}, over = {}) {
  const d = deps(over);
  let booking = await load(d.model, shop, id);
  if (!booking) return { status: "not_found" };
  if (!["requested", "confirmed"].includes(booking.status)) return { status: "wrong_state", booking };
  const set = {};
  if (booking.status === "requested") {
    set.status = "confirmed";
    set.confirmedAt = new Date(d.now());
  }
  const config = bookingConfig(settings);

  // 1. the owner's Google Calendar
  if (!d.calendar.configured()) set["calendar.status"] = "off";
  else if (force || booking.calendar?.status !== "synced") {
    try {
      const out = await d.calendar.upsertEvent({ calendarId: config.calendarId, booking, shopName: shopName || shop });
      set["calendar.status"] = "synced";
      set["calendar.eventId"] = out.eventId;
      set["calendar.link"] = out.link || undefined;
      set["calendar.error"] = undefined;
    } catch (error) {
      set["calendar.status"] = "failed";
      set["calendar.error"] = clean(error?.message, 200);
      console.warn("[booking] calendar sync failed:", clean(error?.message, 160));
    }
  }

  // 2. the email to the shopper
  if (!d.mail.configured()) set["emails.customer"] = "off";
  else if (force || booking.emails?.customer !== "sent") {
    const sent = await d.mail.sendCustomerConfirmation({ booking: { ...booking, ...set }, shopName: shopName || shop });
    set["emails.customer"] = sent.ok ? "sent" : "failed";
    set["emails.error"] = sent.ok ? undefined : clean(sent.error, 200);
  }

  booking = await applyUpdate(d.model, shop, id, set);
  if (notifyOwner) {
    const to = settings?.alerts?.onCallRequest !== false ? await d.ownerEmail(shop, settings) : "";
    if (to) await d.mail.sendOwnerAlert({ booking, to, shopName: shopName || shop, confirmed: true });
  }
  return { status: "ok", booking };
}

async function applyUpdate(m, shop, id, set) {
  const $set = {};
  const $unset = {};
  for (const [k, v] of Object.entries(set)) (v === undefined ? $unset : $set)[k] = v === undefined ? "" : v;
  return m.findOneAndUpdate({ _id: id, shop }, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) }, { new: true, lean: true });
}

/**
 * The owner picks another time for a call. It is moved in the calendar and the shopper is emailed the new time.
 * The new time must be free and in the future; it need not fit the usual hours (the owner decides).
 */
export async function rescheduleBooking(shop, id, { startAt, settings = {}, shopName = "" } = {}, over = {}) {
  const d = deps(over);
  const booking = await load(d.model, shop, id);
  if (!booking) return { status: "not_found" };
  if (!ACTIVE_STATUSES.includes(booking.status)) return { status: "wrong_state", booking };
  const startMs = Date.parse(String(startAt || ""));
  if (!Number.isFinite(startMs) || startMs < d.now()) return { status: "invalid" };
  const length = new Date(booking.endAt).getTime() - new Date(booking.startAt).getTime();
  try {
    await d.model.updateOne(
      { _id: id, shop },
      { $set: { startAt: new Date(startMs), endAt: new Date(startMs + length), activeSlot: slotKey(shop, startMs), "calendar.status": d.calendar.configured() ? "pending" : "off", "emails.customer": "none" } }
    );
  } catch (error) {
    if (error?.code === 11000) return { status: "slot_unavailable" };
    throw error;
  }
  return confirmBooking(shop, id, { settings, shopName, force: true }, over);
}

// ---- the shopper's own callback: the database is the record of it, so a reloaded page can show it ----------------------
const OVERDUE_MS = 60 * MIN;

/** The callback this chat still has waiting (requested or confirmed, not older than a day), or null. */
export async function activeBookingForChat(shop, chatRef, over = {}) {
  const d = deps(over);
  if (!shop || !chatRef) return null;
  const rows = await d.model.find({ shop, chatRef: clean(chatRef, 64), status: { $in: ACTIVE_STATUSES }, startAt: { $gte: new Date(d.now() - DAY_MS) } }).sort({ startAt: 1 }).limit(1).lean();
  return rows[0] || null;
}

/** The most recent callback of this chat that ended some other way (cancelled, missed, completed) in the last week. */
export async function lastClosedBookingForChat(shop, chatRef, over = {}) {
  const d = deps(over);
  if (!shop || !chatRef) return null;
  const rows = await d.model.find({ shop, chatRef: clean(chatRef, 64), status: { $in: ["cancelled", "missed", "completed"] }, updatedAt: { $gte: new Date(d.now() - 7 * DAY_MS) } }).sort({ updatedAt: -1 }).limit(1).lean();
  return rows[0] || null;
}

/**
 * What the shopper's window may know about a booking. Booking confirmation and calendar synchronisation are separate: the
 * calendar is the owner's side, and it never makes the shopper's booking more or less real.
 */
export function bookingForShopper(b, now = Date.now()) {
  if (!b) return null;
  return {
    id: String(b._id),
    reference: String(b._id).slice(-6).toUpperCase(),
    status: b.status,
    confirmed: b.status === "confirmed",
    startAt: new Date(b.startAt).toISOString(),
    endAt: new Date(b.endAt).toISOString(),
    timezone: b.timezone || "",
    callMinutes: Math.round((new Date(b.endAt) - new Date(b.startAt)) / MIN),
    topic: b.topic || "",
    calendar: b.calendar?.status || "off",
    // the time has passed and nobody marked the call as made: say that, instead of "your callback is booked"
    overdue: ACTIVE_STATUSES.includes(b.status) && new Date(b.startAt).getTime() < now - OVERDUE_MS,
  };
}

/** The shopper cancels their own callback. The slot is freed at once and the owner's calendar event is removed. */
export async function cancelOwnBooking(shop, id, chatRef, { settings = {} } = {}, over = {}) {
  const d = deps(over);
  const booking = await load(d.model, shop, id);
  if (!booking || !chatRef || booking.chatRef !== clean(chatRef, 64)) return { status: "not_found" };
  return closeBooking(shop, id, "cancelled", { note: "Cancelled by the shopper", settings }, over);
}

/** The shopper moves their own callback to another free time (the same rules as booking one). */
export async function rescheduleOwnBooking(shop, id, chatRef, { startAt, settings = {}, shopName = "" } = {}, over = {}) {
  const d = deps(over);
  const config = bookingConfig(settings);
  if (!config.enabled) return { status: "disabled" };
  const booking = await load(d.model, shop, id);
  if (!booking || !chatRef || booking.chatRef !== clean(chatRef, 64)) return { status: "not_found" };
  if (!ACTIVE_STATUSES.includes(booking.status)) return { status: "wrong_state", booking };
  const startMs = Date.parse(String(startAt || ""));
  if (!Number.isFinite(startMs)) return { status: "invalid" };
  if (startMs === new Date(booking.startAt).getTime()) return { status: booking.status === "confirmed" ? "confirmed" : "booked", booking, replayed: true };
  const now = d.now();
  const taken = await takenStarts(d.model, shop, startMs, startMs);
  if (!isOnGrid(config, startMs) || startMs < now + config.leadHours * 60 * MIN || startMs > now + (config.maxDaysAhead + 1) * DAY_MS || taken.length) return { status: "slot_unavailable" };
  const endMs = startMs + config.slotMinutes * MIN;
  try {
    await d.model.updateOne(
      { _id: id, shop, status: { $in: ACTIVE_STATUSES } },
      { $set: { startAt: new Date(startMs), endAt: new Date(endMs), activeSlot: slotKey(shop, startMs), "calendar.status": d.calendar.configured() ? "pending" : "off", "emails.customer": "none" } }
    );
  } catch (error) {
    if (error?.code === 11000) return { status: "slot_unavailable" };
    throw error;
  }
  // a confirmed call is moved in the calendar and the shopper is emailed the new time; a request waits for the owner as before
  if (booking.status === "confirmed") {
    const out = await confirmBooking(shop, id, { settings, shopName, force: true }, over);
    return { status: "confirmed", booking: out.booking };
  }
  return { status: "booked", booking: await load(d.model, shop, id) };
}

/** completed | missed | cancelled. The slot is freed; a cancelled call is removed from the calendar. */
export async function closeBooking(shop, id, status, { note, settings = {} } = {}, over = {}) {
  const d = deps(over);
  if (!["completed", "missed", "cancelled"].includes(status)) return { status: "invalid" };
  const booking = await load(d.model, shop, id);
  if (!booking) return { status: "not_found" };
  if (!ACTIVE_STATUSES.includes(booking.status)) return { status: "wrong_state", booking };
  const set = { status, activeSlot: undefined };
  if (note !== undefined) set.ownerNote = clean(note, 500) || undefined;
  if (status === "cancelled" && booking.calendar?.eventId && d.calendar.configured()) {
    try {
      await d.calendar.deleteEvent({ calendarId: bookingConfig(settings).calendarId, eventId: booking.calendar.eventId });
      set["calendar.status"] = "off";
    } catch (error) {
      set["calendar.error"] = clean(error?.message, 200);
    }
  }
  return { status: "ok", booking: await applyUpdate(d.model, shop, id, set) };
}

// ---- reading ----------------------------------------------------------------------------------------
export async function listBookings(shop, { status, conversationId, personKey, upcomingOnly = false, limit = 100 } = {}, over = {}) {
  const d = deps(over);
  const filter = { shop };
  if (status && BOOKING_STATUSES.includes(status)) filter.status = status;
  if (conversationId && isObjectId(conversationId)) filter.conversationId = conversationId;
  if (personKey) filter.personKey = personKey;
  if (upcomingOnly) filter.startAt = { $gte: new Date(d.now() - 60 * MIN) };
  return d.model.find(filter).sort({ startAt: upcomingOnly ? 1 : -1 }).limit(Math.min(limit, 200)).lean();
}

/** Counts for the dashboard badges: calls waiting for the owner and calls coming up. */
export async function bookingSummary(shop, over = {}) {
  const d = deps(over);
  const now = new Date(d.now());
  const [waiting, upcoming, next] = await Promise.all([
    d.model.countDocuments({ shop, status: "requested", startAt: { $gte: new Date(now.getTime() - 60 * MIN) } }),
    d.model.countDocuments({ shop, status: "confirmed", startAt: { $gte: now } }),
    d.model.find({ shop, status: { $in: ACTIVE_STATUSES }, startAt: { $gte: new Date(now.getTime() - 60 * MIN) } }).sort({ startAt: 1 }).limit(5).lean(),
  ]);
  const overdue = await d.model.countDocuments({ shop, status: { $in: ACTIVE_STATUSES }, startAt: { $lt: new Date(now.getTime() - 60 * MIN) } });
  return { waiting, upcoming, overdue, next };
}

/**
 * Called after a turn is stored: ties the booking to the chat it came from and to the person it belongs to
 * (a signed-in customer, else the email they gave for the call). Returns the linked bookings.
 */
export async function linkBookingsToChat(shop, { ids = [], conversationId, chatRef = "", customerRef = null }, over = {}) {
  const d = deps(over);
  const valid = ids.filter(isObjectId);
  if (!valid.length || !conversationId) return [];
  const rows = await d.model.find({ _id: { $in: valid }, shop }).lean();
  const linked = [];
  for (const row of rows) {
    const personKey = personKeyFor(shop, { customerRef, email: row.email, chatRef });
    await d.model.updateOne({ _id: row._id, shop }, { $set: { conversationId, personKey } });
    linked.push({ ...row, conversationId, personKey });
  }
  return linked;
}

