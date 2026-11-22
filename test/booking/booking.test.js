// Call booking: the owner's hours turned into free times (in the store's own time zone), and what happens to a request.
import test from "node:test";
import assert from "node:assert/strict";
import { zonedTimeToUtc, zonedParts, describeLocal, localDate, parseClock } from "../../src/services/bookingTime.js";
import { validateBookingPatch, bookingConfig, BOOKING_DEFAULTS, alertOn, fileKindAllowed } from "../../src/services/bookingSettings.js";
import { validateSettingsPatch, mergeSettings } from "../../src/admin/settings.js";
import { computeSlots, isOnGrid, listFreeSlots, createBooking, confirmBooking, rescheduleBooking, closeBooking, bookingSummary, linkBookingsToChat } from "../../src/services/bookingService.js";
import { SHOP, NOW, ON, wire, fakeBookingModel, fakeCalendar, fakeMail } from "./helpers.js";

const cfg = (over = {}) => bookingConfig({ booking: { enabled: true, ...over } });
const asIst = (iso) => Date.parse(`${iso}+05:30`);
const input = (over = {}) => ({ slotStart: new Date(asIst("2026-11-03T10:00:00")).toISOString(), name: "Riya", phone: "+91 98765 43210", email: "riya@example.com", topic: "bulk order", ...over });

// ---- time zones --------------------------------------------------------------------------------------
test("wall-clock times in a zone become the right instant, also across daylight saving", () => {
  assert.equal(new Date(zonedTimeToUtc({ year: 2026, month: 11, day: 3, hour: 10 }, "Asia/Kolkata")).toISOString(), "2026-11-03T04:30:00.000Z");
  // New York: summer time (UTC-4) before 1 Nov 2026, winter time (UTC-5) after
  assert.equal(new Date(zonedTimeToUtc({ year: 2026, month: 10, day: 30, hour: 9 }, "America/New_York")).toISOString(), "2026-10-30T13:00:00.000Z");
  assert.equal(new Date(zonedTimeToUtc({ year: 2026, month: 11, day: 3, hour: 9 }, "America/New_York")).toISOString(), "2026-11-03T14:00:00.000Z");
  assert.deepEqual(zonedParts(NOW, "Asia/Kolkata"), { year: 2026, month: 11, day: 2, hour: 11, minute: 30, second: 0, weekday: 1 });
  assert.equal(localDate(Date.parse("2026-11-02T20:00:00Z"), "Asia/Kolkata"), "2026-11-03"); // already tomorrow in India
  assert.equal(parseClock("9:05"), 545);
  assert.equal(parseClock("25:00"), null);
  assert.match(describeLocal(asIst("2026-11-03T16:30:00"), "Asia/Kolkata"), /Tue.*3 Nov.*4:30/i);
});

// ---- the owner's rules -------------------------------------------------------------------------------
test("booking settings are checked: hours, days, slot length, zone and calendar id", () => {
  assert.deepEqual(validateBookingPatch({ enabled: true, from: "9:00", to: "17:30", days: [3, 1, 1], slotMinutes: 20, timezone: "Asia/Kolkata" }).value, { enabled: true, from: "09:00", to: "17:30", days: [1, 3], slotMinutes: 20, timezone: "Asia/Kolkata" });
  for (const bad of [{ enabled: "yes" }, { days: [] }, { days: [7] }, { from: "nine" }, { slotMinutes: 5 }, { slotMinutes: 500 }, { timezone: "Mars/Base" }, { leadHours: -1 }, { maxDaysAhead: 90 }, { calendarId: "has space" }, { typo: 1 }, { from: "18:00", to: "10:00" }, { from: "10:00", to: "10:20", slotMinutes: 30 }]) {
    assert.ok(validateBookingPatch(bad).errors.length, JSON.stringify(bad));
  }
  assert.equal(validateBookingPatch(null).value, null);
  assert.deepEqual(bookingConfig({}).days, BOOKING_DEFAULTS.days);
  assert.equal(bookingConfig({}).enabled, false, "booking is off until the owner switches it on");
});

