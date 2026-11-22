// The booking tools the AI uses, what a turn leaves behind for the owner (what the shopper saw, flags, files),
// and the Google Calendar and email adapters.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import ecommerce from "../../src/industries/ecommerce.js";
import { recordTurn, newTelemetry } from "../../src/services/conversationLog.js";
import { signAssertion, upsertEvent, deleteEvent, eventFor, loadServiceAccount, clearTokenCache, CalendarError } from "../../src/services/googleCalendar.js";
import { buildIcs, customerEmailContent, ownerEmailContent, sendCustomerConfirmation, sendOwnerAlert, sendChatAlert } from "../../src/services/bookingEmails.js";
import { bookingEnabled } from "../../src/services/bookingSettings.js";
import { SHOP, NOW, ON } from "./helpers.js";

const analytics = ecommerce.analytics;

// ---- the tools ---------------------------------------------------------------------------------------
function session(settings, bookings, context = {}) {
  return ecommerce.createSession(SHOP, { settings, replyLanguage: "en", chatRef: "ref-1", cart: { items: [], currency: "INR" }, ...context }, { bookings });
}
const fakeApi = (over = {}) => ({
  calls: [],
  async listFreeSlots(a) { this.calls.push(["slots", a.shop]); return over.slots || { enabled: true, timezone: "Asia/Kolkata", slotMinutes: 30, slots: [{ start: "2026-11-03T04:30:00.000Z", date: "2026-11-03", local: "Tue, 3 Nov, 10:00 am" }, { start: "2026-11-03T05:00:00.000Z", date: "2026-11-03", local: "Tue, 3 Nov, 10:30 am" }, { start: "2026-11-04T04:30:00.000Z", date: "2026-11-04", local: "Wed, 4 Nov, 10:00 am" }] }; },
  async createBooking(a) { this.calls.push(["book", a.shop, a.chatRef, a.input.slotStart]); return over.book || { status: "booked", booking: { _id: new mongoose.Types.ObjectId(), startAt: new Date("2026-11-03T04:30:00Z"), timezone: "Asia/Kolkata", status: "requested" } }; },
});

test("call tools exist only when the owner has switched booking on", () => {
  assert.deepEqual(ecommerce.admin.inactiveTools({}), ["get_call_slots", "book_call"]);
  assert.deepEqual(ecommerce.admin.inactiveTools(ON), []);
  const names = ecommerce.toolDefinitions.map((t) => t.function.name);
  for (const n of ["get_call_slots", "book_call", "flag_for_owner"]) assert.ok(names.includes(n), n);
  assert.ok(!ecommerce.admin.configurableTools.includes("book_call"), "switched with the booking setting, not the tool list");
  assert.equal(bookingEnabled(ON), true);
});

