// What the store owner's dashboard reads. Every function takes the store first and puts it in EVERY
// query, so one store can never see another's data. Which events count as revenue, the funnel and the
// top lists come from the industry's `analytics` block; nothing here is industry specific.
import mongoose from "mongoose";
import Conversation from "../models/Conversation.js";
import Message from "../models/Message.js";
import Event from "../models/Event.js";
import Booking from "../models/Booking.js";
import SupportCall from "../models/SupportCall.js";
import SupportRecording from "../models/SupportRecording.js";
import Complaint from "../models/Complaint.js";
import { callCountsForPeople, customerCalls } from "./callAnalytics.js";
import { callView } from "../services/supportService.js";
import { PERSON_KEY_EXPR, personFilter } from "../services/people.js";
import { CASE_STATUSES, CASE_TYPES } from "../services/visitorMemory.js";

const models = { Conversation, Message, Event, Booking, SupportCall, SupportRecording, Complaint };
const DAY_MS = 86400_000;
export const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ["open", "resolved", "needs_human"];
const CHANNELS = ["text", "voice"];
export const INBOX_FILTERS = ["waiting", "person", "follow_up", "calls", "files", "ordered", "resolved", "human", "human_waiting", "human_live", "ai"];

/**
 * The dashboard shows ONE status per chat (waiting on you / with a person / AI handling / resolved). These are the same
 * states as database conditions, so the chips, the counts and the status on each row always agree.
 * A person who has taken over a chat is "with a person", even when the chat is also flagged.
 */
export const STATE_CLAUSES = {
  waiting: [
    { status: { $ne: "resolved" } },
    { "handoff.active": { $ne: true } },
    { $or: [{ status: "needs_human" }, { "flags.needsFollowUp": true }, { "flags.callRequested": true }] },
  ],
  person: [{ status: { $ne: "resolved" } }, { "handoff.active": true }],
  // nobody needs to look at it: the AI has it
  ai: [{ status: { $nin: ["resolved", "needs_human"] } }, { "handoff.active": { $ne: true } }, { "flags.needsFollowUp": { $ne: true } }, { "flags.callRequested": { $ne: true } }],
};
/** Every chat that needs the owner, counted once: waiting on them, a call asked for, or files nobody has looked at yet. */
export const TODO_CLAUSES = [
  { status: { $ne: "resolved" } },
  { "handoff.active": { $ne: true } },
  { $or: [{ status: "needs_human" }, { "flags.needsFollowUp": true }, { "flags.callRequested": true }, { fileCount: { $gt: 0 } }] },
];

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
    this.status = 400;
  }
}

// ---- dates in the store's own time zone --------------------------------------------------------
export function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return String(tz);
  } catch {
    return "UTC";
  }
}

function offsetMs(ts, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ts));
  const o = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  return Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, o.second) - Math.floor(ts / 1000) * 1000;
}

/** The instant a calendar day starts in a time zone. */
export function startOfLocalDay(ymd, tz) {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(first, tz);
  return second;
}

function localYmd(ts, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
  return parts;
}

export const nextYmd = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

/**
 * `from` and `to` are calendar days (YYYY-MM-DD, both included) in the store's time zone. Without
 * them: the last 30 days up to today.
 */