test("the settings screen can save booking, alerts and files, and they merge field by field", () => {
  const { value, errors } = validateSettingsPatch({ booking: { enabled: true }, alerts: { onFiles: false }, files: { videos: false } });
  assert.deepEqual(errors, []);
  const { settings } = mergeSettings({ booking: { from: "09:00" } }, value);
  assert.deepEqual(settings.booking, { from: "09:00", enabled: true });
  assert.equal(alertOn(settings, "onFiles"), false);
  assert.equal(alertOn(settings, "onCallRequest"), true);
  assert.equal(fileKindAllowed(settings, "video"), false);
  assert.equal(fileKindAllowed(settings, "image"), true);
  assert.ok(validateSettingsPatch({ alerts: { onNothing: true } }).errors.length);
  assert.ok(validateSettingsPatch({ files: { pdf: "no" } }).errors.length);
});

// ---- free times --------------------------------------------------------------------------------------
test("free times follow the owner's days, hours, lead time and look-ahead, in their zone", () => {
  const slots = computeSlots(cfg(), { now: NOW, perDay: 3 }).map((ms) => describeLocal(ms, "Asia/Kolkata"));
  // 11:30 now + 2 hours lead = 13:30 earliest today; three per day; weekends skipped
  assert.deepEqual(slots.slice(0, 4), ["Mon, 2 Nov, 1:30 pm", "Mon, 2 Nov, 2:00 pm", "Mon, 2 Nov, 2:30 pm", "Tue, 3 Nov, 10:00 am"]);
  const all = computeSlots(cfg({ maxDaysAhead: 14 }), { now: NOW, perDay: 20 });
  assert.ok(all.every((ms) => ![0, 6].includes(zonedParts(ms, "Asia/Kolkata").weekday)), "no weekend slots");
  assert.ok(all.every((ms) => ms >= NOW + 2 * 3600_000));
  assert.ok(!computeSlots(cfg({ days: [2] }), { now: NOW }).some((ms) => zonedParts(ms, "Asia/Kolkata").weekday !== 2), "only Tuesdays");
});

test("a time that is taken is not offered, and only exact slots of the grid are accepted", () => {
  const tuesday10 = asIst("2026-11-03T10:00:00");
  assert.ok(!computeSlots(cfg(), { now: NOW, taken: [tuesday10], perDay: 20 }).includes(tuesday10));
  assert.equal(isOnGrid(cfg(), tuesday10), true);
  assert.equal(isOnGrid(cfg(), asIst("2026-11-03T10:15:00")), false, "between slots");
  assert.equal(isOnGrid(cfg(), asIst("2026-11-03T18:00:00")), false, "after closing");
  assert.equal(isOnGrid(cfg(), asIst("2026-11-07T10:00:00")), false, "a Saturday");
});

test("the agent is offered nothing while booking is off", async () => {
  const { over } = wire();
  const out = await listFreeSlots({ shop: SHOP, settings: {} }, over);
  assert.deepEqual([out.enabled, out.slots.length], [false, 0]);
  const on = await listFreeSlots({ shop: SHOP, settings: ON, limit: 5 }, over);
  assert.equal(on.slots.length, 5);
  assert.ok(on.slots[0].start.endsWith("Z") && on.slots[0].local && on.slots[0].date);
});

