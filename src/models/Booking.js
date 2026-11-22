import mongoose from "mongoose";

// A call the shopper asked the store to make. `shop` is the tenant key. The shopper picks a time the
// owner's opening hours allow; the owner confirms it (or it is confirmed on its own, per their setting),
// and a confirmed call becomes an event in the owner's Google Calendar plus an email to the shopper.
export const BOOKING_STATUSES = ["requested", "confirmed", "completed", "missed", "cancelled"];
export const ACTIVE_STATUSES = ["requested", "confirmed"];

const bookingSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, lowercase: true, trim: true },
    // The chat it came from (set once the turn is recorded; the shopper is identified by chatRef until then).
    conversationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    chatRef: { type: String, default: "", maxlength: 64 },
    personKey: { type: String, default: undefined, maxlength: 70 },
    name: { type: String, default: "", maxlength: 80 },
    email: { type: String, required: true, maxlength: 254 },
    phone: { type: String, required: true, maxlength: 24 },
    topic: { type: String, default: "", maxlength: 300 },
    language: { type: String, default: "", maxlength: 16 },
    status: { type: String, enum: BOOKING_STATUSES, default: "requested" },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    timezone: { type: String, required: true, maxlength: 64 },
    // Set only while the slot is held (requested or confirmed); a unique index on it stops two shoppers taking the same time.
    activeSlot: { type: String, default: undefined },
    // What the owner suggested instead, when they could not make the asked time.
    proposedStartAt: { type: Date, default: undefined },
    ownerNote: { type: String, default: undefined, maxlength: 500 },
    calendar: {
      eventId: { type: String, default: undefined },
      link: { type: String, default: undefined },
      status: { type: String, enum: ["pending", "synced", "failed", "off"], default: "pending" },
      error: { type: String, default: undefined, maxlength: 200 },
    },
    emails: {
      customer: { type: String, enum: ["none", "sent", "failed", "off"], default: "none" },
      owner: { type: String, enum: ["none", "sent", "failed", "off"], default: "none" },
      error: { type: String, default: undefined, maxlength: 200 },
    },
    confirmedAt: { type: Date, default: undefined },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false }
);

bookingSchema.index({ shop: 1, startAt: 1 });
bookingSchema.index({ shop: 1, status: 1, startAt: 1 });
bookingSchema.index({ shop: 1, conversationId: 1 }, { sparse: true });
bookingSchema.index({ shop: 1, personKey: 1 }, { sparse: true });
bookingSchema.index({ activeSlot: 1 }, { unique: true, sparse: true });
bookingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.Booking || mongoose.model("Booking", bookingSchema);
