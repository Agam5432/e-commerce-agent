import mongoose from "mongoose";

// Small key/value document used by the order-status verification flow
// (email OTP state, "verified" markers and OTP send-rate counters).
// MongoDB removes a row automatically once `expiresAt` has passed (TTL index).
const orderLookupSessionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

orderLookupSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.OrderLookupSession ||
  mongoose.model("OrderLookupSession", orderLookupSessionSchema);