export function parseRange({ from, to } = {}, tz = "UTC", now = Date.now()) {
  tz = validTimezone(tz);
  const today = localYmd(now, tz);
  const end = to ?? today;
  const start = from ?? new Date(Date.parse(`${end}T00:00:00Z`) - (DEFAULT_RANGE_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  if (!YMD.test(String(start)) || !YMD.test(String(end)) || Number.isNaN(Date.parse(`${start}T00:00:00Z`)) || Number.isNaN(Date.parse(`${end}T00:00:00Z`))) {
    throw new InputError("from and to must be dates like 2026-10-30.");
  }
  if (start > end) throw new InputError("from must not be after to.");
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) throw new InputError(`The range can be at most ${MAX_RANGE_DAYS} days.`);
  return { from: start, to: end, days, timezone: tz, start: new Date(startOfLocalDay(start, tz)), end: new Date(startOfLocalDay(nextYmd(end), tz)) };
}

function eventFilter(shop, range, query = {}) {
  const match = { shop, at: { $gte: range.start, $lt: range.end } };
  if (query.channel !== undefined && query.channel !== "") {
    if (!CHANNELS.includes(query.channel)) throw new InputError("channel must be text or voice.");
    match.channel = query.channel;
  }
  if (query.language !== undefined && query.language !== "") {
    if (!/^[a-z-]{2,16}$/i.test(String(query.language))) throw new InputError("language is not valid.");
    match.language = String(query.language).toLowerCase();
  }
  return match;
}

// A field path, or a list of paths where the first one that is set wins (e.g. the store-currency amount, else the chat's).
import { moneyExpr, moneyOfProps, pickPrimary, COUNTED_ORDER, notCountedOrder } from "./money.js";
const get = (path) => (Array.isArray(path) ? path.reduceRight((rest, p) => (rest === null ? `$${p}` : { $ifNull: [`$${p}`, rest] }), null) : `$${path}`);

// ---- overview ------------------------------------------------------------------------------------
export async function overview(shop, query = {}, { analytics = {}, timezone = "UTC", currency = "", now = Date.now() } = {}, m = models) {
  const range = parseRange(query, timezone, now);
  const rev = analytics.revenue || null;
  const match = eventFilter(shop, range, query);
  // an order Shopify reported as cancelled, or refunded in full, is neither an order nor revenue (one rule, see money.js)
  if (rev) match.$nor = [notCountedOrder(rev.event)];
  const money = rev ? moneyExpr(rev) : null;
  const funnel = analytics.funnel || [];
  const dayOf = { $dateToString: { format: "%Y-%m-%d", date: "$at", timezone: range.timezone } };

  const dropoffDefs = rev ? analytics.dropoffs || [] : [];
  const [byType, byDay, funnelRows, visitors, channels, busy, dropRows, sourceRows, paymentRows, needsHuman, ...rankings] = await Promise.all([
    m.Event.aggregate([
      { $match: match },
      { $group: { _id: { type: "$type", currency: money ? money.currency : null }, count: { $sum: 1 }, amount: { $sum: money ? money.amount : 0 }, ms: { $sum: "$props.ms" }, tokensIn: { $sum: "$props.tokensIn" }, tokensCached: { $sum: "$props.tokensCached" }, tokensOut: { $sum: "$props.tokensOut" }, degraded: { $sum: { $cond: ["$props.degraded", 1, 0] } } } },
    ]),
    m.Event.aggregate([
      { $match: { ...match, type: { $in: ["conversation_started", "turn", ...(rev ? [rev.event] : [])] } } },
      { $group: { _id: { day: dayOf, type: "$type", currency: money ? money.currency : null }, count: { $sum: 1 }, amount: { $sum: money ? money.amount : 0 } } },
    ]),
    funnel.length
      ? m.Event.aggregate([
          { $match: { ...match, type: { $in: funnel }, conversationId: { $ne: null } } },
          { $group: { _id: { type: "$type", c: "$conversationId" } } },
          { $group: { _id: "$_id.type", conversations: { $sum: 1 } } },
        ])
      : [],
    m.Event.aggregate([{ $match: { ...match, type: "turn", chatRef: { $ne: null } } }, { $group: { _id: "$chatRef" } }, { $count: "n" }]),
    m.Event.aggregate([{ $match: { ...match, type: "conversation_started" } }, { $group: { _id: "$channel", n: { $sum: 1 } } }]),
    m.Event.aggregate([
      { $match: { ...match, type: "conversation_started" } },
      { $group: { _id: { dow: { $isoDayOfWeek: { date: "$at", timezone: range.timezone } }, hour: { $hour: { date: "$at", timezone: range.timezone } } }, count: { $sum: 1 } } },
    ]),
    // per chat: did it reach each step, and did it end in an order? Then count the ones that did not.
    dropoffDefs.length
      ? m.Event.aggregate([
          { $match: { ...match, type: { $in: [rev.event, ...dropoffDefs.map((d) => d.reached)] }, conversationId: { $ne: null } } },
          { $group: { _id: "$conversationId", ...Object.fromEntries([rev.event, ...dropoffDefs.map((d) => d.reached)].map((type, i) => [`s${i}`, { $max: { $cond: [{ $eq: ["$type", type] }, 1, 0] } }])) } },
          { $group: { _id: null, ...Object.fromEntries(dropoffDefs.map((d, i) => [d.key, { $sum: { $cond: [{ $and: [{ $eq: [`$s${i + 1}`, 1] }, { $eq: ["$s0", 0] }] }, 1, 0] } }])) } },
        ])
      : [],
    // who placed each order (e.g. the agent in the chat, or the shopper later on the site)
    rev?.source
      ? m.Event.aggregate([{ $match: { ...match, type: rev.event } }, { $group: { _id: get(rev.source), n: { $sum: 1 } } }])
      : [],
    // how each order was paid (e.g. cash on delivery or online)
    rev?.payment
      ? m.Event.aggregate([{ $match: { ...match, type: rev.event } }, { $group: { _id: get(rev.payment), n: { $sum: 1 } } }])
      : [],
    // chats the store owner marked "needs follow-up" that were active in this period
    m.Conversation.countDocuments({ shop, status: "needs_human", lastMessageAt: { $gte: range.start, $lt: range.end } }),
    ...(analytics.rankings || []).map((r) =>
      m.Event.aggregate([
        { $match: { ...match, type: r.event } },
        ...(r.list ? [{ $unwind: get(r.list) }] : []),
        { $group: { _id: r.list ? `$${r.list}.${r.field}` : get(r.field), count: { $sum: 1 } } },
        { $match: { _id: { $nin: [null, ""] } } },
        { $sort: { count: -1, _id: 1 } },
        { $limit: 10 },
      ])
    ),
  ]);

  const count = (type) => byType.filter((r) => r._id.type === type).reduce((n, r) => n + r.count, 0);
  const turns = byType.filter((r) => r._id.type === "turn");
  const sum = (key) => turns.reduce((n, r) => n + (r[key] || 0), 0);
  const turnCount = count("turn");
  const degraded = sum("degraded");

  const revenueByCurrency = {};
  let orders = 0;
  if (rev) {
    for (const r of byType.filter((x) => x._id.type === rev.event)) {
      orders += r.count;
      const code = r._id.currency || currency || "";
      revenueByCurrency[code] = (revenueByCurrency[code] || 0) + r.amount;
    }
  }
  const primary = pickPrimary(revenueByCurrency, currency);
  const revenue = Math.round((revenueByCurrency[primary] || 0) * 100) / 100;
  const otherRevenue = Object.entries(revenueByCurrency).filter(([code, v]) => code !== primary && v > 0).map(([code, v]) => ({ currency: code, amount: Math.round(v * 100) / 100 }));
  const ordersInPrimary = rev ? byType.filter((x) => x._id.type === rev.event && (x._id.currency || currency || "") === primary).reduce((n, r) => n + r.count, 0) : 0;

  const funnelCounts = Object.fromEntries(funnelRows.map((r) => [r._id, r.conversations]));
  const started = count("conversation_started");

  // one row per calendar day, including days with nothing
  const perDay = new Map();
  for (const r of byDay) {
    const row = perDay.get(r._id.day) || { conversations: 0, messages: 0, orders: 0, revenue: 0 };
    if (r._id.type === "conversation_started") row.conversations += r.count;
    else if (r._id.type === "turn") row.messages += r.count;
    else if (rev && r._id.type === rev.event) {
      row.orders += r.count;
      if ((r._id.currency || currency || "") === primary) row.revenue += r.amount;
    }
    perDay.set(r._id.day, row);
  }
  const series = [];
  for (let day = range.from; day <= range.to; day = nextYmd(day)) {
    const row = perDay.get(day) || { conversations: 0, messages: 0, orders: 0, revenue: 0 };
    series.push({ date: day, ...row, revenue: Math.round(row.revenue * 100) / 100 });
  }

  const lists = {};
  (analytics.rankings || []).forEach((r, i) => {
    lists[r.key] = rankings[i].map((x) => ({ name: x._id, count: x.count }));
  });

  return {
    range: { from: range.from, to: range.to, days: range.days, timezone: range.timezone },
    totals: {
      conversations: started,
      visitors: visitors[0]?.n || 0,
      messages: turnCount,
      orders,
      revenue: { currency: primary, amount: revenue },
      revenueByCurrency,
      otherRevenue,
      averageOrderValue: ordersInPrimary ? Math.round((revenue / ordersInPrimary) * 100) / 100 : 0,
      needsFollowUp: needsHuman || 0,
      ordersBySource: Object.fromEntries(sourceRows.map((r) => [r._id || "unknown", r.n])),
      ordersByPayment: Object.fromEntries(paymentRows.map((r) => [r._id || "unknown", r.n])),
      dropoffs: Object.fromEntries(dropoffDefs.map((d) => [d.key, dropRows[0]?.[d.key] || 0])),
      conversionRate: started ? Math.min(1, Math.round(((funnelCounts[rev?.event] ?? 0) / started) * 1000) / 1000) : 0,
      averageResponseMs: turnCount ? Math.round(sum("ms") / turnCount) : 0,
      failedReplies: degraded,
      tokens: { in: sum("tokensIn"), cached: sum("tokensCached"), out: sum("tokensOut") },
      channels: Object.fromEntries(CHANNELS.map((c) => [c, channels.find((x) => x._id === c)?.n || 0])),
    },
    series,
    funnel: funnel.map((stage) => ({ stage, conversations: stage === "conversation_started" ? Math.max(started, funnelCounts[stage] || 0) : funnelCounts[stage] || 0 })),
    top: lists,
    busiest: busy.map((b) => ({ weekday: b._id.dow, hour: b._id.hour, conversations: b.count })).sort((a, b) => b.conversations - a.conversations).slice(0, 168),
  };
}

// ---- conversations -------------------------------------------------------------------------------
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clampLimit = (value, fallback = 25) => Math.min(100, Math.max(1, Math.floor(Number(value)) || fallback));

function encodeCursor(time, id) {
  return Buffer.from(JSON.stringify({ t: new Date(time).getTime(), id: String(id) })).toString("base64url");
}
function decodeCursor(cursor) {
  try {
    const c = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (Number.isFinite(c.t) && mongoose.isValidObjectId(c.id)) return { t: new Date(c.t), id: c.id };
  } catch { /* falls through */ }
  throw new InputError("cursor is not valid.");
}

const keyOfConversation = (c) => c.personKey || (c.customerRef ? `c${c.customerRef}` : `v${c.chatRef}`);

// Chats saved before read-tracking existed count as read: only activity after this date can be unread.
export const UNREAD_SINCE = new Date("2026-11-08T00:00:00Z");
export const UNREAD_CLAUSE = { $expr: { $gt: ["$lastMessageAt", { $ifNull: ["$ownerReadAt", UNREAD_SINCE] }] } };

function conversationSummary(c) {
  return {
    id: String(c._id),
    startedAt: c.startedAt,
    lastMessageAt: c.lastMessageAt,
    messageCount: c.messageCount,
    channel: c.channel,
    language: c.language,
    outcome: c.outcome,
    status: c.status,
    firstMessage: c.firstMessage,
    failedReplies: c.degradedTurns || 0,
    clearedByCustomer: Boolean(c.clearedAt),
    verifiedCustomer: Boolean(c.customerRef),
    personKey: keyOfConversation(c),
    contact: { name: c.contact?.name || "", email: c.contact?.email || "", phone: c.contact?.phone || "" },
    flags: { callRequested: Boolean(c.flags?.callRequested), needsFollowUp: Boolean(c.flags?.needsFollowUp) || c.status === "needs_human", hasFiles: (c.fileCount || 0) > 0, reason: c.flags?.reason || "" },
    fileCount: c.fileCount || 0,
    unread: new Date(c.lastMessageAt) > new Date(c.ownerReadAt || UNREAD_SINCE),
    handoff: { active: Boolean(c.handoff?.active), at: c.handoff?.at || null },
    support: c.support?.callId ? { status: c.support.status || "", callId: String(c.support.callId), at: c.support.at || null } : null,
    note: c.ownerNote || "",
    case: c.case?.type || c.case?.status ? { type: c.case.type || "other", status: c.case.status || "received", note: c.case.note || "", updatedAt: c.case.updatedAt || null, updatedBy: c.case.updatedBy || "" } : null,
  };
}

// ---- the list behind a number ------------------------------------------------------------------
// Each card on the dashboard names the chats it counted as a `metric`. This turns that name back into the
// chats, from the same events and the same period the number came from, so the list always adds up.
const ID_CAP = 5000;
const EVENT_NAME = /^[a-z_]{1,40}$/;

async function conversationIdsFor(shop, metric, range, query, analytics, m) {
  const match = { ...eventFilter(shop, range, query), conversationId: { $ne: null } };
  if (analytics.revenue) match.$nor = [notCountedOrder(analytics.revenue.event)];
  const idsOf = async (extra) => (await m.Event.aggregate([{ $match: { ...match, ...extra } }, { $group: { _id: "$conversationId" } }, { $limit: ID_CAP }])).map((r) => r._id);
  if (metric === "started") return idsOf({ type: "conversation_started" });
  if (metric === "failed") return idsOf({ type: "turn", "props.degraded": true });
  if (metric.startsWith("reached:")) {
    const type = metric.slice("reached:".length);
    if (!EVENT_NAME.test(type)) throw new InputError("metric is not valid.");
    return idsOf({ type });
  }
  if (metric.startsWith("dropoff:")) {
    const def = (analytics.dropoffs || []).find((d) => d.key === metric.slice("dropoff:".length));
    if (!def || !analytics.revenue) throw new InputError("metric is not valid.");
    const [reached, ordered] = await Promise.all([idsOf({ type: def.reached }), idsOf({ type: analytics.revenue.event })]);
    const done = new Set(ordered.map(String));
    return reached.filter((id) => !done.has(String(id)));
  }
  if (metric.startsWith("top:")) {
    const [, key, ...rest] = metric.split(":");
    const name = rest.join(":");
    const def = (analytics.rankings || []).find((r) => r.key === key);
    if (!def || !name || name.length > 120) throw new InputError("metric is not valid.");
    const fields = [].concat(def.field);
    const byField = fields.map((f) => (def.list ? { [def.list]: { $elemMatch: { [f]: name } } } : { [f]: name }));
    return idsOf({ type: def.event, $or: byField });
  }
  throw new InputError("metric is not valid.");
}

export async function listConversations(shop, query = {}, { timezone = "UTC", now = Date.now(), analytics = {} } = {}, m = models) {
  const range = parseRange(query, timezone, now);
  const filter = { shop, lastMessageAt: { $gte: range.start, $lt: range.end } };
  const metric = String(query.metric || "");
  if (metric === "needs_follow_up") {
    filter.$or = [{ status: "needs_human" }, { "flags.needsFollowUp": true }];
    filter.status = { $ne: "resolved" };
  } else if (metric && metric !== "active") {
    // the chats a card counted: they are picked by what happened in them, whenever the last message was
    const ids = await conversationIdsFor(shop, metric, range, query, analytics, m);
    if (ids.length === 0) return { items: [], nextCursor: null, total: 0 };
    delete filter.lastMessageAt;
    filter._id = { $in: ids };
  }
  if (query.person) {
    const own = personFilter(shop, String(query.person));
    if (!own) throw new InputError("person is not valid.");
    delete filter.lastMessageAt;
    filter.$and = [own];
  }
  if (query.channel) {
    if (!CHANNELS.includes(query.channel)) throw new InputError("channel must be text or voice.");
    filter.channel = query.channel;
  }
  if (query.status) {
    if (!STATUSES.includes(query.status)) throw new InputError("status is not valid.");
    filter.status = query.status;
  }
  // the inbox chips: what needs the owner, or how a chat ended
  if (query.filter) {
    const f = String(query.filter);
    if (!INBOX_FILTERS.includes(f)) throw new InputError("filter is not valid.");
    // "what needs me" is not a period: without dates it looks at every chat, however old the last message
    if (!query.from && !query.to && !metric) delete filter.lastMessageAt;
    if (STATE_CLAUSES[f]) {
      filter.$and = [...(filter.$and || []), ...STATE_CLAUSES[f]];
    } else if (f === "follow_up") {
      filter.$and = [...(filter.$and || []), { $or: [{ status: "needs_human" }, { "flags.needsFollowUp": true }] }];
      filter.status = { $ne: "resolved" };
    } else if (f === "human") filter["support.callId"] = { $exists: true };
    else if (f === "human_waiting") filter["support.status"] = "requested";
    else if (f === "human_live") filter["support.status"] = { $in: ["accepted", "connected"] };
    else if (f === "calls") filter["flags.callRequested"] = true;
    else if (f === "files") filter.fileCount = { $gt: 0 };
    else if (f === "ordered") filter.outcome = analytics.revenue?.event || "order_placed";
    else if (f === "resolved") filter.status = "resolved";
  }
  if (query.outcome) {
    if (!/^[a-z_]{1,40}$/.test(String(query.outcome))) throw new InputError("outcome is not valid.");
    filter.outcome = String(query.outcome);
  }
  if (query.language) {
    if (!/^[a-z-]{2,16}$/i.test(String(query.language))) throw new InputError("language is not valid.");
    filter.language = String(query.language).toLowerCase();
  }
  const text = String(query.q || "").trim().slice(0, 80);
  if (text) {
    const rx = { $regex: escapeRegex(text), $options: "i" };
    filter.$and = [...(filter.$and || []), { $or: [{ firstMessage: rx }, { "contact.name": rx }, { "contact.email": rx }, { "contact.phone": rx }] }];
  }
  // ONE row per person: a shopper who came back on another day (a new chat each time) or used voice and text is still one
  // person, shown once with their latest chat. A card's own list and one person's list (query.person) stay chat by chat.
  if (!query.person && !(metric && metric !== "active") && typeof m.Conversation.aggregate === "function") {
    const skip = readOffset(query.cursor);
    const limit = clampLimit(query.limit);
    const byPerson = [{ $match: filter }, { $sort: { lastMessageAt: -1, _id: -1 } }, { $group: { _id: PERSON_KEY_EXPR, doc: { $first: "$$ROOT" }, chats: { $sum: 1 } } }];
    const [rows, count] = await Promise.all([
      m.Conversation.aggregate([...byPerson, { $sort: { "doc.lastMessageAt": -1, "doc._id": -1 } }, { $skip: skip }, { $limit: limit + 1 }]),
      query.cursor ? [] : m.Conversation.aggregate([...byPerson, { $count: "n" }]),
    ]);
    return {
      items: rows.slice(0, limit).map((g) => ({ ...conversationSummary(g.doc), chatCount: g.chats })),
      nextCursor: rows.length > limit ? offsetCursor(skip + limit) : null,
      ...(query.cursor ? {} : { total: count[0]?.n || 0 }),
    };
  }
  const total = query.cursor ? undefined : await m.Conversation.countDocuments(filter);
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    const after = [{ lastMessageAt: { $lt: c.t } }, { lastMessageAt: c.t, _id: { $lt: c.id } }];
    filter.$and = [...(filter.$and || []), { $or: after }];
  }
  const limit = clampLimit(query.limit);
  const rows = await m.Conversation.find(filter).sort({ lastMessageAt: -1, _id: -1 }).limit(limit + 1).lean();
  const page = rows.slice(0, limit);
  return {
    items: page.map(conversationSummary),
    nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].lastMessageAt, page[page.length - 1]._id) : null,
    ...(total !== undefined ? { total } : {}),
  };
}

