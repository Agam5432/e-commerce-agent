import mongoose from "mongoose";

// The id of a short-lived storefront token that has been used once. Shared by every server instance,
// so a token cannot be replayed on a second instance either. MongoDB drops the row once the token expires.
const usedTokenSchema = new mongoose.Schema(
  {
    _id: { type: String },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

usedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.UsedToken || mongoose.model("UsedToken", usedTokenSchema);
