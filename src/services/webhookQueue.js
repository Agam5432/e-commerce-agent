// Shopify webhooks, done reliably:
//  - accept(): the delivery is written down (by X-Shopify-Webhook-Id) before Shopify gets its 200, so
//    Shopify never waits on slow work (it gives up after a few seconds and retries) and a repeated
//    delivery is recognised and skipped.
//  - run(): the work happens after the answer. A failure is retried by us with growing waits
//    (WEBHOOK_MAX_ATTEMPTS, default 8); after the last one the receipt is marked dead and an alert goes out.
//  - sweep(): picks up work that is due again, or that a crashed instance left half done. Several
//    instances can sweep at once: each receipt is claimed atomically by one of them.
import mongoose from "mongoose";
import WebhookReceipt from "../models/WebhookReceipt.js";
import { alert } from "../observability/alerts.js";
import { inc } from "../observability/metrics.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_MS = 5 * 60 * 1000;

/** Wait before attempt n+1: 30 s, 1 min, 2 min, ... at most an hour. */
export const retryDelayMs = (attempts) => Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempts - 1));

export function createWebhookQueue({
  Model = WebhookReceipt,
  connected = () => mongoose.connection?.readyState === 1,
  now = Date.now,
  log = console,
  maxAttempts = Number(process.env.WEBHOOK_MAX_ATTEMPTS) > 0 ? Number(process.env.WEBHOOK_MAX_ATTEMPTS) : 8,
} = {}) {
  const handlers = new Map();

  async function run(id) {
    const t = now();
    const claimed = await Model.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { status: { $in: ["pending", "failed"] }, nextAttemptAt: { $lte: new Date(t) } },
          { status: "processing", lockedUntil: { $lt: new Date(t) } },
        ],
      },
      { $set: { status: "processing", lockedUntil: new Date(t + LOCK_MS) }, $inc: { attempts: 1 } },
      { new: true, lean: true }
    );
    if (!claimed) return "skipped";
    const work = handlers.get(claimed.kind);
    try {
      if (!work) throw new Error(`no handler for webhook kind ${claimed.kind}`);
      await work({ shop: claimed.shop, topic: claimed.topic, body: claimed.body || {} });
      await Model.updateOne({ _id: id }, { $set: { status: "done", doneAt: new Date(now()) }, $unset: { body: "", lockedUntil: "", lastError: "" } });
      inc("webhooks_total", { kind: claimed.kind, outcome: "done" }, 1, "Shopify webhooks processed");
      return "done";
    } catch (error) {
      const message = String(error?.message || error).slice(0, 300);
      const dead = claimed.attempts >= maxAttempts;
      await Model.updateOne(
        { _id: id },
        { $set: { status: dead ? "dead" : "failed", lastError: message, nextAttemptAt: new Date(now() + retryDelayMs(claimed.attempts)) }, $unset: { lockedUntil: "" } }
      );
      inc("webhooks_total", { kind: claimed.kind, outcome: dead ? "dead" : "retry" });
      log.error?.(`[webhook] ${claimed.kind} for ${claimed.shop} failed (attempt ${claimed.attempts} of ${maxAttempts}): ${message}`);
      if (dead) alert(`webhook_dead:${claimed.kind}`, `A ${claimed.topic || claimed.kind} webhook for ${claimed.shop} failed ${claimed.attempts} times and was given up (receipt ${id}): ${message}`);
      return dead ? "dead" : "failed";
    }
  }

  return {
    register(kind, work) {
      handlers.set(kind, work);
      return this;
    },
    /** True when deliveries can be written down; without the database, work is done before answering. */
    durable: () => connected(),
    /** Writes the delivery down. "queued" for a new one, "duplicate" for one already received. */
    async accept({ id, kind, shop, topic = "", body = {} }) {
      try {
        await Model.create({ _id: id, kind, shop, topic, body, status: "pending", attempts: 0, nextAttemptAt: new Date(now()), receivedAt: new Date(now()), expiresAt: new Date(now() + WEEK_MS) });
        return "queued";
      } catch (error) {
        if (error?.code === 11000) {
          inc("webhooks_total", { kind, outcome: "duplicate" });
          return "duplicate";
        }
        throw error;
      }
    },
    run,
    /** Runs every receipt that is due. Returns how many were attempted. */
    async sweep({ batch = 20 } = {}) {
      if (!connected()) return 0;
      const t = new Date(now());
      const due = await Model.find(
        { $or: [{ status: { $in: ["pending", "failed"] }, nextAttemptAt: { $lte: t } }, { status: "processing", lockedUntil: { $lt: t } }] },
        { _id: 1 }
      )
        .limit(batch)
        .lean();
      for (const row of due) await run(row._id).catch((error) => log.error?.(`[webhook] sweep: ${String(error?.message || error).slice(0, 160)}`));
      return due.length;
    },
  };
}

let shared;
export function webhookQueue() {
  shared ||= createWebhookQueue();
  return shared;
}
