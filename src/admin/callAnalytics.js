// Call numbers for the dashboard, counted from the real call records (never estimated).
//
//   human call      one SupportCall: a shopper asked for a person. Its outcome is one of
//                   pending (asked, nobody answered yet, still waiting), live (talking now), completed (connected and ended),
//                   missed (nobody answered in time, or nobody was free), failed (the audio could not be set up),
//                   cancelled (the shopper gave up first). Pending and cancelled are never "missed".
//   AI voice        one `ai_voice_session` event (the shopper talked to the assistant by voice).
//   callback        a Booking. It is a request for a call later, so it is NOT counted here.
//   interaction     one piece of support the shopper really got: an AI voice session, or a human call that connected. When the
//                   assistant passed a voice session to a person, that session and the call are ONE interaction.
//
// Detailed history comes from SupportCall, which is kept for the store's retention period. Longer-term counts come from the
// `support_call_closed` events (kept longer, no personal data). The answer says which is which, so a range that reaches back
// past the detailed records is never presented as complete.
import Event from "../models/Event.js";
import SupportCall from "../models/SupportCall.js";
import { callView } from "../services/supportService.js";

const models = { Event, SupportCall };
const OUTCOMES = ["pending", "live", "completed", "missed", "failed", "cancelled"];
const DAY_MS = 86_400_000;
const MAX_ROWS = 50_000;

export class CallInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "CallInputError";
    this.status = 400;
  }
}

/** The outcome of one call, in the words above. */
export function outcomeOf(call, now = Date.now()) {
  switch (call.status) {
    case "ended": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "unanswered": return "missed";
    case "connected": return "live";
    case "accepted": return "pending";
    case "requested": return new Date(call.expiresAt).getTime() <= now ? "missed" : "pending";
    default: return "pending";
  }
}

const outcomeExpr = (now) => ({
  $switch: {
    branches: [
      { case: { $eq: ["$status", "ended"] }, then: "completed" },
      { case: { $eq: ["$status", "failed"] }, then: "failed" },
      { case: { $eq: ["$status", "cancelled"] }, then: "cancelled" },
      { case: { $eq: ["$status", "unanswered"] }, then: "missed" },
      { case: { $eq: ["$status", "connected"] }, then: "live" },
      { case: { $and: [{ $eq: ["$status", "requested"] }, { $lte: ["$expiresAt", new Date(now)] }] }, then: "missed" },
    ],
    default: "pending",
  },
});

