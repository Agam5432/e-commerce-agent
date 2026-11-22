// How the agent is doing, in the owner's terms: how many chats it handled alone, how fast and how reliably it
// answered, and how many chats ended in an order. Everything is counted from what was recorded for this store;
// nothing is estimated. Chats are counted by when they started, replies by when they were sent.
import Conversation from "../models/Conversation.js";
import Event from "../models/Event.js";
import { parseRange, nextYmd } from "./stats.js";
import { notCountedOrder } from "./money.js";

const models = { Conversation, Event };
const rate = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 1000 : 0);
// still waiting for a person: flagged, and not closed by the owner since
const NEEDS_PERSON = { status: { $ne: "resolved" }, $or: [{ status: "needs_human" }, { "flags.needsFollowUp": true }] };

export async function agentPerformance(shop, query = {}, { analytics = {}, timezone = "UTC", now = Date.now() } = {}, m = models) {
  const range = parseRange(query, timezone, now);
  const at = { $gte: range.start, $lt: range.end };
  const rev = analytics.revenue || null;
  const funnel = analytics.funnel || [];
  const dayOf = { $dateToString: { format: "%Y-%m-%d", date: "$at", timezone: range.timezone } };
  const chats = { shop, startedAt: at };

  const [replyRows, dayRows, funnelRows, channelRows, orderedRows, total, needsPerson, resolved] = await Promise.all([
    m.Event.aggregate([
      { $match: { shop, type: "turn", at } },
      { $group: { _id: null, replies: { $sum: 1 }, timed: { $sum: { $cond: [{ $gt: ["$props.ms", 0] }, 1, 0] } }, ms: { $sum: { $cond: [{ $gt: ["$props.ms", 0] }, "$props.ms", 0] } }, failed: { $sum: { $cond: ["$props.degraded", 1, 0] } } } },
    ]),
    m.Event.aggregate([
      { $match: { shop, type: "turn", at } },
      { $group: { _id: dayOf, replies: { $sum: 1 }, timed: { $sum: { $cond: [{ $gt: ["$props.ms", 0] }, 1, 0] } }, ms: { $sum: { $cond: [{ $gt: ["$props.ms", 0] }, "$props.ms", 0] } }, failed: { $sum: { $cond: ["$props.degraded", 1, 0] } } } },
    ]),
    funnel.length
      ? m.Event.aggregate([
          { $match: { shop, at, type: { $in: funnel }, conversationId: { $ne: null }, ...(rev ? { $nor: [notCountedOrder(rev.event)] } : {}) } },
          { $group: { _id: { type: "$type", c: "$conversationId" } } },
          { $group: { _id: "$_id.type", conversations: { $sum: 1 } } },
        ])
      : [],
    m.Event.aggregate([{ $match: { shop, at, type: "conversation_started" } }, { $group: { _id: "$channel", n: { $sum: 1 } } }]),
    rev
      ? m.Event.aggregate([{ $match: { shop, at, type: rev.event, conversationId: { $ne: null }, $nor: [notCountedOrder(rev.event)] } }, { $group: { _id: "$conversationId" } }, { $count: "n" }])
      : [],
    m.Conversation.countDocuments(chats),
    m.Conversation.countDocuments({ ...chats, ...NEEDS_PERSON }),
    m.Conversation.countDocuments({ ...chats, status: "resolved" }),
  ]);

  const r = replyRows[0] || { replies: 0, timed: 0, ms: 0, failed: 0 };
  const channels = Object.fromEntries(channelRows.map((c) => [c._id || "text", c.n]));
  const counts = Object.fromEntries(funnelRows.map((f) => [f._id, f.conversations]));
  const byDay = new Map(dayRows.map((d) => [d._id, d]));
  const series = [];
  for (let day = range.from; day <= range.to; day = nextYmd(day)) {
    const d = byDay.get(day) || { replies: 0, timed: 0, ms: 0, failed: 0 };
    series.push({ date: day, replies: d.replies, failed: d.failed, averageResponseMs: d.timed ? Math.round(d.ms / d.timed) : 0 });
  }
  const ordered = orderedRows[0]?.n || 0;
  return {
    range: { from: range.from, to: range.to, days: range.days, timezone: range.timezone },
    totals: {
      conversations: total,
      needPerson: needsPerson,
      handledAlone: Math.max(total - needsPerson, 0),
      handledAloneRate: rate(Math.max(total - needsPerson, 0), total),
      resolved,
      replies: r.replies,
      failedReplies: r.failed,
      failedRate: rate(r.failed, r.replies),
      averageResponseMs: r.timed ? Math.round(r.ms / r.timed) : 0,
      orderedChats: ordered,
      orderRate: rate(ordered, total),
      channels: { text: channels.text || 0, voice: channels.voice || 0 },
    },
    funnel: funnel.map((stage) => ({ stage, conversations: counts[stage] || 0 })),
    series,
  };
}
