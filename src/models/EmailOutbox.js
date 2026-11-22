import mongoose from "mongoose";

// An email that could not be sent right away (the mail server was unreachable or said "try later"),
// waiting to be sent again. Removed as soon as it is sent; dropped after three days in any case.
const emailOutboxSchema = new mongoose.Schema(
  {
    kind: { type: String, required: true, maxlength: 40 },
    shop: { type: String, default: "", lowercase: true, trim: true },
    message: { type: mongoose.Schema.Types.Mixed, required: true },
    status: { type: String, enum: ["waiting", "sending", "dead"], default: "waiting" },
    attempts: { type: Number, default: 1 },
    nextAttemptAt: { type: Date, required: true },
    lockedUntil: { type: Date },
    lastError: { type: String, maxlength: 300 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

emailOutboxSchema.index({ status: 1, nextAttemptAt: 1 });
emailOutboxSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.EmailOutbox || mongoose.model("EmailOutbox", emailOutboxSchema);
