// Emails that failed for a passing reason (the mail server unreachable, a timeout, "try again later")
// are kept and sent again with growing waits (EMAIL_MAX_ATTEMPTS, default 6, over about a day). An email
// that failed for good (a bad address, a wrong password) is not retried: the wrong password raises an alert.
// Order confirmations and the owner's alerts use this; one-time codes do not (a late code is useless).
import mongoose from "mongoose";
import EmailOutbox from "../models/EmailOutbox.js";
import { alert } from "../observability/alerts.js";
import { inc } from "../observability/metrics.js";
import { redact } from "../utils/logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_MS = 2 * 60 * 1000;

/** 1, 5, 15 minutes, then 1 h, 4 h, 8 h. */
export const emailRetryDelayMs = (attempts) => [60_000, 300_000, 900_000, 3_600_000, 14_400_000][attempts - 1] ?? 28_800_000;

/** True for failures worth trying again; false for a bad address, a refused message or a wrong login. */
export function isTransientEmailError(error) {
  const code = String(error?.code || "");
  const status = Number(error?.responseCode) || 0;
  const message = String(error?.message || error || "");
  if (status === 535 || /EAUTH|Invalid login|Username and Password not accepted/i.test(`${code} ${message}`)) return false;
  if (status >= 500 && status < 600) return false; // permanent SMTP refusal (550 no such user, 552, 553, 554)
  if (status >= 400 && status < 500) return true; // 421, 450, 451, 452: try later
  return /ECONN|ETIMEDOUT|ESOCKET|EDNS|ENOTFOUND|EAI_AGAIN|ECONNRESET|EPIPE|timeout|Greeting never received|Connection closed/i.test(`${code} ${message}`);
}

/** Only what can be stored: text parts and string attachments (e.g. a calendar invite). */
function storable(message) {
  const out = {};
  for (const key of ["from", "to", "cc", "subject", "text", "html", "replyTo"]) if (typeof message[key] === "string") out[key] = message[key];
  if (Array.isArray(message.attachments)) {
    out.attachments = message.attachments
      .filter((a) => a && typeof a.content === "string")
      .map((a) => ({ filename: String(a.filename || "file").slice(0, 120), content: a.content, contentType: a.contentType || undefined }));
  }
  return out;
}

export function createEmailOutbox({
  Model = EmailOutbox,
  connected = () => mongoose.connection?.readyState === 1,
  now = Date.now,
  log = console,
  maxAttempts = Number(process.env.EMAIL_MAX_ATTEMPTS) > 0 ? Number(process.env.EMAIL_MAX_ATTEMPTS) : 6,
} = {}) {
  return {
    /**
     * After a failed send: keeps the email for another try when the failure was a passing one.
     * Returns true when it was kept.
     */
    async keep({ kind, shop = "", message, error }) {
      inc("emails_failed_total", { kind, transient: String(isTransientEmailError(error)) }, 1, "Emails that failed to send");
      if (!isTransientEmailError(error)) {
        if (/EAUTH|535|Invalid login/i.test(`${error?.code || ""} ${error?.responseCode || ""} ${error?.message || ""}`)) {
          alert("email_auth", `Email login was refused (${String(error?.message || error).slice(0, 160)}): no emails are going out. Check EMAIL_USER and EMAIL_APP_PASSWORD.`);
        }
        return false;
      }
      if (!connected()) return false;
      const t = now();
      await Model.create({ kind, shop, message: storable(message), status: "waiting", attempts: 1, nextAttemptAt: new Date(t + emailRetryDelayMs(1)), lastError: String(error?.message || error).slice(0, 300), expiresAt: new Date(t + 3 * DAY_MS) });
      log.warn?.(`[email] ${kind} to ${redact(message.to)} kept to try again`);
      return true;
    },
    /** Sends what is due. Returns how many were sent. */
    async sweep({ send, batch = 20 } = {}) {
      if (!connected() || typeof send !== "function") return 0;
      let sent = 0;
      for (let i = 0; i < batch; i++) {
        const t = now();
        const row = await Model.findOneAndUpdate(
          { $or: [{ status: "waiting", nextAttemptAt: { $lte: new Date(t) } }, { status: "sending", lockedUntil: { $lt: new Date(t) } }] },
          { $set: { status: "sending", lockedUntil: new Date(t + LOCK_MS) }, $inc: { attempts: 1 } },
          { sort: { nextAttemptAt: 1 }, new: true, lean: true }
        );
        if (!row) break;
        try {
          await send(row.message);
          await Model.deleteOne({ _id: row._id });
          inc("emails_retried_total", { kind: row.kind, outcome: "sent" }, 1, "Emails sent on a later try");
          sent++;
        } catch (error) {
          const giveUp = row.attempts >= maxAttempts || !isTransientEmailError(error);
          await Model.updateOne(
            { _id: row._id },
            { $set: { status: giveUp ? "dead" : "waiting", lastError: String(error?.message || error).slice(0, 300), nextAttemptAt: new Date(now() + emailRetryDelayMs(row.attempts)) }, $unset: { lockedUntil: "" } }
          );
          inc("emails_retried_total", { kind: row.kind, outcome: giveUp ? "given_up" : "retry" });
          if (giveUp) alert(`email_dead:${row.kind}`, `A ${row.kind} email for ${row.shop || "a store"} could not be sent after ${row.attempts} tries: ${String(error?.message || error).slice(0, 160)}`);
        }
      }
      return sent;
    },
  };
}

let shared;
export function emailOutbox() {
  shared ||= createEmailOutbox();
  return shared;
}
