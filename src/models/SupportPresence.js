import mongoose from "mongoose";

// Whether a team member can take a call right now. One row per (store, Shopify user). A row only counts as
// available while its heartbeat is fresh: a closed browser stops sending them, so it never stays "online".
export const PRESENCE_STATUSES = ["online", "away", "offline"];

const supportPresenceSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, lowercase: true, trim: true },
    representativeId: { type: String, required: true, maxlength: 60 },
    name: { type: String, default: "", maxlength: 80 },
    // what the person chose; "busy" is not stored: it is derived from `activeCallId`
    status: { type: String, enum: PRESENCE_STATUSES, default: "offline" },
    lastHeartbeatAt: { type: Date, required: true },
    activeCallId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, versionKey: false }
);

supportPresenceSchema.index({ shop: 1, representativeId: 1 }, { unique: true });
supportPresenceSchema.index({ shop: 1, status: 1, lastHeartbeatAt: -1 });
// a row nobody has refreshed for a day is only clutter
supportPresenceSchema.index({ lastHeartbeatAt: 1 }, { expireAfterSeconds: 86400 });

export default mongoose.models.SupportPresence || mongoose.model("SupportPresence", supportPresenceSchema);
