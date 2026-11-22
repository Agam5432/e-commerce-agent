import mongoose from "mongoose";

// A photo, video or PDF a shopper attached in the chat. `shop` is the tenant key; `chatRef` ties the
// file to one visitor. The bytes live either in the document itself (storage "mongo", every file well
// below Mongo's 16 MB limit; the TTL index removes it when the store's retention ends) or in object
// storage (storage "s3": `objectKey`, removed with its object by the attachment sweeper at `deleteAfter`).
const isMongo = function () {
  return this.storage !== "s3";
};

const attachmentSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, lowercase: true, trim: true },
    chatRef: { type: String, required: true, maxlength: 64 },
    name: { type: String, default: "file", maxlength: 120 },
    mime: { type: String, required: true, maxlength: 60 },
    kind: { type: String, enum: ["image", "video", "pdf"], required: true },
    size: { type: Number, required: true },
    storage: { type: String, enum: ["mongo", "s3"], default: "mongo" },
    data: { type: Buffer, required: isMongo, select: false },
    objectKey: { type: String, maxlength: 300 },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: isMongo },
    deleteAfter: { type: Date },
  },
  { versionKey: false }
);

attachmentSchema.index({ shop: 1, chatRef: 1, createdAt: -1 });
attachmentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
attachmentSchema.index({ deleteAfter: 1 }, { partialFilterExpression: { storage: "s3" } });

export default mongoose.models.Attachment || mongoose.model("Attachment", attachmentSchema);