/** Who the call belongs to, also for calls saved before `personKey` existed. */
const PERSON_EXPR = { $ifNull: ["$personKey", { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$customer.customerId", ""] } }, 0] }, { $concat: ["c", "$customer.customerId"] }, { $concat: ["v", "$chatRef"] }] }] };
/** Who had it: the new field, else the person who took it (older calls). */
const HANDLER_ID_EXPR = { $ifNull: ["$handledBy.id", "$representative.id"] };
const HANDLER_NAME_EXPR = { $ifNull: ["$handledBy.name", "$representative.name"] };

const emptyCounts = () => ({ total: 0, pending: 0, live: 0, completed: 0, missed: 0, failed: 0, cancelled: 0, totalDurationSec: 0, avgDurationSec: 0 });

function foldCounts(rows) {
  const out = emptyCounts();
  for (const r of rows) {
    out.total += r.count;
    if (r._id in out) out[r._id] += r.count;
    if (r._id === "completed") out.totalDurationSec += r.duration || 0;
  }
  out.avgDurationSec = out.completed ? Math.round(out.totalDurationSec / out.completed) : 0;
  return out;
}

const countStage = (now) => [{ $addFields: { outcome: outcomeExpr(now) } }, { $group: { _id: "$outcome", count: { $sum: 1 }, duration: { $sum: { $ifNull: ["$durationSec", 0] } } } }];

/** The interaction key of each thing that counts as support (see the top of this file). */
function interactionKeys({ calls, voice }) {
  const keys = new Set();
  for (const c of calls) if (c.connectedAt) keys.add(`call:${c._id}`);
  for (const v of voice) keys.add(v.props?.handedOff && v.props?.handedOffCallId ? `call:${v.props.handedOffCallId}` : `voice:${v.props?.sessionId || v._id}`);
  return keys;
}

/** Store-wide, employee-wise and customer-wise numbers for a date range (a range parsed by stats.parseRange). */
export async function storeCallAnalytics(shop, range, { now = Date.now(), retentionDays = 90, timezone = "UTC" } = {}, m = models) {
  const match = { shop, requestedAt: { $gte: range.start, $lt: range.end } };
  const voiceMatch = { shop, type: "ai_voice_session", at: { $gte: range.start, $lt: range.end } };
  const retainedSince = new Date(now - retentionDays * DAY_MS);
  const [byOutcome, trend, employees, customers, recent, voiceRows, connectedCalls, closedEvents] = await Promise.all([
    m.SupportCall.aggregate([{ $match: match }, ...countStage(now)]),
    m.SupportCall.aggregate([
      { $match: match },
      { $addFields: { outcome: outcomeExpr(now), day: { $dateToString: { format: "%Y-%m-%d", date: "$requestedAt", timezone } } } },
      { $group: { _id: { day: "$day", outcome: "$outcome" }, count: { $sum: 1 } } },
    ]),
    m.SupportCall.aggregate([
      { $match: { ...match, $or: [{ "handledBy.id": { $exists: true } }, { "representative.id": { $exists: true } }] } },
      { $addFields: { outcome: outcomeExpr(now), handler: HANDLER_ID_EXPR, handlerName: HANDLER_NAME_EXPR } },
      { $sort: { requestedAt: 1 } },
      { $group: { _id: "$handler", name: { $last: "$handlerName" }, taken: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ["$outcome", "completed"] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ["$outcome", "failed"] }, 1, 0] } }, droppedBeforeTalking: { $sum: { $cond: [{ $eq: ["$outcome", "cancelled"] }, 1, 0] } }, totalDurationSec: { $sum: { $cond: [{ $eq: ["$outcome", "completed"] }, { $ifNull: ["$durationSec", 0] }, 0] } }, lastCallAt: { $max: "$requestedAt" } } },
      { $sort: { taken: -1, _id: 1 } },
      { $limit: 100 },
    ]),
    m.SupportCall.aggregate([
      { $match: match },
      { $addFields: { person: PERSON_EXPR } },
      { $sort: { requestedAt: 1 } },
      { $group: { _id: "$person", calls: { $sum: 1 }, name: { $last: "$customer.name" }, lastCallAt: { $max: "$requestedAt" } } },
      { $sort: { calls: -1, lastCallAt: -1, _id: 1 } },
      { $limit: 10 },
    ]),
    m.SupportCall.find(match).sort({ requestedAt: -1 }).limit(10).lean(),
    m.Event.find(voiceMatch).select("props at").limit(MAX_ROWS).lean(),
    m.SupportCall.find({ ...match, connectedAt: { $exists: true } }).select("_id connectedAt").limit(MAX_ROWS).lean(),
    // longer-term counts, only worth reading when the range goes back past the detailed records
    range.start < retainedSince
      ? m.Event.aggregate([{ $match: { shop, type: "support_call_closed", at: { $gte: range.start, $lt: range.end } } }, { $group: { _id: "$props.status", count: { $sum: 1 }, duration: { $sum: { $ifNull: ["$props.durationSec", 0] } } } }])
      : Promise.resolve(null),
  ]);

  const human = foldCounts(byOutcome);
  const days = new Map();
  for (const t of trend) {
    const row = days.get(t._id.day) || { day: t._id.day, ...Object.fromEntries(OUTCOMES.map((o) => [o, 0])), total: 0 };
    row[t._id.outcome] += t.count;
    row.total += t.count;
    days.set(t._id.day, row);
  }
  const aiSessions = voiceRows.length;
  const aiHandedOff = voiceRows.filter((v) => v.props?.handedOff).length;
  const interactions = interactionKeys({ calls: connectedCalls, voice: voiceRows }).size;

  let longTerm = null;
  if (closedEvents) {
    const mapped = closedEvents.map((e) => ({ _id: { ended: "completed", unanswered: "missed", failed: "failed", cancelled: "cancelled" }[e._id] || "pending", count: e.count, duration: e.duration }));
    longTerm = { ...foldCounts(mapped), source: "events" };
  }
  return {
    range: { from: range.from, to: range.to },
    human,
    ai: { sessions: aiSessions, handedToPerson: aiHandedOff, totalDurationSec: voiceRows.reduce((n, v) => n + (v.props?.durationSec || 0), 0) },
    // one piece of support counted once, even when the assistant passed it to a person
    interactions,
    trend: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
    employees: employees.map((e) => ({ id: e._id, name: e.name || "", taken: e.taken, completed: e.completed, failed: e.failed, droppedBeforeTalking: e.droppedBeforeTalking, totalDurationSec: e.totalDurationSec, avgDurationSec: e.completed ? Math.round(e.totalDurationSec / e.completed) : 0, lastCallAt: e.lastCallAt })),
    topCustomers: customers.map((c) => ({ id: c._id, name: c.name || "", calls: c.calls, lastCallAt: c.lastCallAt })),
    recent: recent.map((c) => ({ ...callView(c), outcome: outcomeOf(c, now) })),
    // what the numbers above cover
    coverage: {
      detailedDays: retentionDays,
      retainedSince,
      complete: !(range.start < retainedSince),
      note: range.start < retainedSince ? `Call details are kept for ${retentionDays} days. Longer-term counts below come from a short record kept for each finished call.` : "",
    },
    longTerm,
  };
}

