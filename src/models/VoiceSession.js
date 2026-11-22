import mongoose from "mongoose";

// One live voice call in progress, on whichever server instance holds it. The instance refreshes
// `heartbeatAt` while the call runs; a call whose instance stopped is no longer counted once its
// heartbeat is stale, and MongoDB drops the row soon after.
const voiceSessionSchema = new mongoose.Schema(
  {
    _id: { type: String },
    shop: { type: String, required: true, lowercase: true, trim: true },
    instance: { type: String, required: true },
    heartbeatAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

voiceSessionSchema.index({ shop: 1, heartbeatAt: 1 });
voiceSessionSchema.index({ instance: 1 });
voiceSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.VoiceSession || mongoose.model("VoiceSession", voiceSessionSchema);