// ---- taking a request --------------------------------------------------------------------------------
test("a valid request is saved as 'requested' for this store and the owner is told", async () => {
  const w = wire();
  const out = await createBooking({ shop: SHOP, settings: ON, input: input(), chatRef: "ref1", language: "hinglish", shopName: "Aria" }, w.over);
  assert.equal(out.status, "booked");
  const row = w.model.rows[0];
  assert.equal(row.shop, SHOP);
  assert.equal(row.status, "requested");
  assert.equal(row.email, "riya@example.com");
  assert.equal(row.timezone, "Asia/Kolkata");
  assert.equal(new Date(row.endAt) - new Date(row.startAt), 30 * 60000);
  assert.equal(w.mail.sent.owner.length, 1, "the owner gets an alert");
  assert.equal(w.mail.sent.customer.length, 0, "the shopper is emailed only once the owner confirms");
  assert.equal(w.calendar.calls.length, 0, "nothing goes to the calendar before the owner confirms");
});

test("a request with a wrong email, phone or time is refused with the exact problem", async () => {
  const w = wire();
  const out = await createBooking({ shop: SHOP, settings: ON, input: input({ email: "riya@", phone: "12" , slotStart: "soon" }) }, w.over);
  assert.equal(out.status, "invalid");
  assert.deepEqual(out.problems.map((p) => p.field).sort(), ["email", "phone", "slotStart"]);
  assert.equal(w.model.rows.length, 0);
});

test("times outside the hours, in the past, too soon or too far away are not bookable", async () => {
  const w = wire();
  for (const slotStart of [new Date(asIst("2026-11-03T21:00:00")).toISOString(), new Date(asIst("2026-11-02T11:30:00")).toISOString(), new Date(asIst("2026-11-02T12:00:00")).toISOString(), new Date(asIst("2027-03-01T10:00:00")).toISOString(), new Date(asIst("2026-11-07T10:00:00")).toISOString()]) {
    assert.equal((await createBooking({ shop: SHOP, settings: ON, input: input({ slotStart }) }, w.over)).status, "slot_unavailable", slotStart);
  }
  assert.equal(w.model.rows.length, 0);
  assert.equal((await createBooking({ shop: SHOP, settings: {}, input: input() }, w.over)).status, "disabled");
});

test("two shoppers cannot take the same time, not even at the same moment", async () => {
  const w = wire();
  assert.equal((await createBooking({ shop: SHOP, settings: ON, input: input() }, w.over)).status, "booked");
  assert.equal((await createBooking({ shop: SHOP, settings: ON, input: input({ email: "other@example.com" }) }, w.over)).status, "slot_unavailable");
  // the same moment: both pass the check, the unique slot key stops the second
  const race = wire();
  const first = race.model.create.bind(race.model);
  race.model.find = () => { const c = { select: () => c, lean: async () => [] }; return c; }; // both see the time as free
  race.model.create = first;
  const [a, b] = await Promise.all([createBooking({ shop: SHOP, settings: ON, input: input() }, race.over), createBooking({ shop: SHOP, settings: ON, input: input({ email: "x@example.com" }) }, race.over)]);
  assert.deepEqual([a.status, b.status].sort(), ["booked", "slot_unavailable"]);
});

test("the same time in another store is a different slot", async () => {
  const w = wire();
  await createBooking({ shop: SHOP, settings: ON, input: input() }, w.over);
  assert.equal((await createBooking({ shop: "b-store.myshopify.com", settings: ON, input: input() }, w.over)).status, "booked");
});

test("with auto-confirm the call is confirmed straight away: calendar event and email to the shopper", async () => {
  const w = wire();
  const settings = { ...ON, booking: { enabled: true, autoConfirm: true, calendarId: "owner@store.com" } };
  const out = await createBooking({ shop: SHOP, settings, input: input(), shopName: "Aria" }, w.over);
  assert.equal(out.status, "confirmed");
  assert.deepEqual([w.model.rows[0].status, w.model.rows[0].calendar.status, w.model.rows[0].emails.customer], ["confirmed", "synced", "sent"]);
  assert.equal(w.calendar.calls[0][1], "owner@store.com", "this store's own calendar id is used");
  assert.equal(w.mail.sent.customer.length, 1);
});

