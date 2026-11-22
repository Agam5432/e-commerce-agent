import mongoose from "mongoose";

// One chat session of one visitor in one store. `shop` is the tenant key: every query in the app
// filters by it. Nothing here is industry specific: `outcome` is a label the industry module defines.
const conversationSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, lowercase: true, trim: true },
    // Public, non-reversible reference to the visitor (never the private client id).
    chatRef: { type: String, required: true, maxlength: 64 },
    industry: { type: String, default: "ecommerce", maxlength: 40 },
    channel: { type: String, enum: ["text", "voice"], default: "text" },
    language: { type: String, default: "", maxlength: 16 },
    startedAt: { type: Date, required: true },
    lastMessageAt: { type: Date, required: true },
    messageCount: { type: Number, default: 0 },
    status: { type: String, enum: ["open", "resolved", "needs_human"], default: "open" },
    outcome: { type: String, default: "chat", maxlength: 40 },
    outcomeRank: { type: Number, default: 0 },
    firstMessage: { type: String, default: "", maxlength: 240 },
    // Verified customer only (Shopify numeric id); anonymous visitors have none.
    customerRef: { type: String, default: null, maxlength: 40 },
    // Who this is, for the owner's Customers screen (see services/people.js). Removed by the erase tools.
    personKey: { type: String, default: undefined, maxlength: 70 },
    contact: {
      name: { type: String, maxlength: 80 },
      email: { type: String, maxlength: 254 },
      phone: { type: String, maxlength: 24 },
    },
    // Set when the shopper cleared the chat on their screen. The store keeps this copy; the next message starts a new conversation.
    clearedAt: { type: Date, default: null },
    // What needs the owner. Set by the agent (call booked, files sent, asked for a person) and cleared by the owner.
    flags: {
      callRequested: { type: Boolean, default: undefined },
      needsFollowUp: { type: Boolean, default: undefined },
      hasFiles: { type: Boolean, default: undefined },
      reason: { type: String, default: undefined, maxlength: 300 },
      // the owner has been emailed about the files / the request for a person in this chat (once each)
      alertedFiles: { type: Boolean, default: undefined },
      alertedFollowUp: { type: Boolean, default: undefined },
    },
    // The store's own record of a refund / exchange / return the shopper asked for. The shopper's agent reads it, so it
    // can say where things stand; `note` is written for the shopper to hear.
    case: {
      type: { type: String, default: undefined, maxlength: 20 },
      status: { type: String, default: undefined, maxlength: 20 },
      note: { type: String, default: undefined, maxlength: 400 },
      updatedAt: { type: Date, default: undefined },
      updatedBy: { type: String, default: undefined, maxlength: 80 },
    },
    // A person from the store has taken over this chat: the AI stays silent and the shopper hears from the team.
    handoff: {
      active: { type: Boolean, default: undefined },
      at: { type: Date, default: undefined },
      by: { type: String, default: undefined, maxlength: 80 },
      // set while the person has the chat only because of a live call (given back to the AI when that call closes)
      callId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
    },
    // Where the shopper's request for a person stands (mirrors the latest SupportCall, see services/supportService.js).
    support: {
      status: { type: String, default: undefined, maxlength: 20 },
      callId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
      at: { type: Date, default: undefined },
    },
    // When the owner last opened this chat in the admin. A chat is unread while lastMessageAt is later than this.
    ownerReadAt: { type: Date, default: undefined },
    fileCount: { type: Number, default: 0 },
    // The owner's private note about this chat (never shown to the shopper).
    ownerNote: { type: String, default: undefined, maxlength: 1000 },
    degradedTurns: { type: Number, default: 0 },
    tokensIn: { type: Number, default: 0 },
    tokensOut: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

conversationSchema.index({ shop: 1, lastMessageAt: -1 });
conversationSchema.index({ shop: 1, chatRef: 1, lastMessageAt: -1 });
conversationSchema.index({ shop: 1, customerRef: 1 }, { sparse: true });
conversationSchema.index({ shop: 1, personKey: 1, lastMessageAt: -1 }, { sparse: true });
conversationSchema.index({ shop: 1, "flags.needsFollowUp": 1, lastMessageAt: -1 }, { sparse: true });
conversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.Conversation || mongoose.model("Conversation", conversationSchema);