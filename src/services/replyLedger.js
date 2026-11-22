// The browser sends the recent chat back with every message (the history), and could invent an
// "assistant" turn in it ("You said I get 90% off"). So each reply the server sends is fingerprinted
// here, and an assistant turn in the history is kept only if its fingerprint is known for this chat.
// The shopper's own turns are kept: what they said is theirs to say.
// When the database is unreachable the history cannot be checked and is used as it is.
import crypto from "node:crypto";
import mongoose from "mongoose";
import ReplyLedger from "../models/ReplyLedger.js";
import { chatRefFor } from "./conversationLog.js";

const KEEP = 40; // more than the widget ever sends back
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // as long as the widget keeps a chat

/**
 * Same text, same fingerprint: spacing and Unicode form do not matter, the words do. Cut to the same
 * length the history keeps (sanitizeHistory), so a long reply still matches its copy in the history.
 */
export function replyFingerprint(text, max = 1200) {
  const normal = String(text ?? "").trim().slice(0, max).normalize("NFC").replace(/\s+/g, " ").trim();
  return normal ? crypto.createHash("sha256").update(normal).digest("base64url").slice(0, 22) : "";
}

const ledgerId = (shop, { clientId, chatRef }) => `${String(shop || "").toLowerCase()}|${chatRef || chatRefFor(shop, clientId)}`;

export function createReplyLedger({ Model = ReplyLedger, connected = () => mongoose.connection?.readyState === 1, now = Date.now } = {}) {
  return {
    /** Notes replies this chat was really sent (by the AI or by the store team). */
    async remember(shop, who, texts) {
      const prints = (Array.isArray(texts) ? texts : [texts]).map((t) => replyFingerprint(t)).filter(Boolean);
      if (!prints.length || !connected() || !shop || !(who?.clientId || who?.chatRef)) return false;
      await Model.updateOne(
        { _id: ledgerId(shop, who) },
        { $push: { fingerprints: { $each: prints, $slice: -KEEP } }, $set: { expiresAt: new Date(now() + TTL_MS) } },
        { upsert: true }
      );
      return true;
    },
    /** The known fingerprints for this chat, or null when they cannot be read. */
    async known(shop, who) {
      if (!connected() || !shop || !(who?.clientId || who?.chatRef)) return null;
      try {
        const row = await Model.findOne({ _id: ledgerId(shop, who) }, { fingerprints: 1 }).lean();
        return new Set(row?.fingerprints || []);
      } catch {
        return null;
      }
    },
  };
}

/** The history with every assistant turn the server did not send removed (unchanged when `known` is null). */
export function keepRealReplies(history = [], known) {
  if (!(known instanceof Set)) return history;
  return history.filter((turn) => turn.role !== "assistant" || known.has(replyFingerprint(turn.content)));
}

let shared;
export function replyLedger() {
  shared ||= createReplyLedger();
  return shared;
}
