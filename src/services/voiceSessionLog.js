// One small record for each voice conversation with the AI assistant, written when the voice connection closes.
// It lives in the `events` collection (no personal data, kept as long as the store's other events), so the dashboard can
// count AI voice sessions per customer without a new collection. It is NOT a call with a person: those are SupportCall.
// If the shopper asked for a person during the session, the record says so and names the call, so one support interaction
// is never counted twice (the dashboard counts distinct chats, see callAnalytics.js).
import crypto from "node:crypto";
import SupportCall from "../models/SupportCall.js";
import { recordEvent, chatRefFor } from "./conversationLog.js";
import { personKeyFor } from "./people.js";

export const AI_HANDLER = Object.freeze({ type: "ai", id: "ai-agent", name: "AI assistant" });
export const newVoiceSessionId = () => crypto.randomUUID();

/**
 * @param {{shop:string, clientId:string, sessionId:string, startedAt:number, endedAt?:number, turns:number, endedBy?:string, customerId?:string}} s
 * Nothing is written for a session where the shopper never said anything (a mic opened and closed).
 */
export async function recordVoiceSession(s, deps = {}) {
  const d = { Call: SupportCall, record: recordEvent, now: () => Date.now(), ...deps };
  if (!s?.shop || !s.clientId || !s.sessionId || !(s.turns > 0)) return false;
  const endedAt = new Date(s.endedAt || d.now());
  const startedAt = new Date(s.startedAt);
  const chatRef = chatRefFor(s.shop, s.clientId);
  const durationSec = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));
  let handoff = null;
  try {
    handoff = await d.Call.findOne({ shop: s.shop, chatRef, requestedAt: { $gte: startedAt } }).sort({ requestedAt: 1 }).select("_id").lean();
  } catch { /* the record is still worth writing */ }
  return d.record({
    shop: s.shop, type: "ai_voice_session", dedupeKey: `voice:${s.sessionId}`, at: endedAt, chatRef,
    props: {
      sessionId: s.sessionId, durationSec, turns: s.turns, endedBy: String(s.endedBy || "").slice(0, 20),
      handlerType: AI_HANDLER.type, handlerId: AI_HANDLER.id,
      personKey: personKeyFor(s.shop, { customerRef: String(s.customerId || "").replace(/\D/g, ""), chatRef }),
      handedOff: Boolean(handoff), handedOffCallId: handoff ? String(handoff._id) : null,
    },
  });
}