function checkedId(id) {
  if (!mongoose.isValidObjectId(id) || String(id).length !== 24) throw new InputError("id is not valid.");
  return String(id);
}

/** One conversation with its transcript and what happened in it. Null when it is not this store's. */
export async function getConversation(shop, id, m = models) {
  const asked = await m.Conversation.findOne({ _id: checkedId(id), shop }).lean();
  if (!asked) return null;
  // One thread per person: every chat this person has had (other days, voice and text) is read as one conversation, and the
  // controls act on the latest of them.
  const own = personFilter(shop, keyOfConversation(asked));
  let all = [asked];
  if (own && typeof m.Conversation.aggregate === "function") all = await m.Conversation.find(own).sort({ lastMessageAt: -1, _id: -1 }).limit(200).lean();
  const siblings = all.length ? all : [asked];
  const conversation = siblings[0];
  const ids = siblings.map((c) => c._id);
  const refs = [...new Set(siblings.map((c) => c.chatRef).filter(Boolean))];
  // a long history shows its LATEST part: newest first from the database, read oldest first
  const order = siblings.length > 1 ? -1 : 1;
  const [newest, events, bookings, calls] = await Promise.all([
    m.Message.find({ shop, conversationId: { $in: ids } }).sort({ at: order }).limit(500).lean(),
    m.Event.find({ shop, conversationId: { $in: ids }, type: { $ne: "turn" } }).sort({ at: order }).limit(200).lean(),
    m.Booking ? m.Booking.find({ shop, conversationId: { $in: ids } }).sort({ startAt: 1 }).limit(20).lean() : [],
    m.SupportCall ? m.SupportCall.find({ shop, $or: [{ conversationId: { $in: ids } }, { chatRef: { $in: refs } }] }).sort({ requestedAt: -1 }).limit(20).lean() : [],
  ]);
  const messages = order === -1 ? newest.reverse() : newest;
  if (order === -1) events.reverse();
  return {
    conversation: { ...conversationSummary(conversation), chatCount: siblings.length },
    messages: messages.map((x) => ({
      role: x.role, text: x.text, at: x.at, failed: Boolean(x.degraded),
      ...(x.attachments?.length ? { attachments: x.attachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind, mime: a.mime, size: a.size })) } : {}),
      ...(x.shown?.products?.length || x.shown?.actions?.length ? { shown: { products: x.shown.products || [], actions: x.shown.actions || [] } } : {}),
      ...(x.call?.callId ? { call: { callId: x.call.callId, status: x.call.status, durationSec: x.call.durationSec || 0, recording: Boolean(x.call.recording) } } : {}),
    })),
    events: events.map((x) => ({ type: x.type, at: x.at, props: x.props || {} })),
    bookings: bookings.map(bookingView),
    calls: calls.map(callView),
  };
}