test("the prompt explains calls and today's date only when booking is on", () => {
  const off = ecommerce.buildSystemPrompt(SHOP, { settings: {}, history: [] });
  const on = ecommerce.buildSystemPrompt(SHOP, { settings: ON, history: [] });
  assert.ok(!off.includes("get_call_slots"));
  assert.ok(on.includes("CALLS WITH THE STORE TEAM") && on.includes("book_call") && /Today is \w+day, \d+ \w+ \d{4} \(Asia\/Kolkata\)/.test(on));
  assert.ok(!/\d{1,2}:\d{2}\s?(am|pm)?\s*\(Asia/i.test(on), "only the date, never the time, so the prompt stays cacheable");
});

test("get_call_slots offers the real free times; a day can be asked for", async () => {
  const api = fakeApi();
  const { handlers } = session(ON, api);
  const all = await handlers.get_call_slots({});
  assert.equal(all.status, "ok");
  assert.equal(all.slots.length, 3);
  assert.deepEqual(Object.keys(all.slots[0]), ["start", "local"]);
  assert.deepEqual((await handlers.get_call_slots({ date: "2026-11-04" })).slots.map((s) => s.local), ["Wed, 4 Nov, 10:00 am"]);
  assert.equal((await handlers.get_call_slots({ date: "2026-12-25" })).status, "no_slots");
  assert.equal((await session({}, api).handlers.get_call_slots({})).status, "disabled");
  assert.ok(api.calls.every((c) => c[1] === SHOP));
});

test("book_call needs the customer's yes, then books for this store and chat and shows the booking", async () => {
  const api = fakeApi();
  const s = session(ON, api);
  const args = { slotStart: "2026-11-03T04:30:00.000Z", name: "Riya", phone: "+919876543210", email: "riya@example.com", topic: "bulk order" };
  assert.equal((await s.handlers.book_call({ ...args, customerConfirmed: false })).status, "need_confirmation");
  assert.equal(api.calls.filter((c) => c[0] === "book").length, 0, "nothing is booked without a yes");
  const out = await s.handlers.book_call({ ...args, customerConfirmed: true });
  assert.equal(out.status, "booked");
  assert.match(out.note, /not say it is final/);
  assert.deepEqual(api.calls.at(-1), ["book", SHOP, "ref-1", "2026-11-03T04:30:00.000Z"]);
  const action = s.result().actions.find((a) => a.type === "call_booked");
  assert.ok(action.bookingId && action.status === "requested");
  assert.ok(!JSON.stringify(action).includes("riya"), "no personal details travel to the browser");
});

test("book_call tells the AI exactly what went wrong", async () => {
  const bad = session(ON, fakeApi({ book: { status: "invalid", problems: [{ field: "phone", reason: "invalid" }] } }));
  const r1 = await bad.handlers.book_call({ slotStart: "x", name: "R", phone: "1", email: "e@x.com", customerConfirmed: true });
  assert.deepEqual([r1.status, r1.problems[0].field], ["invalid", "phone"]);
  const taken = session(ON, fakeApi({ book: { status: "slot_unavailable" } }));
  const r2 = await taken.handlers.book_call({ slotStart: "x", name: "R", phone: "1", email: "e@x.com", customerConfirmed: true });
  assert.match(r2.note, /get_call_slots/);
  assert.equal(taken.result().actions.some((a) => a.type === "call_booked"), false);
  const confirmed = session(ON, fakeApi({ book: { status: "confirmed", booking: { _id: new mongoose.Types.ObjectId(), startAt: new Date("2026-11-03T04:30:00Z"), timezone: "Asia/Kolkata", status: "confirmed" } } }));
  assert.equal((await confirmed.handlers.book_call({ slotStart: "x", name: "R", phone: "1", email: "e@x.com", customerConfirmed: true })).status, "confirmed");
});

test("flag_for_owner marks the chat for the owner", async () => {
  const s = session(ON, fakeApi());
  assert.equal((await s.handlers.flag_for_owner({ reason: "  refund   dispute\n over order #1001 " })).status, "ok");
  assert.deepEqual(s.result().actions.find((a) => a.type === "flag_for_owner"), { type: "flag_for_owner", reason: "refund dispute over order #1001" });
});

// ---- what the owner sees in the chat -----------------------------------------------------------------
test("the transcript keeps what the shopper saw: products, cart, order, call, flag", () => {
  const result = {
    products: [{ id: "p1", title: "Earbuds", handle: "earbuds", image: "https://cdn/e.jpg", price: "1999.00", compareAtPrice: "2999.00", currency: "INR", onlineStoreUrl: "https://s/products/earbuds", inventoryQuantity: 4 }],
    actions: [
      { type: "add_to_cart", title: "Earbuds", quantity: 2 },
      { type: "order_placed", orderId: "#1001", total: 3998, currency: "INR", paymentMethod: "cod", shipping: { address1: "1 Road" } },
      { type: "call_booked", bookingId: "b1", startAt: "2026-11-03T04:30:00.000Z", timezone: "Asia/Kolkata", status: "requested" },
      { type: "flag_for_owner", reason: "refund" },
      { type: "set_shipping_address", address: { address1: "secret street" } },
    ],
  };
  const shown = analytics.shownFromResult(result);
  assert.equal(shown.products[0].url, "https://s/products/earbuds");
  assert.equal(shown.products[0].inStock, true);
  assert.deepEqual(shown.actions.map((a) => a.type), ["add_to_cart", "order_placed", "call_booked", "flag_for_owner"]);
  assert.ok(!JSON.stringify(shown).includes("secret street") && !JSON.stringify(shown).includes("1 Road"), "addresses are never copied");
  assert.deepEqual(analytics.flagsFromResult(result), { callRequested: true, needsFollowUp: true, reason: "refund" });
  assert.deepEqual(analytics.bookingIdsFromResult(result), ["b1"]);
  assert.deepEqual(analytics.flagsFromResult({ actions: [] }), {});
  const types = analytics.eventsFromResult(result).map((e) => e.type);
  assert.ok(types.includes("call_booked") && types.includes("flagged_for_owner"));
  assert.ok(analytics.outcomes.call_booked >= analytics.outcomes.products_shown && analytics.outcomes.call_booked < analytics.outcomes.order_placed);
});

function fakeLog() {
  const convs = [], msgs = [], linked = [];
  return {
    convs, msgs, linked,
    connected: () => true,
    now: () => NOW,
    linkBookings: async (shop, a) => { linked.push([shop, a.ids, String(a.conversationId)]); return a.ids.map((id) => ({ _id: id, name: "Riya", email: "riya@example.com", phone: "+919876543210", personKey: "eHash" })); },
    Conversation: {
      async findOneAndUpdate(filter, update) {
        const c = convs.find((x) => x.shop === filter.shop && x.chatRef === filter.chatRef);
        if (!c) return null;
        for (const [k, v] of Object.entries(update.$set || {})) {
          const keys = k.split(".");
          let o = c;
          for (const part of keys.slice(0, -1)) o = o[part] ??= {};
          o[keys.at(-1)] = v;
        }
        for (const [k, v] of Object.entries(update.$inc || {})) c[k] = (c[k] || 0) + v;
        return { ...c };
      },
      async create(doc) { const c = { _id: new mongoose.Types.ObjectId(), outcomeRank: 0, ...doc }; convs.push(c); return c; },
      async updateOne(filter, update) { const c = convs.find((x) => String(x._id) === String(filter._id)); if (c) for (const [k, v] of Object.entries(update.$set || {})) { const [a, b] = k.split("."); if (b) c[a] = { ...(c[a] || {}), [b]: v }; else c[a] = v; } },
      async updateMany() {},
      async findOne() { return { sort: () => ({ lean: async () => null }) }; },
    },
    Message: { async insertMany(docs) { msgs.push(...docs); } },
    Event: { async insertMany() {} },
  };
}
const turn = (over = {}) => ({
  shop: SHOP, clientId: "client-abcdefghijklmnop", analytics, settings: {}, userMessage: "call me", telemetry: newTelemetry(),
  result: { answer: "Booked.", products: [], actions: [] }, ...over,
});
const withFindOne = (d) => { d.Conversation.findOne = () => ({ sort: () => ({ lean: async () => null }) }); return d; };

test("a turn stores the shown products, flags, file count and links the booking to its chat", async () => {
  const d = withFindOne(fakeLog());
  const result = {
    answer: "Here you go.",
    products: [{ id: "p1", title: "Earbuds", handle: "earbuds", price: "1999.00", currency: "INR" }],
    actions: [{ type: "call_booked", bookingId: "6540f0f0f0f0f0f0f0f0f0f1", startAt: "2026-11-03T04:30:00.000Z", timezone: "Asia/Kolkata", status: "requested" }, { type: "flag_for_owner", reason: "call me on 9876543210" }],
  };
  await recordTurn(turn({ result, attachments: [{ id: "a1", name: "damage.jpg", kind: "image", mime: "image/jpeg", size: 10 }, { id: "a2", name: "clip.mp4", kind: "video", mime: "video/mp4", size: 10 }] }), d);
  const c = d.convs[0];
  assert.deepEqual([c.fileCount, c.flags.callRequested, c.flags.needsFollowUp], [2, true, true]);
  assert.ok(!c.flags.reason.includes("9876543210"), "personal numbers are removed from the reason");
  const assistant = d.msgs.find((m) => m.role === "assistant");
  assert.equal(assistant.shown.products[0].title, "Earbuds");
  assert.deepEqual(assistant.shown.actions.map((a) => a.type), ["call_booked", "flag_for_owner"]);
  assert.equal(d.msgs.find((m) => m.role === "user").attachments.length, 2);
  assert.deepEqual(d.linked, [[SHOP, ["6540f0f0f0f0f0f0f0f0f0f1"], String(c._id)]]);
  // who the shopper is comes from the call they asked for
  assert.deepEqual([c.personKey, c.contact.name, c.contact.email], ["eHash", "Riya", "riya@example.com"]);
});

test("later turns add files and flags to the same chat; turns without them change nothing", async () => {
  const d = withFindOne(fakeLog());
  await recordTurn(turn(), d);
  await recordTurn(turn({ attachments: [{ id: "a1", name: "x.pdf", kind: "pdf", mime: "application/pdf", size: 5 }] }), d);
  await recordTurn(turn({ result: { answer: "ok", actions: [{ type: "flag_for_owner", reason: "angry" }] } }), d);
  assert.equal(d.convs.length, 1);
  assert.deepEqual([d.convs[0].fileCount, d.convs[0].flags?.needsFollowUp, d.convs[0].flags?.callRequested], [1, true, undefined]);
  assert.equal(d.linked.length, 0);
});

test("with transcripts switched off nothing of the talk is kept, but the booking is still tied to the chat", async () => {
  const d = withFindOne(fakeLog());
  const result = { answer: "Booked.", products: [{ id: "p1", title: "Earbuds" }], actions: [{ type: "call_booked", bookingId: "6540f0f0f0f0f0f0f0f0f0f1", startAt: "x", timezone: "y", status: "requested" }] };
  await recordTurn(turn({ result, settings: { logging: { storeTranscripts: false } } }), d);
  assert.equal(d.msgs.length, 0);
  assert.equal(d.linked.length, 1);
});

// ---- Google Calendar ---------------------------------------------------------------------------------
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "bot@proj.iam.gserviceaccount.com", private_key: pem }), GOOGLE_CALENDAR_ID: "default@group.calendar.google.com" };
const booking = { _id: "6540f0f0f0f0f0f0f0f0f0f1", name: "Riya", phone: "+919876543210", email: "riya@example.com", topic: "bulk order", language: "en", startAt: new Date("2026-11-03T04:30:00Z"), endAt: new Date("2026-11-03T05:00:00Z"), timezone: "Asia/Kolkata" };

