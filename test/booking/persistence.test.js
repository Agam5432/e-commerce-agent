// The callback is the booking in the database: a chat has one, asking again for it is safe, two shoppers cannot hold one
// time, the shopper can cancel or move their own (and only their own), and what the page shows is read back from the store.
import test from "node:test";
import assert from "node:assert/strict";
import { createBooking, confirmBooking, rescheduleBooking, closeBooking, activeBookingForChat, lastClosedBookingForChat, bookingForShopper, cancelOwnBooking, rescheduleOwnBooking } from "../../src/services/bookingService.js";
import { SHOP, ON, wire, fakeCalendar } from "./helpers.js";

const asIst = (iso) => new Date(Date.parse(`${iso}+05:30`)).toISOString();
const SLOT = asIst("2026-11-03T10:00:00");
const OTHER = asIst("2026-11-03T11:00:00");
const AUTO = { booking: { enabled: true, autoConfirm: true }, notificationEmail: "owner@store.com" };
const who = (n) => ({ name: `Shopper ${n}`, phone: "+91 98765 43210", email: `s${n}@example.com`, topic: "Order problem" });
const book = (w, chatRef, slotStart = SLOT, settings = ON, n = 1) => createBooking({ shop: SHOP, settings, chatRef, input: { ...who(n), slotStart }, shopName: "Aria" }, w.over);

test("clicking Confirm twice (or a retried request) books once and returns the same booking", async () => {
  const w = wire();
  const first = await book(w, "chat-a");
  const second = await book(w, "chat-a");
  assert.equal(first.status, "booked");
  assert.equal(second.status, "booked");
  assert.equal(second.replayed, true);
  assert.equal(String(second.booking._id), String(first.booking._id));
  assert.equal(w.model.rows.length, 1);
});

test("a chat has one callback: asking for another time is refused and shows the one it has", async () => {
  const w = wire();
  const first = await book(w, "chat-a");
  const again = await book(w, "chat-a", OTHER);
  assert.equal(again.status, "already_booked");
  assert.equal(String(again.booking._id), String(first.booking._id));
  assert.equal(w.model.rows.length, 1);
});