// ---- the owner's actions -----------------------------------------------------------------------------
async function booked(over = {}) {
  const w = wire(over);
  const out = await createBooking({ shop: SHOP, settings: ON, input: input() }, w.over);
  return { w, id: String(out.booking._id) };
}

test("confirming adds the calendar event and emails the shopper once", async () => {
  const { w, id } = await booked();
  const out = await confirmBooking(SHOP, id, { settings: ON, shopName: "Aria" }, w.over);
  assert.equal(out.status, "ok");
  const row = w.model.rows[0];
  assert.deepEqual([row.status, row.calendar.status, row.calendar.eventId, row.emails.customer], ["confirmed", "synced", `evt-${id}`, "sent"]);
  assert.ok(row.confirmedAt);
  // pressing it again does not send a second email or make a second event
  await confirmBooking(SHOP, id, { settings: ON }, w.over);
  assert.equal(w.mail.sent.customer.length, 1);
  assert.equal(w.calendar.calls.length, 1);
});

test("a calendar or email problem is kept on the call and only the failed part is retried", async () => {
  const cal = fakeCalendar({ fail: "Google said 403" });
  const mail = fakeMail({ failCustomer: true });
  const { w, id } = await booked({ calendar: cal, mail });
  await confirmBooking(SHOP, id, { settings: ON }, w.over);
  let row = w.model.rows[0];
  assert.equal(row.status, "confirmed", "the call stays confirmed");
  assert.deepEqual([row.calendar.status, row.calendar.error, row.emails.customer, row.emails.error], ["failed", "Google said 403", "failed", "smtp down"]);
  // the owner fixes the sharing and presses retry
  const fixed = wire({ model: w.model, calendar: fakeCalendar(), mail: fakeMail() });
  await confirmBooking(SHOP, id, { settings: ON }, fixed.over);
  row = w.model.rows[0];
  assert.deepEqual([row.calendar.status, row.emails.customer, row.calendar.error], ["synced", "sent", undefined]);
});

test("when Google or email is not set up the call is still confirmed and says so", async () => {
  const { w, id } = await booked({ calendar: fakeCalendar({ configured: false }), mail: fakeMail({ configured: false }) });
  await confirmBooking(SHOP, id, { settings: ON }, w.over);
  const row = w.model.rows[0];
  assert.deepEqual([row.status, row.calendar.status, row.emails.customer], ["confirmed", "off", "off"]);
});

test("another store cannot confirm, move or close this store's call", async () => {
  const { w, id } = await booked();
  const other = "b-store.myshopify.com";
  assert.equal((await confirmBooking(other, id, {}, w.over)).status, "not_found");
  assert.equal((await rescheduleBooking(other, id, { startAt: new Date(asIst("2026-11-04T10:00:00")).toISOString() }, w.over)).status, "not_found");
  assert.equal((await closeBooking(other, id, "cancelled", {}, w.over)).status, "not_found");
  assert.equal((await confirmBooking(SHOP, "not-an-id", {}, w.over)).status, "not_found");
  assert.equal(w.model.rows[0].status, "requested");
});

test("changing the time moves the event, frees the old time and emails the new one", async () => {
  const { w, id } = await booked();
  await confirmBooking(SHOP, id, { settings: ON }, w.over);
  const next = new Date(asIst("2026-11-04T15:00:00")).toISOString();
  const out = await rescheduleBooking(SHOP, id, { startAt: next, settings: ON }, w.over);
  assert.equal(out.status, "ok");
  assert.equal(new Date(w.model.rows[0].startAt).toISOString(), next);
  assert.equal(w.mail.sent.customer.length, 2, "the shopper hears about the new time");
  assert.equal(w.calendar.calls.length, 2);
  // the old time is free again
  assert.equal((await createBooking({ shop: SHOP, settings: ON, input: input({ email: "n@example.com" }) }, w.over)).status, "booked");
  // a taken or past time is refused
  assert.equal((await rescheduleBooking(SHOP, id, { startAt: new Date(asIst("2026-11-03T10:00:00")).toISOString(), settings: ON }, w.over)).status, "slot_unavailable");
  assert.equal((await rescheduleBooking(SHOP, id, { startAt: new Date(asIst("2026-10-01T10:00:00")).toISOString() }, w.over)).status, "invalid");
});

