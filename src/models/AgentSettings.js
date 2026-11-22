import mongoose from "mongoose";

// What the store owner can change about their agent. One document per store. The service
// (agentSettings.js) validates every field before it is saved; values the owner never set are
// absent so the industry defaults apply. Nothing in here is industry specific except `industry`,
// which the industry module validates.
const settingsSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, unique: true, lowercase: true, trim: true },
    version: { type: Number, default: 1 },
    persona: {
      name: { type: String, default: undefined, maxlength: 40 },
      tone: { type: String, default: undefined, maxlength: 300 },
    },
    instructions: { type: String, default: undefined, maxlength: 1500 },
    knowledge: {
      type: [{ _id: false, question: { type: String, maxlength: 200 }, answer: { type: String, maxlength: 1000 } }],
      default: undefined,
    },
    disabledTools: { type: [String], default: undefined },
    logging: {
      storeTranscripts: { type: Boolean, default: undefined },
      retentionDays: { type: Number, default: undefined },
    },
    // Call booking rules, "when to call me in" alerts and which files shoppers may send (see services/bookingSettings.js).
    booking: { type: mongoose.Schema.Types.Mixed, default: undefined },
    alerts: { type: mongoose.Schema.Types.Mixed, default: undefined },
    files: { type: mongoose.Schema.Types.Mixed, default: undefined },
    // Live help from a person: { liveEnabled, audioEnabled, recordingEnabled } (see services/bookingSettings.js).
    support: { type: mongoose.Schema.Types.Mixed, default: undefined },
    notificationEmail: { type: String, default: undefined, maxlength: 254 },
    industry: { type: mongoose.Schema.Types.Mixed, default: undefined },
    updatedBy: { type: String, default: "" },
    history: {
      type: [{ _id: false, version: Number, at: Date, by: String, changed: [String] }],
      default: [],
    },
  },
  { timestamps: true, versionKey: false }
);

export default mongoose.models.AgentSettings || mongoose.model("AgentSettings", settingsSchema);