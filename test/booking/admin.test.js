// What the owner's dashboard gets for calls and chats: the inbox chips, the chat with what the shopper saw,
// the notes and resolve action, the "needs you now" counts, and the booking routes (store always from the token).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import { Query } from "mingo";
import * as stats from "../../src/admin/stats.js";
import { attention } from "../../src/admin/attention.js";
import { createAdminRouter } from "../../src/admin/routes.js";
import { requireAdmin, verifySessionToken } from "../../src/admin/auth.js";
import ecommerce from "../../src/industries/ecommerce.js";
import { SHOP as A } from "./helpers.js";

const B = "b-store.myshopify.com";
const oid = () => new mongoose.Types.ObjectId();
const t = (iso) => new Date(iso);
const analytics = ecommerce.analytics;
const opts = { analytics, timezone: "Asia/Kolkata", now: Date.parse("2026-11-02T06:00:00Z") };

function data() {
  const ids = { call: oid(), files: oid(), flag: oid(), ordered: oid(), done: oid(), other: oid() };
  const conv = (shop, id, over = {}) => ({ _id: id, shop, chatRef: String(id), channel: "text", language: "en", startedAt: t("2026-11-01T10:00:00Z"), lastMessageAt: t("2026-11-01T10:05:00Z"), messageCount: 2, status: "open", outcome: "chat", firstMessage: "hi", degradedTurns: 0, customerRef: null, ...over });
  const conversations = [
    conv(A, ids.call, { flags: { callRequested: true, needsFollowUp: true }, firstMessage: "call me about bulk order" }),
    conv(A, ids.files, { fileCount: 2, firstMessage: "see my photos" }),
    conv(A, ids.flag, { status: "needs_human", flags: { needsFollowUp: true, reason: "refund" } }),
    conv(A, ids.ordered, { outcome: "order_placed" }),
    conv(A, ids.done, { status: "resolved", fileCount: 1, flags: { needsFollowUp: true } }),
    conv(B, ids.other, { flags: { callRequested: true, needsFollowUp: true }, fileCount: 3, firstMessage: "store B secret" }),
  ];
  const messages = [
    { _id: oid(), shop: A, conversationId: ids.call, role: "user", text: "call me", at: t("2026-11-01T10:00:00Z"), attachments: [{ id: "f1", name: "a.jpg", kind: "image", mime: "image/jpeg", size: 1 }] },
    { _id: oid(), shop: A, conversationId: ids.call, role: "assistant", text: "Here are options", at: t("2026-11-01T10:00:01Z"), shown: { products: [{ id: "p1", title: "Earbuds", price: "1999.00", currency: "INR" }], actions: [{ type: "call_booked", bookingId: "b1" }] } },
    { _id: oid(), shop: A, conversationId: ids.call, role: "assistant", text: "Plain", at: t("2026-11-01T10:00:02Z") },
  ];
  const bookings = [
    { _id: oid(), shop: A, conversationId: ids.call, personKey: "v1", name: "Riya", email: "r@x.com", phone: "123", status: "requested", startAt: t("2026-11-03T04:30:00Z"), endAt: t("2026-11-03T05:00:00Z"), timezone: "Asia/Kolkata", calendar: { status: "pending" }, emails: { customer: "none", owner: "sent" } },
    { _id: oid(), shop: B, conversationId: ids.other, name: "Secret B", email: "b@x.com", phone: "999", status: "requested", startAt: t("2026-11-03T04:30:00Z"), endAt: t("2026-11-03T05:00:00Z"), timezone: "UTC" },
  ];
  return { ids, conversations, messages, bookings };
}

function models(d) {
  const finder = (docs) => (filter = {}) => {
    let rows = new Query(filter).find(docs).all();
    const c = { sort: () => c, limit: (n) => { rows = rows.slice(0, n); return c; }, lean: async () => rows };
    return c;
  };
  const count = (docs) => async (f) => new Query(f).find(docs).all().length;
  const del = (docs) => async (f) => { const hit = new Query(f).find(docs).all(); hit.forEach((r) => docs.splice(docs.indexOf(r), 1)); return { deletedCount: hit.length }; };
  return {
    Conversation: {
      find: finder(d.conversations), countDocuments: count(d.conversations),
      findOneAndUpdate: async (filter, update) => {
        const c = d.conversations.find((x) => String(x._id) === String(filter._id) && x.shop === filter.shop);
        if (!c) return null;
        Object.assign(c, update.$set || {});
        for (const k of Object.keys(update.$unset || {})) { const [a, b] = k.split("."); if (b) delete c[a]?.[b]; else delete c[a]; }
        for (const [k, v] of Object.entries(update.$set || {})) if (k.includes(".")) { const [a, b] = k.split("."); c[a] = { ...(c[a] || {}), [b]: v }; delete c[k]; }
        return { ...c };
      },
      findOne: (f) => ({ lean: async () => d.conversations.find((x) => String(x._id) === String(f._id) && x.shop === f.shop) || null }),
      updateMany: async () => ({ modifiedCount: 1 }),
    },
    Message: { find: finder(d.messages), deleteMany: del(d.messages) },
    Event: { find: finder([]) },
    Booking: { find: finder(d.bookings), deleteMany: del(d.bookings) },
  };
}