test("two shoppers asking for the same time: only one gets it", async () => {
  const w = wire();
  const results = await Promise.all([book(w, "chat-a", SLOT, ON, 1), book(w, "chat-b", SLOT, ON, 2)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["booked", "slot_unavailable"]);
  assert.equal(w.model.rows.length, 1);
});

test("what the page shows is read from the database: after a reload the same booking comes back, with the real time and status", async () => {
  const w = wire();
  await book(w, "chat-a");
  const shown = bookingForShopper(await activeBookingForChat(SHOP, "chat-a", w.over));
  assert.equal(shown.startAt, SLOT);
  assert.equal(shown.status, "requested");
  assert.equal(shown.confirmed, false);
  assert.equal(shown.timezone, "Asia/Kolkata");
  assert.equal(shown.callMinutes, 30);
  assert.equal(await activeBookingForChat(SHOP, "chat-b", w.over), null, "another chat has none");
  // the owner moves it: the shopper's window shows the new time, not the one it remembered
  await rescheduleBooking(SHOP, shown.id, { startAt: OTHER, settings: ON }, w.over);
  assert.equal(bookingForShopper(await activeBookingForChat(SHOP, "chat-a", w.over)).startAt, OTHER);
});

test("a cancelled callback is no longer shown as booked, and its time is free again", async () => {
  const w = wire();
  const { booking } = await book(w, "chat-a");
  assert.equal((await cancelOwnBooking(SHOP, String(booking._id), "chat-b", {}, w.over)).status, "not_found", "another shopper cannot cancel it");
  assert.equal((await cancelOwnBooking(SHOP, String(booking._id), "chat-a", { settings: ON }, w.over)).status, "ok");
  assert.equal(await activeBookingForChat(SHOP, "chat-a", w.over), null);
  w.model.rows[0].updatedAt = new Date(Date.parse("2026-11-02T06:00:00Z"));
  assert.equal((await lastClosedBookingForChat(SHOP, "chat-a", w.over)).status, "cancelled");
  assert.equal((await book(w, "chat-b", SLOT, ON, 2)).status, "booked", "the freed time can be booked by someone else");
  assert.equal((await cancelOwnBooking(SHOP, String(booking._id), "chat-a", {}, w.over)).status, "wrong_state", "cancelling twice changes nothing");
});

test("the owner cancelling is shown to the shopper too", async () => {
  const w = wire();
  const { booking } = await book(w, "chat-a");
  await closeBooking(SHOP, String(booking._id), "cancelled", { settings: ON }, w.over);
  assert.equal(await activeBookingForChat(SHOP, "chat-a", w.over), null);
});

test("the shopper moves their own callback: the new time is checked, the old one is freed", async () => {
  const w = wire();
  const { booking } = await book(w, "chat-a");
  await book(w, "chat-b", OTHER, ON, 2);
  assert.equal((await rescheduleOwnBooking(SHOP, String(booking._id), "chat-a", { startAt: OTHER, settings: ON }, w.over)).status, "slot_unavailable", "a taken time is refused");
  assert.equal((await rescheduleOwnBooking(SHOP, String(booking._id), "chat-c", { startAt: asIst("2026-11-03T12:00:00"), settings: ON }, w.over)).status, "not_found", "only the owner of the booking");
  assert.equal((await rescheduleOwnBooking(SHOP, String(booking._id), "chat-a", { startAt: asIst("2026-11-03T10:07:00"), settings: ON }, w.over)).status, "slot_unavailable", "off the grid");
  const moved = await rescheduleOwnBooking(SHOP, String(booking._id), "chat-a", { startAt: asIst("2026-11-03T12:00:00"), settings: ON }, w.over);
  assert.equal(moved.status, "booked");
  assert.equal(new Date(moved.booking.startAt).toISOString(), asIst("2026-11-03T12:00:00"));
  assert.equal((await book(w, "chat-d", SLOT, ON, 4)).status, "booked", "the time it left is free");
});

test("the booking is confirmed on its own; the calendar is a separate fact", async () => {
  // calendar connected and working
  let w = wire();
  let out = await book(w, "chat-a", SLOT, AUTO);
  assert.equal(out.status, "confirmed");
  assert.equal(bookingForShopper(out.booking).calendar, "synced");
  // calendar not connected: the booking is still confirmed, and nothing claims a calendar event
  w = wire({ calendar: fakeCalendar({ configured: false }) });
  out = await book(w, "chat-a", SLOT, AUTO);
  assert.equal(out.status, "confirmed");
  assert.equal(bookingForShopper(out.booking).confirmed, true);
  assert.equal(bookingForShopper(out.booking).calendar, "off");
  // calendar failing: confirmed, and the calendar says it failed (never "synced")
  w = wire({ calendar: fakeCalendar({ fail: "Google is down" }) });
  out = await book(w, "chat-a", SLOT, AUTO);
  assert.equal(out.status, "confirmed");
  assert.equal(bookingForShopper(out.booking).confirmed, true);
  assert.equal(bookingForShopper(out.booking).calendar, "failed");
  assert.equal(w.model.rows.length, 1, "the booking is in the database either way");
});

test("a callback whose time has passed without being closed says so", async () => {
  const w = wire();
  await book(w, "chat-a");
  const row = await activeBookingForChat(SHOP, "chat-a", w.over);
  assert.equal(bookingForShopper(row, Date.parse("2026-11-03T06:30:00Z")).overdue, true, "two hours after the time");
  assert.equal(bookingForShopper(row, Date.parse("2026-11-03T04:00:00Z")).overdue, false, "before the time");
});

void confirmBooking;
