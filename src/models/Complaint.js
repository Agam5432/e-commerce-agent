import mongoose from "mongoose";

// A customer's problem, from the first time they describe it until it is settled. It is the structured memory of a chat's
// complaint: what they said, which order and product, what the assistant already suggested, and where it went (an email to
// the store, a person on a call, a callback). `shop` is the tenant key; every query carries it.
//
// One OPEN complaint per chat (a unique index on the open ones): asking to raise it again, repeating it or retrying a request
// finds the same record, so there is never a second complaint, a second email or a second call for the same problem.
export const COMPLAINT_STATUSES = ["troubleshooting", "raised", "email_sent", "email_failed", "human_requested", "callback_booked", "resolved"];
export const EMAIL_STATUSES = ["none", "needs_email", "sending", "sent", "retrying", "failed", "not_configured", "refused"];

const complaintSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, lowercase: true, trim: true },
    chatRef: { type: String, required: true, maxlength: 64 },
    conversationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // shown to the customer and in the email: "CMP-" and six letters or digits
    reference: { type: String, required: true, maxlength: 16 },
    open: { type: Boolean, default: true },
    status: { type: String, enum: COMPLAINT_STATUSES, default: "troubleshooting" },
    language: { type: String, default: "", maxlength: 16 },

    summary: { type: String, default: "", maxlength: 1000 },
    // the customer's own first words about the problem, kept as they wrote them
    originalMessage: { type: String, default: "", maxlength: 1500 },
    orderNumber: { type: String, default: "", maxlength: 40 },
    // true only when the order was looked up for a verified customer: the email says which it is
    orderVerified: { type: Boolean, default: false },
    productName: { type: String, default: "", maxlength: 200 },
    // what the assistant already suggested or tried, so it is never suggested again and the team does not repeat it
    attempts: { type: [String], default: undefined },
    // how many different customer messages have been about this problem (counted by track_issue, once per message): the second one means
    // the customer has come back to it, so the assistant offers the complaint instead of asking for more details
    mentions: { type: Number, default: 0 },
    lastMessageKey: { type: String, default: undefined, maxlength: 40 },
    // which customer message the choice (email or a person) was offered in: raise_complaint acts only on a LATER message, so the
    // customer's consent is enforced here and not only asked for in the prompt
    choiceOfferedKey: { type: String, default: undefined, maxlength: 40 },
    // the details the assistant has already asked this customer for (orderNumber, email, photo, other), one entry per time asked
    asked: { type: [String], default: undefined },
    customerResponse: { type: String, default: "", maxlength: 600 },
    escalationReason: { type: String, default: "", maxlength: 400 },

    customer: {
      name: { type: String, default: "", maxlength: 80 },
      email: { type: String, default: "", maxlength: 254 },
    },

    // what the customer chose: an email to the store, or a person
    channel: { type: String, enum: ["none", "email", "human"], default: "none" },
    escalatedAt: { type: Date, default: undefined },

    email: {
      status: { type: String, enum: EMAIL_STATUSES, default: "none" },
      to: { type: String, default: "", maxlength: 254 },
      cc: { type: String, default: "", maxlength: 254 },
      subject: { type: String, default: "", maxlength: 200 },
      sentAt: { type: Date, default: undefined },
      error: { type: String, default: undefined, maxlength: 300 },
    },

    handoff: {
      status: { type: String, enum: ["none", "requested", "connected", "unavailable", "callback", "ended"], default: "none" },
      callId: { type: String, default: undefined },
      bookingId: { type: String, default: undefined },
      at: { type: Date, default: undefined },
    },

    resolvedAt: { type: Date, default: undefined },
    resolvedBy: { type: String, default: undefined, maxlength: 80 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false }
);

// one open complaint per chat of a store
complaintSchema.index({ shop: 1, chatRef: 1 }, { unique: true, partialFilterExpression: { open: true } });
complaintSchema.index({ shop: 1, createdAt: -1 });
complaintSchema.index({ shop: 1, status: 1, createdAt: -1 });
complaintSchema.index({ shop: 1, reference: 1 }, { unique: true });
complaintSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.Complaint || mongoose.model("Complaint", complaintSchema);