/** A booking as the dashboard shows it (no internal fields). */
export function bookingView(b) {
  return {
    id: String(b._id), conversationId: b.conversationId ? String(b.conversationId) : null, personKey: b.personKey || null,
    name: b.name || "", email: b.email, phone: b.phone, topic: b.topic || "", language: b.language || "",
    status: b.status, startAt: b.startAt, endAt: b.endAt, timezone: b.timezone, createdAt: b.createdAt, confirmedAt: b.confirmedAt || null,
    note: b.ownerNote || "",
    calendar: { status: b.calendar?.status || "pending", link: b.calendar?.link || "", error: b.calendar?.error || "" },
    emails: { customer: b.emails?.customer || "none", owner: b.emails?.owner || "none" },
  };
}

/** Changes the status (resolving also clears "needs follow-up") and/or the owner's private note. */
/** The owner opened this person's chats: everything up to now is read. */
export async function markConversationRead(shop, id, m = models) {
  const chat = await m.Conversation.findOne({ _id: checkedId(id), shop }).lean();
  if (!chat) return false;
  const key = keyOfConversation(chat);
  const filter = personFilter(shop, key) || { _id: chat._id, shop };
  await m.Conversation.updateMany(filter, { $set: { ownerReadAt: new Date() } });
  return true;
}