/** One customer's calls and voice sessions. `person` is their key; `chatIds`/`chatRefs` are the chats the dashboard already found for them. */
export async function customerCalls(shop, { key, chatIds = [], chatRefs = [], now = Date.now(), limit = 50 } = {}, m = models) {
  const ors = [{ personKey: key }];
  if (chatIds.length) ors.push({ conversationId: { $in: chatIds } });
  if (key?.startsWith("c")) ors.push({ "customer.customerId": key.slice(1) });
  // a browser id finds records only for a visitor: a signed-in customer or a guest may share a browser with someone else
  const byBrowser = key?.startsWith("v") && chatRefs.length > 0;
  if (byBrowser) ors.push({ personKey: { $exists: false }, chatRef: { $in: chatRefs } });
  const callFilter = { shop, $or: ors };
  const voiceFilter = { shop, type: "ai_voice_session", $or: [{ "props.personKey": key }, ...(byBrowser ? [{ chatRef: { $in: chatRefs } }] : [])] };
  const [byOutcome, rows, voice, connected] = await Promise.all([
    m.SupportCall.aggregate([{ $match: callFilter }, ...countStage(now)]),
    m.SupportCall.find(callFilter).sort({ requestedAt: -1 }).limit(Math.min(Math.max(Number(limit) || 50, 1), 100)).lean(),
    m.Event.find(voiceFilter).sort({ at: -1 }).limit(200).lean(),
    m.SupportCall.find({ ...callFilter, connectedAt: { $exists: true } }).select("_id connectedAt").limit(1000).lean(),
  ]);
  const human = foldCounts(byOutcome);
  return {
    human,
    ai: { sessions: voice.length, handedToPerson: voice.filter((v) => v.props?.handedOff).length, totalDurationSec: voice.reduce((n, v) => n + (v.props?.durationSec || 0), 0) },
    interactions: interactionKeys({ calls: connected, voice }).size,
    calls: rows.map((c) => ({ ...callView(c), outcome: outcomeOf(c, now) })),
    voiceSessions: voice.slice(0, 20).map((v) => ({ id: String(v._id), at: v.at, durationSec: v.props?.durationSec || 0, turns: v.props?.turns || 0, handedToPerson: Boolean(v.props?.handedOff), callId: v.props?.handedOffCallId || null, handler: { type: "ai", id: "ai-agent", name: "AI assistant" } })),
  };
}