const idsOf = (res) => res.items.map((c) => c.firstMessage).sort();

test("inbox chips: follow-up, calls, files, ordered, resolved, each for this store only", async () => {
  const m = models(data());
  const list = (filter) => stats.listConversations(A, { from: "2026-10-01", to: "2026-11-02", filter }, opts, m);
  assert.equal((await list("follow_up")).items.length, 2, "a call-requested chat and a needs-human chat, not the resolved one");
  assert.deepEqual(idsOf(await list("calls")), ["call me about bulk order"]);
  // without dates, "what needs me" looks at every chat, however old
  const everything = await stats.listConversations(A, { filter: "calls" }, { ...opts, now: Date.parse("2027-06-01T00:00:00Z") }, m);
  assert.equal(everything.items.length, 1);
  assert.deepEqual(idsOf(await list("files")), ["hi", "see my photos"], "every chat with files, also the resolved one");
  assert.equal((await list("ordered")).items.length, 1);
  assert.equal((await list("resolved")).items.length, 1);
  assert.ok(!(await list("calls")).items.some((c) => c.firstMessage.includes("store B")));
  await assert.rejects(list("everything"), /filter is not valid/);
});

test("'waiting on you' and 'with a person' are the two states of the one status each chat shows", async () => {
  const d = data();
  const taken = oid();
  const takenAndFlagged = oid();
  const base = d.conversations[0];
  const extra = (id, over) => ({ ...base, _id: id, chatRef: String(id), flags: {}, ...over });
  d.conversations.push(
    extra(taken, { firstMessage: "a person has this", handoff: { active: true } }),
    extra(takenAndFlagged, { firstMessage: "taken and flagged", handoff: { active: true }, flags: { needsFollowUp: true } }),
  );
  const m = models(d);
  const list = (filter) => stats.listConversations(A, { filter }, opts, m);
  assert.deepEqual(idsOf(await list("waiting")), ["call me about bulk order", "hi"], "a call request or a flag, not resolved, nobody has taken it over (the needs-human chat is also 'hi')");
  assert.deepEqual(idsOf(await list("person")), ["a person has this", "taken and flagged"], "a person has these, flagged or not");
  assert.ok(!(await list("waiting")).items.some((c) => c.firstMessage === "store B secret"), "only this store");
  const out = await attention(A, { Conv: m.Conversation, summary: async () => ({ waiting: 0, upcoming: 0, overdue: 0, next: [] }) });
  assert.deepEqual([out.inbox.waiting, out.inbox.person], [2, 2], "the chip numbers are what each chip lists");
  assert.equal(out.todo, 3, "the to-do count: the call chat, the needs-human chat and the chat with photos, each once; not the resolved or taken-over ones");
  for (const f of ["waiting", "person", "follow_up", "calls", "files", "ordered", "resolved"]) assert.ok(stats.INBOX_FILTERS.includes(f), `the dashboard offers ${f}`);
  const row = (await list("person")).items.find((c) => c.firstMessage === "taken and flagged");
  assert.equal(row.handoff.active, true, "the row carries what the status is worked out from");
});

test("each chat row says what needs the owner", async () => {
  const m = models(data());
  const rows = (await stats.listConversations(A, { from: "2026-10-01", to: "2026-11-02" }, opts, m)).items;
  const call = rows.find((r) => r.firstMessage.startsWith("call me"));
  assert.deepEqual([call.flags.callRequested, call.flags.needsFollowUp, call.flags.hasFiles], [true, true, false]);
  const files = rows.find((r) => r.firstMessage === "see my photos");
  assert.deepEqual([files.flags.hasFiles, files.fileCount], [true, 2]);
  assert.equal(rows.find((r) => r.status === "needs_human").flags.needsFollowUp, true);
});