export async function updateConversation(shop, id, { status, note, case: supportCase, by = "" } = {}, m = models) {
  const set = {};
  const unset = {};
  if (supportCase !== undefined) {
    // the store's own record of a refund / exchange / return; the shopper's agent reads it and words it
    if (supportCase === null) unset.case = "";
    else {
      const type = String(supportCase.type ?? "");
      const state = String(supportCase.status ?? "");
      if (!CASE_TYPES.includes(type)) throw new InputError(`type must be one of ${CASE_TYPES.join(", ")}.`);
      if (!CASE_STATUSES.includes(state)) throw new InputError(`status must be one of ${CASE_STATUSES.join(", ")}.`);
      const text = String(supportCase.note ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 400);
      set.case = { type, status: state, note: text, updatedAt: new Date(), updatedBy: String(by || "").slice(0, 80) };
    }
  }
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw new InputError("status must be open, resolved or needs_human.");
    set.status = status;
    if (status === "resolved") { unset["flags.needsFollowUp"] = ""; unset.handoff = ""; } // closing a chat gives it back to the AI
    if (status === "needs_human") set["flags.needsFollowUp"] = true;
  }
  if (note !== undefined) {
    const text = String(note ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 1000);
    if (text) set.ownerNote = text;
    else unset.ownerNote = "";
  }
  if (!Object.keys(set).length && !Object.keys(unset).length) throw new InputError("Nothing to change.");
  const updated = await m.Conversation.findOneAndUpdate({ _id: checkedId(id), shop }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true, lean: true });
  return updated ? conversationSummary(updated) : null;
}

export const setConversationStatus = (shop, id, status, m = models) => updateConversation(shop, id, { status }, m);

// ---- orders --------------------------------------------------------------------------------------
const WORD = /^[a-z0-9_,-]{1,60}$/i;

