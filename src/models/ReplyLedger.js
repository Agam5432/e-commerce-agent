import mongoose from "mongoose";

// Fingerprints of the replies this server (the AI, or a person from the store) really sent in one chat,
// so an "assistant" turn the browser sends back in its history can be checked. No reply text is kept,
// only a short hash. Dropped when the chat has been quiet for its retention time.
const replyLedgerSchema = new mongoose.Schema(
  {
    _id: { type: String }, // `${shop}|${chatRef}`
    fingerprints: { type: [String], default: [] },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

replyLedgerSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.ReplyLedger || mongoose.model("ReplyLedger", replyLedgerSchema);
