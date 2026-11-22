// Shared fakes for the booking tests: an in-memory Booking collection (queried with mingo, like the real
// one), a fake calendar and a fake mailer that can be told to fail.
import mongoose from "mongoose";
import { Query } from "mingo";

export const SHOP = "a-store.myshopify.com";
// Monday 2 November 2026, 11:30 in India
export const NOW = Date.parse("2026-11-02T06:00:00Z");

const clone = (v) => {
  if (v instanceof Date) return new Date(v);
  if (v instanceof mongoose.Types.ObjectId) return v;
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
};

const setPath = (obj, path, value) => {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  if (value === undefined) delete o[keys.at(-1)];
  else o[keys.at(-1)] = value;
};

export function fakeBookingModel(seed = []) {
  const rows = seed.map((r) => ({ _id: new mongoose.Types.ObjectId(), ...r }));
  // mongoose turns id strings in a filter into ObjectIds; do the same here
  const cast = (v, key = "") => {
    if (typeof v === "string" && /^[a-f0-9]{24}$/i.test(v) && ["_id", "conversationId"].includes(key)) return new mongoose.Types.ObjectId(v);
    if (Array.isArray(v)) return v.map((x) => cast(x, key));
    if (v && typeof v === "object" && !(v instanceof Date) && !(v instanceof mongoose.Types.ObjectId)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cast(x, k.startsWith("$") ? key : k)]));
    return v;
  };
  const match = (filter) => rows.filter((r) => new Query(cast(filter)).test(r));
  const cursor = (list) => {
    const c = { select: () => c, sort: () => c, limit: () => c, lean: async () => list.map((x) => clone(x)) };
    return c;
  };
  const applyUpdate = (row, update) => {
    for (const [k, v] of Object.entries(update.$set || {})) setPath(row, k, v);
    for (const k of Object.keys(update.$unset || {})) setPath(row, k, undefined);
  };
  return {
    rows,
    async create(doc) {
      if (doc.activeSlot && rows.some((r) => r.activeSlot === doc.activeSlot)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
      const row = { _id: new mongoose.Types.ObjectId(), createdAt: new Date(), ...clone(doc) };
      rows.push(row);
      return { ...row, toObject: () => clone(row) };
    },
    find: (filter) => cursor(match(filter)),
    findOne: (filter) => ({ lean: async () => (match(filter)[0] ? clone(match(filter)[0]) : null) }),
    async findOneAndUpdate(filter, update) {
      const row = match(filter)[0];
      if (!row) return null;
      applyUpdate(row, update);
      return clone(row);
    },
    async updateOne(filter, update) {
      const row = match(filter)[0];
      if (!row) return { modifiedCount: 0 };
      update = { ...update, $set: cast(update.$set || {}) };
      if (update.$set?.activeSlot && rows.some((r) => r !== row && r.activeSlot === update.$set.activeSlot)) throw Object.assign(new Error("E11000"), { code: 11000 });
      applyUpdate(row, update);
      return { modifiedCount: 1 };
    },
    async updateMany(filter, update) {
      const hit = match(filter);
      hit.forEach((r) => applyUpdate(r, { ...update, $set: cast(update.$set || {}) }));
      return { modifiedCount: hit.length };
    },
    async countDocuments(filter) { return match(filter).length; },
    async deleteMany(filter) {
      const hit = match(filter);
      hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
      return { deletedCount: hit.length };
    },
  };
}

export function fakeCalendar({ configured = true, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    configured: () => configured,
    upsertEvent: async (args) => { calls.push(["upsert", args.calendarId, String(args.booking._id)]); if (fail) throw new Error(fail); return { eventId: `evt-${args.booking._id}`, link: "https://calendar.example/e" }; },
    deleteEvent: async (args) => { calls.push(["delete", args.eventId]); },
  };
}

export function fakeMail({ configured = true, failCustomer = false } = {}) {
  const sent = { customer: [], owner: [] };
  return {
    sent,
    configured: () => configured,
    sendCustomerConfirmation: async (a) => { sent.customer.push(a); return failCustomer ? { ok: false, error: "smtp down" } : { ok: true }; },
    sendOwnerAlert: async (a) => { sent.owner.push(a); return { ok: true }; },
  };
}

export const ON = { booking: { enabled: true }, notificationEmail: "owner@store.com" };

export function wire({ model = fakeBookingModel(), calendar = fakeCalendar(), mail = fakeMail(), now = NOW } = {}) {
  return { model, calendar, mail, over: { model, calendar, mail, now: () => now, ownerEmail: async (_s, settings) => settings?.notificationEmail || "" } };
}