test("a chat opens with what the shopper saw next to each reply, and its calls", async () => {
  const d = data();
  const open = await stats.getConversation(A, String(d.ids.call), models(d));
  const withCards = open.messages.find((x) => x.shown);
  assert.equal(withCards.shown.products[0].title, "Earbuds");
  assert.equal(withCards.shown.actions[0].type, "call_booked");
  assert.equal(open.messages.find((x) => x.text === "Plain").shown, undefined, "replies with nothing shown stay plain");
  assert.equal(open.messages[0].attachments[0].kind, "image");
  assert.equal(open.bookings.length, 1);
  assert.deepEqual([open.bookings[0].name, open.bookings[0].status, open.bookings[0].calendar.status], ["Riya", "requested", "pending"]);
  assert.ok(!("expiresAt" in open.bookings[0]) && !("activeSlot" in open.bookings[0]), "no internal fields");
  assert.equal(await stats.getConversation(B, String(d.ids.call), models(d)), null);
});

test("resolving clears 'needs follow-up'; a private note can be saved and cleared; another store cannot", async () => {
  const d = data();
  const m = models(d);
  const out = await stats.updateConversation(A, String(d.ids.flag), { status: "resolved" }, m);
  assert.equal(out.status, "resolved");
  assert.equal(out.flags.needsFollowUp, false);
  assert.equal((await stats.updateConversation(A, String(d.ids.call), { note: "  Rang her back, will order Friday  " }, m)).note, "Rang her back, will order Friday");
  assert.equal((await stats.updateConversation(A, String(d.ids.call), { note: "" }, m)).note, "");
  assert.equal(await stats.updateConversation(B, String(d.ids.call), { note: "x" }, m), null);
  await assert.rejects(stats.updateConversation(A, String(d.ids.call), {}, m), /Nothing to change/);
  await assert.rejects(stats.updateConversation(A, String(d.ids.call), { status: "deleted" }, m), /status must be/);
});

test("erasing a person also removes their calls", async () => {
  const d = data();
  const m = models(d);
  const out = await stats.erasePerson(A, `v${d.ids.call}`, m);
  assert.equal(out.bookings, 1);
  assert.deepEqual(d.bookings.map((b) => b.shop), [B], "the other store's call is untouched");
});

test("'needs you now' counts calls waiting, follow-ups and files not yet dealt with, for this store", async () => {
  const d = data();
  const m = models(d);
  const out = await attention(A, { Conv: m.Conversation, summary: async () => ({ waiting: 1, upcoming: 2, overdue: 0, next: d.bookings.filter((b) => b.shop === A) }) });
  assert.deepEqual([out.calls.waiting, out.calls.upcoming, out.followUps, out.files], [1, 2, 2, 1], "resolved chats do not count");
  assert.equal(out.calls.next[0].name, "Riya");
  assert.ok(!JSON.stringify(out).includes("Secret B"));
});

test("the inbox chip numbers are exactly what each chip lists, for this store only", async () => {
  const d = data();
  const m = models(d);
  const out = await attention(A, { Conv: m.Conversation, summary: async () => ({ waiting: 0, upcoming: 0, overdue: 0, next: [] }) });
  const mine = d.conversations.filter((c) => c.shop === A);
  assert.equal(out.inbox.all, mine.length);
  assert.equal(out.inbox.calls, mine.filter((c) => c.flags?.callRequested).length);
  assert.equal(out.inbox.files, mine.filter((c) => c.fileCount > 0).length);
  assert.equal(out.inbox.resolved, mine.filter((c) => c.status === "resolved").length);
  assert.equal(out.inbox.follow_up, out.followUps, "the follow-up chip and the Overview card agree");
  assert.equal(out.inbox.ordered, mine.filter((c) => c.outcome === "order_placed").length);
  const other = await attention(A, { Conv: m.Conversation, orderedOutcome: "something_else", summary: async () => ({ waiting: 0, upcoming: 0, overdue: 0, next: [] }) });
  assert.equal(other.inbox.ordered, 0, "uses the store type's own 'ordered' result");
});

