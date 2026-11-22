import mongoose from "mongoose";

// The audio of one call the shopper agreed to save. Never public: it is only read through the dashboard (the store's
// signed-in team) or by the shopper's own chat, each checked against the store and the chat. The bytes live in the
// document (storage "mongo", capped well below Mongo's 16 MB) or in object storage (storage "s3"), like shopper files.
const isMongo = function () {
  return this.storage !== "s3";
};

const supportRecordingSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, lowercase: true, trim: true },
    callId: { type: mongoose.Schema.Types.ObjectId, required: true },
    chatRef: { type: String, required: true, maxlength: 64 },
    mime: { type: String, required: true, maxlength: 60 },
    size: { type: Number, required: true },
    durationSec: { type: Number, default: undefined },
    storage: { type: String, enum: ["mongo", "s3"], default: "mongo" },
    data: { type: Buffer, required: isMongo, select: false },
    objectKey: { type: String, maxlength: 300 },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: isMongo },
    deleteAfter: { type: Date },
  },
  { versionKey: false }
);

supportRecordingSchema.index({ shop: 1, callId: 1 }, { unique: true });
supportRecordingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
supportRecordingSchema.index({ deleteAfter: 1 }, { partialFilterExpression: { storage: "s3" } });

export default mongoose.models.SupportRecording || mongoose.model("SupportRecording", supportRecordingSchema);
