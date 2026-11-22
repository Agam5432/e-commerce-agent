import mongoose from "mongoose";

// Analytics fact: something that happened (a chat started, a product was shown, an order was placed).
// Holds no personal data, so it is kept longer than transcripts. `type` is a free string: the core
// writes `conversation_started` and `turn`, each industry adds its own.
const eventSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, lowercase: true, trim: true },
    type: { type: String, required: true, maxlength: 60 },
    at: { type: Date, required: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    chatRef: { type: String, default: null, maxlength: 64 },
    channel: { type: String, default: "text", maxlength: 12 },
    language: { type: String, default: "", maxlength: 16 },
    props: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Makes an event idempotent (e.g. one order seen by both the agent and Shopify's webhook).
    dedupeKey: { type: String, default: undefined, maxlength: 120 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

eventSchema.index({ shop: 1, type: 1, at: -1 });
eventSchema.index({ shop: 1, at: -1 });
eventSchema.index({ shop: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });
eventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.Event || mongoose.model("Event", eventSchema);