// ---- routes ------------------------------------------------------------------------------------------
const SECRET = "test-secret";
const KEY = "test-client-id";
const NOW = Date.now();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token() {
  const payload = { iss: `https://${A}/admin`, dest: `https://${A}`, aud: KEY, sub: "42", exp: Math.floor(NOW / 1000) + 600, nbf: Math.floor(NOW / 1000) - 5 };
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${body}.${crypto.createHmac("sha256", SECRET).update(body).digest("base64url")}`;
}

async function serve() {
  const calls = [];
  const view = { _id: oid(), shop: A, name: "Riya", email: "r@x.com", phone: "1", status: "confirmed", startAt: t("2026-11-03T04:30:00Z"), endAt: t("2026-11-03T05:00:00Z"), timezone: "Asia/Kolkata" };
  const book = {
    listBookings: async (shop, q) => { calls.push(["list", shop, q]); return [view]; },
    listFreeSlots: async ({ shop }) => { calls.push(["slots", shop]); return { timezone: "Asia/Kolkata", slots: [{ start: "x", local: "y", date: "z" }] }; },
    confirmBooking: async (shop, id) => { calls.push(["confirm", shop, id]); return id === "gone" ? { status: "not_found" } : { status: "ok", booking: view }; },
    rescheduleBooking: async (shop, id, o) => { calls.push(["reschedule", shop, id, o.startAt]); return o.startAt === "taken" ? { status: "slot_unavailable" } : { status: "ok", booking: view }; },
    closeBooking: async (shop, id, status) => { calls.push(["close", shop, id, status]); return status === "bad" ? { status: "invalid" } : id === "closed" ? { status: "wrong_state" } : { status: "ok", booking: { ...view, status } }; },
  };
  const config = { DEFAULT_RETENTION_DAYS: 90, getAgentSettings: async () => ({ booking: { enabled: true } }), invalidateSettings() {}, getSettingsHistory: async () => [] };
  const app = express();
  app.use(express.json());
  app.use("/admin/api", createAdminRouter({
    auth: requireAdmin({ verify: (tk) => verifySessionToken(tk, { now: NOW, secret: SECRET, key: KEY }), active: async (s) => s === A }),
    store: async (shop) => ({ shop, name: "Aria", currency: "INR", timezone: "UTC", industry: "ecommerce" }),
    api: stats, config, book, needsYou: async (shop) => { calls.push(["attention", shop]); return { calls: { waiting: 1 }, followUps: 0, files: 0 }; }, limit: (req, res, next) => next(),
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/admin/api`;
  const call = (path, { method = "GET", body, auth = `Bearer ${token()}` } = {}) =>
    fetch(base + path, { method, headers: { ...(auth ? { Authorization: auth } : {}), "Content-Type": "application/json" }, body: body === undefined || method === "GET" ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  return { call, calls, close: () => server.close() };
}

test("booking routes need a valid token", async () => {
  const s = await serve();
  try {
    for (const [method, path] of [["GET", "/bookings"], ["GET", "/bookings/slots"], ["POST", "/bookings/x/confirm"], ["POST", "/bookings/x/reschedule"], ["POST", "/bookings/x/close"], ["GET", "/attention"]]) {
      assert.equal((await s.call(path, { method, auth: null, body: {} })).status, 401, `${method} ${path}`);
    }
    assert.equal(s.calls.length, 0);
  } finally { s.close(); }
});

test("the store always comes from the token; results hide internal fields", async () => {
  const s = await serve();
  try {
    const list = await s.call(`/bookings?shop=${B}&status=confirmed`);
    assert.equal(list.body.items[0].name, "Riya");
    assert.ok(!("shop" in list.body.items[0]) && !("activeSlot" in list.body.items[0]));
    await s.call(`/bookings/abc/confirm`, { method: "POST", body: { shop: B } });
    await s.call(`/bookings/abc/reschedule`, { method: "POST", body: { shop: B, startAt: "2026-11-04T10:00:00Z" } });
    await s.call(`/bookings/abc/close`, { method: "POST", body: { shop: B, status: "completed" } });
    await s.call("/bookings/slots");
    await s.call("/attention");
    assert.ok(s.calls.every((c) => c[1] === A), JSON.stringify(s.calls));
    assert.deepEqual(s.calls.find((c) => c[0] === "list")[2].status, "confirmed");
  } finally { s.close(); }
});

test("booking actions answer with clear codes: ok 200, unknown 404, closed or taken 409, bad input 400", async () => {
  const s = await serve();
  try {
    assert.equal((await s.call("/bookings/ok/confirm", { method: "POST" })).status, 200);
    assert.equal((await s.call("/bookings/gone/confirm", { method: "POST" })).status, 404);
    assert.equal((await s.call("/bookings/ok/reschedule", { method: "POST", body: { startAt: "taken" } })).status, 409);
    const closed = await s.call("/bookings/closed/close", { method: "POST", body: { status: "completed" } });
    assert.deepEqual([closed.status, closed.body.error], [409, "This call is already closed."]);
    assert.equal((await s.call("/bookings/ok/close", { method: "POST", body: { status: "bad" } })).status, 400);
    assert.equal((await s.call("/bookings/ok/close", { method: "POST", body: { status: "completed" } })).body.booking.status, "completed");
    assert.equal((await s.call("/bookings/slots")).body.slots.length, 1);
    const settings = await s.call("/settings");
    assert.equal(typeof settings.body.options.emailConfigured, "boolean");
    assert.ok("shareWith" in settings.body.options.calendar && settings.body.options.bookingDefaults.slotMinutes === 30);
  } finally { s.close(); }
});
