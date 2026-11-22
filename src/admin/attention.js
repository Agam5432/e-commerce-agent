// "Needs you now": what is waiting for the store owner right now, whatever date range the dashboard shows.
import Conversation from "../models/Conversation.js";
import Complaint from "../models/Complaint.js";
import { PERSON_KEY_EXPR } from "../services/people.js";
import { bookingSummary } from "../services/bookingService.js";
import { STATE_CLAUSES, TODO_CLAUSES, UNREAD_CLAUSE, bookingView } from "./stats.js";

export async function attention(shop, { Conv = Conversation, summary = bookingSummary, orderedOutcome = "order_placed", Complaints = Conv === Conversation ? Complaint : null } = {}) {
  const notDone = { shop, status: { $ne: "resolved" } };
  const needsPerson = { $or: [{ status: "needs_human" }, { "flags.needsFollowUp": true }] };
  const count = (filter) => Conv.countDocuments(filter);
  // the numbers on the inbox chips count PEOPLE (the list shows one row per person), not every chat they ever had
  const people = (filter) => (typeof Conv.aggregate === "function" ? Conv.aggregate([{ $match: filter }, { $group: { _id: PERSON_KEY_EXPR } }, { $count: "n" }]).then((r) => r[0]?.n || 0) : count(filter));
  const [calls, followUps, files, all, callChats, fileChats, ordered, resolved, waiting, person, todo, human, humanWaiting, humanLive, ai, unread] = await Promise.all([
    summary(shop),
    count({ ...notDone, ...needsPerson }),
    count({ ...notDone, fileCount: { $gt: 0 } }),
    // the numbers on the inbox chips: each is exactly what that chip lists (every chat, whatever its date)
    people({ shop }),
    people({ shop, "flags.callRequested": true }),
    people({ shop, fileCount: { $gt: 0 } }),
    people({ shop, outcome: orderedOutcome }),
    people({ shop, status: "resolved" }),
    people({ shop, $and: STATE_CLAUSES.waiting }),
    people({ shop, $and: STATE_CLAUSES.person }),
    count({ shop, $and: TODO_CLAUSES }),
    people({ shop, "support.callId": { $exists: true } }),
    people({ shop, "support.status": "requested" }),
    people({ shop, "support.status": { $in: ["accepted", "connected"] } }),
    people({ shop, $and: STATE_CLAUSES.ai }),
    // chats with news the owner has not opened yet, one per person
    people({ shop, ...UNREAD_CLAUSE }),
  ]);
  // complaints that are open, and the ones whose email did not go (they need the store to act)
  const [complaintsOpen, complaintsEmailFailed] = await Promise.all([
    Complaints?.countDocuments ? Complaints.countDocuments({ shop, open: true, status: { $ne: "troubleshooting" } }) : 0,
    Complaints?.countDocuments ? Complaints.countDocuments({ shop, open: true, "email.status": { $in: ["failed", "not_configured", "retrying"] } }) : 0,
  ]);
  return {
    complaints: { open: complaintsOpen, emailFailed: complaintsEmailFailed },
    calls: { waiting: calls.waiting, upcoming: calls.upcoming, overdue: calls.overdue, next: (calls.next || []).map(bookingView) },
    followUps,
    files,
    // the number on the sidebar and the Home to-do list: each chat that needs the owner, counted once
    todo,
    inbox: { all, waiting, person, follow_up: followUps, calls: callChats, files: fileChats, ordered, resolved, human, human_waiting: humanWaiting, human_live: humanLive, ai, unread },
  };
}
