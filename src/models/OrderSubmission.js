import mongoose from "mongoose";

// Claim a checkout before contacting Shopify. Keep uncertain submissions so a
// timeout/restart cannot cause a second charge/order on the next request.
const schema = new mongoose.Schema({
  shop: { type: String, required: true },
  key: { type: String, required: true },
  requestId: { type: String, required: true },
  status: { type: String, enum: ["processing", "review", "unknown", "failed", "complete"], required: true },
  draftId: String,
  mutationStartedAt: Date,
  result: mongoose.Schema.Types.Mixed,
  error: String,
}, { timestamps: true, collection: "order_submissions" });

schema.index({ shop: 1, key: 1 }, { unique: true });
export default mongoose.models.OrderSubmission || mongoose.model("OrderSubmission", schema);
