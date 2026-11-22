// One-off, safe to run again. For human calls saved before call accountability existed it
//   1. adds the customer key (`personKey`): c<Shopify id> when the call carried a signed-in customer's id, else v<browser id>.
//      This only names the identity the call ALREADY had. It does not connect a visitor to the same person on another
//      browser or after cookies were cleared: only a Shopify sign-in or (later) a verified email/phone can do that.
//   2. writes the short `support_call_closed` event for every finished call that has none, so counts older than the detailed
//      call records (kept for the store's retention period) stay available.
// Nothing is deleted and nothing else is changed (who took a call is read from `representative`, not rewritten).
// Usage: node scripts/backfill-support-calls.mjs            (shows what would change)
//        node scripts/backfill-support-calls.mjs --apply    (does it)
import "dotenv/config";
import mongoose from "mongoose";
import SupportCall from "../src/models/SupportCall.js";
import Event from "../src/models/Event.js";

const apply = process.argv.includes("--apply");
const FINAL = ["ended", "failed", "cancelled", "unanswered"];
const EVENT_DAYS = Number(process.env.EVENT_RETENTION_DAYS || 400);
const keyOf = (c) => (String(c.customer?.customerId || "").replace(/\D/g, "") ? `c${String(c.customer.customerId).replace(/\D/g, "")}` : `v${c.chatRef}`);

try {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME, serverSelectionTimeoutMS: 5000 });
  let keyed = 0;
  let events = 0;
  let skipped = 0;
  const cursor = SupportCall.find({}).lean().cursor();
  for await (const c of cursor) {
    if (!c.personKey) {
      keyed++;
      if (apply) await SupportCall.updateOne({ _id: c._id, shop: c.shop, personKey: { $exists: false } }, { $set: { personKey: keyOf(c) } });
    }
    if (FINAL.includes(c.status)) {
      const end = c.endedAt || c.requestedAt;
      // older than the events are kept for: nothing to write (they would expire at once)
      if (Date.now() - new Date(end).getTime() > EVENT_DAYS * 86_400_000) { skipped++; continue; }
      const who = c.handledBy?.id || c.representative?.id || null;
      events++;
      if (apply) {
        await Event.updateOne(
          { shop: c.shop, dedupeKey: `call:${c._id}` },
          { $setOnInsert: { shop: c.shop, type: "support_call_closed", at: end, conversationId: c.conversationId || null, chatRef: c.chatRef || null, dedupeKey: `call:${c._id}`, expiresAt: new Date(Date.now() + EVENT_DAYS * 86_400_000), props: { callId: String(c._id), status: c.status, durationSec: c.status === "ended" ? c.durationSec || 0 : 0, connected: Boolean(c.connectedAt), requestedAt: c.requestedAt, acceptedAt: c.acceptedAt || null, handlerType: "human", handlerId: who, personKey: c.personKey || keyOf(c) } } },
          { upsert: true }
        );
      }
    }
  }
  console.log(`${keyed} call(s) ${apply ? "got" : "would get"} a customer key; ${events} finished call(s) ${apply ? "were checked for" : "would be checked for"} their record; ${skipped} too old to need one.`);
  if (!apply) console.log("This was a dry run. Run again with --apply to make the changes.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