/** Call and voice-session counts for the people on one page of the customer list: Map(personKey -> {calls, completed, voice}). */
export async function callCountsForPeople(shop, keys, m = models) {
  const out = new Map(keys.map((k) => [k, { calls: 0, completed: 0, voiceSessions: 0 }]));
  if (!keys.length) return out;
  const ids = keys.filter((k) => k[0] === "c").map((k) => k.slice(1));
  const refs = keys.filter((k) => k[0] === "v").map((k) => k.slice(1));
  const [calls, voice] = await Promise.all([
    m.SupportCall.aggregate([
      { $match: { shop, $or: [{ personKey: { $in: keys } }, ...(ids.length ? [{ "customer.customerId": { $in: ids } }] : []), ...(refs.length ? [{ chatRef: { $in: refs }, personKey: { $exists: false } }] : [])] } },
      { $group: { _id: PERSON_EXPR, calls: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ["$status", "ended"] }, 1, 0] } } } },
      { $match: { _id: { $in: keys } } },
    ]),
    m.Event.aggregate([{ $match: { shop, type: "ai_voice_session", "props.personKey": { $in: keys } } }, { $group: { _id: "$props.personKey", n: { $sum: 1 } } }]),
  ]);
  for (const c of calls) out.set(c._id, { ...out.get(c._id), calls: c.calls, completed: c.completed });
  for (const v of voice) out.set(v._id, { ...out.get(v._id), voiceSessions: v.n });
  return out;
}

/** A filtered, paged list of human calls (newest first). Filters: person, handler, outcome, from/to (Dates), chatRef. */
export async function listSupportCalls(shop, { person = "", handler = "", outcome = "", from = null, to = null, offset = 0, limit = 25, now = Date.now() } = {}, m = models) {
  if (outcome && !OUTCOMES.includes(outcome)) throw new CallInputError(`outcome must be one of ${OUTCOMES.join(", ")}.`);
  if (person && !/^[cev][A-Za-z0-9_-]{1,64}$/.test(person)) throw new CallInputError("person is not valid.");
  if (handler && !/^[A-Za-z0-9_.:@-]{1,60}$/.test(handler)) throw new CallInputError("handler is not valid.");
  const and = [{ shop }];
  if (from || to) and.push({ requestedAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) } });
  if (handler) and.push({ $or: [{ "handledBy.id": handler }, { "representative.id": handler, handledBy: { $exists: false } }] });
  if (person) {
    const ors = [{ personKey: person }];
    if (person[0] === "c") ors.push({ "customer.customerId": person.slice(1) });
    if (person[0] === "v") ors.push({ chatRef: person.slice(1), personKey: { $exists: false } });
    and.push({ $or: ors });
  }
  const pipeline = [{ $match: { $and: and } }, { $addFields: { outcome: outcomeExpr(now) } }, ...(outcome ? [{ $match: { outcome } }] : [])];
  const cap = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const skip = Math.max(Number(offset) || 0, 0);
  const [rows, total] = await Promise.all([
    m.SupportCall.aggregate([...pipeline, { $sort: { requestedAt: -1, _id: -1 } }, { $skip: skip }, { $limit: cap + 1 }]),
    skip === 0 ? m.SupportCall.aggregate([...pipeline, { $count: "n" }]) : Promise.resolve(null),
  ]);
  return {
    items: rows.slice(0, cap).map((c) => ({ ...callView(c), outcome: c.outcome })),
    next: rows.length > cap ? skip + cap : null,
    ...(total ? { total: total[0]?.n || 0 } : {}),
  };
}

/** One call with everything on it (still only if it is this store's). */
export async function getSupportCall(shop, id, { now = Date.now() } = {}, m = models) {
  if (!/^[a-f0-9]{24}$/i.test(String(id || ""))) return null;
  const call = await m.SupportCall.findOne({ _id: id, shop }).lean();
  if (!call) return null;
  return { ...callView(call), outcome: outcomeOf(call, now) };
}
