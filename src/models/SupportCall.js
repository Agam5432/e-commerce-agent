import mongoose from "mongoose";

// One request by a shopper to talk to a person, and the audio call it becomes. `shop` is the tenant key.
//
//   requested -> accepted -> connected -> ended          (a person took it, the audio came up, someone hung up)
//   requested -> cancelled                               (the shopper gave up while waiting)
//   requested -> unanswered                              (nobody took it in time, or nobody was left to take it)
//   accepted | connected -> failed                       (the audio could not be set up, or a side dropped for good)
//
// While a call is open (requested, accepted, connected) `openKey` is set and a unique index on it stops a second
// open request from the same chat; it is removed when the call closes.
export const OPEN_STATUSES = ["requested", "accepted", "connected"];
export const CALL_STATUSES = [...OPEN_STATUSES, "ended", "cancelled", "unanswered", "failed"];
export const RECORDING_STATES = ["none", "declined", "recording", "uploading", "saved", "failed", "withdrawn"];

const supportCallSchema = new mongoose.Schema(
  {
    shop: { type: String, required: true, lowercase: true, trim: true },
    // The chat it belongs to. `chatRef` is known at once; `conversationId` once the chat has been stored.
    chatRef: { type: String, required: true, maxlength: 64 },
    conversationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    status: { type: String, enum: CALL_STATUSES, default: "requested" },
    openKey: { type: String, default: undefined },
    callType: { type: String, enum: ["audio"], default: "audio" },
    // Who asked: only what the shopper has already given the chat (never asked again here).
    customer: {
      name: { type: String, default: "", maxlength: 80 },
      email: { type: String, default: "", maxlength: 254 },
      phone: { type: String, default: "", maxlength: 24 },
      customerId: { type: String, default: "", maxlength: 30 },
    },
    reason: { type: String, default: "", maxlength: 300 },
    // Who took it (the Shopify user of the team member) and who passed on it.
    representative: { id: { type: String, default: undefined, maxlength: 60 }, name: { type: String, default: undefined, maxlength: 80 } },
    rejectedBy: { type: [String], default: undefined },
    // Accountability. `personKey` is the customer this call belongs to (the same key the dashboard groups chats by).
    // Every call so far is a customer asking for a person, so `initiatedBy` is always "customer" and `direction` "inbound".
    // `assignedTo` is who the call was given to, `handledBy` who really has it; both use the stable team-member id
    // (the Shopify user) and keep a name as it was at the time. `representative` is the same person, kept as before.
    personKey: { type: String, default: undefined, maxlength: 70 },
    initiatedBy: { type: String, enum: ["customer"], default: "customer" },
    direction: { type: String, enum: ["inbound"], default: "inbound" },
    handlerType: { type: String, enum: ["human"], default: "human" },
    assignedTo: { type: { type: String, enum: ["human", "ai"], default: undefined }, id: { type: String, default: undefined, maxlength: 60 }, name: { type: String, default: undefined, maxlength: 80 } },
    handledBy: { type: { type: String, enum: ["human", "ai"], default: undefined }, id: { type: String, default: undefined, maxlength: 60 }, name: { type: String, default: undefined, maxlength: 80 } },
    // Who had the call and for how long (from taking it to letting go). A call is taken by one person today, so there is one.
    handlingSegments: {
      type: [{ _id: false, employeeId: { type: String, maxlength: 60 }, employeeName: { type: String, default: "", maxlength: 80 }, startedAt: Date, endedAt: { type: Date, default: undefined }, durationSec: { type: Number, default: undefined } }],
      default: undefined,
    },
    // The shopper's choice about saving the call. Asked before the call; never a condition for being helped.
    recording: {
      consent: { type: Boolean, default: false },
      consentAt: { type: Date, default: undefined },
      withdrawnAt: { type: Date, default: undefined },
      status: { type: String, enum: RECORDING_STATES, default: "none" },
      recordingId: { type: mongoose.Schema.Types.ObjectId, default: undefined },
      sizeBytes: { type: Number, default: undefined },
      error: { type: String, default: undefined, maxlength: 200 },
    },
    requestedAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: undefined },
    connectedAt: { type: Date, default: undefined },
    endedAt: { type: Date, default: undefined },
    durationSec: { type: Number, default: undefined },
    failureReason: { type: String, default: undefined, maxlength: 120 },
    // a request nobody has taken by then is closed as unanswered (see supportService.sweepSupport)
    expiresAt: { type: Date, required: true },
    // the call record itself is kept as long as the chat is (TTL)
    keepUntil: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false }
);

supportCallSchema.index({ shop: 1, status: 1, requestedAt: -1 });
supportCallSchema.index({ shop: 1, conversationId: 1, requestedAt: -1 }, { sparse: true });
supportCallSchema.index({ shop: 1, chatRef: 1, requestedAt: -1 });
supportCallSchema.index({ shop: 1, personKey: 1, requestedAt: -1 }, { sparse: true });
supportCallSchema.index({ shop: 1, "handledBy.id": 1, requestedAt: -1 }, { sparse: true });
supportCallSchema.index({ openKey: 1 }, { unique: true, sparse: true });
supportCallSchema.index({ keepUntil: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.SupportCall || mongoose.model("SupportCall", supportCallSchema);