function googleFake(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body, headers: init.headers });
    const hit = routes.find((r) => r.when(String(url), init));
    const res = hit ? hit.reply(calls.length) : { status: 500, body: {} };
    return { ok: res.status < 300, status: res.status, json: async () => res.body };
  };
  return { calls, fetchImpl };
}
const token = { when: (u) => u.includes("oauth2"), reply: () => ({ status: 200, body: { access_token: "tok", expires_in: 3600 } }) };

test("the service account is read from JSON or base64, and anything else means 'not set up'", () => {
  assert.equal(loadServiceAccount(env).email, "bot@proj.iam.gserviceaccount.com");
  assert.equal(loadServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_JSON).toString("base64") }).email, "bot@proj.iam.gserviceaccount.com");
  assert.equal(loadServiceAccount({}), null);
  assert.equal(loadServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: "{oops" }), null);
  assert.equal(loadServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: "{\"client_email\":\"a@b\"}" }), null);
});

test("the sign-in assertion is a real RS256 signature with the calendar scope", () => {
  const jwt = signAssertion(loadServiceAccount(env), NOW);
  const [h, p, sig] = jwt.split(".");
  assert.ok(crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url")));
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  assert.equal(claims.iss, "bot@proj.iam.gserviceaccount.com");
  assert.equal(claims.scope, "https://www.googleapis.com/auth/calendar.events");
  assert.equal(claims.exp - claims.iat, 3600);
});

test("a confirmed call becomes one event in the store's own calendar, with a stable id", async () => {
  clearTokenCache();
  const g = googleFake([token, { when: (u, i) => i.method === "PUT", reply: () => ({ status: 404, body: {} }) }, { when: (u, i) => i.method === "POST" && u.includes("/events"), reply: () => ({ status: 200, body: { id: "b6540f0f0f0f0f0f0f0f0f0f1", htmlLink: "https://calendar.google.com/e" } }) }]);
  const out = await upsertEvent({ calendarId: "owner@store.com", booking, shopName: "Aria" }, { fetchImpl: g.fetchImpl, now: () => NOW, env });
  assert.deepEqual(out, { eventId: "b6540f0f0f0f0f0f0f0f0f0f1", link: "https://calendar.google.com/e" });
  const post = g.calls.find((c) => c.method === "POST" && c.url.includes("/events"));
  assert.ok(post.url.includes(encodeURIComponent("owner@store.com")), "the store's calendar, not the server default");
  assert.equal(post.headers.Authorization, "Bearer tok");
  const body = JSON.parse(post.body);
  assert.equal(body.id, "b6540f0f0f0f0f0f0f0f0f0f1");
  assert.deepEqual([body.start.timeZone, body.start.dateTime], ["Asia/Kolkata", "2026-11-03T04:30:00.000Z"]);
  assert.match(body.description, /Phone: \+919876543210/);
  // a second event for the same booking updates the same id (a retry cannot double-book the calendar)
  const again = googleFake([token, { when: (u, i) => i.method === "PUT", reply: () => ({ status: 200, body: { id: "b6540f0f0f0f0f0f0f0f0f0f1" } }) }]);
  await upsertEvent({ booking: { ...booking, calendar: { eventId: "b6540f0f0f0f0f0f0f0f0f0f1" } } }, { fetchImpl: again.fetchImpl, now: () => NOW, env });
  assert.ok(!again.calls.some((c) => c.method === "POST" && c.url.includes("/events")));
  assert.ok(again.calls.find((c) => c.method === "PUT").url.includes(encodeURIComponent("default@group.calendar.google.com")), "falls back to the server default calendar");
});

test("calendar problems are reported clearly and never include secrets", async () => {
  clearTokenCache();
  const denied = googleFake([token, { when: (u, i) => i.method === "PUT", reply: () => ({ status: 403, body: { error: { message: "Forbidden: share the calendar with the service account" } } }) }]);
  await assert.rejects(upsertEvent({ calendarId: "c", booking }, { fetchImpl: denied.fetchImpl, now: () => NOW, env }), (e) => e instanceof CalendarError && e.status === 403 && /share the calendar/.test(e.message) && !e.message.includes("PRIVATE KEY"));
  clearTokenCache();
  const noAuth = googleFake([{ when: (u) => u.includes("oauth2"), reply: () => ({ status: 400, body: { error: "invalid_grant" } }) }]);
  await assert.rejects(upsertEvent({ calendarId: "c", booking }, { fetchImpl: noAuth.fetchImpl, now: () => NOW, env }), /sign-in failed/);
  await assert.rejects(upsertEvent({ calendarId: "c", booking }, { fetchImpl: noAuth.fetchImpl, env: {} }), /not set up/);
  await assert.rejects(upsertEvent({ booking }, { fetchImpl: noAuth.fetchImpl, env: { GOOGLE_SERVICE_ACCOUNT_JSON: env.GOOGLE_SERVICE_ACCOUNT_JSON } }), /No Google Calendar ID/);
  assert.match(eventFor(booking).summary, /^Call: Riya/);
});

test("cancelling removes the event, and an event that is already gone is fine", async () => {
  clearTokenCache();
  const gone = googleFake([token, { when: (u, i) => i.method === "DELETE", reply: () => ({ status: 410, body: {} }) }]);
  assert.equal(await deleteEvent({ calendarId: "c", eventId: "e1" }, { fetchImpl: gone.fetchImpl, now: () => NOW, env }), true);
  assert.equal(await deleteEvent({ calendarId: "c", eventId: "" }, { fetchImpl: gone.fetchImpl, env }), false);
});

// ---- the emails --------------------------------------------------------------------------------------
test("the shopper's email names the time in the store's zone, in their language, with a calendar file", async () => {
  const en = customerEmailContent({ booking, shopName: "Aria" });
  assert.match(en.subject, /confirmed.*Tue, 3 Nov, 10:00/i);
  assert.match(en.text, /Aria is confirmed.*Asia\/Kolkata/);
  const hi = customerEmailContent({ booking: { ...booking, language: "hinglish", name: "Riya" }, shopName: "Aria" });
  assert.match(hi.subject, /confirm ho gayi/);
  const html = customerEmailContent({ booking: { ...booking, name: "<script>x</script>" }, shopName: "Aria" }).html;
  assert.ok(!html.includes("<script>"), "names are escaped");
  const sent = [];
  const ok = await sendCustomerConfirmation({ booking, shopName: "Aria" }, { send: async (m) => { sent.push(m); return { ok: true }; }, now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(sent[0].to, "riya@example.com");
  const ics = sent[0].attachments[0].content;
  assert.match(ics, /BEGIN:VCALENDAR[\s\S]*DTSTART:20261103T043000Z[\s\S]*DTEND:20261103T050000Z[\s\S]*END:VCALENDAR/);
  assert.ok(ics.includes("\r\n") && ics.includes(`UID:${booking._id}@orbi-booking`));
  assert.equal((await sendCustomerConfirmation({ booking, shopName: "A" }, { send: async () => { throw new Error("smtp"); } })).ok, false, "a mail failure never throws");
});

test("the owner's email says whether the call needs their OK", async () => {
  assert.match(ownerEmailContent({ booking, shopName: "Aria" }).subject, /New call request: Riya/);
  assert.match(ownerEmailContent({ booking, shopName: "Aria", confirmed: true }).subject, /New call booked/);
  assert.equal((await sendOwnerAlert({ booking, to: "" }, { send: async () => assert.fail("no address") })).ok, false);
  assert.equal(buildIcs({ booking: { ...booking, topic: "a, b; c" }, shopName: "S,x", now: NOW }).includes("SUMMARY:Call from S\\,x"), true);
  // RFC 5545: a semicolon in text is written as "\;" (it used to come out bare)
  assert.ok(buildIcs({ booking: { ...booking, topic: "a, b; c" }, now: NOW }).includes("DESCRIPTION:About: a\\, b\\; c"));
});

// ---- telling the owner once ---------------------------------------------------------------------------
function alertDb() {
  const d = withFindOne(fakeLog());
  const claimed = new Set();
  const alerts = [];
  const plainUpdate = d.Conversation.updateOne;
  d.Conversation.updateOne = async (filter, update) => {
    const field = Object.keys(update.$set || {}).find((k) => k.startsWith("flags.alerted"));
    if (!field) return plainUpdate(filter, update);
    const key = `${filter._id}|${field}`;
    if (claimed.has(key)) return { modifiedCount: 0 };
    claimed.add(key);
    return { modifiedCount: 1 };
  };
  d.ownerEmail = async () => "owner@store.com";
  d.alert = async (a) => { alerts.push(a); return { ok: true }; };
  return { d, alerts };
}
const files = [{ id: "a1", name: "damage.jpg", kind: "image", mime: "image/jpeg", size: 10 }];

test("the owner is emailed once when files arrive and once when the agent asks for a person", async () => {
  const { d, alerts } = alertDb();
  await recordTurn(turn({ attachments: files }), d);
  await recordTurn(turn({ attachments: files }), d);
  assert.deepEqual(alerts.map((a) => [a.kind, a.fileCount]), [["files", 1]], "the second photo in the same chat sends nothing");
  const ask = { answer: "ok", actions: [{ type: "flag_for_owner", reason: "refund, call 9876543210" }] };
  await recordTurn(turn({ result: ask }), d);
  await recordTurn(turn({ result: ask }), d);
  assert.deepEqual(alerts.map((a) => a.kind), ["files", "follow_up"]);
  assert.ok(!alerts[1].reason.includes("9876543210"));
});

test("alerts the owner switched off, or with nobody to send to, are not sent; a booked call is not a 'needs a person' alert", async () => {
  const off = alertDb();
  await recordTurn(turn({ attachments: files, settings: { alerts: { onFiles: false } } }), off.d);
  assert.equal(off.alerts.length, 0);
  const call = alertDb();
  await recordTurn(turn({ result: { answer: "Booked", actions: [{ type: "call_booked", bookingId: "6540f0f0f0f0f0f0f0f0f0f1", startAt: "x", timezone: "y", status: "requested" }] } }), call.d);
  assert.equal(call.alerts.length, 0, "the booking has its own email");
  const nobody = alertDb();
  nobody.d.ownerEmail = async () => "";
  await recordTurn(turn({ attachments: files }), nobody.d);
  assert.equal(nobody.alerts.length, 0);
  nobody.d.alert = async () => { throw new Error("smtp"); };
  nobody.d.ownerEmail = async () => "owner@store.com";
  await assert.doesNotReject(recordTurn(turn({ attachments: [...files, { ...files[0], id: "a2" }], settings: {} }), nobody.d), "a mail failure never breaks the log");
});

test("the alert email says what happened and where to look", async () => {
  const sent = [];
  const send = async (m) => { sent.push(m); return { ok: true }; };
  await sendChatAlert({ kind: "files", to: "o@s.com", shopName: "Aria", fileCount: 2 }, { send });
  await sendChatAlert({ kind: "follow_up", to: "o@s.com", shopName: "Aria", reason: "refund dispute" }, { send });
  assert.match(sent[0].subject, /2 files/);
  assert.match(sent[1].text, /Why: refund dispute/);
  assert.match(sent[1].text, /go to Chats to see it/);
  assert.equal((await sendChatAlert({ kind: "files", to: "" }, { send })).ok, false);
});
