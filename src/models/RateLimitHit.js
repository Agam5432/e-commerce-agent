import mongoose from "mongoose";

// One counter per (limit, shopper or shop, time window). Shared by every server instance, so a
// restart or a second instance does not reset anyone's limit. MongoDB drops a row once its window ends.
const rateLimitHitSchema = new mongoose.Schema(
  {
    _id: { type: String },
    hits: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

rateLimitHitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.RateLimitHit || mongoose.model("RateLimitHit", rateLimitHitSchema);