test("completed, missed and cancelled calls free the time; cancelling removes the calendar event", async () => {
  const { w, id } = await booked();
  await confirmBooking(SHOP, id, { settings: ON }, w.over);
  const out = await closeBooking(SHOP, id, "cancelled", { note: "customer rang to cancel" }, w.over);
  assert.equal(out.status, "ok");
  assert.deepEqual(w.calendar.calls.at(-1), ["delete", `evt-${id}`]);
  assert.equal(w.model.rows[0].activeSlot, undefined);
  assert.equal(w.model.rows[0].ownerNote, "customer rang to cancel");
  assert.equal((await createBooking({ shop: SHOP, settings: ON, input: input({ email: "n@example.com" }) }, w.over)).status, "booked");
  assert.equal((await closeBooking(SHOP, id, "completed", {}, w.over)).status, "wrong_state", "a closed call stays closed");
  assert.equal((await closeBooking(SHOP, id, "exploded", {}, w.over)).status, "invalid");
});

test("the dashboard counts: waiting for the owner, coming up, and overdue", async () => {
  const w = wire();
  const mk = (over) => ({ shop: SHOP, startAt: new Date(NOW + 86400000), status: "requested", ...over });
  const model = fakeBookingModel([mk({}), mk({ status: "confirmed" }), mk({ status: "confirmed", startAt: new Date(NOW - 3 * 3600000) }), mk({ status: "cancelled" }), mk({ shop: "b-store.myshopify.com" })]);
  const out = await bookingSummary(SHOP, { ...w.over, model });
  assert.deepEqual([out.waiting, out.upcoming, out.overdue], [1, 1, 1]);
});

test("a call booked in a chat is tied to that chat and to the person it belongs to, in this store only", async () => {
  const { w, id } = await booked();
  const conversationId = "6540f0f0f0f0f0f0f0f0f0f0";
  assert.deepEqual(await linkBookingsToChat("b-store.myshopify.com", { ids: [id], conversationId, chatRef: "ref" }, w.over), []);
  const linked = await linkBookingsToChat(SHOP, { ids: [id, "junk"], conversationId, chatRef: "ref" }, w.over);
  assert.equal(linked.length, 1);
  assert.match(linked[0].personKey, /^e/, "known by the email they gave");
  assert.deepEqual([String(w.model.rows[0].conversationId), w.model.rows[0].personKey], [conversationId, linked[0].personKey]);
  const signedIn = await linkBookingsToChat(SHOP, { ids: [id], conversationId, chatRef: "ref", customerRef: "778899" }, w.over);
  assert.equal(signedIn[0].personKey, "c778899", "a signed-in customer keeps their Shopify identity");
});

// ---- which files shoppers may send ----------------------------------------------------------------
import { saveAttachments } from "../../src/services/attachmentService.js";

test("the owner can switch off photos, videos or PDFs; those files are refused", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)]);
  const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom"), Buffer.alloc(20)]);
  const model = { insertMany: async (docs) => docs.map((d, i) => ({ _id: `a${i}`, ...d })) };
  const files = [{ originalname: "a.png", buffer: png }, { originalname: "b.mp4", buffer: mp4 }];
  const all = await saveAttachments({ shop: SHOP, chatRef: "r", files, settings: {} }, { model });
  assert.deepEqual(all.attachments.map((a) => a.kind), ["image", "video"]);
  const noVideo = await saveAttachments({ shop: SHOP, chatRef: "r", files, settings: { files: { videos: false } } }, { model });
  assert.deepEqual([noVideo.attachments.map((a) => a.kind), noVideo.rejected], [["image"], ["b.mp4"]]);
});
