import mongoose from "mongoose";

// One line of a transcript. The text is stored already redacted (see conversationLog.redactText).
const messageSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, lowercase: true, trim: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // "staff" is a person from the store, writing to the shopper from the dashboard
    role: { type: String, enum: ["user", "assistant", "staff"], required: true },
    staffBy: { type: String, default: undefined, maxlength: 80 },
    text: { type: String, default: "", maxlength: 4000 },
    at: { type: Date, required: true },
    // Files the shopper attached to this message (the bytes are in the Attachment collection).
    attachments: {
      type: [{ _id: false, id: String, name: String, kind: String, mime: String, size: Number }],
      default: undefined,
    },
    // What the assistant put on screen with this reply (product cards, cart / checkout / booking steps),
    // so the owner sees the same thing the shopper saw. Plain facts only; the dashboard words them.
    shown: {
      type: new mongoose.Schema(
        {
          products: {
            type: [{ _id: false, id: String, title: String, handle: String, image: String, price: String, compareAtPrice: String, currency: String, url: String, inStock: Boolean }],
            default: undefined,
          },
          actions: { type: [mongoose.Schema.Types.Mixed], default: undefined },
        },
        { _id: false }
      ),
      default: undefined,
    },
    // A line that reports an audio call (written as a "staff" message): which call, how it ended, whether it was saved.
    call: {
      type: new mongoose.Schema({ callId: String, status: String, durationSec: Number, recording: Boolean }, { _id: false }),
      default: undefined,
    },
    // true when the AI could not answer and a safe fallback was sent instead
    degraded: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

messageSchema.index({ shop: 1, conversationId: 1, at: 1 });
messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.Message || mongoose.model("Message", messageSchema);