export async function listOrders(shop, query = {}, { analytics = {}, timezone = "UTC", now = Date.now() } = {}, m = models) {
  const rev = analytics.revenue;
  if (!rev) return { items: [], nextCursor: null, total: 0 };
  const range = parseRange(query, timezone, now);
  const filter = { shop, type: rev.event, at: { $gte: range.start, $lt: range.end } };
  // narrow the list the way the cards on the page describe it (placed by the agent, paid online, one chat...)
  if (query.source) {
    if (!WORD.test(String(query.source))) throw new InputError("source is not valid.");
    filter["props.source"] = String(query.source);
  }
  if (query.payment) {
    if (!WORD.test(String(query.payment))) throw new InputError("payment is not valid.");
    filter["props.paymentMethod"] = String(query.payment);
  }
  if (query.conversation) filter.conversationId = new mongoose.Types.ObjectId(checkedId(query.conversation));
  if (query.person) {
    // one customer's orders: the orders from any of their chats
    const own = personFilter(shop, String(query.person));
    if (!own) throw new InputError("person is not valid.");
    const chats = await m.Conversation.find(own).lean();
    if (!chats.length) return { items: [], nextCursor: null, total: 0 };
    filter.conversationId = { $in: chats.map((c) => c._id) };
  }
  const text = String(query.q || "").trim().slice(0, 40);
  if (text) {
    // an order number, or whoever ordered: the name, email or phone they gave in the chat
    const like = { $regex: escapeRegex(text), $options: "i" };
    const either = [{ "props.orderName": like }];
    const people = await m.Conversation.find({ shop, $or: [{ "contact.name": like }, { "contact.email": like }, { "contact.phone": like }] }).limit(200).lean();
    if (people.length) either.push({ conversationId: { $in: people.map((c) => c._id) } });
    filter.$and = [{ $or: either }];
  }
  const total = query.cursor ? undefined : await m.Event.countDocuments(filter);
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    filter.$or = [{ at: { $lt: c.t } }, { at: c.t, _id: { $lt: c.id } }];
  }
  const limit = clampLimit(query.limit);
  const rows = await m.Event.find(filter).sort({ at: -1, _id: -1 }).limit(limit + 1).lean();
  const page = rows.slice(0, limit);
  // who ordered: the name and email the shopper gave in that chat
  const ids = [...new Set(page.map((e) => e.conversationId).filter(Boolean).map(String))];
  const chats = ids.length ? await m.Conversation.find({ shop, _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } }).lean() : [];
  const byId = new Map(chats.map((c) => [String(c._id), c]));
  return {
    items: page.map((e) => {
      const chat = e.conversationId ? byId.get(String(e.conversationId)) : null;
      return {
        at: e.at,
        conversationId: e.conversationId ? String(e.conversationId) : null,
        ...e.props,
        customer: chat ? { personKey: keyOfConversation(chat), name: chat.contact?.name || "", email: chat.contact?.email || "", phone: chat.contact?.phone || "" } : null,
      };
    }),
    nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].at, page[page.length - 1]._id) : null,
    ...(total !== undefined ? { total } : {}),
  };
}

// ---- customers -----------------------------------------------------------------------------------
// A "customer" is a person who chatted: a signed-in Shopify customer, a guest who gave an email at
// checkout, or one anonymous visitor (see services/people.js). Everything is limited to this store.
const CUSTOMER_TYPES = ["customer", "guest"];
const SORTS = ["recent", "chats", "spend"];
const SPEND_PAGE_CAP = 5000;

function offsetCursor(skip) {
  return Buffer.from(JSON.stringify({ skip })).toString("base64url");
}
function readOffset(cursor) {
  if (!cursor) return 0;
  try {
    const skip = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8")).skip;
    if (Number.isInteger(skip) && skip >= 0 && skip < 1_000_000) return skip;
  } catch { /* falls through */ }
  throw new InputError("cursor is not valid.");
}

/** What each person ordered in the period: orders and spend per currency, from the revenue events. */
async function ordersByPerson(shop, range, analytics, m, chatsFilter = {}) {
  const rev = analytics.revenue;
  const totals = new Map();
  if (!rev) return totals;
  const money = moneyExpr(rev);
  const rows = await m.Event.aggregate([
    { $match: { shop, type: rev.event, at: { $gte: range.start, $lt: range.end }, conversationId: { $ne: null }, ...COUNTED_ORDER, ...chatsFilter } },
    { $group: { _id: { c: "$conversationId", currency: money.currency }, orders: { $sum: 1 }, amount: { $sum: money.amount }, last: { $max: "$at" } } },
    { $limit: SPEND_PAGE_CAP },
  ]);
  if (!rows.length) return totals;
  const chats = await m.Conversation.find({ shop, _id: { $in: [...new Set(rows.map((r) => r._id.c))] } }).lean();
  const keyOf = new Map(chats.map((c) => [String(c._id), keyOfConversation(c)]));
  for (const r of rows) {
    const key = keyOf.get(String(r._id.c));
    if (!key) continue;
    const row = totals.get(key) || { orders: 0, byCurrency: {}, lastOrderAt: null };
    row.orders += r.orders;
    const code = r._id.currency || "";
    row.byCurrency[code] = Math.round(((row.byCurrency[code] || 0) + r.amount) * 100) / 100;
    if (!row.lastOrderAt || r.last > row.lastOrderAt) row.lastOrderAt = r.last;
    totals.set(key, row);
  }
  return totals;
}

// amounts with no currency of their own are in the store's currency
const withStoreCurrency = (byCurrency = {}, store = "") => Object.entries(byCurrency).reduce((o, [code, v]) => ({ ...o, [code || store]: Math.round(((o[code || store] || 0) + v) * 100) / 100 }), {});
const spendCurrency = (row, store) => (row ? pickPrimary(withStoreCurrency(row.byCurrency, store), store) : store);
const spendIn = (row, store) => (row ? withStoreCurrency(row.byCurrency, store)[spendCurrency(row, store)] || 0 : 0);
// rank -> outcome name (when two outcomes share a rank, the first one listed is used)
const rankNames = (outcomes = {}) => {
  const names = {};
  for (const [name, rank] of Object.entries(outcomes)) if (!(rank in names)) names[rank] = name;
  return names;
};

