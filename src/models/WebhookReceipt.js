import mongoose from "mongoose";

// One Shopify webhook delivery, by its X-Shopify-Webhook-Id: so a delivery Shopify sends twice is done
// once, and work that failed after Shopify got its 200 is retried by us. The payload is kept only until
// the work is done; the receipt itself is dropped after a week.
const webhookReceiptSchema = new mongoose.Schema(
  {
    _id: { type: String },
    kind: { type: String, required: true, maxlength: 40 },
    shop: { type: String, required: true, lowercase: true, trim: true },
    topic: { type: String, default: "", maxlength: 80 },
    body: { type: mongoose.Schema.Types.Mixed },
    status: { type: String, enum: ["pending", "processing", "failed", "done", "dead"], default: "pending" },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lockedUntil: { type: Date },
    lastError: { type: String, maxlength: 300 },
    receivedAt: { type: Date, default: Date.now },
    doneAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

webhookReceiptSchema.index({ status: 1, nextAttemptAt: 1 });
webhookReceiptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.WebhookReceipt || mongoose.model("WebhookReceipt", webhookReceiptSchema);