function personRow(g, spend, { currency, outcomes }) {
  const orders = spend?.orders || 0;
  return {
    id: g._id,
    kind: g.loggedIn ? "customer" : g.email ? "guest" : "visitor",
    // How sure we are who this is. Only a Shopify sign-in is proof; a typed email is not, and a visitor is only "this browser".
    identity: g.loggedIn ? "shopify" : g.email ? "guest_unverified_email" : "visitor_browser",
    name: g.name || "",
    email: g.email || "",
    phone: g.phone || "",
    chats: g.chats,
    messages: g.messages,
    voiceChats: g.voice || 0,
    firstSeen: g.firstSeen,
    lastSeen: g.lastSeen,
    needsFollowUp: (g.needsHuman || 0) > 0,
    callRequested: (g.calls || 0) > 0,
    fileCount: g.files || 0,
    bestOutcome: outcomes[g.bestRank] || "",
    orders,
    spend: { currency: spendCurrency(spend, currency), amount: spendIn(spend, currency) },
    spendByCurrency: spend ? withStoreCurrency(spend.byCurrency, currency) : {},
  };
}

const groupStage = {
  $group: {
    _id: PERSON_KEY_EXPR,
    chats: { $sum: 1 },
    messages: { $sum: "$messageCount" },
    voice: { $sum: { $cond: [{ $eq: ["$channel", "voice"] }, 1, 0] } },
    needsHuman: { $sum: { $cond: [{ $and: [{ $ne: ["$status", "resolved"] }, { $or: [{ $eq: ["$status", "needs_human"] }, { $eq: ["$flags.needsFollowUp", true] }] }] }, 1, 0] } },
    calls: { $sum: { $cond: [{ $eq: ["$flags.callRequested", true] }, 1, 0] } },
    files: { $sum: { $ifNull: ["$fileCount", 0] } },
    firstSeen: { $min: "$startedAt" },
    lastSeen: { $max: "$lastMessageAt" },
    name: { $max: "$contact.name" },
    email: { $max: "$contact.email" },
    phone: { $max: "$contact.phone" },
    bestRank: { $max: "$outcomeRank" },
    loggedIn: { $max: { $cond: [{ $ne: [{ $ifNull: ["$customerRef", null] }, null] }, 1, 0] } },
  },
};

export async function listCustomers(shop, query = {}, { analytics = {}, timezone = "UTC", currency = "", now = Date.now() } = {}, m = models) {
  const range = parseRange(query, timezone, now);
  const type = String(query.type || "");
  if (type && !CUSTOMER_TYPES.includes(type)) throw new InputError("type must be customer or guest.");
  const sort = String(query.sort || "recent");
  if (!SORTS.includes(sort)) throw new InputError("sort is not valid.");
  const skip = readOffset(query.cursor);
  const limit = clampLimit(query.limit);
  const match = { shop, lastMessageAt: { $gte: range.start, $lt: range.end } };
  const text = String(query.q || "").trim().slice(0, 80);
  if (text) {
    const rx = { $regex: escapeRegex(text), $options: "i" };
    match.$or = [{ "contact.name": rx }, { "contact.email": rx }, { "contact.phone": rx }];
  }
  // "customer" = signed in to Shopify; "guest" = everyone else (including visitors who gave no email)
  const typeStage = type ? [{ $match: { loggedIn: type === "customer" ? 1 : 0 } }] : [];
  const spend = await ordersByPerson(shop, range, analytics, m);
  const names = rankNames(analytics.outcomes);
  const ctx = { currency, outcomes: names };

  let groups;
  if (sort === "spend") {
    // only people who ordered, biggest spenders first
    const keys = [...spend.entries()].sort((a, b) => spendIn(b[1], currency) - spendIn(a[1], currency) || b[1].orders - a[1].orders).map(([k]) => k);
    groups = keys.length ? await m.Conversation.aggregate([{ $match: match }, groupStage, { $match: { _id: { $in: keys } } }, ...typeStage]) : [];
    const rank = new Map(keys.map((k, i) => [k, i]));
    groups.sort((a, b) => rank.get(a._id) - rank.get(b._id));
  } else {
    groups = await m.Conversation.aggregate([{ $match: match }, groupStage, ...typeStage, { $sort: sort === "chats" ? { chats: -1, lastSeen: -1, _id: 1 } : { lastSeen: -1, _id: 1 } }]);
  }
  const page = groups.slice(skip, skip + limit);
  const callCounts = await callCountsForPeople(shop, page.map((g) => g._id), m).catch(() => new Map());
  return {
    items: page.map((g) => ({ ...personRow(g, spend.get(g._id), ctx), humanCalls: callCounts.get(g._id)?.calls || 0, completedCalls: callCounts.get(g._id)?.completed || 0, aiVoiceSessions: callCounts.get(g._id)?.voiceSessions || 0 })),
    nextCursor: groups.length > skip + limit ? offsetCursor(skip + limit) : null,
    ...(query.cursor ? {} : { total: groups.length }),
  };
}

/** One person with their chats and orders (everything the agent still holds about them). */
export async function getCustomer(shop, key, { analytics = {}, currency = "" } = {}, m = models) {
  const own = personFilter(shop, key);
  if (!own) throw new InputError("id is not valid.");
  const chats = await m.Conversation.find(own).sort({ lastMessageAt: -1 }).limit(100).lean();
  if (!chats.length) return null;
  const [group] = await m.Conversation.aggregate([{ $match: own }, groupStage]);
  const rev = analytics.revenue;
  const ids = chats.map((c) => c._id);
  const orderEvents = rev ? await m.Event.find({ shop, type: rev.event, ...COUNTED_ORDER, conversationId: { $in: ids } }).sort({ at: -1 }).limit(100).lean() : [];
  const spend = { orders: 0, byCurrency: {}, lastOrderAt: null };
  for (const e of orderEvents) {
    const { amount, currency: code } = moneyOfProps(rev, e.props);
    spend.orders += 1;
    spend.byCurrency[code] = Math.round(((spend.byCurrency[code] || 0) + amount) * 100) / 100;
    if (!spend.lastOrderAt || e.at > spend.lastOrderAt) spend.lastOrderAt = e.at;
  }
  const person = personRow({ ...group, _id: key }, spend, { currency, outcomes: rankNames(analytics.outcomes) });
  const chatRefs = [...new Set(chats.map((c) => c.chatRef).filter(Boolean))];
  const [calls, complaints, bookings] = await Promise.all([
    customerCalls(shop, { key, chatIds: ids, chatRefs }, m).catch(() => null),
    m.Complaint ? m.Complaint.find({ shop, $or: [{ conversationId: { $in: ids } }, { chatRef: { $in: chatRefs } }] }).sort({ createdAt: -1 }).limit(50).lean().catch(() => []) : [],
    m.Booking ? m.Booking.find({ shop, $or: [{ personKey: key }, { conversationId: { $in: ids } }] }).sort({ startAt: -1 }).limit(50).lean().catch(() => []) : [],
  ]);
  return {
    person: { ...person, ...(calls ? { humanCalls: calls.human.total, completedCalls: calls.human.completed, aiVoiceSessions: calls.ai.sessions } : {}) },
    conversations: chats.map(conversationSummary),
    orders: orderEvents.map((e) => ({ at: e.at, conversationId: e.conversationId ? String(e.conversationId) : null, ...e.props })),
    // human calls (who took each one), AI voice sessions, and how many separate pieces of support this was; a callback is not a call
    calls,
    complaints: complaints.map((c) => ({ id: String(c._id), reference: c.reference, status: c.status, summary: c.summary || "", orderNumber: c.orderNumber || "", email: c.email?.status || "none", handoff: c.handoff?.status || "none", createdAt: c.createdAt, open: Boolean(c.open) })),
    callbacks: bookings.map(bookingView),
  };
}

/**
 * The store owner erases one person's personal data (a customer asked, or the owner decided to). Their
 * transcripts, name, email and phone are removed. The counts (that a chat happened, that an order was
 * placed) stay, because they hold nothing about who it was.
 */
export async function erasePerson(shop, key, m = models) {
  const own = personFilter(shop, key);
  if (!own) throw new InputError("id is not valid.");
  const chats = await m.Conversation.find(own).lean();
  if (!chats.length) return null;
  const ids = chats.map((c) => c._id);
  const messages = (await m.Message.deleteMany({ shop, conversationId: { $in: ids } })).deletedCount || 0;
  const bookings = m.Booking ? (await m.Booking.deleteMany({ shop, $or: [{ conversationId: { $in: ids } }, { personKey: key }] })).deletedCount || 0 : 0;
  const cleared = await m.Conversation.updateMany({ shop, _id: { $in: ids } }, { $set: { firstMessage: "" }, $unset: { contact: "", customerRef: "", personKey: "", ownerNote: "" } });
  const support = await erasePersonCalls(shop, key, ids, [...new Set(chats.map((c) => c.chatRef).filter(Boolean))], m);
  return { conversations: cleared?.modifiedCount ?? ids.length, messages, bookings, ...support };
}

/**
 * The calls part of erasing a person: the shopper's name, contact and reason leave the call records, their recordings are
 * deleted, their complaints are deleted, and the short call/voice events lose the link to them. What stays is that a call
 * happened, who of the team took it and how long it was: nothing about who the shopper was.
 */
async function erasePersonCalls(shop, key, conversationIds, chatRefs, m) {
  const empty = { calls: 0, recordings: 0, complaints: 0, events: 0 };
  if (!m.SupportCall) return empty;
  // A browser's id is only used to find a visitor's own records: a signed-in customer or a guest may share a browser with
  // someone else, so for them only what is tied to their chats or their key is touched.
  const byBrowser = key.startsWith("v");
  const ors = [{ personKey: key }, { conversationId: { $in: conversationIds } }, ...(byBrowser ? [{ chatRef: { $in: chatRefs }, personKey: { $exists: false } }] : [])];
  if (key.startsWith("c")) ors.push({ "customer.customerId": key.slice(1) });
  const calls = await m.SupportCall.find({ shop, $or: ors }).select("_id").lean();
  const callIds = calls.map((c) => c._id);
  let recordings = 0;
  if (callIds.length && m.SupportRecording) {
    // audio kept in the database goes now; audio in object storage is removed by the clean-up job (deleteAfter is now)
    recordings = (await m.SupportRecording.deleteMany({ shop, callId: { $in: callIds }, storage: { $ne: "s3" } })).deletedCount || 0;
    const later = await m.SupportRecording.updateMany({ shop, callId: { $in: callIds }, storage: "s3" }, { $set: { deleteAfter: new Date() } });
    recordings += later?.modifiedCount || 0;
  }
  if (callIds.length) {
    await m.SupportCall.updateMany({ shop, _id: { $in: callIds } }, { $set: { reason: "", "recording.status": "none" }, $unset: { customer: "", personKey: "", "recording.recordingId": "" } });
  }
  const complaints = m.Complaint ? (await m.Complaint.deleteMany({ shop, $or: [{ conversationId: { $in: conversationIds } }, ...(byBrowser ? [{ chatRef: { $in: chatRefs } }] : [])] })).deletedCount || 0 : 0;
  const events = await m.Event.updateMany({ shop, type: { $in: ["support_call_closed", "ai_voice_session"] }, $or: [{ "props.personKey": key }, { conversationId: { $in: conversationIds } }, ...(byBrowser ? [{ chatRef: { $in: chatRefs } }] : [])] }, { $unset: { "props.personKey": "", chatRef: "", conversationId: "" } });
  return { calls: callIds.length, recordings, complaints, events: events?.modifiedCount || 0 };
}
